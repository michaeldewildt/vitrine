/**
 * vitrine.test.ts — the extension suite ("the extension registers the
 * tool; the worker-mode extension exposes exactly `vitrine_done`; an invalid
 * `VITRINE_TASK_DIR` refuses with a notify + a `tail.log` line", plus the
 * cutover rule and a full headless E2E through the real extension
 * entry).
 *
 * Hermetic: a fake ExtensionAPI captures registrations; env is scoped per
 * test; the E2E runs the real wrapper against the fixture pi with an
 * unreachable compositor (empty PATH ⇒ headless mode).
 */
import { describe, expect, it, beforeAll, afterAll, mock } from "bun:test";
import { chmodSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionToolContext, ToolResult } from "@earendil-works/pi-coding-agent";
import * as P from "./protocol";
import { waitForTasks } from "./dispatch";

// The pi packages resolve only under pi's extension loader (jiti aliases the
// specifiers), not in this repo — so the extension entry's value imports
// (v1.14) are mocked before it loads. bun 1.4.2 mock.module
// intercepts unresolvable specifiers (probed 2026-09-18); static imports
// hoist above mock.module, hence the dynamic import below.
class StubText {
	constructor(public text: string, public padX = 0, public padY = 0) {}
	render(_w: number) {
		return [this.text];
	}
}
class StubContainer {
	private kids: Array<{ render(w: number): string[] }> = [];
	addChild(c: { render(w: number): string[] }) {
		this.kids.push(c);
	}
	render(_w: number) {
		return this.kids.flatMap((k) => k.render(80));
	}
}
class StubMarkdown {
	constructor(public text: string, public padX = 0, public padY = 0, public theme: unknown) {}
	render(_w: number) {
		return [`md:${this.text}`];
	}
}
mock.module("@earendil-works/pi-tui", () => ({ Text: StubText, Container: StubContainer, Markdown: StubMarkdown }));
mock.module("@earendil-works/pi-coding-agent", () => ({ getMarkdownTheme: () => ({ stub: "markdown-theme" }) }));
const { default: vitrine, composeDispatchDescription } = await import("./vitrine");

let base: string;
let tasksRoot: string;
let sessionsRoot: string;
let realHome: string;
let realTaskDir: string | undefined;
/** A stand-in for another extension's entry file (cutover fixture). */
let coOwnerPath: string;
const fixturePi = join(import.meta.dir, "..", "test", "fixtures", "fake-pi.ts");

beforeAll(async () => {
	base = await mkdtemp(join(tmpdir(), "vitrine-ext-"));
	realHome = process.env.HOME ?? "";
	realTaskDir = process.env.VITRINE_TASK_DIR;
	process.env.HOME = base;
	tasksRoot = join(base, "tasks");
	process.env.VITRINE_TASKS_ROOT = tasksRoot;
	sessionsRoot = join(base, "sessions");
	process.env.VITRINE_SESSIONS_DIR = sessionsRoot;
	await mkdir(sessionsRoot, { recursive: true });
	await writeFile(join(sessionsRoot, "disp.jsonl"), "{}\n");
	const agentsDir = join(base, ".pi", "agent", "agents");
	await mkdir(agentsDir, { recursive: true });
	await writeFile(join(agentsDir, "test-agent.md"), "---\nname: test-agent\ndescription: fixture agent for the extension tests.\n---\n# Fixture agent\n\nYou are the fixture test agent.\n");
	// the fixture pi as a command (headless E2E)
	const fakePiBin = join(base, "fake-pi");
	await writeFile(fakePiBin, `#!/bin/sh\nexec ${process.execPath} ${fixturePi} "$@"\n`);
	chmodSync(fakePiBin, 0o755);
	coOwnerPath = join(base, "co-owner.ts");
	await writeFile(coOwnerPath, "// another extension's entry file (cutover fixture)\n");
	process.env.VITRINE_PI_BIN = fakePiBin;
	process.env.VITRINE_BUN_BIN = process.execPath;
});

afterAll(async () => {
	process.env.HOME = realHome;
	if (realTaskDir === undefined) delete process.env.VITRINE_TASK_DIR;
	else process.env.VITRINE_TASK_DIR = realTaskDir;
	delete process.env.VITRINE_TASKS_ROOT;
	delete process.env.VITRINE_SESSIONS_DIR;
	delete process.env.VITRINE_BUN_BIN;
	delete process.env.VITRINE_PI_BIN;
	await rm(base, { recursive: true, force: true });
});

/** The entry path as the guard sees it — vitrine.ts's own file. */
const ownEntryPath = fileURLToPath(new URL("./vitrine.ts", import.meta.url));

interface RegisteredTool {
	name: string;
	description?: string;
	parameters: unknown;
	execute?: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal,
		onUpdate?: (update: { content: Array<{ type: "text"; text: string }>; details?: unknown }) => void,
		ctx?: ExtensionToolContext,
	) => Promise<ToolResult>;
	// the v1.14 TUI renderers (worker mode; never called by the tests below
	// except where a test drives them with the stub components above)
	renderCall?: (args: Record<string, unknown>, theme: unknown, context?: unknown) => { render(w: number): string[] };
	renderResult?: (
		result: { content?: unknown[]; details?: unknown; isError?: boolean },
		options: { expanded: boolean; isPartial: boolean },
		theme: unknown,
		context?: unknown,
	) => { render(w: number): string[] };
}

function fakePi(activeTools: string[] = [], opts: { coOwnerTools?: string[] } = {}) {
	const coOwned = new Set(opts.coOwnerTools ?? []);
	const tools: RegisteredTool[] = [];
	const sessionStart: Array<(event: unknown, ctx: unknown) => unknown> = [];
	const sessionShutdown: Array<(event: unknown, ctx: unknown) => unknown> = [];
	/** The captured `sendMessage` calls (the fake pi's delivery surface — R3). */
	const sentMessages: Array<{ message: unknown; options?: unknown }> = [];
	const setActiveToolsCalls: string[][] = [];
	const api: ExtensionAPI = {
		registerTool: (def) => {
			tools.push(def as RegisteredTool);
		},
		on: (event: string, handler: (...a: unknown[]) => unknown) => {
			if (event === "session_start") sessionStart.push(handler);
			else if (event === "session_shutdown") sessionShutdown.push(handler);
		},
		getActiveTools: () => activeTools,
		getAllTools: () =>
			[
				{
					name: "vitrine_dispatch",
					// pi's tool map is name-keyed (last-loaded wins): the single
					// entry's sourceInfo.path is whoever currently owns the name
					// — this file when free, the co-owner's file when contested
					sourceInfo: { path: coOwned.has("vitrine_dispatch") ? coOwnerPath : ownEntryPath },
				},
				{
					name: "vitrine_collect",
					sourceInfo: { path: coOwned.has("vitrine_collect") ? coOwnerPath : ownEntryPath },
				},
			],
		setActiveTools: (names: string[]) => {
			setActiveToolsCalls.push(names);
		},
		getSessionName: () => "test",
		// The delivery surface (R3): captured, never fails (a failed send is
		// the watcher core's business — src/watcher.test.ts drives it there)
		sendMessage: (message: unknown, options?: unknown) => {
			sentMessages.push({ message, options });
			return Promise.resolve();
		},
	} as ExtensionAPI;
	return {
		api,
		tools,
		setActiveToolsCalls,
		sentMessages,
		// test seam: fire the session_start handlers (pi does this after load)
		// with the (event, ctx) pair pi hands them — AWAITED: the handler is
		// async (the fork-ancestry resolution reads the previous session's header)
		fire: async (event: unknown = { reason: "startup" }, ctx: unknown = fakeCtx()): Promise<void> => {
			for (const h of sessionStart) await h(event, ctx);
		},
		// test seam: fire the session_shutdown handlers (the watcher's close)
		fireShutdown: () => {
			for (const h of sessionShutdown) h({ reason: "shutdown" }, fakeCtx());
		},
	};
}

function fakeCtx(over: Partial<ExtensionToolContext> = {}): ExtensionToolContext {
	return {
		sessionManager: { getSessionId: () => "disp-ext", getSessionFile: () => join(sessionsRoot, "disp.jsonl") },
		model: { provider: "ninfer", id: "ext-model" },
		cwd: base,
		isProjectTrusted: false,
		ui: { notify: () => {} },
		...over,
	};
}

describe("worker mode (exactly one tool)", () => {
	it("registers exactly vitrine_done for a valid task dir", async () => {
		const id = P.newTaskId();
		const dir = join(tasksRoot, id);
		// the wrapper (via the protocol) creates the task dir — spec.json +
		// state.json — before spawning the worker; that is the realistic
		// state at extension-load time
		const spec: P.TaskSpec = {
			task_id: id,
			agent: { name: "test-agent", body: "body\n" },
			dispatcher_session_id: "disp-ext",
			cwd: base,
			session_id: `vitrine.${id}`,
			session_name: `vitrine: test-agent · ${id.slice(0, 8)}`,
			mode: "tile",
			attended: false,
			workspace: 9,
			wall_timeout_s: 3600,
			inactivity_s: 600,
			auto_settle_s: 600,
			auto_settle_grace_s: 60,
			created_at: new Date().toISOString(),
			boot_id: P.currentBootId(),
		};
		await P.createTask(dir, spec, "probe\n");
		process.env.VITRINE_TASK_DIR = dir;
		const { api, tools } = fakePi();
		vitrine(api);
		delete process.env.VITRINE_TASK_DIR;
		expect(tools.map((t) => t.name)).toEqual(["vitrine_done"]);
	});

	it("vitrine_done writes result.md + done.marker + the event, never state.json", async () => {
		const id = P.newTaskId();
		const dir = join(tasksRoot, id);
		const spec: P.TaskSpec = {
			task_id: id,
			agent: { name: "test-agent", body: "body\n" },
			dispatcher_session_id: "disp-ext",
			cwd: base,
			session_id: `vitrine.${id}`,
			session_name: `vitrine: test-agent · ${id.slice(0, 8)}`,
			mode: "tile",
			attended: false,
			workspace: 9,
			wall_timeout_s: 3600,
			inactivity_s: 600,
			auto_settle_s: 600,
			auto_settle_grace_s: 60,
			created_at: new Date().toISOString(),
			boot_id: P.currentBootId(),
		};
		await P.createTask(dir, spec, "probe\n");
		process.env.VITRINE_TASK_DIR = dir;
		const { api, tools } = fakePi();
		vitrine(api);
		const stateBefore = JSON.stringify(await P.readState(dir));
		const out = await tools[0].execute!("call1", { answer: "the answer\n" }, new AbortController().signal, undefined, fakeCtx());
		const stateAfter = JSON.stringify(await P.readState(dir));
		expect(stateBefore).toBe(stateAfter); // state.json untouched (single-writer rule)
		// Regression (2026-09-17): pi's TUI dereferences `result.content`
		// unconditionally — a string return crashed the worker tile and the
		// dispatcher window and dropped the text from the session record.
		expect(typeof out).toBe("object");
		expect(out.content).toHaveLength(1);
		expect(out.content[0].type).toBe("text");
		expect(out.content[0].text).toContain("Done");
		expect(await readFile(join(dir, "result.md"), "utf8")).toBe("the answer\n");
		const marker = await P.readDoneMarker(dir);
		expect(marker).toMatchObject({ source: "vitrine_done" });
		const events = (await P.readEvents(dir)).map((e) => e.event);
		expect(events).toContain("vitrine_done");
		delete process.env.VITRINE_TASK_DIR;
	});

	it("vitrine_done with data (no schema): the payload is recorded to result.json (0600) alongside result.md", async () => {
		const id = P.newTaskId();
		const dir = join(tasksRoot, id);
		const spec: P.TaskSpec = {
			task_id: id,
			agent: { name: "test-agent", body: "body\n" },
			dispatcher_session_id: "disp-ext",
			cwd: base,
			session_id: `vitrine.${id}`,
			session_name: `vitrine: test-agent · ${id.slice(0, 8)}`,
			mode: "tile",
			attended: false,
			workspace: 9,
			wall_timeout_s: 3600,
			inactivity_s: 600,
			auto_settle_s: 600,
			auto_settle_grace_s: 60,
			created_at: new Date().toISOString(),
			boot_id: P.currentBootId(),
		};
		await P.createTask(dir, spec, "probe\n");
		process.env.VITRINE_TASK_DIR = dir;
		const { api, tools } = fakePi();
		vitrine(api);
		const data = { verdict: "pass", port: 8080 };
		const out = await tools[0].execute!("call1", { answer: "done\n", data }, new AbortController().signal, undefined, fakeCtx());
		expect(out.content[0].text).toContain("Done");
		// the prose answer and the typed data stay orthogonal
		expect(await readFile(join(dir, "result.md"), "utf8")).toBe("done\n");
		expect(JSON.parse(await readFile(join(dir, "result.json"), "utf8"))).toEqual(data);
		expect((await stat(join(dir, "result.json"))).mode & 0o777).toBe(0o600);
		expect(await P.readDoneMarker(dir)).toMatchObject({ source: "vitrine_done" });
		delete process.env.VITRINE_TASK_DIR;
	});

	it("vitrine_done with a declared output_schema: data is required and must satisfy it", async () => {
		const id = P.newTaskId();
		const dir = join(tasksRoot, id);
		const outputSchema = { type: "object", properties: { port: { type: "integer" }, name: { type: "string" } }, required: ["port", "name"] };
		const spec: P.TaskSpec = {
			task_id: id,
			agent: { name: "test-agent", body: "body\n" },
			dispatcher_session_id: "disp-ext",
			cwd: base,
			session_id: `vitrine.${id}`,
			session_name: `vitrine: test-agent · ${id.slice(0, 8)}`,
			mode: "tile",
			attended: false,
			workspace: 9,
			wall_timeout_s: 3600,
			inactivity_s: 600,
			auto_settle_s: 600,
			auto_settle_grace_s: 60,
			output_schema: outputSchema,
			created_at: new Date().toISOString(),
			boot_id: P.currentBootId(),
		};
		await P.createTask(dir, spec, "probe\n");
		process.env.VITRINE_TASK_DIR = dir;
		const { api, tools } = fakePi();
		vitrine(api);
		const sig = new AbortController().signal;
		// the contract was declared, the payload is missing → the call errors (fail fast, nothing recorded)
		await expect(tools[0].execute!("call1", { answer: "x\n" }, sig, undefined, fakeCtx())).rejects.toThrow(/declares an output_schema/);
		expect(await P.readDoneMarker(dir)).toBeNull();
		expect(await readFile(join(dir, "result.md"), "utf8").catch(() => null)).toBeNull();
		// invalid data → the error carries the field messages (the worker retries with a fixed payload)
		await expect(tools[0].execute!("call2", { answer: "x\n", data: { port: "nope" } }, sig, undefined, fakeCtx())).rejects.toThrow(/must be integer/);
		expect(await P.readDoneMarker(dir)).toBeNull();
		// valid data → recorded to result.json, marker written
		const out = await tools[0].execute!("call3", { answer: "y\n", data: { port: 8080, name: "mikey" } }, sig, undefined, fakeCtx());
		expect(out.content[0].text).toContain("Done");
		expect(JSON.parse(await readFile(join(dir, "result.json"), "utf8"))).toEqual({ port: 8080, name: "mikey" });
		expect(await P.readDoneMarker(dir)).toMatchObject({ source: "vitrine_done" });
		delete process.env.VITRINE_TASK_DIR;
	});

	it("vitrine_done with a declared output_schema that fails to compile: failing closed (the second line)", async () => {
		const id = P.newTaskId();
		const dir = join(tasksRoot, id);
		// a schema typebox's Compile throws on (an invalid pattern) — the
		// dispatch edge now rejects this at authoring; a spec that reaches
		// vitrine_done (a hand-authored dir, or a pre-fix task) fails closed
		// HERE, the second line: nothing is recorded
		const outputSchema = { type: "object", properties: { x: { type: "string", pattern: "[invalid" } } };
		const spec: P.TaskSpec = {
			task_id: id,
			agent: { name: "test-agent", body: "body\n" },
			dispatcher_session_id: "disp-ext",
			cwd: base,
			session_id: `vitrine.${id}`,
			session_name: `vitrine: test-agent · ${id.slice(0, 8)}`,
			mode: "tile",
			attended: false,
			workspace: 9,
			wall_timeout_s: 3600,
			inactivity_s: 600,
			auto_settle_s: 600,
			auto_settle_grace_s: 60,
			output_schema: outputSchema,
			created_at: new Date().toISOString(),
			boot_id: P.currentBootId(),
		};
		await P.createTask(dir, spec, "probe\n");
		process.env.VITRINE_TASK_DIR = dir;
		const { api, tools } = fakePi();
		vitrine(api);
		const sig = new AbortController().signal;
		await expect(tools[0].execute!("call1", { answer: "x\n", data: { x: "y" } }, sig, undefined, fakeCtx())).rejects.toThrow(/failed to compile/);
		// nothing half-recorded: no marker, no result
		expect(await P.readDoneMarker(dir)).toBeNull();
		expect(await readFile(join(dir, "result.md"), "utf8").catch(() => null)).toBeNull();
		delete process.env.VITRINE_TASK_DIR;
	});

	it("vitrine_done failure throws (pi wraps the error into an error tool result)", async () => {
		const id = P.newTaskId();
		const dir = join(tasksRoot, id);
		const spec: P.TaskSpec = {
			task_id: id,
			agent: { name: "test-agent", body: "body\n" },
			dispatcher_session_id: "disp-ext",
			cwd: base,
			session_id: `vitrine.${id}`,
			session_name: `vitrine: test-agent · ${id.slice(0, 8)}`,
			mode: "tile",
			attended: false,
			workspace: 9,
			wall_timeout_s: 3600,
			inactivity_s: 600,
			auto_settle_s: 600,
			auto_settle_grace_s: 60,
			created_at: new Date().toISOString(),
			boot_id: P.currentBootId(),
		};
		await P.createTask(dir, spec, "probe\n");
		process.env.VITRINE_TASK_DIR = dir;
		const { api, tools } = fakePi();
		vitrine(api);
		// read-only task dir: writeResult must fail. (Root-fragile: as root the
		// write would succeed and the `rejects` assertion would fail opaquely —
		// the suite runs unprivileged.)
		await chmod(dir, 0o555);
		try {
			await expect(
				tools[0].execute!("call1", { answer: "x" }, new AbortController().signal, undefined, fakeCtx()),
			).rejects.toThrow();
			// nothing half-recorded: no done marker (the worker retries or the
			// wrapper's watchdogs settle it)
			expect(await P.readDoneMarker(dir)).toBeNull();
		} finally {
			delete process.env.VITRINE_TASK_DIR;
			await chmod(dir, 0o700); // afterAll's rm must be able to descend
		}
	});

	it("vitrine_done carries the TUI renderers and details.answer (v1.14)", async () => {
		const id = P.newTaskId();
		const dir = join(tasksRoot, id);
		const spec: P.TaskSpec = {
			task_id: id,
			agent: { name: "test-agent", body: "body\n" },
			dispatcher_session_id: "disp-ext",
			cwd: base,
			session_id: `vitrine.${id}`,
			session_name: `vitrine: test-agent · ${id.slice(0, 8)}`,
			mode: "tile",
			attended: false,
			workspace: 9,
			wall_timeout_s: 3600,
			inactivity_s: 600,
			auto_settle_s: 600,
			auto_settle_grace_s: 60,
			created_at: new Date().toISOString(),
			boot_id: P.currentBootId(),
		};
		await P.createTask(dir, spec, "probe\n");
		process.env.VITRINE_TASK_DIR = dir;
		const { api, tools } = fakePi();
		vitrine(api);
		const def = tools[0];
		expect(typeof def.renderCall).toBe("function");
		expect(typeof def.renderResult).toBe("function");
		const out = await def.execute!("call1", { answer: "the answer\n" }, new AbortController().signal, undefined, fakeCtx());
		// the recorded answer rides the result for the TUI renderer (persisted
		// in the session record — the keep-alive tile re-renders from it)
		expect(out.details).toEqual({ answer: "the answer\n" });
		// the model-facing ack is UNCHANGED (master-side result UX intact)
		expect(out.content[0].text).toContain("Done. The answer is recorded");
		delete process.env.VITRINE_TASK_DIR;
	});

	it("the registered renderers show the recorded answer as markdown (stub components)", async () => {
		const id = P.newTaskId();
		const dir = join(tasksRoot, id);
		const spec: P.TaskSpec = {
			task_id: id,
			agent: { name: "test-agent", body: "body\n" },
			dispatcher_session_id: "disp-ext",
			cwd: base,
			session_id: `vitrine.${id}`,
			session_name: `vitrine: test-agent · ${id.slice(0, 8)}`,
			mode: "tile",
			attended: false,
			workspace: 9,
			wall_timeout_s: 3600,
			inactivity_s: 600,
			auto_settle_s: 600,
			auto_settle_grace_s: 60,
			created_at: new Date().toISOString(),
			boot_id: P.currentBootId(),
		};
		await P.createTask(dir, spec, "probe\n");
		process.env.VITRINE_TASK_DIR = dir;
		const { api, tools } = fakePi();
		vitrine(api);
		const def = tools[0];
		const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
		const answer = "# Report\n\n- **one**\n";
		// result slot: header + the recorded answer as markdown, verbatim —
		// shown regardless of `expanded` (the v1.14 decision)
		const comp = def.renderResult!({ content: [], details: { answer } }, { expanded: false, isPartial: false }, theme);
		expect(comp.render(80).join("\n")).toContain("md:# Report");
		expect(comp.render(80).join("\n")).toContain(`✓ answer recorded (${answer.length} chars)`);
		// call slot: a one-line header, not the escaped-JSON argument
		const callLines = def.renderCall!({ answer }, theme).render(80);
		expect(callLines).toHaveLength(1);
		expect(callLines[0]).toContain("vitrine_done");
		expect(callLines[0]).toContain(`${answer.length} chars`);
		delete process.env.VITRINE_TASK_DIR;
	});

	it("a second vitrine_done on a settled task is an idempotent no-op (R12)", async () => {
		const id = P.newTaskId();
		const dir = join(tasksRoot, id);
		const spec: P.TaskSpec = {
			task_id: id,
			agent: { name: "test-agent", body: "body\n" },
			dispatcher_session_id: "disp-ext",
			cwd: base,
			session_id: `vitrine.${id}`,
			session_name: `vitrine: test-agent · ${id.slice(0, 8)}`,
			mode: "tile",
			attended: false,
			workspace: 9,
			wall_timeout_s: 3600,
			inactivity_s: 600,
			auto_settle_s: 600,
			auto_settle_grace_s: 60,
			created_at: new Date().toISOString(),
			boot_id: P.currentBootId(),
		};
		await P.createTask(dir, spec, "probe\n");
		process.env.VITRINE_TASK_DIR = dir;
		const { api, tools } = fakePi();
		vitrine(api);
		const sig = new AbortController().signal;
		const first = await tools[0].execute!("call1", { answer: "the first answer\n" }, sig, undefined, fakeCtx());
		expect(first.content[0].text).toContain("Done");
		const firstMarker = JSON.stringify(await P.readDoneMarker(dir));
		const firstResult = await readFile(join(dir, "result.md"), "utf8");
		const eventsBefore = (await P.readEvents(dir)).length;
		// the second call: the done marker is already written → the handler
		// short-circuits — no event, no state change, no re-recording (a
		// confused worker repeating the call gets an acknowledgement, not an
		// error — and a human-resumed session keeps talking without
		// re-settling)
		const second = await tools[0].execute!("call2", { answer: "a different answer\n" }, sig, undefined, fakeCtx());
		expect(second.content[0].text).toContain("Already settled");
		expect(second.content[0].text).toContain("no-op");
		expect((second.details as { noop?: boolean }).noop).toBe(true);
		expect(JSON.stringify(await P.readDoneMarker(dir))).toBe(firstMarker); // the original marker
		expect(await readFile(join(dir, "result.md"), "utf8")).toBe(firstResult); // not overwritten
		expect((await P.readEvents(dir)).length).toBe(eventsBefore); // no event
		delete process.env.VITRINE_TASK_DIR;
	});

	it("an invalid VITRINE_TASK_DIR refuses: no tool, stderr line, tail.log line", () => {
		// a UUID-shaped dir that does not exist
		process.env.VITRINE_TASK_DIR = join(tasksRoot, P.newTaskId());
		const { api, tools } = fakePi();
		const errLines: string[] = [];
		const origErr = process.stderr.write;
		process.stderr.write = ((chunk: unknown) => {
			errLines.push(String(chunk));
			return true;
		}) as typeof process.stderr.write;
		let threw: unknown = null;
		try {
			vitrine(api);
		} catch (e: unknown) {
			threw = e;
		} finally {
			process.stderr.write = origErr;
		}
		expect(threw).toBeNull(); // refusal is a warning, not a crash
		expect(tools).toHaveLength(0);
		expect(errLines.join("")).toContain("refusing worker mode");
	});

	it("a valid-but-empty task dir records the refusal in tail.log", async () => {
		const id = P.newTaskId();
		const dir = join(tasksRoot, id);
		process.env.VITRINE_TASK_DIR = dir;
		await mkdir(dir, { recursive: true, mode: 0o700 });
		const { api, tools } = fakePi();
		vitrine(api);
		expect(tools).toHaveLength(0);
		const tail = await readFile(join(dir, "tail.log"), "utf8").catch(() => "");
		expect(tail).toContain("worker-mode-refused");
	});
});

describe("dispatcher mode (cutover + the dispatch tool)", () => {
	it("registers vitrine_dispatch + vitrine_collect when the name is free", () => {
		delete process.env.VITRINE_TASK_DIR;
		const fake = fakePi();
		vitrine(fake.api);
		expect(fake.tools.map((t) => t.name)).toEqual(["vitrine_dispatch", "vitrine_collect"]);
		expect(fake.tools[0].parameters).toBeDefined();
		// the cutover guard runs at session_start (pi 0.85.1 exposes no
		// load-time introspection); with a free name it deactivates nothing
		fake.fire();
		expect(fake.setActiveToolsCalls).toHaveLength(0);
	});

	it("the cutover rule: a co-owned name is refused at session_start (deactivated + warned)", () => {
		delete process.env.VITRINE_TASK_DIR;
		const errLines: string[] = [];
		const origErr = process.stderr.write;
		process.stderr.write = ((chunk: unknown) => {
			errLines.push(String(chunk));
			return true;
		}) as typeof process.stderr.write;
		const fake = fakePi(["vitrine_dispatch", "vitrine_collect"], { coOwnerTools: ["vitrine_dispatch"] });
		try {
			vitrine(fake.api);
			// registration still happens at load (a registration cannot be
			// retracted in pi 0.85.1) — the session_start guard is the refusal
			expect(fake.tools.map((t) => t.name)).toEqual(["vitrine_dispatch", "vitrine_collect"]);
			fake.fire();
		} finally {
			process.stderr.write = origErr;
		}
		expect(fake.setActiveToolsCalls).toHaveLength(1);
		expect(fake.setActiveToolsCalls[0]).not.toContain("vitrine_dispatch");
		expect(fake.setActiveToolsCalls[0]).toContain("vitrine_collect"); // only the contested name is deactivated
		expect(errLines.join("")).toContain("cutover rule");
	});

	it("the cutover rule covers vitrine_collect too: a later-loaded owner shadows it (deactivated + warned)", () => {
		delete process.env.VITRINE_TASK_DIR;
		const errLines: string[] = [];
		const origErr = process.stderr.write;
		process.stderr.write = ((chunk: unknown) => {
			errLines.push(String(chunk));
			return true;
		}) as typeof process.stderr.write;
		// pi's name-keyed map is last-loaded wins: a later-loaded extension can
		// shadow EITHER dispatcher-side name — the guard checks both
		const fake = fakePi(["vitrine_dispatch", "vitrine_collect"], { coOwnerTools: ["vitrine_collect"] });
		try {
			vitrine(fake.api);
			fake.fire();
		} finally {
			process.stderr.write = origErr;
		}
		expect(fake.setActiveToolsCalls).toHaveLength(1);
		expect(fake.setActiveToolsCalls[0]).not.toContain("vitrine_collect");
		expect(fake.setActiveToolsCalls[0]).toContain("vitrine_dispatch"); // the free name keeps our registration
		expect(errLines.join("")).toContain("vitrine_collect");
		expect(errLines.join("")).toContain("cutover rule");
	});

	it("E2E (headless): the tool returns after the spawn pass — no wait, no harvest; the task settles on disk", async () => {
		delete process.env.VITRINE_TASK_DIR;
		// Make the compositor unreachable deterministically (headless
		// forced): without the instance signature hyprctl exits
		// non-zero ⇒ the probe reports unreachable ⇒ headless mode.
		const realSig = process.env.HYPRLAND_INSTANCE_SIGNATURE;
		delete process.env.HYPRLAND_INSTANCE_SIGNATURE;
		// a fresh, empty tasks root: earlier tests in this file leave `queued`
		// dirs (no live wrapper) that would count against the cap
		const realRoot = process.env.VITRINE_TASKS_ROOT;
		const e2eRoot = join(base, "e2e-tasks");
		await mkdir(e2eRoot, { recursive: true });
		process.env.VITRINE_TASKS_ROOT = e2eRoot;
		try {
			const fake = fakePi();
			const { api, tools } = fake;
			vitrine(api);
			const progress: string[] = [];
			const out = await tools[0].execute!(
				"call1",
				{ tasks: [{ agent: "test-agent", task: "say hi" }] },
				new AbortController().signal,
				(u) => progress.push(u.content.map((c) => c.text).join("\n")),
				fakeCtx(),
			);
			const returnedAt = Date.now();
			const text = out.content.map((c) => c.text).join("\n");
			// The R1 contract: the tool returns after the spawn pass — long
			// before the worker settles (the fixture takes ~1 s) — and it
			// carries no harvest and streams no progress
			expect(text).toContain("1 dispatched (non-blocking — each task's harvest will be reported on settlement, not in this result)");
			expect(text).toContain("the harvest will be reported on settlement");
			expect(progress.length).toBe(0);
			// the reported task: short id + the state at return time (the
			// wrapper flips queued→running on its own first tick)
			const m = text.match(/\[1\] test-agent · ([0-9a-f]{8}) — (running|queued)/);
			expect(m).not.toBeNull();
			const dirs = await P.listTaskDirs();
			const dir = dirs.find((d) => (d.split("/").pop() ?? "").startsWith(m![1]));
			expect(dir).toBeDefined();
			const taskId = dir!.split("/").pop()!;
			// drive the wait the way the session's watcher drives it (R2): the
			// task settles completed on disk (the fixture exits clean like real
			// pi's --print; the wrapper's settle records the session's last
			// assistant text as the on-disk harvest — result.md). The tool
			// result carries no harvest — the harvest arrives as the delivery.
			const w = await waitForTasks({
				ids: [taskId],
				mode: "headless",
				bunBin: () => process.env.VITRINE_BUN_BIN ?? "bun",
				lease: { owner: "disp-ext", nonce: "e2e" },
				deps: { tickMs: 150 },
			});
			expect(w.states[0].state).toBe("completed");
			// R11 (the strong timing assertion): the tool returned BEFORE the
			// settlement — the fixture settles ~1 s after the spawn pass, so a
			// reintroduced in-call wait would not return before `finished_at`
			// (a fixed wall-clock bound can't tell the two apart).
			const settled = await P.readState(dir!);
			expect(settled.finished_at).toBeDefined();
			expect(returnedAt).toBeLessThan(Date.parse(settled.finished_at!));
			const onDisk = await readFile(join(dir!, "result.md"), "utf8").catch(() => "");
			expect(onDisk).toContain("fixture finished the work");
			expect(text).not.toContain("fixture finished the work"); // the harvest never lands in the tool result
			// The session's watcher — armed by the dispatch call itself —
			// delivers the harvest on settlement: the async contract's E2E (the
			// delivery, not the tool result, carries the harvest; the
			// harvest-delivered marker lands after the successful send)
			const findHarvest = () =>
				fake.sentMessages.find(
					(m) => typeof (m.message as { content?: string }).content === "string" && (m.message as { content: string }).content.includes("fixture finished the work"),
				);
			const deadline = Date.now() + 8000;
			while (Date.now() < deadline && !findHarvest()) await new Promise((r) => setTimeout(r, 100));
			const harvest = findHarvest();
			expect(harvest).toBeDefined(); // the delivery landed
			const harvestMsg = harvest!.message as { customType: string; details: { batch: string } };
			expect(harvestMsg.customType).toBe("vitrine-harvest");
			expect(harvest!.options).toEqual({ deliverAs: "followUp", triggerTurn: true });
			expect(await P.harvestDeliveredId(dir!)).toBe(harvestMsg.details.batch); // the marker is written after the send
		} finally {
			process.env.VITRINE_TASKS_ROOT = realRoot;
			if (realSig === undefined) delete process.env.HYPRLAND_INSTANCE_SIGNATURE;
			else process.env.HYPRLAND_INSTANCE_SIGNATURE = realSig;
		}
	}, 30_000);

	it("E2E (wiring): session_start arms the watcher — a settled async task delivers via pi.sendMessage; session_shutdown closes it", async () => {
		delete process.env.VITRINE_TASK_DIR;
		// a fresh, empty tasks root: the shared root carries earlier tests' dirs
		const realRoot = process.env.VITRINE_TASKS_ROOT;
		const wireRoot = join(base, "wire-tasks");
		await mkdir(wireRoot, { recursive: true });
		process.env.VITRINE_TASKS_ROOT = wireRoot;
		try {
			const fake = fakePi();
			vitrine(fake.api);
			// a completed async task for this session (the fake ctx's session id),
			// undelivered — the session-start arm must REPLAY it (R5)
			const id = P.newTaskId();
			const dir = join(wireRoot, id);
			const spec: P.TaskSpec = {
				task_id: id,
				agent: { name: "test-agent", body: "body\n" },
				dispatcher_session_id: "disp-ext",
				cwd: base,
				session_id: `vitrine.${id}`,
				session_name: `vitrine: test-agent · ${id.slice(0, 8)}`,
				mode: "headless",
				attended: false,
				workspace: 9,
				wall_timeout_s: 3600,
				inactivity_s: 600,
				auto_settle_s: 600,
				auto_settle_grace_s: 60,
				async: true,
				created_at: new Date().toISOString(),
				boot_id: P.currentBootId(),
			};
			await P.createTask(dir, spec, "wiring prompt\n");
			await P.transitionState(dir, "queued", "running", { started_at: new Date(Date.now() - 42_000).toISOString() });
			await writeFile(join(dir, "result.md"), "the wiring answer\n");
			await P.transitionState(dir, "running", "completed", { finished_at: new Date().toISOString() });
			// session start → the watcher arms (the session-start scope: attach + replay)
			fake.fire();
			// the production tick is 1000 ms — the replay delivery lands well inside
			// the wait (the first loop pass runs before the first tick sleep)
			await new Promise((r) => setTimeout(r, 2500));
			expect(fake.sentMessages).toHaveLength(1);
			const { message, options } = fake.sentMessages[0] as { message: { customType: string; content: string }; options: Record<string, unknown> };
			expect(message.customType).toBe("vitrine-harvest");
			expect(message.content).toContain("the wiring answer");
			expect(message.content).toContain("replay: the session restarted"); // undelivered at session start
			expect(options).toEqual({ deliverAs: "followUp", triggerTurn: true });
			expect(await P.harvestDeliveredId(dir)).toBeTruthy(); // the marker is written after the send
			// session shutdown → the watcher closes (no send after it)
			fake.fireShutdown();
			await new Promise((r) => setTimeout(r, 1200));
			expect(fake.sentMessages).toHaveLength(1);
		} finally {
			process.env.VITRINE_TASKS_ROOT = realRoot;
		}
	}, 30_000);

	it("E2E (wiring): a FORKED session_start replays the pre-fork undelivered settlement (coalesced replay: message)", async () => {
		delete process.env.VITRINE_TASK_DIR;
		const realRoot = process.env.VITRINE_TASKS_ROOT;
		const forkRoot = join(base, "fork-tasks");
		await mkdir(forkRoot, { recursive: true });
		process.env.VITRINE_TASKS_ROOT = forkRoot;
		try {
			const fake = fakePi();
			vitrine(fake.api);
			// the pre-fork dispatcher's session id (the previous file's header id)
			const preForkId = P.newTaskId();
			const preForkFile = join(sessionsRoot, `fork-pre-${preForkId.slice(0, 8)}.jsonl`);
			const hdr: Record<string, unknown> = { type: "session", version: 3, id: preForkId, timestamp: new Date().toISOString(), cwd: base };
			await writeFile(preForkFile, JSON.stringify(hdr) + "\n");
			// a completed, undelivered async task dispatched BY the pre-fork session
			const id = P.newTaskId();
			const dir = join(forkRoot, id);
			const spec: P.TaskSpec = {
				task_id: id,
				agent: { name: "test-agent", body: "body\n" },
				dispatcher_session_id: preForkId,
				cwd: base,
				session_id: `vitrine.${id}`,
				session_name: `test-agent · ${id.slice(0, 8)}`,
				mode: "headless",
				attended: false,
				workspace: 9,
				wall_timeout_s: 3600,
				inactivity_s: 600,
				auto_settle_s: 600,
				auto_settle_grace_s: 60,
				async: true,
				created_at: new Date().toISOString(),
				boot_id: P.currentBootId(),
			};
			await P.createTask(dir, spec, "fork replay prompt\n");
			await P.transitionState(dir, "queued", "running", { started_at: new Date(Date.now() - 42_000).toISOString() });
			await writeFile(join(dir, "result.md"), "the pre-fork answer\n");
			await P.transitionState(dir, "running", "completed", { finished_at: new Date().toISOString() });
			// the FORKED session start (previousSessionFile → the ancestry + the replay arm)
			await fake.fire({ reason: "fork", previousSessionFile: preForkFile });
			// the replay is the arm's OWN message (immediately at arm) — lands well inside the wait
			await new Promise((r) => setTimeout(r, 2500));
			expect(fake.sentMessages).toHaveLength(1);
			const { message, options } = fake.sentMessages[0] as { message: { customType: string; content: string; details: { replay: boolean; batch: string } }; options: Record<string, unknown> };
			expect(message.customType).toBe("vitrine-harvest");
			expect(message.content).toContain("the pre-fork answer");
			expect(message.content).toContain("replay: the session restarted"); // undelivered at session start
			expect(message.details.replay).toBe(true);
			expect(options).toEqual({ deliverAs: "followUp", triggerTurn: true });
			expect(await P.harvestDeliveredId(dir)).toBe(message.details.batch); // the marker is written after the send
		} finally {
			process.env.VITRINE_TASKS_ROOT = realRoot;
		}
	}, 30_000);
});

describe("dispatch description (the roster is composed at load)", () => {
	it("composeDispatchDescription: mechanics + the fixture agent's roster line + the policy lines", () => {
		const d = composeDispatchDescription();
		// the mechanics paragraph stays the verbatim opening
		expect(d).toContain("Dispatch one or more tasks to specialist agents (pi agent files), each in its own visible workspace");
		// the fixture agent's roster line: name + the FIRST sentence of its description
		expect(d).toContain("- `test-agent`: fixture agent for the extension tests.");
		// the authored policy lines (R9: the dispatch names the collect — both tools point at each other)
		expect(d).toContain(
			"Dispatch when a side task would flood this context, for parallel mechanical units, or for an independent check; not for a single sequential unit or judgment work that needs the conversation.",
		);
		expect(d).toContain(
			"Dispatch returns immediately — each task's result arrives as a delivery on settlement; never act on a worker's result in the same turn you dispatched it, and never busy-wait for it. vitrine_collect is the on-demand pull for a result you want now", 
		);
		expect(d).toContain(
			"Project-local `.pi/agents/` agents shadow these when the project is trusted; an unknown-agent error lists the live roster.",
		);
	});

	it("an empty global agents dir: the roster lines are skipped, mechanics + policy stay", async () => {
		// the composition reads $HOME at call time, so a scoped override steers it
		const emptyHome = join(base, "empty-roster-home");
		await mkdir(emptyHome, { recursive: true });
		const home = process.env.HOME;
		process.env.HOME = emptyHome;
		try {
			const d = composeDispatchDescription();
			expect(d).toContain("Dispatch one or more tasks to specialist agents (pi agent files), each in its own visible workspace");
			expect(d).not.toContain("- `");
			expect(d).toContain("Dispatch when a side task would flood this context");
			expect(d).toContain("Project-local `.pi/agents/` agents shadow these when the project is trusted");
		} finally {
			process.env.HOME = home;
		}
	});

	it("the registered vitrine_dispatch carries the composed description (composed once at load)", () => {
		delete process.env.VITRINE_TASK_DIR;
		const fake = fakePi();
		vitrine(fake.api);
		expect(fake.tools[0].name).toBe("vitrine_dispatch");
		expect(fake.tools[0].description).toBe(composeDispatchDescription());
	});
});

// ---------------------------------------------------------------------------
// vitrine_collect (R6): the pull floor + the fork ancestry

describe("vitrine_collect (the pull floor + the fork ancestry)", () => {
	/** A session JSONL whose first line is the header (id, optional parentSession). */
	const writeSessionFile = (name: string, id: string, parentSession?: string): Promise<void> => {
		const hdr: Record<string, unknown> = { type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd: base };
		if (parentSession !== undefined) hdr.parentSession = parentSession;
		return writeFile(join(sessionsRoot, name), JSON.stringify(hdr) + "\n");
	};

	/** A completed, undelivered, async task dispatched by `dispatcher` (the session id in spec). */
	const mkCollectTask = async (answer: string, dispatcher: string): Promise<string> => {
		const id = P.newTaskId();
		const dir = join(tasksRoot, id);
		const spec: P.TaskSpec = {
			task_id: id,
			agent: { name: "test-agent", body: "body\n" },
			dispatcher_session_id: dispatcher,
			cwd: base,
			session_id: `vitrine.${id}`,
			session_name: `test-agent · ${id.slice(0, 8)}`,
			mode: "headless",
			attended: false,
			workspace: 9,
			wall_timeout_s: 3600,
			inactivity_s: 600,
			auto_settle_s: 600,
			auto_settle_grace_s: 60,
			async: true,
			created_at: new Date().toISOString(),
			boot_id: P.currentBootId(),
		};
		await P.createTask(dir, spec, "collect fork test prompt\n");
		await P.transitionState(dir, "queued", "running", { started_at: new Date(Date.now() - 42_000).toISOString() });
		await writeFile(join(dir, "result.md"), answer);
		await P.transitionState(dir, "running", "completed", { finished_at: new Date().toISOString() });
		return id;
	};

	const collectOf = (fake: { tools: RegisteredTool[] }): ((params?: Record<string, unknown>) => Promise<string>) => {
		const tool = fake.tools.find((t) => t.name === "vitrine_collect");
		expect(tool).toBeDefined();
		return async (params: Record<string, unknown> = {}) => {
			const out = await tool!.execute!("c1", params, new AbortController().signal, undefined, fakeCtx());
			return out.content.map((c) => c.text).join("\n");
		};
	};

	it("the collect description carries the doctrine (dispatch returns immediately; collect is the on-demand pull; never busy-poll)", () => {
		delete process.env.VITRINE_TASK_DIR;
		const fake = fakePi();
		vitrine(fake.api);
		const collect = fake.tools.find((t) => t.name === "vitrine_collect");
		expect(collect).toBeDefined();
		const d = collect!.description ?? "";
		// the doctrine: the pull floor, the never-blocks guarantee, the write semantics
		expect(d).toContain("Pull vitrine results on demand");
		expect(d).toContain("NEVER blocks on a running worker");
		expect(d).toContain("never busy-poll collect inside a turn");
		expect(d).toContain("writes the harvest-delivered marker");
		expect(d).toContain("headlined without a body");
	});

	/** Walk a typebox schema object for the first node with `type: "array"` (the Optional wrapper nests it under `anyOf`). */
	const findArraySchema = (node: unknown): Record<string, unknown> | null => {
		if (node === null || typeof node !== "object") return null;
		const o = node as Record<string, unknown>;
		if (o.type === "array") return o;
		for (const v of Object.values(o)) {
			const found = findArraySchema(v);
			if (found !== null) return found;
		}
		return null;
	};

	it("the ids param enforces the 1–8 bound (maxItems, matching vitrine_dispatch's surface)", () => {
		delete process.env.VITRINE_TASK_DIR;
		const fake = fakePi();
		vitrine(fake.api);
		const collect = fake.tools.find((t) => t.name === "vitrine_collect");
		expect(collect).toBeDefined();
		const arr = findArraySchema(collect!.parameters);
		expect(arr).not.toBeNull();
		// the description says 1–8 — the schema must say so too (enforced, not just documented)
		expect(arr!.minItems).toBe(1);
		expect(arr!.maxItems).toBe(8);
		expect(String(arr!.description ?? "")).toContain("1–8 task ids");
	});

	it("a fork's no-id collect finds the pre-fork task (the session_start fork ancestry)", async () => {
		delete process.env.VITRINE_TASK_DIR;
		const idA = P.newTaskId(); // the pre-fork dispatcher's session id (the file header id)
		const fileA = join(sessionsRoot, `pre-fork-${idA.slice(0, 8)}.jsonl`);
		await writeSessionFile(`pre-fork-${idA.slice(0, 8)}.jsonl`, idA);
		// a completed, undelivered task dispatched BY the pre-fork session
		const taskId = await mkCollectTask("the pre-fork answer\n", idA);
		const fake = fakePi();
		vitrine(fake.api);
		// session_start for the FORK: previousSessionFile = the pre-fork file
		await fake.fire({ reason: "fork", previousSessionFile: fileA });
		const collect = collectOf(fake);
		const text = await collect();
		// the task is in the no-id scope via the fork ancestry — the harvest rides the fixed wrapper
		expect(text).toContain("scope: this session + 1 fork ancestor(s)");
		expect(text).toContain("the pre-fork answer");
		expect(text).toContain(`test-agent · ${taskId.slice(0, 8)} — completed`);
		// and it is marked delivered (the collect is a delivery) — the marker lands
		expect(await P.harvestDeliveredId(join(tasksRoot, taskId))).toBeTruthy();
	});

	it("the fork ancestry chains through the parentSession header (a fork of a fork)", async () => {
		delete process.env.VITRINE_TASK_DIR;
		const idA = P.newTaskId();
		const idB = P.newTaskId();
		const fileA = join(sessionsRoot, `chain-a-${idA.slice(0, 8)}.jsonl`);
		const fileB = join(sessionsRoot, `chain-b-${idB.slice(0, 8)}.jsonl`);
		await writeSessionFile(`chain-a-${idA.slice(0, 8)}.jsonl`, idA);
		await writeSessionFile(`chain-b-${idB.slice(0, 8)}.jsonl`, idB, fileA);
		// tasks dispatched by TWO different ancestors (idB and idA)
		const taskB = await mkCollectTask("the mid-ancestor answer\n", idB);
		const taskA = await mkCollectTask("the root-ancestor answer\n", idA);
		const fake = fakePi();
		vitrine(fake.api);
		// the fork's previousSessionFile is the immediate predecessor (fileB);
		// its header's parentSession chains back to fileA (a fork of a fork)
		await fake.fire({ reason: "fork", previousSessionFile: fileB });
		const collect = collectOf(fake);
		const text = await collect();
		// both ancestors are in the resolved chain (idB + idA)
		expect(text).toContain("scope: this session + 2 fork ancestor(s)");
		expect(text).toContain("the mid-ancestor answer");
		expect(text).toContain(`test-agent · ${taskB.slice(0, 8)} — completed`);
		expect(text).toContain("the root-ancestor answer");
		expect(text).toContain(`test-agent · ${taskA.slice(0, 8)} — completed`);
	});

	it("a non-fork session_start records no ancestry (session-scoped); explicit ids still cross sessions", async () => {
		delete process.env.VITRINE_TASK_DIR;
		const foreign = P.newTaskId(); // a session id that is NOT the current one and NOT a fork ancestor
		const taskId = await mkCollectTask("the foreign-session answer\n", foreign);
		const fake = fakePi();
		vitrine(fake.api);
		// a PLAIN startup (no fork) — the ancestry is empty
		await fake.fire({ reason: "startup" });
		const collect = collectOf(fake);
		// no ids: the foreign task is OUT of scope (the scope is this session only)
		const noScope = await collect();
		expect(noScope).toContain("scope: this session");
		expect(noScope).not.toContain("the foreign-session answer");
		// an explicit id crosses any session — the task is found + marked
		const byId = await collect({ ids: [taskId.slice(0, 8)] });
		expect(byId).toContain("scope: explicit ids");
		expect(byId).toContain("the foreign-session answer");
		expect(await P.harvestDeliveredId(join(tasksRoot, taskId))).toBeTruthy();
	});
});
