/**
 * vitrine.ts — the Vitrine pi extension.
 *
 * One package, two roles, switched by env ("The worker-mode extension"):
 * - dispatcher sessions: registers the `vitrine_dispatch` tool — admit, spawn,
 *   return (the async contract: the tool path never waits; the harvest is
 *   reported on settlement as a delivery, and the queue is owned by the
 *   session's watcher from the pass onward). The mode is the protocol's
 *   decision, not a second probe: the compositor reachability probe
 *   (tool-side only) picks the spawn shape — tile if reachable, headless
 *   otherwise, never the reverse.
 * - worker mode (`VITRINE_TASK_DIR` in env): registers exactly one tool,
 *   `vitrine_done(answer, data?)` — writes `result.md` (+ `result.json` when
 *   `data` is present) + `done.marker` and one `events.jsonl` line; never
 *   `state.json` (single-writer rule). When the task's spec declares an
 *   `output_schema`, `data` is required and is validated against it at the
 *   call (fail-fast — the worker sees the field errors and retries).
 *   No dispatch tool in worker mode.
 *
 * Cutover rule: one name, one owner — refuse rather than shadow;
 * the ownership check runs at `session_start` (see below).
 */
import { appendFileSync, realpathSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getMarkdownTheme, type ExtensionAPI, type ExtensionToolContext, type ToolResult } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { Compile } from "typebox/compile";
import * as P from "./protocol";
import * as D from "./dispatch";
import { collectTasks } from "./collect";
import { startSessionWatcher, type DeliveryOptions, type HarvestMessage, type SessionWatcher } from "./watcher";
import { listAgentSummaries } from "./agents";
import { makeDoneRenderers, type DoneRenderDeps } from "./done-render";

const DISPATCH_TOOL = "vitrine_dispatch";
const COLLECT_TOOL = "vitrine_collect";
const DONE_TOOL = "vitrine_done";

/**
 * The `vitrine_done` TUI renderers (v1.14) — the worker's own
 * tile shows the recorded answer as markdown (the completed tile is kept
 * open so the human can read it; the default rendering would
 * bury the answer in the escaped-JSON tool argument). Worker mode only —
 * the dispatcher's panel never sees them (master-side result UX untouched).
 * The pure logic + stub-driven tests live in
 * src/done-render.ts; the pi-tui packages resolve only under pi's
 * extension loader (headless `--print` loads these imports but never calls
 * the renderers).
 */
const doneRenderDeps: DoneRenderDeps = {
	text: (content, padX, padY) => new Text(content, padX, padY),
	container: (children) => {
		const c = new Container();
		for (const child of children) c.addChild(child);
		return c;
	},
	markdown: (text, padX, padY, theme) => new Markdown(text, padX, padY, theme),
	markdownTheme: () => getMarkdownTheme(),
};
const doneRenderers = makeDoneRenderers(doneRenderDeps);

/** The `vitrine_dispatch` mechanics — the stable opening
 * paragraph of the tool description, VERBATIM; the roster + policy lines
 * are appended at load (see `composeDispatchDescription`). */
const DISPATCH_MECHANICS =
	"Dispatch one or more tasks to specialist agents (pi agent files), each in its own visible workspace " +
	"(a Hyprland/foot tile when the compositor is reachable, otherwise a headless background worker). " +
	"Returns immediately after the spawn/admission pass — per task: short id, agent, and state (running or " +
	"queued). Each task's harvest is reported on settlement as a delivery; it never lands in the tool " +
	"result — do not act on a worker's result in the same turn you dispatched it. " +
	"pi's docs call starting a new agent 'spawn' — this is that spawn: it starts one worker per task and dispatches the task to it.";

/**
 * The `vitrine_collect` mechanics (R9): the pull-floor doctrine — dispatch
 * returns immediately and results arrive as a delivery; collect is the
 * on-demand pull for a result you want now; never busy-poll collect inside
 * a turn. The per-task shapes and the write semantics ride the description
 * (the tool is its own documentation — the doctrine the delivery's risk
 * section bounds).
 */
const COLLECT_MECHANICS =
	"Pull vitrine results on demand — the pull floor that complements vitrine_dispatch: dispatch returns immediately (ids + state, no harvest) " +
	"and each task's harvest arrives as a delivery on settlement; this tool is how you get a result when you want it now. " +
	"It answers immediately from disk and NEVER blocks on a running worker — so never busy-poll collect inside a turn to wait a worker out: " +
	"the delivery is the result path, and a turn that dispatched must not act on the result in the same turn.\n" +
	"Per task: terminal → the full harvest in the fixed wrapper (capped — the 0600 overflow file's path is named in the body, and reading it " +
	"is the sanctioned response to a truncated body) + delivery status; running/queued → a status line (state, elapsed, workspace) with no body; " +
	"a terminal task a human resumed in its tile → the session's latest output as an advisory note (never a state change, never a re-delivery).\n" +
	"No ids = all tasks of this session plus its fork ancestry (the pre-fork dispatcher's tasks). ids = explicit task ids (full, or the short " +
	"8-char prefix from the dispatch return) — they cross any session.\n" +
	"A collect that harvests a terminal task writes the harvest-delivered marker (a fresh collect-scoped batch id) — the collect is a delivery " +
	"to this session's context, so replay and gc treat the task as delivered. Undelivered attended tasks are headlined without a body — " +
	"attended workspaces are the human's; pulling their harvest is an explicit id.";

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
			"Dispatch returns immediately — each task's result arrives as a delivery on settlement; never act on a worker's result in the same turn you dispatched it, and never busy-wait for it. " +
			"vitrine_collect is the on-demand pull for a result you want now (an explicit status check, a re-harvest after a human resumed a worker, or a delivery-path diagnosis) — pull when you want it, never busy-poll collect inside a turn.\n" +
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

function isTaskDir(dir: string): boolean {
	// A real task dir: a directory, a bare uuid basename, a spec.json the
	// wrapper (via the protocol) wrote before the worker loaded — and
	// lexically inside the tasks root (a uuid-named dir elsewhere is not
	// ours even if it happens to carry a spec.json). A uuid-named dir with no
	// spec.json is not a task (an empty leftover) and is refused.
	try {
		const st = statSync(dir);
		if (!st.isDirectory()) return false;
		const root = P.tasksRoot();
		if (!dir.startsWith(root + "/")) return false;
		if (!P.UUID_RE.test(dir.split("/").pop() ?? "")) return false;
		return statSync(join(dir, "spec.json")).isFile();
	} catch {
		return false;
	}
}

function refuseWorkerMode(taskDir: string, why: string): void {
	// The wrapper appends the worker's stderr to tail.log; a direct tail.log
	// line keeps the record even if the wrapper never ran.
	const line = JSON.stringify({ ts: new Date().toISOString(), event: "worker-mode-refused", reason: why, source: "extension" }) + "\n";
	try {
		appendFileSync(join(taskDir, "tail.log"), line);
	} catch {
		// best-effort — the stderr line still reaches tail.log via the wrapper
	}
	process.stderr.write(`vitrine: refusing worker mode — ${why} (VITRINE_TASK_DIR=${taskDir}); the task will settle via its watchdogs\n`);
}

export default function vitrine(pi: ExtensionAPI): void {
	const taskDir = process.env.VITRINE_TASK_DIR;

	// ---- worker mode ----------------------------------------------------------
	if (taskDir !== undefined) {
		if (!isTaskDir(taskDir)) {
			refuseWorkerMode(taskDir, "VITRINE_TASK_DIR is not a valid task dir");
			return;
		}
		pi.registerTool({
			name: DONE_TOOL,
			label: "Vitrine done",
			description:
				"Finish this vitrine task. Call it exactly once, when the task is complete, with the final answer " +
				"(the text the dispatcher should read). It records the answer and signals the wrapper; after the " +
				"call returns, stop immediately.",
			parameters: Type.Object({
				answer: Type.String({ description: "The final answer — written to result.md, model-facing on harvest." }),
				data: Type.Optional(
					Type.Unknown({
						description:
							"Optional typed data payload (arbitrary JSON) — written to result.json alongside the answer. " +
							"REQUIRED when this task's dispatch declared an output_schema: the payload must satisfy that " +
							"schema, otherwise this call errors (naming the offending fields) so you retry with a fixed payload.",
					}),
				),
			}),
			// Custom TUI rendering (v1.14): the answer is shown as
			// markdown in the worker's own tile. Never called in headless mode.
			renderCall: doneRenderers.renderCall,
			renderResult: doneRenderers.renderResult,
			async execute(_toolCallId: string, params: Record<string, unknown>): Promise<ToolResult> {
				const answer = typeof params.answer === "string" ? params.answer : "";
				const data = params.data; // Type.Optional(Type.Unknown()) — present iff the model passed it
				// Failure: let it throw — no try/catch. pi wraps a thrown error into
				// an error tool result (isError: true): the worker sees the message
				// and continues, and the wrapper's watchdogs remain the safety net.
				// AgentToolResult carries no isError field, so throwing is the
				// contract-faithful error path (a string result is a success to pi).
				const d = await P.assertTaskDir(taskDir);
				// The resume commit (R12): a second `vitrine_done` on an already-
				// terminal task is an idempotent no-op — the done marker is
				// write-once, so the handler short-circuits: NO event, no state
				// change, no re-recording. (A confused worker repeating the call
				// gets a plain acknowledgement, not an error — and a human-resumed
				// session keeps talking after settlement without re-settling.)
				const existingMarker = await P.readDoneMarker(d);
				if (existingMarker !== null) {
					return {
						content: [{ type: "text", text: `Already settled: the answer was recorded on an earlier vitrine_done (marker source: ${existingMarker.source}) — this call is a no-op (no event, no state change). Stop immediately.` }],
						details: { noop: true, source: existingMarker.source },
					};
				}
				// The typed-harvest contract: when the dispatch declared an
				// `output_schema`, `data` is REQUIRED and must satisfy the schema
				// — validated at the call (fail-fast) so the worker retries with a
				// fixed payload. The prose answer (result.md) and the typed data
				// (result.json) stay orthogonal.
				const spec = await P.readSpec(d);
				if (spec.output_schema !== undefined) {
					if (data === undefined) {
						throw new Error(
							"this task declares an output_schema — vitrine_done requires the `data` parameter (the contract was declared; the payload is missing)",
						);
					}
					let validator;
					try {
						validator = Compile(spec.output_schema);
					} catch (e: unknown) {
						// the contract was declared and is unverifiable — fail closed
						throw new Error(`the task's output_schema failed to compile — failing closed: ${e instanceof Error ? e.message : String(e)}`);
					}
					if (!validator.Check(data)) {
						const detail = validator
							.Errors(data)
							.slice(0, 5)
							.map((er) => `${er.instancePath === "" ? "(root)" : er.instancePath} ${er.message}`)
							.join("; ");
						throw new Error(`data does not satisfy the task's output_schema — ${detail}; fix the payload and call vitrine_done again`);
					}
				}
				await P.writeResult(d, answer);
				if (data !== undefined) await P.writeResultJson(d, data); // no schema + data present: still recorded (harmless)
				await P.writeDoneMarker(d, "vitrine_done");
				await P.appendEvent(d, { event: "vitrine_done", source: "worker", ...(data !== undefined ? { data: true } : {}) });
				// A plain-string result crashes pi's TUI (getTextOutput dereferences
				// `result.content`) and is silently dropped from the session record —
				// the result must be a ToolResult object (pi 0.85.1, verified 2026-09-17).
				// `details.answer` rides the session record so the TUI renderer above
				// shows the exact recorded text — and re-shows it on re-render/resume
				// (the keep-alive tile). The model-facing ack is unchanged.
				return {
					content: [{ type: "text", text: "Done. The answer is recorded; the wrapper will settle the task. Stop immediately." }],
					details: data === undefined ? { answer } : { answer, dataRecorded: true },
				};
			},
		});
		return;
	}

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
					output_schema: Type.Optional(
						Type.Object({}, {
							description:
								"Optional typed-harvest contract — a JSON Schema the worker's vitrine_done `data` payload must satisfy. " +
								"When declared, the payload is required and validated at the call; the data is recorded to result.json and " +
								"rendered (capped) in the harvest report.",
						}),
					),
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
			// genuine duplicate, not a replay).
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
					{ minItems: 1, description: "1–8 task ids; a short prefix must match exactly one task." },
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
	// ours (a registration cannot be retracted) and warn.

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
			const entry = pi.getAllTools().find((t) => t.name === DISPATCH_TOOL);
			const ownPath = safeRealpath(fileURLToPath(import.meta.url));
			const ownerPath = safeRealpath(entry?.sourceInfo?.path ?? "");
			if (ownPath && ownerPath && ownerPath !== ownPath) {
				pi.setActiveTools(pi.getActiveTools().filter((n) => n !== DISPATCH_TOOL));
				process.stderr.write(
					`vitrine: refusing to own ${DISPATCH_TOOL} — the name is owned by another extension (${ownerPath}; cutover rule); our registration is deactivated\n`,
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

/** realpath with a fail-safe undefined — the guard is best-effort only. */
function safeRealpath(p: string): string | undefined {
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
