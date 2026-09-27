/**
 * vitrine.ts — the Vitrine pi extension (dispatcher-only, v1.21).
 *
 * Registers the `vitrine_dispatch` tool — admit, spawn, return (the async
 * contract: the tool path never waits; the harvest is reported on settlement
 * as a delivery, and the queue is owned by the session's watcher from the
 * pass onward). The mode is the protocol's decision, not a second probe: the
 * compositor reachability probe (tool-side only) picks the spawn shape — tile
 * if reachable, headless otherwise, never the reverse.
 *
 * Workers see no extension tools: v1.21 retired the `vitrine_done` worker
 * tool — completion is a fact the wrapper observes on its tick (the
 * stop-settle: the worker's turn settled, unattended; headless: the process
 * exit), and the worker's final message is the deliverable. `VITRINE_TASK_DIR`
 * in env no longer switches an extension mode.
 *
 * Cutover rule: one name, one owner — refuse rather than shadow;
 * the ownership check runs at `session_start` (see below).
 */
import { realpathSync } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { type ExtensionAPI, type ExtensionToolContext, type ToolResult } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as D from "./dispatch";
import { collectTasks } from "./collect";
import { startSessionWatcher, type DeliveryOptions, type HarvestMessage, type SessionWatcher } from "./watcher";
import { listAgentSummaries } from "./agents";

const DISPATCH_TOOL = "vitrine_dispatch";
const COLLECT_TOOL = "vitrine_collect";

/** The vault doctrine file — the single home for the vitrine dispatch/collect
 * instructions. Both tool descriptions carry a pointer here rather than the
 * full doctrine, so the doctrine is edited in the vault and the descriptions
 * cannot drift from it. (The seat roster stays generated in the dispatch
 * description — it comes from the resolver's own layer and cannot live in a
 * file.) Machine-specific path, like the `~/.pi/agent/agents` coupling the
 * resolver already carries. */
const VITRINE_DOCTRINE = `${process.env.HOME ?? homedir()}/Documents/Agent/Agents/Vitrine.md`;

/** The `vitrine_dispatch` mechanics — the stable opening
 * paragraph of the tool description, VERBATIM; the roster + policy lines
 * are appended at load (see `composeDispatchDescription`). */
const DISPATCH_MECHANICS =
	"Dispatch one or more tasks to specialist agents (pi agent files), each in its own visible workspace " +
	"(a Hyprland/foot tile when the compositor is reachable, otherwise a headless worker). " +
	"Returns immediately after the spawn/admission pass — per task: short id, agent, and state (running or " +
	"queued).";

/**
 * The `vitrine_collect` contract — the pull-floor doctrine: dispatch
 * returns immediately and results arrive as a delivery; collect is the
 * on-demand pull for a result you want now; never busy-poll collect inside
 * a turn. The per-task result shapes and the write semantics live in the
 * vault doctrine file (VITRINE_DOCTRINE) — the description keeps the
 * one-line contract plus the pointer, so the file is the single home for
 * the doctrine and the two cannot drift apart.
 */
const COLLECT_MECHANICS =
	"Pull vitrine results on demand — the complement to vitrine_dispatch (which returns immediately and delivers each harvest on settlement); " +
	"the way to get a result when you want it now. It answers immediately from disk and NEVER blocks on a running worker — " +
	"never busy-poll collect inside a turn; the delivery is the result path. " +
	`Per-task result shapes and write semantics: ${VITRINE_DOCTRINE} (the collect section).`;

/**
 * Compose the `vitrine_dispatch` description:
 * the mechanics paragraph, then — only when the global agents dir yields
 * entries — one roster line per agent (`- \`name\`: first sentence`, from
 * `listAgentSummaries`), then the dispatch-policy line and the
 * project-shadowing line. The roster is generated from the resolver's own
 * layer (`listAgentSummaries` scans the same `~/.pi/agent/agents` dir
 * `resolveAgent` resolves against), so it cannot drift from what dispatch
 * actually accepts — and new global agents appear on the next session
 * start, when the extension loads again. Called ONCE at load, never per
 * tool call. Load-time constraint (see `ExtensionAPI` in
 * src/types/pi-coding-agent.d.ts): there is no cwd and no project-trust at
 * load, so the roster enumerates ONLY the global dir; the per-call
 * unknown-agent error — where `ctx.cwd`/`ctx.isProjectTrusted` are known —
 * lists the full live roster instead.
 */
export function composeDispatchDescription(): string {
	const parts: string[] = [DISPATCH_MECHANICS];
	const roster = listAgentSummaries(); // global-only: no trust/cwd at load
	if (roster.length > 0) {
		parts.push(roster.map((s) => `- \`${s.name}\`: ${s.line}`).join("\n"));
	}
	parts.push(
		"Dispatch when a side task would flood this context, for parallel mechanical units, or for an independent check; not for a single sequential unit or judgment work that needs the conversation.\n" +
		"Each task's harvest arrives as a delivery on settlement — it never lands in the tool result; never act on a worker's result in the same turn you dispatched it. " +
		"Full delivery/collect doctrine (per-task result shapes, the harvest-delivered marker, attended tasks): " + VITRINE_DOCTRINE + ".\n" +
		"Project-local `.pi/agents/` agents shadow these when the project is trusted; an unknown-agent error lists the live roster.",
	);
	return parts.join("\n\n");
}

/** `ctx.model` is nullable and loosely shaped; normalise to "provider/id" | null. */
function modelString(model: unknown): string | null {
	if (model === null || model === undefined) return null;
	if (typeof model === "string") return model;
	if (typeof model === "object") {
		const m = model as Record<string, unknown>;
		const provider = typeof m.provider === "string" ? m.provider : null;
		const id = typeof m.id === "string" ? m.id : typeof m.modelId === "string" ? m.modelId : null;
		if (provider !== null && id !== null) return `${provider}/${id}`;
		if (id !== null) return id;
		if (typeof m.name === "string") return m.name;
	}
	return null;
}

export default function vitrine(pi: ExtensionAPI): void {
	// ---- dispatcher mode ------------------------------------------------------
	// The description is composed ONCE here, at load — not per tool call: the
	// roster comes from the resolver's own layer so it cannot drift, and new
	// global agents appear on the next session start (there is no trust/cwd at
	// load — see ExtensionAPI in src/types/pi-coding-agent.d.ts).
	const dispatchDescription = composeDispatchDescription();
	pi.registerTool({
		name: DISPATCH_TOOL,
		label: "Vitrine dispatch",
		description: dispatchDescription,
		parameters: Type.Object({
			tasks: Type.Array(
				Type.Object({
					agent: Type.String({ description: "Required — the exact agent name (a pi agent file, global or project-local when the project is trusted)." }),
					task: Type.String({ description: "Required — the mission, verbatim." }),
					cwd: Type.Optional(Type.String({ description: "Working directory for the worker. Default: the dispatcher's cwd." })),
					model: Type.Optional(Type.String({ description: "Model override. Default chain: agent frontmatter → dispatcher's current model." })),
					thinking: Type.Optional(
						Type.Union(
							[
								Type.Literal("off"),
								Type.Literal("minimal"),
								Type.Literal("low"),
								Type.Literal("medium"),
								Type.Literal("high"),
								Type.Literal("xhigh"),
								Type.Literal("max"),
							],
							{ description: "Thinking-level override for this task (pi --thinking levels). Default chain: agent frontmatter → pi default." },
						),
					),
					from: Type.Optional(Type.String({ description: "Continue from a previous task: fork that task's worker session (its id). The source task must be terminal." })),
					context: Type.Optional(Type.Literal("parent", { description: "Rare: seed this worker from the dispatcher's own session." })),
					attended: Type.Optional(Type.Boolean({ description: "This workspace is the human's: auto-settle is suppressed (default false)." })),
					timeout: Type.Optional(Type.Number({ description: "Wall-clock budget in seconds. Default: config wall_timeout_s." })),
					inactivity: Type.Optional(Type.Number({ description: "Watchdog idle budget in seconds. Default: agent frontmatter → config inactivity_s." })),
					max_cost_usd: Type.Optional(Type.Number({ description: "Max total session cost in USD; the cost watchdog settles the task at the budget (reason 'cost'). No default — unset means no cost budget." })),
				}),
				{ minItems: 1, maxItems: 8, description: "1–8 tasks per invocation; overflow queues within the call." },
			),
		}),
		async execute(
			_toolCallId: string,
			params: Record<string, unknown>,
			signal: AbortSignal,
			// pi's streaming callback — unused by the async contract (R1): the
			// tool returns after the spawn pass, there is nothing to stream.
			_onUpdate?: (update: { content: Array<{ type: "text"; text: string }>; details?: unknown }) => void,
			ctx?: ExtensionToolContext,
		): Promise<ToolResult> {
			if (ctx === undefined) {
				throw new Error("vitrine_dispatch needs the extension tool context (ctx) — pi version mismatch?");
			}
			const dispatcher: D.DispatcherInfo = {
				sessionId: ctx.sessionManager.getSessionId(),
				sessionFile: ctx.sessionManager.getSessionFile(),
				model: modelString(ctx.model),
				cwd: ctx.cwd,
				projectTrusted: ctx.isProjectTrusted === true,
			};
			// Mode: the compositor reachability probe. Unreachable ⇒
			// headless, never the reverse.
			const mode = (await D.probeCompositor()) ? "tile" : "headless";
			// The async contract (R1): the tool returns after the spawn/
			// admission pass — no in-call wait, NO harvest in the result.
			// The harvest of every task is reported on settlement (the
			// delivery); the queue is owned by the session's watcher from
			// here (R2). `details.results` rides the session record as the
			// machine-readable twin of the text.
			const report = await D.dispatchTasks({
				tasks: params.tasks as D.DispatchTaskInput[],
				mode,
				dispatcher,
				bunBin: D.resolveBunBin, // thunk: resolved lazily at the first headless spawn (tile never resolves it)
				deps: {
					signal,
				},
			});
			// The queue is owned by the session's watcher from this pass (R2):
			// re-arm it when it had stopped (the stop condition applied after the
			// previous work drained) — the dispatch guarantees its own batch is
			// watched. No replay here: the context is live (a re-show would be a
			// genuine duplicate, not a replay). The re-arm's attach scan adopts
			// only STALE-LEASE tasks (the dead-predecessor discriminator) — a
			// live session's running tasks are never co-adopted by this re-arm.
			armWatcher(dispatcher.sessionId, false);
			// A plain-string result crashes pi's TUI and is dropped from the
			// session record — return the ToolResult object (verified 2026-09-17).
			return { content: [{ type: "text", text: report.text }], details: { mode, results: report.results } };
		},
	});

	// The pull floor (R6): main-session only (the worker mode above already
	// returned — a worker never sees it). It answers immediately from disk
	// (never blocks on a worker) and reuses the delivery's fixed wrapper +
	// harvest machinery (no second shape). The write semantics: a collect
	// that harvests a terminal task writes `harvest-delivered` (a fresh
	// collect-scoped batch id) — replay and gc then treat the task as
	// delivered. The scope: this session + the fork ancestry (recorded at
	// session_start, below); explicit ids cross any session.
	pi.registerTool({
		name: COLLECT_TOOL,
		label: "Vitrine collect",
		description: COLLECT_MECHANICS,
		parameters: Type.Object({
			ids: Type.Optional(
				Type.Array(
					Type.String({
						description:
							"Optional task ids (full ids, or the short 8-char prefix from the dispatch return) — they cross any session. " +
							"Omitted: all tasks of this session plus its fork ancestry.",
					}),
					{ minItems: 1, maxItems: 8, description: "1–8 task ids (matching vitrine_dispatch's bound); a short prefix must match exactly one task." },
				),
			),
		}),
		async execute(
			_toolCallId: string,
			params: Record<string, unknown>,
			_signal: AbortSignal,
			// pi's streaming callback — unused (the collect answers in one
			// shot from disk; there is nothing to stream).
			_onUpdate?: (update: { content: Array<{ type: "text"; text: string }>; details?: unknown }) => void,
			ctx?: ExtensionToolContext,
		): Promise<ToolResult> {
			if (ctx === undefined) {
				throw new Error("vitrine_collect needs the extension tool context (ctx) — pi version mismatch?");
			}
			const ids = Array.isArray(params.ids) ? params.ids.filter((s): s is string => typeof s === "string") : undefined;
			const res = await collectTasks({
				sessionId: ctx.sessionManager.getSessionId(),
				ancestryIds: forkAncestry,
				...(ids !== undefined && ids.length > 0 ? { ids } : {}),
			});
			return {
				content: [{ type: "text", text: res.text }],
				details: { batch: res.batch, headlined: res.headlined, notes: res.notes, rows: res.rows },
			};
		},
	});

	// Cutover rule: one name, one owner — refuse rather than
	// shadow. pi 0.85.1 exposes no load-time tool introspection
	// (getActiveTools/getAllTools are action methods that throw during
	// extension loading), so the ownership check runs at session_start:
	// pi merges all extensions' tools into a name-keyed map (last-loaded
	// wins), so a conflicting owner loaded AFTER us is detectable via the
	// entry's sourceInfo.path differing from this file; an owner loaded
	// before us was superseded by us and is undetectable (we own the name
	// then — documented limitation). On a detected conflict we deactivate
	// ours (a registration cannot be retracted) and warn. BOTH dispatcher-
	// side tools are checked: a later-loaded extension can shadow either
	// name.

	// ---- The session-scoped watcher (R2/R3) ---------------------------------
	// The session's long-lived poller: it owns what the blocking call used to
	// own (admitting queued tasks as slots free, spawning them, refreshing
	// their owner lease each tick) and the delivery (every in-scope task that
	// settled since the last delivery goes out coalesced as one
	// pi.sendMessage, R3). It arms at session_start (the session-start scope
	// is the GLOBAL predicate set — attach + replay, R5), re-arms at every
	// dispatch call (a stopped watcher is re-armed by the tool — the queue is
	// owned from the pass onward), and closes at session_shutdown (nothing
	// settles on close).
	let watcher: SessionWatcher | null = null;
	// The fork ancestry (R6): the pre-fork dispatcher's session ids, recorded
	// from `session_start { reason: "fork", previousSessionFile }` — a fork's
	// no-id vitrine_collect still finds the pre-fork tasks (explicit ids cross
	// any session regardless). Reset on every session_start (pi re-binds the
	// extension per session — the watcher reset below is the precedent).
	let forkAncestry: string[] = [];
	const sendHarvest: (message: HarvestMessage, options: DeliveryOptions) => Promise<void> = (message, options) => {
		// The floor check (R8) made sendMessage part of the declared surface —
		// the runtime guard is for a genuinely older pi than the stubs assume.
		const fn = (pi as unknown as { sendMessage?: (message: unknown, options?: unknown) => Promise<void> }).sendMessage;
		if (typeof fn !== "function") {
			throw new Error("pi.sendMessage is unavailable — the vitrine pi floor (0.85) is not met");
		}
		return fn.call(pi, message, options);
	};
	const armWatcher = (sessionId: string, replay: boolean): void => {
		if (watcher !== null && watcher.closed) watcher = null;
		if (watcher !== null && !watcher.stopped) return; // already watching
		watcher = startSessionWatcher({ sessionId, send: sendHarvest, replay, bunBin: D.resolveBunBin });
	};

	const onSessionStart = async (event: unknown, ctx: unknown): Promise<void> => {
		try {
			const ownPath = safeRealpath(fileURLToPath(import.meta.url));
			const conflicting = [DISPATCH_TOOL, COLLECT_TOOL].filter((name) => {
				const entry = pi.getAllTools().find((t) => t.name === name);
				const ownerPath = safeRealpath(entry?.sourceInfo?.path ?? "");
				return ownPath !== undefined && ownerPath !== undefined && ownerPath !== ownPath;
			});
			if (conflicting.length > 0) {
				pi.setActiveTools(pi.getActiveTools().filter((n) => !conflicting.includes(n)));
				process.stderr.write(
					`vitrine: refusing to own ${conflicting.join(", ")} — ${conflicting.length > 1 ? "the names are" : "the name is"} owned by another extension (cutover rule); our registration is deactivated\n`,
				);
			}
		} catch {
			// best-effort: a future pi without session-time introspection — a
			// duplicate, if any, is still pi's own to surface
		}
		// The session-start arm (R5): the scope is the GLOBAL predicate set —
		// non-terminal async tasks are re-attached (their queue settles into
		// this session) and terminal undelivered non-attended tasks are
		// replayed (one coalesced message, the `replay:` header). The reason
		// (startup/resume/fork) only changes what the model already knows —
		// the replay predicate is global in every case.
		// The fork ancestry (R6): the previous session file resolves to the
		// pre-fork session's id (the file's header line), and its own
		// `parentSession` header field chains back through any further forks —
		// the tasks those sessions dispatched carry `spec.dispatcher_session_id`
		// = one of these ids, so a fork's no-id collect still finds them.
		const ev = (event ?? {}) as { reason?: string; previousSessionFile?: string };
		forkAncestry = ev.reason === "fork" && typeof ev.previousSessionFile === "string" ? await forkAncestryIds(ev.previousSessionFile) : [];
		const sm = (ctx as { sessionManager?: { getSessionId(): string } } | null | undefined)?.sessionManager;
		if (typeof sm?.getSessionId === "function") {
			const sessionId = sm.getSessionId();
			watcher?.close(); // a previous arm in this process (defensive — pi re-binds extensions per session)
			watcher = null;
			armWatcher(sessionId, true);
		}
	};
	pi.on("session_start", onSessionStart);
	pi.on("session_shutdown", () => {
		// Close the watcher: the loop exits; nothing settles on close (the
		// queue's lease decides its fate — a dead owner's stale lease settles
		// it never-spawned on the next reconcile).
		watcher?.close();
		watcher = null;
	});
}

/** realpath with a fail-safe undefined — the guard is best-effort only. An empty path is NOT real-able (realpathSync("")) yields the CWD — a missing entry must read as "no owner", not a conflict. */
function safeRealpath(p: string): string | undefined {
	if (p === "") return undefined;
	try {
		return realpathSync(p);
	} catch {
		return undefined;
	}
}

/**
 * The session file's header (the first line) — a BOUNDED read: the session
 * file is pi-owned, append-only, and can be multi-megabytes, and only the
 * first line (the SessionHeader: `id` + `parentSession` on a forked file) is
 * needed. `null` when unreadable or the first line is empty/torn.
 */
async function readSessionHeaderLine(path: string): Promise<Record<string, unknown> | null> {
	const fh = await open(path, "r").catch(() => null);
	if (fh === null) return null;
	try {
		const buf = Buffer.alloc(65536);
		const { bytesRead } = await fh.read(buf, 0, 65536, 0);
		let text = buf.subarray(0, bytesRead).toString("utf8");
		const nl = text.indexOf("\n");
		if (nl >= 0) text = text.slice(0, nl);
		if (text.trim() === "") return null;
		return JSON.parse(text) as Record<string, unknown>;
	} catch {
		return null;
	} finally {
		await fh.close().catch(() => null);
	}
}

/**
 * The fork-ancestry ids (R6): the previous session file's header `id`, then
 * the chain of its `parentSession` headers (a fork of a fork). These are the
 * pre-fork dispatcher session ids — the tasks those sessions dispatched
 * carry `spec.dispatcher_session_id` = one of them, so a fork's no-id
 * vitrine_collect still finds the pre-fork tasks. An unreadable header or a
 * cycle ends the chain (a hop cap guards a pathological one); a fork's
 * collect degrades to the session-scoped set, and explicit ids always work.
 */
async function forkAncestryIds(previousSessionFile: string): Promise<string[]> {
	const ids: string[] = [];
	const seen = new Set<string>();
	let file: string | undefined = previousSessionFile;
	for (let hops = 0; file !== undefined && hops < 32 && !seen.has(file); hops++) {
		seen.add(file);
		const hdr = await readSessionHeaderLine(file);
		if (hdr === null || typeof hdr.id !== "string") break;
		ids.push(hdr.id);
		file = typeof hdr.parentSession === "string" ? hdr.parentSession : undefined;
	}
	return ids;
}
