/**
 * core.ts — the dispatch core: the tool-call surface (types +
 * `DispatchError`), `dispatchTasks` (validate → reconcile → admit →
 * resolve/create → spawn+wait → results + deferred harvest → the report),
 * and the model-facing report renderer.
 *
 * The collaborators live beside it: `spawn.ts` (the tile argv + the join
 * juggle + the headless bun resolution + the formatting pieces), `harvest.ts`
 * (the result harvest + the deferred-harvest registry), `admit.ts` (the
 * liveness-qualified slot count + reconciliation).
 */
import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import * as P from "../protocol";
import * as C from "../config";
import { listAgentSummaries, resolveAgent } from "../agents";
import { defaultHyprctl, type HyprctlResult } from "../hyprctl";
import { formatElapsed, promptHeader, shortId, spawnTileWithJoin, tileSpawnArgv } from "./spawn";
import type { PanelDeps } from "./panel";
import { harvestTask, pendingDispatchedIds, registryAdd, registryRemove, type Harvest } from "./harvest";
import { countSlots, nonTerminalTasks, reconcileAll } from "./admit";

// ---------------------------------------------------------------------------
// the surface

/** One task in the tool call ("The surface"). */
export interface DispatchTaskInput {
	/** Required — exact agent name. */
	agent: string;
	/** Required — the mission, verbatim. */
	task: string;
	/** Optional — default: the dispatcher's cwd. */
	cwd?: string;
	/** Optional — override; default chain: agent frontmatter → dispatcher model. */
	model?: string;
	/** Optional — thinking-level override (pi `--thinking`); default chain: agent frontmatter → pi default. */
	thinking?: string;
	/** Optional — continue from a previous task's session (source guard: terminal + session.json). */
	from?: string;
	/** Optional (rare) — `"parent"` seeds from the dispatcher's session. `from` + `context` is rejected. */
	context?: "parent";
	/** Optional — this tile is the human's workspace (auto-settle suppressed). */
	attended?: boolean;
	/** Optional — wall-clock seconds; default: config `wall_timeout_s`. */
	timeout?: number;
	/** Optional — watchdog idle seconds; default: agent frontmatter → config `inactivity_s`. */
	inactivity?: number;
	/** Optional — max total session cost (USD); the watchdog settles the task at the budget (reason `cost`). No default — unset means no cost budget. */
	max_cost_usd?: number;
}

/** The dispatcher's self-knowledge (probed: sessionManager + ctx fields). */
export interface DispatcherInfo {
	/** `ctx.sessionManager.getSessionId()`. */
	sessionId: string;
	/** `ctx.sessionManager.getSessionFile()`. */
	sessionFile: string;
	/** `ctx.model` (nullable). */
	model: string | null;
	/** `ctx.cwd`. */
	cwd: string;
	/** `ctx.isProjectTrusted` — gates project-local agent lookup. */
	projectTrusted: boolean;
}

export interface DispatchDeps {
	/** Injectable hyprctl (default: execFile, 5 s timeout). */
	hyprctl?: (args: string[]) => Promise<HyprctlResult>;
	/** Clock (default `Date.now`). */
	now?: () => number;
	/** Sleep (default `setTimeout`). */
	sleep?: (ms: number) => Promise<void>;
	/** Poll tick (default 1000 ms, Waiting). */
	tickMs?: number;
	/** Join-juggle map-wait budget (default 2000 ms, Spawn). */
	mapWaitMs?: number;
	/** Join-juggle map-wait tick (default 200 ms). */
	mapWaitTickMs?: number;
	/** Main-agent panel discovery (defaults: walk up from `process.ppid`
	 *  through `/proc` — `panel.ts`; production value, inject for tests). */
	panel?: PanelDeps;
	/** The extension's AbortSignal (probed: it flips on turn abort). */
	signal?: AbortSignal;
	/** Progress sink (the extension's `onUpdate`). */
	onUpdate?: (progress: string) => void;
	/** Model-facing result cap, bytes (default 50 KB). */
	maxResultBytes?: number;
	/** Model-facing result cap, lines (default 2000). */
	maxResultLines?: number;
	/** Overflow-file root (default `os.tmpdir()`). */
	tmpDir?: string;
}

export const MAX_TASKS_PER_CALL = 8;

export class DispatchError extends P.ProtocolError {
	constructor(code: "bad-input" | "no-compositor" | "bad-agent" | "bad-config", message: string) {
		super(code, message);
		this.name = "DispatchError";
	}
}

export interface DispatchOptions {
	/** 1–8 tasks. */
	tasks: DispatchTaskInput[];
	/** The spawn shape — decided by the compositor probe (tile if reachable, headless otherwise; never the reverse). */
	mode: "tile" | "headless";
	dispatcher: DispatcherInfo;
	/** The dispatcher's own bun binary (absolute). A THUNK: resolved lazily at the first headless spawn — tile mode never evaluates it (the tile needs a direct executable — the installed exec-wrapper carries its own absolute bun path — and the compositor's `sh -c` layer cannot be trusted to resolve `bun` from a shell-init PATH), so a headless box with a broken bun PATH still tiles fine. */
	bunBin: () => string;
	bootId?: string;
	deps?: DispatchDeps;
}

export interface DispatchedTaskResult {
	id: string;
	agent: string;
	state: P.TaskState;
	reason?: string;
	/** Elapsed ms (created_at → finished_at, or the abort time). */
	elapsedMs: number;
	/** The harvested text (capped). */
	result?: string;
	/** True for killed/crashed/timeout/failed — the partial is labelled as such. */
	partial?: boolean;
	/** The 0600 overflow file (the capped result names it). */
	overflowFile?: string;
	/** True when this call queued the item and it ran after a slot freed. */
	queuedThisCall?: boolean;
	/** True when adopted (live at admission, not dispatched this call). */
	adopted?: boolean;
	/** True when settled `never-spawned` (abort path or the 15 s rule). */
	neverSpawned?: boolean;
	/** `vitrine.<id>` — the session handle. */
	sessionId: string;
}

export interface DispatchReport {
	mode: "tile" | "headless";
	dispatched: number;
	results: DispatchedTaskResult[];
	/** Items queued within the call (overflow past the cap). */
	queuedThisCall: number;
	/** Adopted live tasks (reported in the header). */
	adopted: DispatchedTaskResult[];
	/** Deferred harvests (non-terminal at admission, terminal now). */
	deferred: DispatchedTaskResult[];
	aborted: boolean;
	/** The model-facing text (result shape). */
	text: string;
}

// ---------------------------------------------------------------------------
// the dispatch core

interface PlannedTask {
	input: DispatchTaskInput;
	id: string;
	dir: string;
	spec: P.TaskSpec;
	agentName: string;
	queuedThisCall: boolean;
	spawnIssued: boolean;
	seenState: P.TaskState;
	seenReason?: string;
	elapsedFrom: string;
}

/**
 * The dispatch core. Validates + creates the task dirs, admits against the
 * liveness-qualified slot cap, spawns (tile: hyprctl argv; headless:
 * detached wrapper spawn), then polls until every admitted+queued task is
 * terminal (or the abort signal fires). Returns the model-facing report.
 */
export async function dispatchTasks(opts: DispatchOptions): Promise<DispatchReport> {
	const deps = opts.deps ?? {};
	const now = deps.now ?? Date.now;
	const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
	const tickMs = deps.tickMs ?? 1000;
	const mapWaitMs = deps.mapWaitMs ?? 2000;
	const mapWaitTickMs = deps.mapWaitTickMs ?? 200;
	const hyprctl = deps.hyprctl ?? defaultHyprctl();
	const bootId = opts.bootId ?? P.currentBootId();
	const info = opts.dispatcher;

	// ---- validate the surface ------------------------------------------------
	if (!Array.isArray(opts.tasks) || opts.tasks.length < 1 || opts.tasks.length > MAX_TASKS_PER_CALL) {
		throw new DispatchError("bad-input", `tasks: 1–${MAX_TASKS_PER_CALL} per invocation (got ${Array.isArray(opts.tasks) ? opts.tasks.length : "?"})`);
	}
	for (const t of opts.tasks) {
		if (typeof t.agent !== "string" || t.agent === "") throw new DispatchError("bad-input", "each task needs a non-empty 'agent'");
		if (typeof t.task !== "string" || t.task === "") throw new DispatchError("bad-input", "each task needs a non-empty 'task'");
		if (t.from !== undefined && t.context !== undefined) {
			throw new DispatchError("bad-input", `task for agent '${t.agent}': 'from' + 'context' cannot be combined`);
		}
		if (t.cwd !== undefined && !isAbsolute(t.cwd)) throw new DispatchError("bad-input", `'cwd' must be an absolute path (got '${t.cwd}')`);
		if (t.timeout !== undefined && (typeof t.timeout !== "number" || t.timeout <= 0)) throw new DispatchError("bad-input", "'timeout' must be a positive number of seconds");
		if (t.inactivity !== undefined && (typeof t.inactivity !== "number" || t.inactivity <= 0)) throw new DispatchError("bad-input", "'inactivity' must be a positive number of seconds");
		if (t.max_cost_usd !== undefined && (typeof t.max_cost_usd !== "number" || t.max_cost_usd <= 0)) throw new DispatchError("bad-input", "'max_cost_usd' must be a positive number of USD");
	}

	const cfg = C.readConfigSync();
	// Per-call lease identity (one session can have concurrent dispatch calls —
	// the lease claim is per-call, so each call owns only its own tasks).
	const callNonce = P.newTaskId();

	// ---- reconcile first (before admission) -------------------------
	await reconcileAll(now());

	// ---- admission: liveness-qualified slot count ------------------
	const slotsBefore = countSlots(await nonTerminalTasks(), now());
	const cap = cfg.max_concurrent;
	const admittedCount = Math.max(0, Math.min(cap - slotsBefore, opts.tasks.length));

	// ---- resolve agents + guards, create task dirs ---------------------------
	const planned: PlannedTask[] = [];
	const adopted: DispatchedTaskResult[] = [];
	const deferred: DispatchedTaskResult[] = [];

	// Adopt + deferred harvest: non-terminal tasks from other calls, and
	// registry ids this session dispatched but never saw terminal.
	const foreignDirs = await P.listTaskDirs();
	const foreignQueued: Array<{ id: string; agent: string; sessionId: string; createdAt?: string }> = [];
	const adoptedMeta = new Map<string, { createdAt?: string }>();
	for (const dir of foreignDirs) {
		const st = await P.readState(dir).catch(() => null);
		if (st === null) continue;
		const id = P.taskIdOf(dir);
		if (st.state === "running") {
			const live = await P.wrapperLiveness(dir, st);
			if (live.live) {
				// adopt (reported in the result header)
				const spec = await P.readSpec(dir).catch(() => null);
				adoptedMeta.set(id, { createdAt: spec?.created_at });
				adopted.push({
					id,
					agent: spec?.agent.name ?? "?",
					state: "running",
					elapsedMs: st.started_at !== undefined ? now() - Date.parse(st.started_at) : 0,
					sessionId: spec?.session_id ?? "vitrine.?",
					adopted: true,
				});
			}
		} else if (st.state === "queued") {
			// another call's in-flight queue (its dispatcher may not have
			// spawned it yet): snapshot it for the post-loop deferred harvest
			// (a foreign queued task that goes terminal while this
			// call waits gets its result here; the registry covers only the
			// same session, this covers cross-session)
			const spec = await P.readSpec(dir).catch(() => null);
			foreignQueued.push({ id, agent: spec?.agent.name ?? "?", sessionId: spec?.session_id ?? "vitrine.?", createdAt: spec?.created_at });
		}
	}
	// deferred harvest: registry ids that are terminal now
	for (const id of pendingDispatchedIds(info.sessionId)) {
		const dir = join(P.tasksRoot(), id);
		const st = await P.readState(dir).catch(() => null);
		if (st === null) {
			// the dir is gone (gc'd, or removed externally): nothing to harvest,
			// and the id can never become harvestable — drop the registry entry
			// or it would linger for the life of the session (and the next call
			// would re-check the same vanished dir, forever)
			registryRemove(info.sessionId, id);
			continue;
		}
		if (P.isTerminal(st.state)) {
			const spec = await P.readSpec(dir).catch(() => null);
			const h = await harvestTask(dir, st.state, deps);
			deferred.push({
				id,
				agent: spec?.agent.name ?? "?",
				state: st.state,
				reason: st.reason,
				elapsedMs: st.finished_at !== undefined && spec?.created_at ? Date.parse(st.finished_at) - Date.parse(spec.created_at) : 0,
				result: h.text,
				partial: h.partial,
				overflowFile: h.overflowFile,
				sessionId: spec?.session_id ?? `vitrine.${id}`,
			});
			registryRemove(info.sessionId, id);
		}
	}

	for (let i = 0; i < opts.tasks.length; i++) {
		const input = opts.tasks[i];
		const id = P.newTaskId();
		const dir = join(P.tasksRoot(), id);

		// agent resolution (trust-gated) — unknown-agent lists the live roster (name + one-line description)
		const agent = await resolveAgent(input.agent, { projectAllowed: info.projectTrusted, cwd: info.cwd }).catch((e: unknown) => {
			// the available-agents listing is for the UNKNOWN-agent case.
			// The invalid-name and body-read cases keep their own precise message —
			// wrapping them as "unknown agent" would misreport a valid-but-missing
			// body or a malformed name.
			const msg = e instanceof P.ProtocolError ? e.message : "";
			const unknown = e instanceof P.ProtocolError && e.code === "bad-agent" && msg.startsWith("no agent file for");
			if (!unknown && e instanceof P.ProtocolError) throw e;
			// the full live roster (project shadows global — the same layering
			// resolveAgent just tried): each agent as "name: first sentence"
			const summaries = listAgentSummaries({ projectAllowed: info.projectTrusted, cwd: info.cwd });
			throw new DispatchError(
				"bad-agent",
				`unknown agent '${input.agent}' (available: ${summaries.length > 0 ? summaries.map((s) => `${s.name}: ${s.line}`).join("; ") : "none"})`,
			);
		});

		// admission
		const queuedThisCall = i >= admittedCount;

		// from-guard (source guard: terminal state + session.json present)
		let fromTaskId: string | undefined;
		let fromSessionFile: string | undefined;
		if (input.from !== undefined) {
			const srcId = input.from;
			const srcDir = join(P.tasksRoot(), srcId);
			const srcState = await P.readState(srcDir).catch((e: NodeJS.ErrnoException) => {
				if (e.code === "ENOENT") throw new DispatchError("bad-input", `'from' task ${srcId} does not exist`);
				throw e;
			});
			if (!P.isTerminal(srcState.state)) {
				throw new DispatchError("bad-input", `'from' source ${srcId} is ${srcState.state} — only terminal tasks may be forked (a live session has one writer)`);
			}
			// the source guard: terminal state + session.json present
			await P.readSession(srcDir).catch(() => {
				throw new DispatchError("bad-input", `'from' source ${srcId} has no session.json — its session was never recorded`);
			});
			fromTaskId = srcId;
		} else if (input.context === "parent") {
			fromSessionFile = info.sessionFile;
			await stat(info.sessionFile).catch(() => {
				throw new DispatchError("bad-input", "'context: parent' but the dispatcher's session file is missing");
			});
		}

		// model chain: per-call > agent frontmatter > dispatcher model
		// thinking chain: per-call > agent frontmatter > pi default (flag omitted)
		const model = input.model ?? agent.frontmatter.model ?? info.model ?? undefined;
		const thinking = input.thinking ?? agent.frontmatter.thinking;
		const tools = agent.frontmatter.noTools === true ? [] : agent.frontmatter.tools;
		const inactivityS = input.inactivity ?? agent.frontmatter.inactivityTimeout ?? cfg.inactivity_s;
		const wallTimeoutS = input.timeout ?? cfg.wall_timeout_s;
		const maxCostUsd = input.max_cost_usd;
		const cwd = input.cwd ?? info.cwd;

		const spec: P.TaskSpec = {
			task_id: id,
			agent: {
				name: agent.name,
				body: agent.body,
				model,
				thinking,
				tools,
				inactivityTimeout: agent.frontmatter.inactivityTimeout,
			},
			dispatcher_session_id: info.sessionId,
			cwd,
			session_id: `vitrine.${id}`,
			session_name: `${agent.name} · ${shortId(id)}`,
			mode: opts.mode,
			attended: input.attended === true,
			workspace: cfg.workspace,
			wall_timeout_s: wallTimeoutS,
			inactivity_s: inactivityS,
			max_cost_usd: maxCostUsd,
			auto_settle_s: cfg.auto_settle_s,
			auto_settle_grace_s: cfg.auto_settle_grace_s,
			completed_close_s: cfg.completed_close_s,
			from_task_id: fromTaskId,
			from_session_file: fromSessionFile,
			created_at: new Date(now()).toISOString(),
			boot_id: bootId,
		};
		const prompt = `${promptHeader({ taskId: id, agent: agent.name, dispatcherSessionId: info.sessionId, cwd, fromTaskId })}\n${input.task}`;
		await P.createTask(dir, spec, prompt);
		// the owner claim (the stuck-queued gate): this call owns the lease
		// from creation until the spawn is issued — refreshed every tick
		await P.writeLease(dir, { owner: info.sessionId, nonce: callNonce, updated_at: new Date(now()).toISOString() });
		registryAdd(info.sessionId, [id]);

		planned.push({
			input,
			id,
			dir,
			spec,
			agentName: agent.name,
			queuedThisCall,
			spawnIssued: false,
			seenState: "queued",
			elapsedFrom: spec.created_at,
		});
	}

	// ---- spawn + wait loop ----------------------------------------------------
	// Per-tick order: reconcile → count → spawn → poll.
	const spawnOne = async (p: PlannedTask): Promise<void> => {
		// a spawn-command failure settles the task crashed/failed-to-spawn
		// IMMEDIATELY in-call (no waiting out the 15 s window for a task that
		// is known not to have launched).
		const doSpawn = async (): Promise<boolean> => {
			try {
				if (opts.mode === "tile") {
					// Window routing + grouping (main-agent group): a static
					// Hyprland window rule keyed on app-id `vitrine-worker` opens the
					// tile on the CURRENT workspace with `group = "set"` — the
					// dispatcher places nothing. The main-agent join juggle finds the
					// dispatcher's own panel (the window of the pi process running this
					// tool), makes it a group if it isn't one (right before this spawn),
					// focuses its group so the tile joins it at map time, then restores
					// the user's focus after the map. Fail-soft: a juggle failure
					// degrades to the tile opening as its own group; only the spawn
					// itself settles failed-to-spawn.
					// Tile mode needs a direct executable and never uses the bun
					// binary, so the `bunBin` thunk is NOT evaluated here (a broken
					// headless-box bun PATH must not break tiling).
					const runPath = C.resolveRunPath(cfg, "tile");
					const argv = tileSpawnArgv(p.agentName, p.id, runPath, p.dir);
					const { spawnOk } = await spawnTileWithJoin(
						async () => (await hyprctl(argv)).code === 0,
						{ hyprctl, sleep, now, mapWaitMs, mapWaitTickMs, panel: deps.panel },
					);
					return spawnOk;
				}
				const runPath = C.resolveRunPath(cfg, "headless", opts.bunBin());
				const child = spawn(runPath.command, [...runPath.args, p.dir], {
					cwd: p.spec.cwd,
					env: { ...process.env, ...C.wrapperRootEnv(cfg) },
					detached: true,
					stdio: "ignore",
				});
				child.unref();
				return true;
			} catch (e: unknown) {
				await P.appendEvent(p.dir, { event: "spawn-failed", source: "dispatch", error: String(e) });
				return false;
			}
		};
		const ok = await doSpawn();
		p.spawnIssued = true;
		if (!ok) {
			await P.transitionState(p.dir, "queued", "crashed", {}, "failed-to-spawn").catch(() => null);
			p.seenState = "crashed";
			p.seenReason = "failed-to-spawn";
			await P.appendEvent(p.dir, { event: "failed-to-spawn", source: "dispatch" });
		}
	};

	let aborted = false;
	let lastProgressAt = 0;
	// a fresh read each time (TS would otherwise narrow the property across
	// the await and flag the second check)
	const signalAborted = (): boolean => deps.signal?.aborted === true;

	while (true) {
		if (signalAborted()) {
			aborted = true;
			break;
		}
		// the call's own unspawned tasks are the in-call queue — excluded from
		// the slot count (they become holders once their spawn is issued) and
		// from reconciliation (a queue waiting on a full cap is not "stuck")
		const notSpawned = new Set(planned.filter((p) => !p.spawnIssued).map((p) => p.id));
		const notSpawnedDirs = new Set(planned.filter((p) => !p.spawnIssued).map((p) => p.dir));
		// reconcile → count → spawn
		await reconcileAll(now(), notSpawnedDirs);
		// Refresh this call's leases for its own unspawned tasks — the claim
		// that keeps a concurrent dispatch's reconcile from settling them:
		// a live owner ticks (and thus refreshes); a dead one stops.
		for (const dir of notSpawnedDirs) {
			await P.writeLease(dir, { owner: info.sessionId, nonce: callNonce, updated_at: new Date(now()).toISOString() }).catch(() => null);
		}
		let slots = countSlots(await nonTerminalTasks(notSpawned), now());
		for (const p of planned) {
			if (p.spawnIssued) continue;
			if (P.isTerminal(p.seenState)) continue;
			if (slots >= cap) break;
			// check the abort signal BEFORE the spawn decision
			if (signalAborted()) {
				aborted = true;
				break;
			}
			await spawnOne(p);
			if (!P.isTerminal(p.seenState)) slots++;
		}
		if (aborted) break;

		// poll the states we own
		let allTerminal = true;
		for (const p of planned) {
			const st = await P.readState(p.dir).catch(() => null);
			// a failed read is NOT terminal evidence — keep waiting unless the
			// task was already observed terminal (the dir cannot reappear;
			// gc only removes settled tasks, and a vanished mid-call dir is
			// the concurrent-gc case the harvest labels)
			if (st === null) {
				if (!P.isTerminal(p.seenState)) allTerminal = false;
				continue;
			}
			if (st.state !== p.seenState || st.reason !== undefined && st.reason !== p.seenReason) {
				p.seenState = st.state;
				p.seenReason = st.reason;
				if (P.isTerminal(st.state)) registryRemove(info.sessionId, p.id);
			}
			if (!P.isTerminal(st.state)) allTerminal = false;
		}
		if (allTerminal) break;

		// progress (throttled to the tick)
		const t0 = now();
		if (t0 - lastProgressAt >= tickMs / 2) {
			lastProgressAt = t0;
			const lines = planned.map((p, i) => {
				const age = formatElapsed(t0 - Date.parse(p.elapsedFrom));
				return `[${i + 1}/${planned.length}] ${p.agentName} · ${shortId(p.id)} — ${p.seenState} (${age})${p.seenReason !== undefined ? ` ${p.seenReason}` : ""}`;
			});
			deps.onUpdate?.(lines.join("\n"));
		}
		await sleep(tickMs);
	}

	// ---- abort path (unspawned ⇒ never-spawned now) ------------------
	if (aborted) {
		for (const p of planned) {
			if (!p.spawnIssued && p.seenState === "queued") {
				await P.transitionState(p.dir, "queued", "crashed", {}, "never-spawned").catch(() => null);
				p.seenState = "crashed";
				p.seenReason = "never-spawned";
			}
		}
	}

	// ---- results ----------------------------------------------------------------
	const results: DispatchedTaskResult[] = [];
	for (const p of planned) {
		const st = await P.readState(p.dir).catch(() => null);
		const state = st !== null ? st.state : p.seenState;
		const reason = st?.reason ?? p.seenReason;
		const finishedAt = st?.finished_at ?? (aborted ? new Date(now()).toISOString() : undefined);
		const elapsedMs = finishedAt !== undefined ? Date.parse(finishedAt) - Date.parse(p.elapsedFrom) : now() - Date.parse(p.elapsedFrom);
		const h: Harvest | null = P.isTerminal(state) ? await harvestTask(p.dir, state, deps) : null;
		results.push({
			id: p.id,
			agent: p.agentName,
			state,
			reason,
			elapsedMs,
			result: h?.text,
			partial: h?.partial || undefined,
			overflowFile: h?.overflowFile,
			queuedThisCall: p.queuedThisCall || undefined,
			neverSpawned: reason === "never-spawned" ? true : undefined,
			sessionId: p.spec.session_id,
		});
	}

	// deferred harvest (the adopted branch): an adopted task that went
	// terminal while this call waited gets its result now — this is how results
	// come back after the dispatcher was aborted, restarted, or rebooted.
	const deferredIds = new Set(deferred.map((d) => d.id));
	for (const a of adopted) {
		const dir = join(P.tasksRoot(), a.id);
		const st = await P.readState(dir).catch(() => null);
		if (st === null || !P.isTerminal(st.state)) continue;
		const h = await harvestTask(dir, st.state, deps);
		deferredIds.add(a.id);
		// fresh elapsed (finished_at − created_at) — the admission-time value
		// is stale by definition (the task ran for the whole wait)
		const createdAt = adoptedMeta.get(a.id)?.createdAt;
		deferred.push({
			id: a.id,
			agent: a.agent,
			state: st.state,
			reason: st.reason,
			elapsedMs: createdAt !== undefined && st.finished_at !== undefined ? Date.parse(st.finished_at) - Date.parse(createdAt) : a.elapsedMs,
			result: h.text,
			partial: h.partial || undefined,
			overflowFile: h.overflowFile,
			sessionId: a.sessionId,
			adopted: true,
		});
	}
	// deferred harvest (foreign queued): cross-session queued tasks that
	// went terminal while this call waited
	for (const f of foreignQueued) {
		if (deferredIds.has(f.id)) continue;
		const dir = join(P.tasksRoot(), f.id);
		const st = await P.readState(dir).catch(() => null);
		if (st === null || !P.isTerminal(st.state)) continue;
		const h = await harvestTask(dir, st.state, deps);
		deferredIds.add(f.id);
		deferred.push({
			id: f.id,
			agent: f.agent,
			state: st.state,
			reason: st.reason,
			elapsedMs: f.createdAt !== undefined && st.finished_at !== undefined ? Date.parse(st.finished_at) - Date.parse(f.createdAt) : 0,
			result: h.text,
			partial: h.partial || undefined,
			overflowFile: h.overflowFile,
			sessionId: f.sessionId,
			adopted: true,
		});
	}

	const text = renderReport({ mode: opts.mode, dispatched: results.length, results, queuedThisCall: results.filter((r) => r.queuedThisCall).length, adopted, deferred, aborted });
	return { mode: opts.mode, dispatched: results.length, results, queuedThisCall: results.filter((r) => r.queuedThisCall).length, adopted, deferred, aborted, text };
}

// ---------------------------------------------------------------------------
// the result format (Results — compact; exact wording is an
// implementation detail, but the named test pins this shape)

interface RenderReport {
	mode: "tile" | "headless";
	dispatched: number;
	results: DispatchedTaskResult[];
	queuedThisCall: number;
	adopted: DispatchedTaskResult[];
	deferred: DispatchedTaskResult[];
	aborted: boolean;
}

const PARTIAL_STATES: ReadonlySet<P.TaskState> = new Set(["killed", "crashed", "timeout", "failed"]);

export function renderReport(r: RenderReport): string {
	const out: string[] = [];
	const succeeded = r.results.filter((x) => x.state === "completed").length;
	// on abort, the still-running tasks are not failures — they keep running
	// under their wrappers; count them separately
	const stillRunning = r.aborted ? r.results.filter((x) => !P.isTerminal(x.state)).length : 0;
	const failed = r.results.length - succeeded - stillRunning;
	out.push(`${r.dispatched} dispatched · ${succeeded} succeeded, ${failed} failed${stillRunning > 0 ? `, ${stillRunning} still running` : ""}${r.aborted ? " · ABORTED (workers keep running)" : ""}`);
	if (r.adopted.length > 0) {
		out.push("");
		out.push(`running from an earlier call: ${r.adopted.map((a) => `${a.agent} · ${shortId(a.id)}`).join("; ")}`);
	}
	out.push("");
	r.results.forEach((res, i) => {
		const head = `[${i + 1}] ${res.agent} · ${shortId(res.id)} — ${res.state} (${formatElapsed(res.elapsedMs)})${res.reason !== undefined && res.reason !== "" ? ` (${res.reason})` : ""}${PARTIAL_STATES.has(res.state) ? " — partial" : ""}`;
		out.push(head);
		const body = res.result !== undefined ? res.result : res.state === "completed" ? "(no result content)" : "(not harvested)";
		for (const line of body.split("\n")) out.push(line === "" ? "    " : `    ${line}`);
		out.push(`    session ${res.sessionId}`);
	});
	if (r.deferred.length > 0) {
		out.push("");
		out.push(`deferred harvest (terminal since the last call):`);
		for (const d of r.deferred) {
			out.push(`  ${d.agent} · ${shortId(d.id)} — ${d.state}${d.partial ? " — partial" : ""}`);
			if (d.result !== undefined) {
				for (const line of d.result.split("\n")) out.push(line === "" ? "      " : `      ${line}`);
			}
		}
	}
	if (r.queuedThisCall > 0) {
		out.push("");
		out.push(
			`${r.queuedThisCall} queued this call, ran after slot freed: ${r.results
				.filter((x) => x.queuedThisCall)
				.map((x) => `${x.agent} · ${shortId(x.id)} — ${x.state}`)
				.join("; ")}`,
		);
	}
	return out.join("\n");
}
