/**
 * core.ts — the dispatch core: the tool-call surface (types +
 * `DispatchError`), `dispatchTasks` (validate → reconcile → admit →
 * resolve/create → the one-shot spawn pass → the R1 report), and the
 * model-facing report renderer.
 *
 * The async contract (R1): the tool path returns after the spawn/admission
 * pass — the admitted tasks spawn now, the rest queue under their owner
 * lease — and carries NO harvest. The harvest of every task is reported on
 * settlement (the delivery); the session-scoped watcher owns the queue
 * (admitting as slots free, spawning, refreshing the leases — R2) and the
 * bench drivers (R10) drive the factored wait loop in-process. The old
 * in-call wait-and-harvest loop is gone from the tool path; its machinery
 * lives in `loop.ts` (the wait) and `harvest.ts` (the harvest — now the
 * watcher/collect's, not the tool's).
 *
 * The collaborators live beside it: `spawn.ts` (the tile argv + the join
 * juggle + `issueSpawn` + the headless bun resolution + the formatting
 * pieces), `loop.ts` (the reusable wait loop), `harvest.ts` (the result
 * harvest + the deferred-harvest registry), `admit.ts` (the
 * liveness-qualified slot count + reconciliation).
 */
import { stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import * as P from "../protocol";
import * as C from "../config";
import { listAgentSummaries, resolveAgent } from "../agents";
import { defaultHyprctl, type HyprctlResult } from "../hyprctl";
import { issueSpawn, shortId, promptHeader, type SpawnEnv } from "./spawn";
import { spawnInFlight } from "./loop";
import type { PanelDeps } from "./panel";
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
	/** Optional — the typed-harvest contract: a JSON Schema (a plain object) the worker's `vitrine_done` `data` payload must satisfy. Rides spec.json; validated at the call (fail-fast). No default — unset means no typed contract (a `data` payload, if any, is recorded unvalidated). */
	output_schema?: Record<string, unknown>;
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
	/** Poll tick (default 1000 ms — the wait loop's; the entry itself never waits). */
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

/**
 * One task's result in the R1 return shape: the short id + agent + the
 * state observed AFTER the spawn/admission pass — `running` or `queued`
 * (a spawn that failed in the pass settled `crashed`/`failed-to-spawn`
 * immediately). The result carries NO harvest — the harvest is reported
 * on settlement, never in the tool result (R1).
 */
export interface DispatchedTaskResult {
	/** The task id (the dir under the tasks root). */
	id: string;
	agent: string;
	state: P.TaskState;
	reason?: string;
	/** True when the pass queued the task past the slot cap — the session's watcher spawns it as a slot frees (the queue is live under the owner lease, R2). */
	queued?: boolean;
	/** `vitrine.<id>` — the session handle. */
	sessionId: string;
}

export interface DispatchReport {
	mode: "tile" | "headless";
	/** The number of tasks created (every input task becomes a task dir). */
	dispatched: number;
	results: DispatchedTaskResult[];
	/** Tasks queued past the slot cap (spawned as slots free). */
	queued: number;
	/** True when the abort signal had already flipped: the spawn pass was skipped (no work added to a dying turn) — the created tasks stay queued under their lease for the session's watcher. */
	aborted: boolean;
	/** The model-facing text (the R1 shape). */
	text: string;
}

// ---------------------------------------------------------------------------
// the dispatch core

interface PlannedTask {
	id: string;
	dir: string;
	spec: P.TaskSpec;
	agentName: string;
	/** The admission decision (index past the free slots at admission). */
	queuedThisCall: boolean;
}

/**
 * The dispatch core, the async contract (R1): validates the surface,
 * reconciles, admits against the liveness-qualified slot cap, creates the
 * task dirs (spec + prompt + `queued` state + the owner lease + the
 * delivery-eligibility marker), runs the one-shot spawn pass (the admitted
 * tasks spawn now; the rest queue), and returns the per-task report. It
 * NEVER waits: the harvest arrives as a delivery on settlement, and the
 * queue is owned by the session's watcher from here (R2).
 */
export async function dispatchTasks(opts: DispatchOptions): Promise<DispatchReport> {
	const deps = opts.deps ?? {};
	const now = deps.now ?? Date.now;
	const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
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
		if (t.output_schema !== undefined && (typeof t.output_schema !== "object" || t.output_schema === null || Array.isArray(t.output_schema))) {
			throw new DispatchError("bad-input", "'output_schema' must be a plain object (a JSON Schema)");
		}
		// The fail-closed authoring-time check (the dispatch edge): a schema
		// that does not Compile, or that carries an unknown `type` keyword
		// (typebox silently accepts an unrecognised `type` and its Check
		// never rejects on it — a typo'd LLM-authored schema would be
		// silently vacuous), is rejected here with a named error the
		// dispatcher can fix; the `vitrine_done`-time validation is the
		// second line
		if (t.output_schema !== undefined) {
			const schemaErrors = P.outputSchemaErrors(t.output_schema);
			if (schemaErrors.length > 0) {
				throw new DispatchError("bad-input", `task for agent '${t.agent}': ${schemaErrors.join("; ")}`);
			}
		}
	}

	const cfg = C.readConfigSync();
	// Per-call lease identity (one session can have concurrent dispatch calls —
	// the lease claim is per-call, so each call owns only its own tasks).
	const callNonce = P.newTaskId();
	const env: SpawnEnv = { mode: opts.mode, cfg, bunBin: opts.bunBin, hyprctl, sleep, now, mapWaitMs, mapWaitTickMs, panel: deps.panel };

	// ---- reconcile first (before admission) -------------------------
	await reconcileAll(now());

	// ---- admission: liveness-qualified slot count ------------------
	const slotsBefore = countSlots(await nonTerminalTasks(), now());
	const cap = cfg.max_concurrent;
	const admittedCount = Math.max(0, Math.min(cap - slotsBefore, opts.tasks.length));

	// ---- resolve agents + guards, create task dirs ---------------------------
	const planned: PlannedTask[] = [];
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
			output_schema: input.output_schema,
			auto_settle_s: cfg.auto_settle_s,
			auto_settle_grace_s: cfg.auto_settle_grace_s,
			completed_close_s: cfg.completed_close_s,
			from_task_id: fromTaskId,
			from_session_file: fromSessionFile,
			// the delivery-eligibility marker (the upgrade boundary): every
			// task created from the async-dispatch change onward carries it;
			// its absence on historical dirs is what excludes them from
			// delivery, replay, and the gc-skip
			async: true,
			created_at: new Date(now()).toISOString(),
			boot_id: bootId,
		};
		const prompt = `${promptHeader({ taskId: id, agent: agent.name, dispatcherSessionId: info.sessionId, cwd, fromTaskId })}\n${input.task}`;
		await P.createTask(dir, spec, prompt);
		// the owner claim (the stuck-queued gate): this call owns the lease
		// from creation; the session's watcher keeps refreshing it for the
		// queue it owns from this call (freshness is what keeps a queue
		// behind a slow worker a live queue, R2)
		await P.writeLease(dir, { owner: info.sessionId, nonce: callNonce, updated_at: new Date(now()).toISOString() });

		planned.push({ id, dir, spec, agentName: agent.name, queuedThisCall });
	}

	// ---- the spawn pass (one pass — no wait) ---------------------------------
	// The admitted tasks spawn now; the rest queue under their lease for the
	// session's watcher (it admits them as slots free — R2). An abort signal
	// that has already flipped skips the pass entirely: no work is added to a
	// dying turn — the created tasks stay queued under their lease (the
	// watcher owns them if the session lives; a dead session's stale lease
	// settles them never-spawned — delivery is session-scoped, not turn-scoped).
	let aborted = deps.signal?.aborted === true;
	if (!aborted) {
		for (const p of planned) {
			if (p.queuedThisCall) continue;
			// The loop's per-task spawn guards (the no-double-spawn invariant,
			// the same decision the wait loop makes): the session's watcher
			// (armed at session_start) ticks in this same process between the
			// pass's awaits and can spawn the task first — a live wrapper or a
			// fresh spawn-issued event means the spawn is in flight: skip it
			// (the other owner owns the spawn; the state says so on disk)
			const st = await P.readState(p.dir).catch(() => null);
			if (st === null || st.state !== "queued") continue;
			const live = await P.wrapperLiveness(p.dir, st);
			if (live.live) continue;
			if (await spawnInFlight(p.dir)) continue;
			await issueSpawn({ id: p.id, dir: p.dir, agentName: p.agentName, spec: p.spec }, env);
		}
	}

	// ---- the R1 result: the observed on-disk state after the pass ------------
	// The tool result carries NO harvest — the state is what the pass left on
	// disk (a headless/tile spawn is asynchronous: the wrapper flips
	// queued→running on its own first tick, so `queued` at return time is the
	// normal shape for a just-spawned task), and the harvest is reported on
	// settlement (the delivery), never in the tool result. An aborted pass
	// spawned nothing — every task is queued in effect, not just the ones the
	// admission put past the cap.
	const results: DispatchedTaskResult[] = [];
	for (const p of planned) {
		const st = await P.readState(p.dir).catch(() => null);
		results.push({
			id: p.id,
			agent: p.agentName,
			state: st !== null ? st.state : "queued",
			reason: st?.reason,
			queued: aborted || p.queuedThisCall ? true : undefined,
			sessionId: p.spec.session_id,
		});
	}

	const text = renderDispatch({ dispatched: results.length, results, aborted });
	return { mode: opts.mode, dispatched: results.length, results, queued: results.filter((r) => r.queued).length, aborted, text };
}

// ---------------------------------------------------------------------------
// the report (the R1 shape — compact; exact wording is an
// implementation detail, but the named test pins this shape)

interface RenderDispatch {
	dispatched: number;
	results: DispatchedTaskResult[];
	aborted: boolean;
}

/**
 * The R1 return text: a header line (the non-blocking contract — the
 * harvests are reported on settlement, not in this result), then one line
 * per task: short id, agent, state — and, for every non-terminal task, the
 * one line stating the harvest will be reported on settlement. A task the
 * pass already settled (a failed spawn) names its state + reason; its
 * settled harvest is still delivered on settlement like any terminal state.
 */
export function renderDispatch(r: RenderDispatch): string {
	const out: string[] = [];
	out.push(
		`${r.dispatched} dispatched (non-blocking — each task's harvest will be reported on settlement, not in this result)${r.aborted ? " · ABORTED (the spawn pass was skipped — the tasks stay queued under their lease)" : ""}`,
	);
	r.results.forEach((res, i) => {
		const head = `[${i + 1}] ${res.agent} · ${shortId(res.id)} — ${res.state}${res.reason !== undefined && res.reason !== "" ? ` (${res.reason})` : ""}`;
		out.push(P.isTerminal(res.state) ? head : `${head} — the harvest will be reported on settlement`);
	});
	return out.join("\n");
}
