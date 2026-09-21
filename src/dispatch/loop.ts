/**
 * loop.ts — the reusable wait loop, factored out of the dispatch entry's
 * old in-call wait-and-harvest loop. The async contract (R1) removed the
 * wait from the tool path — the entry returns after the spawn/admission
 * pass and carries no harvest — so the machinery that owned what the
 * blocking call used to own (R2: admitting queued tasks as slots free,
 * spawning them, refreshing their lease each tick) is a standalone module
 * the session-scoped watcher (the delivery side) and the bench drivers
 * (R10) drive.
 *
 * Per tick: attach the provider scope's new ids (a dynamic `ids` grows the
 * owned set mid-wait — the watcher's dispatches land while it runs) →
 * reconcile (the in-scope unspawned queue is excluded — it is what this
 * loop is about to spawn, never "stuck") → refresh the in-scope unspawned
 * tasks' owner lease (freshness is what makes them a live queue, not a
 * dead owner's residue) → count the liveness-qualified slots → spawn
 * in-scope queued tasks as slots free (per-task spec.mode — a mixed-mode
 * scope spawns each task the way its own dispatch planned it) → poll the
 * in-scope states → the `onPass` hook (the watcher's per-tick delivery
 * check, R3).
 * Stops when every owned task is terminal AND the `pending` condition (the
 * R2 stop condition's delivery clause) is not true, or the stop signal
 * flips — NOTHING settles on abort (delivery is session-scoped, not
 * turn-scoped: the queue's lease decides its fate — a live owner keeps
 * ticking it, a dead owner's stale lease settles it never-spawned).
 *
 * The loop does NOT harvest: it hands the observed states to `onPass` and
 * returns them; the caller owns the harvest (the watcher's delivery via
 * `harvestTask`; the bench collector reads the task dirs).
 */
import { join } from "node:path";
import * as P from "../protocol";
import * as C from "../config";
import { defaultHyprctl } from "../hyprctl";
import { countSlots, nonTerminalTasks, reconcileAll, STUCK_QUEUED_MS } from "./admit";
import { issueSpawn, type SpawnEnv } from "./spawn";
import type { DispatchDeps } from "./core";

export interface WaitOptions {
	/**
	 * The task ids this wait owns (a static set) — or a PROVIDER re-evaluated
	 * each tick: new ids join the owned set (the session-scoped watcher's
	 * scope — a dispatch that lands mid-wait is owned from the next tick,
	 * R2). The queued ones spawn as slots free; every one is polled to
	 * terminal.
	 */
	ids: string[] | (() => string[] | Promise<string[]>);
	/** The spawn shape (the compositor probe's decision, as in the entry; the per-task spec.mode wins for the actual spawn). */
	mode: "tile" | "headless";
	/** The dispatcher's own bun binary (a thunk; headless only — tile never resolves it). */
	bunBin: () => string;
	/** The lease identity refreshed on the in-scope unspawned tasks every tick (the freshness claim that keeps the queue live). */
	lease: { owner: string; nonce: string };
	/** The injectable deps (the entry's `DispatchDeps` shape — the loop's timing + the spawn transport). */
	deps?: DispatchDeps;
	/**
	 * Called after each state-poll pass, with every owned task's
	 * last-observed state — the session-scoped watcher's per-tick delivery
	 * hook (R3): a settlement visible in this pass is delivered in this
	 * tick. Awaiting it is part of the tick (before the stop check, before
	 * the sleep).
	 */
	onPass?: (tasks: PassTask[]) => Promise<void> | void;
	/**
	 * The external pending condition — the R2 stop condition's delivery
	 * clause: the loop stays alive (even with every owned task terminal) as
	 * long as this returns true (an undelivered settlement still due for a
	 * send, a failed send still inside its retry budget).
	 */
	pending?: () => boolean;
}

/** One owned task's last-observed state, as handed to `WaitOptions.onPass`. */
export interface PassTask {
	id: string;
	dir: string;
	spec: P.TaskSpec;
	/** The last-observed state (the attach read, or the latest poll). */
	state: P.TaskState;
	reason?: string;
}

export interface WaitedTaskState {
	id: string;
	/** The observed state (terminal when the wait completed normally; the last observed state when the stop signal flipped). */
	state: P.TaskState;
	reason?: string;
	/** True when THIS loop issued the spawn (a task in flight at attach — the caller's pass spawned it — is not counted). */
	spawned: boolean;
}

export interface WaitResult {
	states: WaitedTaskState[];
	/** True when the stop signal flipped — the loop returned the observed states; nothing was settled on abort. */
	aborted: boolean;
}

/**
 * Whether a spawn is in flight for this task — the disk record of the
 * caller's (the entry's pass) spawn: the `spawn-issued` event, still inside
 * the stuck window. A wait loop that attaches within the wrapper's boot
 * window sees the state still `queued` (the wrapper flips it on its own
 * first tick); the event is what keeps the loop from double-spawning it. A
 * spawn-issued OLDER than the window is a dead spawner (the wrapper booted
 * nowhere) — the loop re-spawns then. Wall clock: the event's timestamp is
 * wall time (`appendEvent` is real), so this check does not follow the
 * injectable `now` (which tests use to fast-forward the protocol predicates
 * — lease/age — that key on timestamps the caller writes).
 */
async function spawnInFlight(dir: string): Promise<boolean> {
	const events = await P.readEvents(dir).catch(() => null);
	if (events === null) return false;
	for (let i = events.length - 1; i >= 0; i--) {
		if (events[i].event !== "spawn-issued") continue;
		const ts = Date.parse(String(events[i].ts));
		return Number.isFinite(ts) && Date.now() - ts < STUCK_QUEUED_MS;
	}
	return false;
}

/**
 * Own the wait over a set of tasks: spawn the queued ones as slots free,
 * poll every one to terminal (or the stop signal). See the module header
 * for the per-tick order and the abort semantics.
 */
export async function waitForTasks(opts: WaitOptions): Promise<WaitResult> {
	const deps = opts.deps ?? {};
	const now = deps.now ?? Date.now;
	const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
	const tickMs = deps.tickMs ?? 1000;
	const mapWaitMs = deps.mapWaitMs ?? 2000;
	const mapWaitTickMs = deps.mapWaitTickMs ?? 200;
	const hyprctl = deps.hyprctl ?? defaultHyprctl();
	const cfg = C.readConfigSync();
	const cap = cfg.max_concurrent;
	const env: SpawnEnv = { mode: opts.mode, cfg, bunBin: opts.bunBin, hyprctl, sleep, now, mapWaitMs, mapWaitTickMs, panel: deps.panel };
	// a fresh read each time (TS would otherwise narrow the property across
	// the await and flag the second check)
	const signalAborted = (): boolean => deps.signal?.aborted === true;

	// The in-scope set (a vanished dir — a concurrent gc — is out of scope:
	// nothing to spawn or poll).
	interface Owned {
		id: string;
		dir: string;
		spec: P.TaskSpec;
		/** The spawn is issued (by this loop, or in flight at attach — the caller's pass spawned it and the wrapper has not flipped it off `queued` yet). */
		spawnIssued: boolean;
		/** True when THIS loop issued the spawn (the attach-time in-flight spawns were not issued by it). */
		spawned: boolean;
		seenState: P.TaskState;
		seenReason?: string;
	}
	const owned: Owned[] = [];
	const ownedIds = new Set<string>();
	const attach = async (id: string): Promise<void> => {
		if (ownedIds.has(id)) return;
		const dir = join(P.tasksRoot(), id);
		const st = await P.readState(dir).catch(() => null);
		if (st === null) return;
		const spec = await P.readSpec(dir).catch(() => null);
		if (spec === null) return;
		// a spawn in flight: the state already left `queued` (the wrapper
		// flipped it), or the spawn-issued event is fresh (the caller's pass
		// issued it within the wrapper's boot window) — never re-spawn it
		owned.push({ id, dir, spec, spawnIssued: st.state !== "queued" || (await spawnInFlight(dir)), spawned: false, seenState: st.state, seenReason: st.reason });
		ownedIds.add(id);
	};
	// a static set and a provider share the attach path — the provider is
	// re-evaluated every tick (the scope can grow mid-wait)
	const idsOpt = opts.ids;
	const idProvider: () => string[] | Promise<string[]> = typeof idsOpt === "function" ? idsOpt : () => idsOpt;
	for (const id of await idProvider()) await attach(id);

	let aborted = false;
	while (true) {
		if (signalAborted()) {
			aborted = true;
			break;
		}
		// A provider scope grows mid-wait (the session's watcher: a dispatch
		// that lands this tick is owned from this pass) — attach the new ids
		// before the pass so they take part in it (reconcile-exclusion, lease
		// refresh, admission).
		for (const id of await idProvider()) await attach(id);
		// Per-tick order: reconcile → count → spawn. The loop's own
		// unspawned tasks are the in-scope queue — excluded from the slot
		// count (they become holders once their spawn is issued) and from
		// reconciliation (a queue waiting on a full cap is not "stuck")
		const unspawned = owned.filter((o) => !o.spawnIssued && !P.isTerminal(o.seenState));
		const unspawnedDirs = new Set(unspawned.map((o) => o.dir));
		await reconcileAll(now(), unspawnedDirs);
		// Refresh this loop's lease for the unspawned in-scope tasks — the
		// claim that keeps a concurrent reconcile from settling them: a
		// live owner ticks (and thus refreshes); a dead one stops.
		for (const o of unspawned) {
			await P.writeLease(o.dir, { owner: opts.lease.owner, nonce: opts.lease.nonce, updated_at: new Date(now()).toISOString() }).catch(() => null);
		}
		let slots = countSlots(await nonTerminalTasks(new Set(unspawned.map((o) => o.id))), now());
		for (const o of unspawned) {
			if (slots >= cap) break;
			// check the abort signal BEFORE the spawn decision
			if (signalAborted()) {
				aborted = true;
				break;
			}
			// a live wrapper on a queued task = a spawn in flight (by this
			// loop's own previous tick, or by another owner) — never double-spawn;
			// the same guard holds for the caller's pass's in-flight spawns
			// (the spawn-issued event, the state may still be `queued`)
			const st = await P.readState(o.dir).catch(() => null);
			if (st === null || st.state !== "queued") continue;
			const live = await P.wrapperLiveness(o.dir, st);
			if (live.live) continue;
			if (await spawnInFlight(o.dir)) continue;
			// the per-task spawn shape (spec.mode — the task's own dispatch
			// planned it; a mixed-mode scope spawns each task its own way)
			await issueSpawn({ id: o.id, dir: o.dir, agentName: o.spec.agent.name, spec: o.spec }, { ...env, mode: o.spec.mode });
			// the spawn either issued (the state is running or will be; the
			// wrapper flips queued→running on its own tick) or settled
			// failed-to-spawn — re-observe either way
			const after = await P.readState(o.dir).catch(() => null);
			if (after !== null) {
				o.seenState = after.state;
				o.seenReason = after.reason;
			}
			o.spawnIssued = true;
			o.spawned = true;
			if (!P.isTerminal(o.seenState)) slots++;
		}
		if (aborted) break;

		// poll the in-scope states
		let allTerminal = true;
		for (const o of owned) {
			const st = await P.readState(o.dir).catch(() => null);
			// a failed read is NOT terminal evidence — keep waiting unless the
			// task was already observed terminal (the dir cannot reappear;
			// gc only removes settled tasks)
			if (st === null) {
				if (!P.isTerminal(o.seenState)) allTerminal = false;
				continue;
			}
			o.seenState = st.state;
			o.seenReason = st.reason;
			if (!P.isTerminal(st.state)) allTerminal = false;
		}
		// The per-tick delivery hook (R3): the pass's observed states, before
		// the stop check — a settlement visible in this pass is delivered in
		// this tick (the watcher's onPass: coalesced edge-triggered send).
		if (opts.onPass !== undefined && owned.length > 0) {
			await opts.onPass(owned.map((o) => ({ id: o.id, dir: o.dir, spec: o.spec, state: o.seenState, reason: o.seenReason })));
		}
		// Stop: every owned task is terminal AND nothing is pending outside the
		// loop (the delivery clause — a failed or still-due send keeps the loop
		// alive, R2).
		if (allTerminal && !(opts.pending?.() ?? false)) break;
		await sleep(tickMs);
	}

	return {
		states: owned.map((o) => ({ id: o.id, state: o.seenState, reason: o.seenReason, spawned: o.spawned })),
		aborted,
	};
}
