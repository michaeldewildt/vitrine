/**
 * reconcile.ts — the ordering-rule 2/3 reconciliation + the shared kill path.
 *
 * - `reconcileDeadWrapper` (ordering rule 2): a `running` task whose wrapper
 *   is dead — marker ⇒ `completed`; else SIGTERM the recorded `worker_pid`
 *   (start-time-checked) and record `crashed` unless a marker appeared.
 * - `reconcileStuckQueued` (ordering rule 3, dispatcher side): a `queued`
 *   task with no live wrapper past the 15 s window settles — a slot must
 *   never be held forever. The settle is gated on the owner lease: a task
 *   whose creating dispatch call is still ticking (fresh `lease.json`) is
 *   waiting on the cap, not stuck.
 * - `killTask`: the single kill path shared by the CLI and any
 *   external caller.
 *
 * The worker kill is injectable (`killWorker`); the default is SIGTERM with
 * ESRCH tolerated (the pid can die between check and kill — the start-time
 * check, not the kill, is the guard).
 */
import { appendEvent, assertTaskDir } from "./fs";
import { readSpec } from "./spec";
import { isTerminal, readState, transitionState, type TaskState } from "./state";
import { readLease } from "./files";
import { killRequested, readDoneMarker, requestKill } from "./files";
import { pidInfo, wrapperLiveness } from "./env";

const defaultKillWorker: (pid: number) => Promise<void> = async (pid) => {
	try {
		process.kill(pid, "SIGTERM");
	} catch (e: unknown) {
		if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
	}
};

// ---------------------------------------------------------------------------
// Ordering rule 2 — dead-wrapper reconcile

export interface ReconcileResult {
	dir: string;
	outcome: "completed" | "crashed" | "none" | "contested";
	/** The state.json state after the reconcile — the outcome's ground truth. */
	state: TaskState;
	workerKilled: boolean;
	reason: string;
}

export async function reconcileDeadWrapper(
	dir: string,
	deps: { killWorker?: (pid: number) => Promise<void> } = {},
): Promise<ReconcileResult> {
	const d = await assertTaskDir(dir);
	const killWorker = deps.killWorker ?? defaultKillWorker;
	const st = await readState(d);
	if (st.state !== "running") {
		return { dir: d, outcome: "none", state: st.state, workerKilled: false, reason: `state is ${st.state}, not running` };
	}
	const live = await wrapperLiveness(d, st);
	if (live.live) {
		return { dir: d, outcome: "none", state: st.state, workerKilled: false, reason: `${live.reason} — not a dead-wrapper case` };
	}

	// The settle: attempt the transition, and — if the state moved off `running`
	// between the read and the rename (a sibling reconcile, a concurrent settle)
	// — report the actual state as `contested` rather than asserting the intent.
	let workerKilled = false;
	const settle = async (to: "completed" | "crashed", reason: string): Promise<ReconcileResult> => {
		const t = await transitionState(d, "running", to, {}, reason);
		if (t.ok) return { dir: d, outcome: to, state: to, workerKilled, reason };
		const nowSt = await readState(d);
		return { dir: d, outcome: "contested", state: nowSt.state, workerKilled, reason: `contested: ${to} rejected (${t.code}); state is ${nowSt.state}` };
	};

	// Marker first: the worker settled before we noticed the dead wrapper.
	const markerBefore = await readDoneMarker(d);
	if (markerBefore !== null) return await settle("completed", `marker-wins (source=${markerBefore.source})`);

	if (st.worker_pid !== undefined) {
		const info = pidInfo(st.worker_pid);
		const startMatches = st.worker_pid_start !== undefined && info.startTime !== undefined && info.startTime === st.worker_pid_start;
		if (info.alive && startMatches) {
			await killWorker(st.worker_pid);
			await appendEvent(d, { event: "kill", source: "reconcile", pid: st.worker_pid });
			workerKilled = true;
		}
	}
	// Re-check the marker — the worker can complete between the read and the kill.
	const markerAfter = await readDoneMarker(d);
	if (markerAfter !== null) return await settle("completed", `marker-wins (source=${markerAfter.source})`);
	return await settle("crashed", "dead-wrapper");
}

// ---------------------------------------------------------------------------
// Ordering rule 3 — stuck-queued

export interface StuckQueuedResult {
	dir: string;
	/** `crashed`/`completed` when this call settled the task; `none` when it is not a stuck case (or a concurrent settle won). */
	settled: "crashed" | "completed" | "none";
	/** The state after the call — the ground truth for a `none`. */
	state: TaskState;
	reason: string;
}

/**
 * A task that was never given a wrapper (the dispatcher aborted
 * or died before spawning, or the tile never came up): `queued` with no
 * LIVE wrapper for longer than `minAgeMs` ⇒ `crashed` with reason
 * `never-spawned` — a queued task that holds a slot must never do so forever.
 * A `kill_requested` queued task settles `kill-requested` instead (the
 * human's explicit kill wins over the timeout label). A live wrapper pid
 * means a spawn is in flight — never touched. The marker wins even on
 * queued (ordering rule 1), lease or not. The owner lease gates the settle:
 * the creating dispatch call refreshes `lease.json` on every tick of its
 * wait loop, so a live owner's tasks are waiting on the cap, not stuck; a
 * dead owner's lease goes stale and the task settles.
 */
export async function reconcileStuckQueued(
	dir: string,
	opts: { now?: number; minAgeMs?: number; leaseTtlMs?: number } = {},
): Promise<StuckQueuedResult> {
	const d = await assertTaskDir(dir);
	const minAgeMs = opts.minAgeMs ?? 15_000;
	const leaseTtlMs = opts.leaseTtlMs ?? 30_000;
	const now = opts.now ?? Date.now();
	const st = await readState(d);
	if (st.state !== "queued") return { dir: d, settled: "none", state: st.state, reason: `state is ${st.state}, not queued` };
	const live = await wrapperLiveness(d, st);
	if (live.live) {
		return { dir: d, settled: "none", state: st.state, reason: `${live.reason} — spawn in flight` };
	}
	const spec = await readSpec(d);
	const age = now - Date.parse(spec.created_at);
	if (!Number.isFinite(age) || age < minAgeMs) {
		return { dir: d, settled: "none", state: st.state, reason: `younger than the ${minAgeMs}ms stuck window` };
	}
	// Ordering rule 1 first — the marker wins even on queued, lease or not:
	// a completed result must not be held back by a fresh owner lease.
	const marker = await readDoneMarker(d).catch(() => null);
	if (marker === null) {
		// The owner lease (the cross-call gate): a queued task whose creating
		// dispatch call is still ticking is waiting on the cap, not stuck —
		// the owner refreshes lease.json every tick of its wait loop, and a
		// dead owner (crash, reboot, abort) stops refreshing. A lease-read
		// failure is treated as absent (settle), mirroring killRequested:
		// the CAS below is the final guard either way.
		const lease = await readLease(d).catch(() => null);
		if (lease !== null) {
			const leaseAge = now - Date.parse(lease.updated_at);
			if (Number.isFinite(leaseAge) && leaseAge < leaseTtlMs) {
				return { dir: d, settled: "none", state: st.state, reason: `owner lease fresh (${Math.round(leaseAge)}ms < ${leaseTtlMs}ms TTL) — waiting on the cap, not stuck` };
			}
		}
	}
	// The marker wins even on queued (rule 1): a wrapper that died mid-spawn can
	// still have the worker's done-marker land. A single settle call covers
	// both cases — with a marker present (at decision or CAS time) the
	// transitionState remap maps the requested `crashed` to `completed`.
	const killed = await killRequested(d).catch(() => false);
	const reason = killed ? "kill-requested" : "never-spawned";
	const t = await transitionState(d, "queued", "crashed", {}, reason);
	if (t.ok) {
		const final = await readState(d);
		return { dir: d, settled: final.state === "completed" ? "completed" : "crashed", state: final.state, reason: final.reason ?? reason };
	}
	return { dir: d, settled: "none", state: (await readState(d)).state, reason: `settle contested (${t.code})` };
}

// ---------------------------------------------------------------------------
// kill

export interface KillTaskResult {
	dir: string;
	/**
	 * `settled` — a `queued` task was settled `crashed`/`kill-requested` now;
	 * `requested` — `kill_requested` written (the live wrapper observes it and
	 * records `killed`); `reconciled` — the wrapper was already dead, ordering
	 * rule 2 ran; `none` — already terminal (no-op report).
	 */
	action: "settled" | "requested" | "reconciled" | "none";
	state: TaskState;
	workerSignalled: boolean;
	reason: string;
}

/**
 * `vitrine kill <task_id>`. Queued ⇒ settle `crashed`/
 * `kill-requested` NOW (a queued task has no worker to signal; waiting out
 * the 15 s stuck window would mislabel the human's explicit kill as
 * `never-spawned`). Running with a live wrapper ⇒ write `kill_requested`
 * (the wrapper observes it each tick and records `killed`) AND SIGTERM the
 * recorded `worker_pid` after the start-time check (a hint that speeds the
 * wrapper's own kill path — the wrapper's in-process `live()` gate remains
 * the authority on its own child). Running with a dead wrapper ⇒ ordering
 * rule 2 (else the kill is recorded nowhere). Terminal ⇒ no-op report.
 */
export async function killTask(
	dir: string,
	deps: { killWorker?: (pid: number) => Promise<void> } = {},
): Promise<KillTaskResult> {
	const d = await assertTaskDir(dir);
	const st = await readState(d);
	if (isTerminal(st.state)) return { dir: d, action: "none", state: st.state, workerSignalled: false, reason: `state is ${st.state}, already terminal` };
	if (st.state === "queued") {
		const t = await transitionState(d, "queued", "crashed", {}, "kill-requested");
		if (t.ok) return { dir: d, action: "settled", state: "crashed", workerSignalled: false, reason: "kill-requested" };
		// The state moved (a wrapper grabbed the task between read and write) —
		// fall through and kill the now-running task.
		const moved = await readState(d);
		if (isTerminal(moved.state)) return { dir: d, action: "none", state: moved.state, workerSignalled: false, reason: `state moved to ${moved.state}` };
	}
	const cur = st.state === "queued" ? await readState(d) : st;
	if (cur.state === "running") {
		// anti-recycling liveness (the invariant: a live pid alone is not the
		// wrapper — start-time + boot_id qualify it). A pid recycled after
		// reboot, or a stale small pid, must fall through to rule 2, not be
		// treated as a live wrapper we ask to kill.
		const live = await wrapperLiveness(d, cur);
		if (!live.live) {
			const r = await reconcileDeadWrapper(d, deps);
			return {
				dir: d,
				action: "reconciled",
				state: r.state,
				workerSignalled: r.workerKilled,
				reason: `dead wrapper (rule 2: ${r.reason}) — ${live.reason}`,
			};
		}
		await requestKill(d);
		let workerSignalled = false;
		if (cur.worker_pid !== undefined) {
			const info = pidInfo(cur.worker_pid);
			const startMatches =
				cur.worker_pid_start !== undefined && info.startTime !== undefined && info.startTime === cur.worker_pid_start;
			if (info.alive && startMatches) {
				const killWorker = deps.killWorker ?? defaultKillWorker;
				await killWorker(cur.worker_pid);
				await appendEvent(d, { event: "kill", source: "kill-task", pid: cur.worker_pid });
				workerSignalled = true;
			}
		}
		return { dir: d, action: "requested", state: "running", workerSignalled, reason: "kill_requested written; the wrapper records killed" };
	}
	return { dir: d, action: "none", state: cur.state, workerSignalled: false, reason: `state is ${cur.state}` };
}
