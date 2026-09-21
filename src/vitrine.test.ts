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

function fakePi(activeTools: string[] = [], opts: { coOwner?: boolean } = {}) {
	const tools: RegisteredTool[] = [];
	const sessionStart: Array<() => void> = [];
	const setActiveToolsCalls: string[][] = [];
	const api: ExtensionAPI = {
		registerTool: (def) => {
			tools.push(def as RegisteredTool);
		},
		on: (event: string, handler: () => void) => {
			if (event === "session_start") sessionStart.push(handler);
		},
		getActiveTools: () => activeTools,
		getAllTools: () =>
			[
				{
					name: "vitrine_dispatch",
					// pi's tool map is name-keyed (last-loaded wins): the single
					// entry's sourceInfo.path is whoever currently owns the name
					// — this file when free, the co-owner's file when contested
					sourceInfo: { path: opts.coOwner ? coOwnerPath : ownEntryPath },
				},
			],
		setActiveTools: (names: string[]) => {
			setActiveToolsCalls.push(names);
		},
		getSessionName: () => "test",
	} as ExtensionAPI;
	return {
		api,
		tools,
		setActiveToolsCalls,
		// test seam: fire the session_start handlers (pi does this after load)
		fire: () => {
			for (const h of sessionStart) h();
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
	it("registers vitrine_dispatch when the name is free", () => {
		delete process.env.VITRINE_TASK_DIR;
		const fake = fakePi();
		vitrine(fake.api);
		expect(fake.tools.map((t) => t.name)).toEqual(["vitrine_dispatch"]);
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
		const fake = fakePi([], { coOwner: true });
		try {
			vitrine(fake.api);
			// registration still happens at load (a registration cannot be
			// retracted in pi 0.85.1) — the session_start guard is the refusal
			expect(fake.tools.map((t) => t.name)).toEqual(["vitrine_dispatch"]);
			fake.fire();
		} finally {
			process.stderr.write = origErr;
		}
		expect(fake.setActiveToolsCalls).toHaveLength(1);
		expect(fake.setActiveToolsCalls[0]).not.toContain("vitrine_dispatch");
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
			const { api, tools } = fakePi();
			vitrine(api);
			const progress: string[] = [];
			const started = Date.now();
			const out = await tools[0].execute!(
				"call1",
				{ tasks: [{ agent: "test-agent", task: "say hi" }] },
				new AbortController().signal,
				(u) => progress.push(u.content.map((c) => c.text).join("\n")),
				fakeCtx(),
			);
			const text = out.content.map((c) => c.text).join("\n");
			// The R1 contract: the tool returns after the spawn pass — long
			// before the worker settles (the fixture takes ~1 s) — and it
			// carries no harvest and streams no progress
			expect(Date.now() - started).toBeLessThan(2000);
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
			// assistant text as the on-disk harvest — result.md), and no
			// delivery has happened yet (the watcher — unit 2 — writes the
			// harvest-delivered marker; the gc-skip keeps the dir until then)
			const w = await waitForTasks({
				ids: [taskId],
				mode: "headless",
				bunBin: () => process.env.VITRINE_BUN_BIN ?? "bun",
				lease: { owner: "disp-ext", nonce: "e2e" },
				deps: { tickMs: 150 },
			});
			expect(w.states[0].state).toBe("completed");
			const onDisk = await readFile(join(dir!, "result.md"), "utf8").catch(() => "");
			expect(onDisk).toContain("fixture finished the work");
			expect(text).not.toContain("fixture finished the work"); // the harvest never lands in the tool result
			expect(await P.harvestDeliveredId(dir!)).toBeNull();
		} finally {
			process.env.VITRINE_TASKS_ROOT = realRoot;
			if (realSig === undefined) delete process.env.HYPRLAND_INSTANCE_SIGNATURE;
			else process.env.HYPRLAND_INSTANCE_SIGNATURE = realSig;
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
		// the authored policy lines
		expect(d).toContain(
			"Dispatch when a side task would flood this context, for parallel mechanical units, or for an independent check; not for a single sequential unit or judgment work that needs the conversation.",
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
