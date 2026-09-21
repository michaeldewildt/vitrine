/**
 * dispatch.test.ts — the dispatch tool suite:
 * admission (2 + in-call queue across a foreign running task; the
 * self-deadlock batch), reconciliation (stuck-queued settle + the
 * `kill_requested` interaction; deferred harvest), exact argv-array spawn
 * construction, result format + caps + 0600 overflow, abort-hook marking.
 *
 * Hermetic: HOME/VITRINE_TASKS_ROOT/VITRINE_SESSIONS_DIR point at a tmp dir;
 * the compositor is injected (no hyprland); headless E2E runs the REAL
 * wrapper against the fixture pi (VITRINE_PI_BIN → fake-pi script).
 */
import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as P from "./protocol";
import * as C from "./config";
import { makeBase, type TestBase } from "../test/helpers";
import {
	DispatchError,
	WORKER_APP_ID,
	countSlots,
	dispatchTasks,
	findDispatcherWindow,
	findPanelInWindows,
	focusWindowByPid,
	harvestTask,
	listAllWindows,
	listWorkerWindows,
	pendingDispatchedIds,
	probeCompositor,
	readActiveWindow,
	readPpid,
	renderReport,
	spawnTileWithJoin,
	tileSpawnArgv,
	toggleGroup,
	type DispatchDeps,
	type DispatchedTaskResult,
	type DispatcherInfo,
	type HyprctlResult,
	type WorkerWindow,
} from "./dispatch";

let tb: TestBase;
let base: string;
let tasksRoot: string;
let sessionsRoot: string;
let realHome: string;
const fixturePi = join(import.meta.dir, "..", "test", "fixtures", "fake-pi.ts");
const bunBinPath = process.execPath;
// DispatchOptions.bunBin is a THUNK (resolved lazily at the first headless
// spawn; tile never resolves it). The tests pass this thunk as `bunBin`.
const bunBin = (): string => bunBinPath;

beforeAll(async () => {
	tb = await makeBase("dispatch");
	base = tb.base;
	realHome = process.env.HOME ?? "";
	process.env.HOME = base;
	tasksRoot = join(base, "tasks");
	sessionsRoot = join(base, "sessions");
	process.env.VITRINE_SESSIONS_DIR = sessionsRoot;
	await mkdir(sessionsRoot, { recursive: true });
	await writeFile(join(sessionsRoot, "disp.jsonl"), JSON.stringify({ type: "session_info", id: "disp-test", cwd: base }) + "\n");
	// the dispatcher's own session file (context: "parent" reads it)
	// agents dir (global)
	const agentsDir = join(base, ".pi", "agent", "agents");
	await mkdir(agentsDir, { recursive: true });
	await writeFile(
		join(agentsDir, "test-agent.md"),
		"---\nname: test-agent\ndescription: fixture agent for dispatch tests. Surplus sentence never shown.\nmodel: ninfer/fm-model\ntools: read,grep\ninactivityTimeout: 120\n---\n# Fixture agent\n\nYou are the fixture test agent.\n",
	);
	// config with the defaults (max_concurrent = 2 — the 2+2 tests rely on it)
	C.readConfigSync();
	// the fixture pi as a command
	const fakePiBin = join(base, "fake-pi");
	writeFileSync(fakePiBin, `#!/bin/sh\nexec ${bunBinPath} ${fixturePi} "$@"\n`);
	chmodSync(fakePiBin, 0o755);
	process.env.VITRINE_PI_BIN = fakePiBin;
});

afterAll(async () => {
	process.env.HOME = realHome;
	delete process.env.VITRINE_SESSIONS_DIR;
	delete process.env.VITRINE_PI_BIN;
	if (process.env.VITRINE_KEEP_BASE) {
		console.log(`[debug] keeping base: ${base}`);
		return;
	}
	await tb.close();
});

const info = (): DispatcherInfo => ({
	sessionId: "disp-test",
	sessionFile: join(sessionsRoot, "disp.jsonl"),
	model: "ninfer/dispatcher-model",
	cwd: base,
	projectTrusted: false,
});

/** Injectable deps: fast ticks; the compositor + hyprctl default to fakes. */
function deps(over: Partial<DispatchDeps> = {}): DispatchDeps {
	return {
		tickMs: 150,
		// zero-cost map-wait for the legacy tile-spawn tests (the juggle tests
		// set their own budget + fake clock)
		mapWaitMs: 1,
		mapWaitTickMs: 1,
		sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
		...over,
	};
}

/** A spec good enough for createTask (mode "tile" — ghost tasks never spawn). */
function ghostSpec(id: string): P.TaskSpec {
	return {
		task_id: id,
		agent: { name: "test-agent", body: "ghost body\n" },
		dispatcher_session_id: "disp-ghost",
		cwd: base,
		session_id: `vitrine.${id}`,
		session_name: `test-agent · ${id.slice(0, 8)}`,
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
}

async function createGhostTask(): Promise<string> {
	const id = P.newTaskId();
	const dir = join(tasksRoot, id);
	await P.createTask(dir, ghostSpec(id), "ghost prompt\n");
	return dir;
}

/** A foreign RUNNING task with a live wrapper pid (a real `sleep` process). */
async function spawnForeignRunning(liveMs = 40_000): Promise<{ dir: string; pid: number }> {
	const dir = await createGhostTask();
	const proc = spawn("sleep", [String(liveMs / 1000)], { detached: true, stdio: "ignore" });
	proc.unref();
	const pid = proc.pid!;
	const pinfo = P.pidInfo(pid);
	await P.transitionState(
		dir,
		"queued",
		"running",
		{ wrapper_pid: pid, wrapper_pid_start: pinfo.startTime, started_at: new Date().toISOString() },
		"spawned (test ghost)",
	);
	return { dir, pid };
}

async function rejectsDispatch(code: string, fn: () => Promise<unknown>): Promise<string> {
	try {
		await fn();
	} catch (e) {
		if (e instanceof P.ProtocolError && e.code === code) return String(e);
		throw new Error(`expected code '${code}', got: ${String(e)}`);
	}
	throw new Error(`expected code '${code}', resolved instead`);
}

// ---------------------------------------------------------------------------

describe("surface validation", () => {
	it("rejects an empty batch and a batch over 8 (bad-input)", async () => {
		const one = [{ agent: "test-agent", task: "t" }];
		await rejectsDispatch("bad-input", () => dispatchTasks({ tasks: [], mode: "tile", dispatcher: info(), bunBin, deps: deps({ hyprctl: async () => ({ code: 0, stdout: "", stderr: "" }) }) }));
		await rejectsDispatch("bad-input", () =>
			dispatchTasks({ tasks: Array.from({ length: 9 }, () => one[0]), mode: "tile", dispatcher: info(), bunBin, deps: deps({ hyprctl: async () => ({ code: 0, stdout: "", stderr: "" }) }) }),
		);
	});

	it("rejects an empty agent / empty task / from+context / relative cwd (bad-input)", async () => {
		const h = { hyprctl: async (): Promise<HyprctlResult> => ({ code: 0, stdout: "", stderr: "" }) };
		const d = deps({ hyprctl: h.hyprctl });
		await rejectsDispatch("bad-input", () => dispatchTasks({ tasks: [{ agent: "", task: "t" }], mode: "tile", dispatcher: info(), bunBin, deps: d }));
		await rejectsDispatch("bad-input", () => dispatchTasks({ tasks: [{ agent: "test-agent", task: "" }], mode: "tile", dispatcher: info(), bunBin, deps: d }));
		await rejectsDispatch("bad-input", () => dispatchTasks({ tasks: [{ agent: "test-agent", task: "t", from: "abc", context: "parent" }], mode: "tile", dispatcher: info(), bunBin, deps: d }));
		await rejectsDispatch("bad-input", () => dispatchTasks({ tasks: [{ agent: "test-agent", task: "t", cwd: "relative/path" }], mode: "tile", dispatcher: info(), bunBin, deps: d }));
	});

	it("rejects a non-positive max_cost_usd (bad-input)", async () => {
		const h = { hyprctl: async (): Promise<HyprctlResult> => ({ code: 0, stdout: "", stderr: "" }) };
		const d = deps({ hyprctl: h.hyprctl });
		await rejectsDispatch("bad-input", () => dispatchTasks({ tasks: [{ agent: "test-agent", task: "t", max_cost_usd: 0 }], mode: "tile", dispatcher: info(), bunBin, deps: d }));
		await rejectsDispatch("bad-input", () => dispatchTasks({ tasks: [{ agent: "test-agent", task: "t", max_cost_usd: -1 }], mode: "tile", dispatcher: info(), bunBin, deps: d }));
	});

	it("an unknown agent is a bad-agent that lists the available names", async () => {
		const msg = await rejectsDispatch("bad-agent", () =>
			dispatchTasks({ tasks: [{ agent: "nope", task: "t" }], mode: "tile", dispatcher: info(), bunBin, deps: deps({ hyprctl: async () => ({ code: 0, stdout: "", stderr: "" }) }) }),
		);
		expect(msg).toContain("unknown agent 'nope'");
		expect(msg).toContain("test-agent");
		// the listing carries each agent's one-line description — the first
		// sentence of the frontmatter description, not the whole field
		expect(msg).toContain("test-agent: fixture agent for dispatch tests.");
		expect(msg).not.toContain("Surplus sentence");
	});
});

describe("source guards (terminal + session.json)", () => {
	it("'from' a non-terminal task is rejected (bad-input)", async () => {
		const { dir, pid } = await spawnForeignRunning();
		const dirName = dir.split("/").pop()!;
		const msg = await rejectsDispatch("bad-input", () =>
			dispatchTasks({ tasks: [{ agent: "test-agent", task: "t", from: dirName }], mode: "tile", dispatcher: info(), bunBin, deps: deps({ hyprctl: async () => ({ code: 0, stdout: "", stderr: "" }) }) }),
		);
		expect(msg).toContain("only terminal tasks may be forked");
		process.kill(pid, "SIGTERM");
	});

	it("'from' a terminal task without session.json is rejected (bad-input)", async () => {
		const dir = await createGhostTask();
		await P.transitionState(dir, "queued", "running", { started_at: new Date().toISOString() });
		await P.transitionState(dir, "running", "completed", { finished_at: new Date().toISOString() });
		const dirName = dir.split("/").pop()!;
		const msg = await rejectsDispatch("bad-input", () =>
			dispatchTasks({ tasks: [{ agent: "test-agent", task: "t", from: dirName }], mode: "tile", dispatcher: info(), bunBin, deps: deps({ hyprctl: async () => ({ code: 0, stdout: "", stderr: "" }) }) }),
		);
		expect(msg).toContain("no session.json");
	});

	it("'context: parent' with a missing session file is rejected (bad-input)", async () => {
		const dinfo = info();
		dinfo.sessionFile = join(sessionsRoot, "missing.jsonl");
		await rejectsDispatch("bad-input", () =>
			dispatchTasks({ tasks: [{ agent: "test-agent", task: "t", context: "parent" }], mode: "tile", dispatcher: dinfo, bunBin, deps: deps({ hyprctl: async () => ({ code: 0, stdout: "", stderr: "" }) }) }),
		);
	});
});

describe("spawn construction (exact argv array)", () => {
	it("tile: a direct-executable run_path", () => {
		const argv = tileSpawnArgv("test-agent", "a1b2c3d4-0000-0000-0000-000000000000", { command: "/home/u/.local/bin/vitrine-run", args: [], source: "local-bin" }, "/tmp/tasks/xyz");
		expect(argv).toEqual(["dispatch", `hl.dsp.exec_cmd("foot -T 'test-agent a1b2c3d4' --app-id vitrine-worker -- /home/u/.local/bin/vitrine-run /tmp/tasks/xyz")`]);
	});

	it("tile: the bun + script run_path carries both", () => {
		const argv = tileSpawnArgv("test-agent", "a1b2c3d4-0000-0000-0000-000000000000", { command: "/usr/bin/bun", args: ["/repo/src/vitrine-run.ts"], source: "in-place" }, "/tmp/tasks/xyz");
		expect(argv).toEqual(["dispatch", `hl.dsp.exec_cmd("foot -T 'test-agent a1b2c3d4' --app-id vitrine-worker -- /usr/bin/bun /repo/src/vitrine-run.ts /tmp/tasks/xyz")`]);
	});

	it("probeCompositor: code 0 is reachable, non-zero / rejection is not", async () => {
		expect(await probeCompositor({ hyprctl: async () => ({ code: 0, stdout: "", stderr: "" }) })).toBe(true);
		expect(await probeCompositor({ hyprctl: async () => ({ code: 1, stdout: "", stderr: "no" }) })).toBe(false);
		expect(await probeCompositor({ hyprctl: async () => {
			throw new Error("ENOENT");
		} })).toBe(false);
	});
});

describe("spawn failure settles immediately (failed-to-spawn)", () => {
	it("a non-zero hyprctl settle crashes/failed-to-spawn without waiting out the window", async () => {
		const t0 = Date.now();
		// Make the tile run_path resolvable (a direct-executable local-bin) so
		// the spawn path reaches the hyprctl call — otherwise resolveRunPath
		// throws first and the test passes for the wrong reason (B1's lesson).
		const localBinDir = join(process.env.HOME!, ".local", "bin");
		mkdirSync(localBinDir, { recursive: true });
		const localBin = join(localBinDir, "vitrine-run");
		writeFileSync(localBin, "#!/bin/sh\nexit 0\n");
		chmodSync(localBin, 0o755);
		// B1: the tile spawn must call THIS hyprctl (the dispatcher's spawn
		// transport) — not a stray `readCompositor`. Count the calls to prove
		// the injected stub is the one that ran (the real `hyprctl -j` throws
		// on this box, so a stray call would mask a broken spawn path).
		let hyprctlCalls = 0;
		try {
			const r = await dispatchTasks({
				tasks: [{ agent: "test-agent", task: "spawn me" }],
				mode: "tile",
				dispatcher: info(),
				bunBin,
				deps: deps({
					hyprctl: async (args) => {
						hyprctlCalls++;
						return { code: 1, stdout: "", stderr: "compositor down" };
					},
				}),
			});
			expect(Date.now() - t0).toBeLessThan(3000);
			expect(hyprctlCalls).toBeGreaterThan(0);
			expect(r.results[0].state).toBe("crashed");
			expect(r.results[0].reason).toBe("failed-to-spawn");
			const events = (await P.readEvents(join(tasksRoot, r.results[0].id))).map((e: Record<string, unknown>) => e.event);
			// a code-1 hyprctl (no throw) takes the ok=false path ⇒ `failed-to-spawn`
			// (the `spawn-failed` event is the throw/catch path — e.g. resolveRunPath)
			expect(events).toContain("failed-to-spawn");
		} finally {
			// do NOT leak the local-bin into later tests — a headless dispatch
			// would otherwise spawn this stub (which exits 0 without running the
			// wrapper) instead of the in-place real wrapper.
			rmSync(localBin, { force: true });
		}
	});

	it("tile mode never evaluates the bunBin thunk (a broken headless bun PATH must not break tiling)", async () => {
		const localBinDir = join(process.env.HOME!, ".local", "bin");
		mkdirSync(localBinDir, { recursive: true });
		const localBin = join(localBinDir, "vitrine-run");
		writeFileSync(localBin, "#!/bin/sh\nexit 0\n");
		chmodSync(localBin, 0o755);
		// abort after a beat: the spawn has happened by then; the call leaves
		// without waiting out the 15 s stuck-queued window
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 300);
		let hyprctlCalls = 0;
		try {
			const r = await dispatchTasks({
				tasks: [{ agent: "test-agent", task: "spawn me" }],
				mode: "tile",
				dispatcher: info(),
				// throws if evaluated: the tile's run_path is a direct executable
				// (the compositor's sh -c layer cannot be trusted to resolve bun),
				// so tile mode must not resolve the headless bun binary
				bunBin: () => {
					throw new Error("the bunBin thunk must not be evaluated in tile mode");
				},
				deps: deps({
					signal: controller.signal,
					hyprctl: async () => {
						hyprctlCalls++;
						return { code: 0, stdout: "", stderr: "" };
					},
				}),
			});
			// if the thunk had been evaluated, doSpawn would have thrown ⇒ the
			// spawn-failed (throw/catch) path settled before the hyprctl call.
			// Reaching the transport + no spawn-failed event proves the thunk
			// stayed unevaluated.
			expect(hyprctlCalls).toBeGreaterThan(0);
			expect(r.aborted).toBe(true);
			const events = (await P.readEvents(join(tasksRoot, r.results[0].id))).map((e: Record<string, unknown>) => e.event);
			expect(events).not.toContain("spawn-failed");
		} finally {
			clearTimeout(timer);
			rmSync(localBin, { force: true });
			// the tile task never settles (hyprctl was stubbed, no wrapper ran):
			// remove it so the residual queued dir cannot consume a slot in the
			// admission tests that follow
			for (const dir of await P.listTaskDirs()) {
				const st = await P.readState(dir).catch(() => null);
				if (st !== null && !P.isTerminal(st.state)) await P.removeTask(dir);
			}
		}
	});
});

// ---------------------------------------------------------------------------
// join juggle (grouping in v1)

/** A scripted hyprctl for juggle tests; records every call. `focusCode`
 * scripts the `hl.dsp.focus(...)` calls, `toggleCode` the
 * `hl.dsp.group.toggle()` call. */
function fakeJuggleHyprctl(state: {
	clients: () => unknown;
	active: () => unknown;
	focusCode?: number;
	toggleCode?: number;
}): { hyprctl: (args: string[]) => Promise<HyprctlResult>; calls: string[][] } {
	const calls: string[][] = [];
	const hyprctl = async (args: string[]): Promise<HyprctlResult> => {
		calls.push(args);
		if (args[0] === "clients") return { code: 0, stdout: JSON.stringify(state.clients()), stderr: "" };
		if (args[0] === "activewindow") return { code: 0, stdout: JSON.stringify(state.active()), stderr: "" };
		if (args[0] === "dispatch") {
			if ((args[1] ?? "").includes("group.toggle")) return { code: state.toggleCode ?? 0, stdout: "", stderr: "" };
			return { code: state.focusCode ?? 0, stdout: "", stderr: "" };
		}
		throw new Error(`unexpected hyprctl args: ${args.join(" ")}`);
	};
	return { hyprctl, calls };
}

/** A deterministic clock + sleep for the map-wait. */
function fakeClock(): { now: () => number; sleep: (ms: number) => Promise<void> } {
	let t = 0;
	return { now: () => t, sleep: async (ms) => { t += ms; } };
}

const workerWin = (pid: number, grouped: string[] = ["0xg"]) => ({ pid, class: WORKER_APP_ID, grouped });
/** The main-agent panel (the dispatcher's own foot window). */
const panelWin = (pid: number, grouped: string[] = []) => ({ pid, class: "foot", grouped });
/** A pid chain ending at panel pid 200: start 100 → 150 → 200 (window). */
const PANEL_DEPS = { startPid: 100, ppidOf: (p: number) => (p === 100 ? 150 : p === 150 ? 200 : null) };
/** A dead chain (no window on it) — the v1.9 degradation path. */
const NO_PANEL = { startPid: 100, ppidOf: () => null };

describe("join juggle v2 — spawnTileWithJoin (main-agent group)", () => {
	it("first tile: the panel becomes a group right before the spawn (focus + toggle before the spawn, restore after the map)", async () => {
		const clock = fakeClock();
		let clientsCalls = 0;
		let spawnAt = -1;
		const { hyprctl, calls } = fakeJuggleHyprctl({
			clients: () => {
				clientsCalls++;
				// before the spawn: an ungrouped panel, no workers; after it:
				// the panel's group + the joined worker
				return clientsCalls >= 3 ? [panelWin(200, ["0xP"]), workerWin(333, ["0xP"])] : [panelWin(200)];
			},
			active: () => ({ pid: 111, class: "foot", grouped: [] }),
		});
		const r = await spawnTileWithJoin(
			async () => {
				spawnAt = calls.length;
				return true;
			},
			{ hyprctl, ...clock, mapWaitMs: 500, mapWaitTickMs: 100, panel: PANEL_DEPS },
		);
		expect(r).toEqual({ spawnOk: true, join: { joinedFocus: true, mapped: true, restored: true } });
		const iFocus = calls.findIndex((a) => a[0] === "dispatch" && a[1]?.includes("pid:200"));
		const iToggle = calls.findIndex((a) => a[0] === "dispatch" && a[1]?.includes("group.toggle"));
		const iRestore = calls.findIndex((a) => a[0] === "dispatch" && a[1]?.includes("pid:111"));
		// the panel is focused BEFORE the toggle (the toggle acts on the
		// active window — it must never act on the user's window)
		expect(iFocus).toBeGreaterThanOrEqual(0);
		expect(iFocus).toBeLessThan(iToggle);
		// …and both before the spawn; the restore only after it
		expect(iToggle).toBeLessThan(spawnAt);
		expect(iRestore).toBeGreaterThan(spawnAt);
	});

	it("P0 is the panel itself: toggle in place — no focus call, no restore", async () => {
		const clock = fakeClock();
		let clientsCalls = 0;
		const { hyprctl, calls } = fakeJuggleHyprctl({
			clients: () => {
				clientsCalls++;
				return clientsCalls >= 3 ? [panelWin(200, ["0xP"]), workerWin(333, ["0xP"])] : [panelWin(200)];
			},
			active: () => ({ pid: 200, class: "foot", grouped: [] }),
		});
		const r = await spawnTileWithJoin(async () => true, { hyprctl, ...clock, mapWaitMs: 500, mapWaitTickMs: 100, panel: PANEL_DEPS });
		expect(r).toEqual({ spawnOk: true, join: { joinedFocus: true, mapped: true, restored: false } });
		// exactly one dispatch call: the toggle itself
		expect(calls.filter((a) => a[0] === "dispatch")).toEqual([[
			"dispatch",
			"hl.dsp.group.toggle()",
		]]);
	});

	it("panel already grouped, P0 elsewhere: focus the panel's group — no toggle", async () => {
		const clock = fakeClock();
		const { hyprctl, calls } = fakeJuggleHyprctl({
			clients: () => [panelWin(200, ["0xP"]), workerWin(222, ["0xP"])],
			active: () => ({ pid: 111, class: "foot", grouped: [] }),
		});
		const r = await spawnTileWithJoin(async () => true, { hyprctl, ...clock, mapWaitMs: 300, mapWaitTickMs: 100, panel: PANEL_DEPS });
		expect(r).toEqual({ spawnOk: true, join: { joinedFocus: true, mapped: false, restored: true } });
		const focusCalls = calls.filter((a) => a[0] === "dispatch");
		expect(focusCalls.map((a) => a[1])).toEqual([
			'hl.dsp.focus({ window = "pid:200" })',
			'hl.dsp.focus({ window = "pid:111" })',
		]);
	});

	it("P0 is a worker in the panel's group: re-assert the panel's focus for the join, no restore", async () => {
		// 2026-09-19 five-spawn repro: the `set` join resolves against the
		// group focused at MAP time, so focus is re-asserted for EVERY spawn
		// — a join makes the new tile the group's active window and
		// follow_mouse can move focus on the back-to-back map events.
		const clock = fakeClock();
		const { hyprctl, calls } = fakeJuggleHyprctl({
			clients: () => [panelWin(200, ["0xP"]), workerWin(222, ["0xP"])],
			active: () => ({ pid: 222, class: WORKER_APP_ID, grouped: ["0xP"] }),
		});
		const r = await spawnTileWithJoin(async () => true, { hyprctl, ...clock, mapWaitMs: 300, mapWaitTickMs: 100, panel: PANEL_DEPS });
		expect(r).toEqual({ spawnOk: true, join: { joinedFocus: true, mapped: false, restored: false } });
		expect(calls.filter((a) => a[0] === "dispatch").map((a) => a[1])).toEqual(['hl.dsp.focus({ window = "pid:200" })']);
	});

	it("P0 is a worker in a legacy (v1.9) group: juggle to the panel's group", async () => {
		const clock = fakeClock();
		const { hyprctl, calls } = fakeJuggleHyprctl({
			clients: () => [panelWin(200, ["0xP"]), workerWin(222, ["0xW"])],
			active: () => ({ pid: 222, class: WORKER_APP_ID, grouped: ["0xW"] }),
		});
		const r = await spawnTileWithJoin(async () => true, { hyprctl, ...clock, mapWaitMs: 300, mapWaitTickMs: 100, panel: PANEL_DEPS });
		expect(r).toEqual({ spawnOk: true, join: { joinedFocus: true, mapped: false, restored: true } });
		const focusCalls = calls.filter((a) => a[0] === "dispatch");
		expect(focusCalls.map((a) => a[1])).toEqual([
			'hl.dsp.focus({ window = "pid:200" })',
			'hl.dsp.focus({ window = "pid:222" })',
		]);
	});

	it("panel undiscoverable (no window on the pid chain): v1.9 degradation — no group call, spawn proceeds", async () => {
		const clock = fakeClock();
		const { hyprctl, calls } = fakeJuggleHyprctl({
			clients: () => [workerWin(222)],
			active: () => ({ pid: 111, class: "foot", grouped: [] }),
		});
		const r = await spawnTileWithJoin(async () => true, { hyprctl, ...clock, mapWaitMs: 300, mapWaitTickMs: 100, panel: NO_PANEL });
		expect(r).toEqual({ spawnOk: true, join: { joinedFocus: false, mapped: false, restored: false } });
		expect(calls.filter((a) => a[0] === "dispatch")).toEqual([]);
	});

	it("panel focus fails: NO toggle — the toggle must never act on the user's window", async () => {
		const clock = fakeClock();
		const { hyprctl, calls } = fakeJuggleHyprctl({
			clients: () => [panelWin(200)],
			active: () => ({ pid: 111, class: "foot", grouped: [] }),
			focusCode: 1,
		});
		const r = await spawnTileWithJoin(async () => true, { hyprctl, ...clock, mapWaitMs: 300, mapWaitTickMs: 100, panel: PANEL_DEPS });
		expect(r).toEqual({ spawnOk: true, join: { joinedFocus: false, mapped: false, restored: false } });
		// exactly the one (failed) focus call — no toggle, no restore
		expect(calls.filter((a) => a[0] === "dispatch")).toHaveLength(1);
	});

	it("toggle fails after the focus: restore the user's focus right away (no map to preserve) and degrade", async () => {
		const clock = fakeClock();
		let spawnAt = -1;
		const { hyprctl, calls } = fakeJuggleHyprctl({
			clients: () => [panelWin(200)],
			active: () => ({ pid: 111, class: "foot", grouped: [] }),
			toggleCode: 1,
		});
		const r = await spawnTileWithJoin(
			async () => {
				spawnAt = calls.length;
				return true;
			},
			{ hyprctl, ...clock, mapWaitMs: 300, mapWaitTickMs: 100, panel: PANEL_DEPS },
		);
		expect(r).toEqual({ spawnOk: true, join: { joinedFocus: false, mapped: false, restored: false } });
		// focus the panel, the failed toggle, the immediate restore — all
		// BEFORE the spawn (there is no map-wait to hold the focus for)
		const dispatchIdxs = calls.reduce<number[]>((acc, a, i) => (a[0] === "dispatch" ? [...acc, i] : acc), []);
		expect(dispatchIdxs).toHaveLength(3);
		for (const i of dispatchIdxs) expect(i).toBeLessThan(spawnAt);
		expect(calls[dispatchIdxs[2]][1]).toContain("pid:111");
	});

	it("juggle probe fails (clients throws): spawn proceeds, no juggle", async () => {
		const clock = fakeClock();
		const hyprctl: (args: string[]) => Promise<HyprctlResult> = async (args) => {
			if (args[0] === "clients") throw new Error("compositor gone");
			if (args[0] === "activewindow") return { code: 0, stdout: JSON.stringify({ pid: 111, class: "foot", grouped: [] }), stderr: "" };
			return { code: 0, stdout: "", stderr: "" };
		};
		const r = await spawnTileWithJoin(async () => true, { hyprctl, ...clock, mapWaitMs: 100, mapWaitTickMs: 50, panel: PANEL_DEPS });
		expect(r.spawnOk).toBe(true);
		expect(r.join.joinedFocus).toBe(false);
		expect(r.join.restored).toBe(false);
	});

	it("juggle probe fails (clients non-zero): same degradation", async () => {
		const clock = fakeClock();
		const hyprctl = async (args: string[]): Promise<HyprctlResult> =>
			args[0] === "clients"
				? { code: 1, stdout: "", stderr: "boom" }
				: args[0] === "activewindow"
					? { code: 0, stdout: JSON.stringify({ pid: 111, class: "foot", grouped: [] }), stderr: "" }
					: { code: 0, stdout: "", stderr: "" };
		const r = await spawnTileWithJoin(async () => true, { hyprctl, ...clock, mapWaitMs: 100, mapWaitTickMs: 50, panel: PANEL_DEPS });
		expect(r.spawnOk).toBe(true);
		expect(r.join.joinedFocus).toBe(false);
	});

	it("no focused window (P0 null): no juggle — the panel must NOT be focused (it would strand focus there)", async () => {
		const clock = fakeClock();
		const { hyprctl, calls } = fakeJuggleHyprctl({
			clients: () => [panelWin(200)],
			active: () => null, // no focused window (or the probe failed)
		});
		const r = await spawnTileWithJoin(async () => true, { hyprctl, ...clock, mapWaitMs: 300, mapWaitTickMs: 100, panel: PANEL_DEPS });
		expect(r).toEqual({ spawnOk: true, join: { joinedFocus: false, mapped: false, restored: false } });
		expect(calls.filter((a) => a[0] === "dispatch")).toEqual([]);
	});

	it("map-wait budget exhausted: mapped=false, restore still runs (we moved the focus)", async () => {
		const clock = fakeClock();
		const { hyprctl, calls } = fakeJuggleHyprctl({
			clients: () => [panelWin(200, ["0xP"])], // the new tile never appears
			active: () => ({ pid: 111, class: "foot", grouped: [] }),
		});
		const r = await spawnTileWithJoin(async () => true, { hyprctl, ...clock, mapWaitMs: 300, mapWaitTickMs: 100, panel: PANEL_DEPS });
		expect(r).toEqual({ spawnOk: true, join: { joinedFocus: true, mapped: false, restored: true } });
		expect(calls.filter((a) => a[0] === "dispatch")).toHaveLength(2); // focus the panel + restore P0
	});

	it("spawn failure (throwing): spawnOk=false, no map-wait, restore still runs", async () => {
		const clock = fakeClock();
		const { hyprctl, calls } = fakeJuggleHyprctl({
			clients: () => [panelWin(200, ["0xP"])],
			active: () => ({ pid: 111, class: "foot", grouped: [] }),
		});
		const r = await spawnTileWithJoin(
			async () => {
				throw new Error("spawn exploded");
			},
			{ hyprctl, ...clock, mapWaitMs: 300, mapWaitTickMs: 100, panel: PANEL_DEPS },
		);
		expect(r).toEqual({ spawnOk: false, join: { joinedFocus: true, mapped: false, restored: true } });
		expect(calls.filter((a) => a[0] === "clients")).toHaveLength(1); // prep only — no map-wait polls
	});

	it("map-wait budget bounds the polls (500 ms / 100 ms tick ⇒ 5 polls + 1 prep)", async () => {
		const clock = fakeClock();
		const { hyprctl, calls } = fakeJuggleHyprctl({
			clients: () => [panelWin(200, ["0xP"])],
			active: () => ({ pid: 111, class: "foot", grouped: [] }),
		});
		await spawnTileWithJoin(async () => true, { hyprctl, ...clock, mapWaitMs: 500, mapWaitTickMs: 100, panel: PANEL_DEPS });
		// polls at now=100,200,300,400,500 (≤ the budget); the loop ends once
		// now reaches the deadline
		expect(calls.filter((a) => a[0] === "clients")).toHaveLength(6);
	});
});

describe("juggle probes (clients / activewindow / focus parsing)", () => {
	it("listWorkerWindows: filters on the app-id, tolerates bad shapes", async () => {
		const good = async (a: string[]): Promise<HyprctlResult> =>
			a[0] === "clients"
				? {
						code: 0,
						stdout: JSON.stringify([
							{ pid: 1, class: WORKER_APP_ID, grouped: ["0x1", 42, null] },
							{ pid: 2, class: "foot", grouped: [] },
							"junk",
							{ pid: 3, class: WORKER_APP_ID },
						]),
						stderr: "",
					}
					: { code: 1, stdout: "", stderr: "" };
			const w = await listWorkerWindows(good);
			expect(w).toEqual([{ pid: 1, grouped: ["0x1"] }, { pid: 3, grouped: [] }]);
			expect(await listWorkerWindows(async () => ({ code: 1, stdout: "", stderr: "x" }))).toBeNull();
			expect(await listWorkerWindows(async () => ({ code: 0, stdout: "not json", stderr: "" }))).toBeNull();
			expect(await listWorkerWindows(async () => ({ code: 0, stdout: "{}", stderr: "" }))).toBeNull();
			expect(await listWorkerWindows(async () => Promise.reject(new Error("no compositor")))).toBeNull();
	});

	it("readActiveWindow: null on no window / bad shape", async () => {
		expect(await readActiveWindow(async () => ({ code: 0, stdout: JSON.stringify({ pid: 9, class: "foot" }), stderr: "" })))
			.toEqual({ pid: 9, class: "foot", grouped: [] });
		expect(await readActiveWindow(async () => ({ code: 0, stdout: "null", stderr: "" }))).toBeNull();
		expect(await readActiveWindow(async () => ({ code: 0, stdout: JSON.stringify({ class: "foot" }), stderr: "" }))).toBeNull();
		expect(await readActiveWindow(async () => ({ code: 1, stdout: "", stderr: "x" }))).toBeNull();
		// the real Hyprland no-window shape: code 0 with an error body
		expect(await readActiveWindow(async () => ({ code: 0, stdout: "Invalid", stderr: "" }))).toBeNull();
	});

	it("focusWindowByPid: dispatches the pid focus; false on failure / throw", async () => {
		const seen: string[][] = [];
		expect(await focusWindowByPid(async (a) => { seen.push(a); return { code: 0, stdout: "", stderr: "" }; }, 4242)).toBe(true);
		expect(seen).toEqual([["dispatch", 'hl.dsp.focus({ window = "pid:4242" })']]);
		expect(await focusWindowByPid(async () => ({ code: 1, stdout: "", stderr: "x" }), 1)).toBe(false);
		expect(await focusWindowByPid(async () => Promise.reject(new Error("down")), 1)).toBe(false);
	});

	it("toggleGroup: dispatches hl.dsp.group.toggle(); false on failure / throw", async () => {
		const seen: string[][] = [];
		const ok = async (a: string[]): Promise<HyprctlResult> => {
			seen.push(a);
			return { code: 0, stdout: "", stderr: "" };
		};
		expect(await toggleGroup(ok)).toBe(true);
		expect(seen).toEqual([["dispatch", "hl.dsp.group.toggle()"]]);
		expect(await toggleGroup(async () => ({ code: 1, stdout: "", stderr: "x" }))).toBe(false);
		expect(await toggleGroup(async () => Promise.reject(new Error("down")))).toBe(false);
	});

	it("listAllWindows: the full snapshot — tolerates bad shapes", async () => {
		const good = async (a: string[]): Promise<HyprctlResult> =>
			a[0] === "clients"
				? {
						code: 0,
						stdout: JSON.stringify([
							{ pid: 1, class: WORKER_APP_ID, grouped: ["0x1", 42, null] },
							{ pid: 2, class: "foot", grouped: [] },
							"junk",
							{ pid: 3 }, // no class ⇒ ""
							{ class: "foot" }, // no pid ⇒ skipped
						]),
						stderr: "",
					}
					: { code: 1, stdout: "", stderr: "" };
		const all = await listAllWindows(good);
		expect(all).toEqual([
			{ pid: 1, class: WORKER_APP_ID, grouped: ["0x1"] },
			{ pid: 2, class: "foot", grouped: [] },
			{ pid: 3, class: "", grouped: [] },
		]);
		expect(await listAllWindows(async () => ({ code: 1, stdout: "", stderr: "x" }))).toBeNull();
		expect(await listAllWindows(async () => ({ code: 0, stdout: "not json", stderr: "" }))).toBeNull();
		expect(await listAllWindows(async () => ({ code: 0, stdout: "{}", stderr: "" }))).toBeNull();
		expect(await listAllWindows(async () => Promise.reject(new Error("no compositor")))).toBeNull();
	});
});

describe("panel discovery (main-agent group)", () => {
	it("readPpid: the /proc reader resolves the test process's parent; a dead pid ⇒ null", () => {
		const ppid = readPpid(process.pid);
		expect(typeof ppid).toBe("number");
		expect(ppid).toBeGreaterThan(0);
		expect(readPpid(2_000_000_000)).toBeNull();
	});

	it("findPanelInWindows: walks the chain to the first window ancestor", () => {
		const windows = [{ pid: 200, class: "foot", grouped: ["0xP"] }];
		const panel = findPanelInWindows(windows, { startPid: 100, ppidOf: (p) => (p === 100 ? 150 : p === 150 ? 200 : null) });
		expect(panel).toEqual({ pid: 200, grouped: ["0xP"] });
	});

	it("findPanelInWindows: a window EARLIER on the chain wins (the first hit)", () => {
		const windows = [{ pid: 150, class: "foot", grouped: [] }, { pid: 200, class: "foot", grouped: ["0xP"] }];
		const panel = findPanelInWindows(windows, { startPid: 100, ppidOf: (p) => (p === 100 ? 150 : p === 150 ? 200 : null) });
		expect(panel).toEqual({ pid: 150, grouped: [] });
	});

	it("findPanelInWindows: the chain ends at pid 1 ⇒ null (no window found)", () => {
		const windows = [{ pid: 999, class: "foot", grouped: [] }];
		const panel = findPanelInWindows(windows, { startPid: 100, ppidOf: (p) => (p === 100 ? 150 : 1) });
		expect(panel).toBeNull();
	});

	it("findPanelInWindows: a pid cycle terminates (the hop cap / self-parent guard)", () => {
		const windows = [{ pid: 999, class: "foot", grouped: [] }];
		// 100 → 101 → 100 → … (a cycle the real /proc can never produce)
		const panel = findPanelInWindows(windows, { startPid: 100, ppidOf: (p) => (p === 100 ? 101 : 100) });
		expect(panel).toBeNull();
	});

	it("findDispatcherWindow: one live clients call; failure ⇒ null, hit ⇒ the panel", async () => {
		const windows = [{ pid: 200, class: "foot", grouped: ["0xP"] }];
		const ok = async (a: string[]): Promise<HyprctlResult> =>
			a[0] === "clients" ? { code: 0, stdout: JSON.stringify(windows), stderr: "" } : { code: 1, stdout: "", stderr: "" };
		expect(await findDispatcherWindow(ok, { startPid: 100, ppidOf: () => 200 })).toEqual({ pid: 200, grouped: ["0xP"] });
		const dead = async (a: string[]): Promise<HyprctlResult> =>
			a[0] === "clients" ? { code: 1, stdout: "", stderr: "x" } : { code: 0, stdout: "", stderr: "" };
		expect(await findDispatcherWindow(dead, { startPid: 100, ppidOf: () => 200 })).toBeNull();
	});
});

describe("join juggle through dispatchTasks (per-tile map-wait ordering, main-agent group)", () => {
	it("two tasks in one call: both tiles join the main-agent panel's group", async () => {
		// a stateful compositor: the panel (pid 500) starts UNGROUPED; the
		// toggle groups it; each tile's pid appears in `clients` only after
		// its own spawn dispatch, inside the panel's group
		const panelPid = 500;
		let panelGrouped = false;
		const spawnedPids: number[] = [];
		const inner = async (args: string[]): Promise<HyprctlResult> => {
			if (args[0] === "clients") {
				const wins = [{ pid: panelPid, class: "foot", grouped: panelGrouped ? ["0xP"] : [] }];
				for (const pid of spawnedPids) wins.push({ pid, class: WORKER_APP_ID, grouped: ["0xP"] });
				return { code: 0, stdout: JSON.stringify(wins), stderr: "" };
			}
			if (args[0] === "activewindow") {
				return { code: 0, stdout: JSON.stringify({ pid: 111, class: "foot", grouped: [] }), stderr: "" };
			}
			if (args[0] === "dispatch") {
				if (args[1]?.startsWith("hl.dsp.exec_cmd")) {
					spawnedPids.push(4000 + spawnedPids.length + 1);
					return { code: 0, stdout: "", stderr: "" };
				}
				if (args[1]?.includes("group.toggle")) {
					panelGrouped = true;
					return { code: 0, stdout: "", stderr: "" };
				}
				return { code: 0, stdout: "", stderr: "" };
			}
			throw new Error(`unexpected: ${args.join(" ")}`);
		};
		const calls: string[][] = [];
		const wrapping = async (args: string[]): Promise<HyprctlResult> => {
			calls.push(args);
			return inner(args);
		};
		const localBinDir = join(process.env.HOME!, ".local", "bin");
		mkdirSync(localBinDir, { recursive: true });
		const localBin = join(localBinDir, "vitrine-run");
		writeFileSync(localBin, "#!/bin/sh\nexit 0\n");
		chmodSync(localBin, 0o755);
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 1500);
		try {
			await dispatchTasks({
				tasks: [{ agent: "test-agent", task: "first" }, { agent: "test-agent", task: "second" }],
				mode: "tile",
				dispatcher: info(),
				bunBin,
				deps: deps({
					signal: controller.signal,
					hyprctl: wrapping,
					tickMs: 50,
					mapWaitMs: 400,
					mapWaitTickMs: 10,
					panel: { startPid: 100, ppidOf: () => panelPid },
				}),
			});
			const spawnIdxs = calls.reduce<number[]>((acc, a, i) => (a[0] === "dispatch" && a[1]?.startsWith("hl.dsp.exec_cmd") ? [...acc, i] : acc), []);
			expect(spawnIdxs).toHaveLength(2);
			// task 1's juggle: focus the panel + make it a group — BOTH before
			// task 1's spawn (the toggle acts on the active window)
			const iToggle = calls.findIndex((a) => a[0] === "dispatch" && a[1]?.includes("group.toggle"));
			expect(iToggle).toBeGreaterThanOrEqual(0);
			expect(iToggle).toBeLessThan(spawnIdxs[0]);
			// task 2's juggle: the panel is ALREADY a group — a second focus
			// (between the spawns), no second toggle (idempotent)
			const focusIdxs = calls.reduce<number[]>((acc, a, i) => (a[0] === "dispatch" && a[1]?.includes(`pid:${panelPid}`) ? [...acc, i] : acc), []);
			expect(focusIdxs).toHaveLength(2);
			expect(focusIdxs[1]).toBeGreaterThan(spawnIdxs[0]);
			expect(focusIdxs[1]).toBeLessThan(spawnIdxs[1]);
			// the user's focus is restored after each tile's map — the last
			// restore only after task 2's spawn
			const restoreIdxs = calls.reduce<number[]>((acc, a, i) => (a[0] === "dispatch" && a[1]?.includes("pid:111") ? [...acc, i] : acc), []);
			expect(restoreIdxs).toHaveLength(2);
			expect(restoreIdxs[1]).toBeGreaterThan(spawnIdxs[1]);
		} finally {
			clearTimeout(timer);
			rmSync(localBin, { force: true });
			// the tile tasks never settle (hyprctl was stubbed, no wrapper ran):
			// remove them so the residual queued dirs cannot consume a slot
			for (const dir of await P.listTaskDirs()) {
				const st = await P.readState(dir).catch(() => null);
				if (st !== null && !P.isTerminal(st.state)) await P.removeTask(dir);
			}
		}
	});
});

describe("admission + in-call queue (2+2, work-conserving)", () => {
	it("the self-deadlock batch: 4 tasks, cap 2, no foreign — all four complete, two queued in-call", async () => {
		const r = await dispatchTasks({
			tasks: [1, 2, 3, 4].map((n) => ({ agent: "test-agent", task: `review ${n}` })),
			mode: "headless",
			dispatcher: info(),
			bunBin,
			deps: deps(),
		});
		expect(r.dispatched).toBe(4);
		expect(r.results.every((x) => x.state === "completed")).toBe(true);
		expect(r.results.filter((x) => x.queuedThisCall).length).toBe(2);
		expect(r.queuedThisCall).toBe(2);
		expect(r.text).toContain("queued this call");
		// the clean fixture leaves no result.md — the harvest falls back to the
		// session's last assistant text
		expect(r.results.every((x) => x.result !== undefined && x.result.includes("fixture finished the work"))).toBe(true);
		// spec-transport pin (v1.10): the config tunable rides spec.json —
		// createTask fills it, the wrapper reads it from the spec
		const firstSpec = await P.readSpec(join(tasksRoot, r.results[0].id));
		expect(firstSpec.completed_close_s).toBe(600);
	}, 60_000);

	it("completed_close_s: 0 rides the spec (never auto-close)", async () => {
		const cfgFile = join(base, ".vitrine", "config.json");
		await writeFile(cfgFile, JSON.stringify({ ...C.CONFIG_DEFAULTS, completed_close_s: 0 }, null, 2));
		try {
			const r = await dispatchTasks({
				tasks: [{ agent: "test-agent", task: "zero close" }],
				mode: "headless",
				dispatcher: info(),
				bunBin,
				deps: deps(),
			});
			expect(r.results[0].state).toBe("completed");
			const spec = await P.readSpec(join(tasksRoot, r.results[0].id));
			expect(spec.completed_close_s).toBe(0);
		} finally {
			// restore the default config for the other suites in this file
			await writeFile(cfgFile, JSON.stringify({ ...C.CONFIG_DEFAULTS }, null, 2));
		}
	}, 60_000);

	it("thinking chain: per-call > agent frontmatter > omitted (no flag)", async () => {
		const thinker = join(base, ".pi", "agent", "agents", "thinker.md");
		await writeFile(thinker, "---\nname: thinker\ndescription: fixture thinker agent\nthinking: medium\n---\nbody\n");
		try {
			// no per-call thinking → the frontmatter value rides the spec
			const r1 = await dispatchTasks({
				tasks: [{ agent: "thinker", task: "frontmatter thinking" }],
				mode: "headless",
				dispatcher: info(),
				bunBin,
				deps: deps(),
			});
			expect(r1.results[0].state).toBe("completed");
			expect((await P.readSpec(join(tasksRoot, r1.results[0].id))).agent.thinking).toBe("medium");
			// the per-call value wins over the frontmatter
			const r2 = await dispatchTasks({
				tasks: [{ agent: "thinker", task: "per-call thinking", thinking: "max" }],
				mode: "headless",
				dispatcher: info(),
				bunBin,
				deps: deps(),
			});
			expect(r2.results[0].state).toBe("completed");
			expect((await P.readSpec(join(tasksRoot, r2.results[0].id))).agent.thinking).toBe("max");
		} finally {
			rmSync(thinker, { force: true });
		}
	}, 60_000);

	it("2 + in-call queue across a foreign running task; the foreign task is adopted", async () => {
		const foreign = await spawnForeignRunning(3500);
		try {
			const r = await dispatchTasks({
				tasks: [{ agent: "test-agent", task: "one" }, { agent: "test-agent", task: "two" }],
				mode: "headless",
				dispatcher: info(),
				bunBin,
				deps: deps(),
			});
			expect(r.adopted.length).toBe(1);
			expect(r.adopted[0].id).toBe(foreign.dir.split("/").pop()!);
			expect(r.text).toContain("running from an earlier call");
			// 1 slot free at admission: one spawns now, one queues and runs when the foreign one frees
			expect(r.results.filter((x) => x.queuedThisCall).length).toBe(1);
			expect(r.results.every((x) => x.state === "completed")).toBe(true);
		} finally {
			try {
				process.kill(foreign.pid, "SIGTERM");
			} catch {
				// already gone (it was a `sleep` with a limited lifetime)
			}
		}
	}, 60_000);
});

describe("reconciliation through dispatch", () => {
	it("the call's own in-call queue is never settled as stuck (a queue past the window is healthy; residue is not)", async () => {
		// a foreign running task holds one slot, so the second task of the
		// batch queues in-call. The injected clock fast-forwards 10 s per
		// tick: by tick 2 the queued task's age (created_at vs now) is past
		// the 15 s stuck window — without the exclusion, the dispatcher's
		// own reconcile would settle its own healthy queue.
		const foreign = await spawnForeignRunning(20_000);
		// a backdated ghost queued task is residue: the SAME reconcile must
		// still settle it (the exclusion is scoped to this call's own queue)
		const ghost = await createGhostTask();
		const ghostSpec = await P.readSpec(ghost);
		ghostSpec.created_at = new Date(Date.now() - 20_000).toISOString();
		await writeFile(join(ghost, "spec.json"), JSON.stringify(ghostSpec, null, 2));
		let t = Date.now();
		const now = (): number => (t += 10_000);
		try {
			const r = await dispatchTasks({
				tasks: [{ agent: "test-agent", task: "first" }, { agent: "test-agent", task: "second" }],
				mode: "headless",
				dispatcher: info(),
				bunBin,
				deps: deps({ now }),
			});
			const queued = r.results.find((x) => x.queuedThisCall)!;
			expect(queued.state).toBe("completed"); // it survived past the window and ran
			const qEvents = await P.readEvents(join(tasksRoot, queued.id));
			expect(qEvents.some((e) => e.event === "transition" && e.from === "queued" && e.to === "crashed")).toBe(false);
			// the residue was settled by the same call's reconcile
			expect((await P.readState(ghost)).state).toBe("crashed");
		} finally {
			try {
				process.kill(foreign.pid, "SIGTERM");
			} catch {
				// already gone
			}
		}
	}, 60_000);

	it("a stuck foreign queued task settles never-spawned before admission", async () => {
		const dir = await createGhostTask();
		const id = dir.split("/").pop()!;
		// backdate created_at 20 s into the past
		const spec = await P.readSpec(dir);
		spec.created_at = new Date(Date.now() - 20_000).toISOString();
		await writeFile(join(dir, "spec.json"), JSON.stringify(spec, null, 2));
		await dispatchTasks({ tasks: [{ agent: "test-agent", task: "probe" }], mode: "tile", dispatcher: info(), bunBin, deps: deps({ hyprctl: async () => ({ code: 1, stdout: "", stderr: "" }) }) });
		const st = await P.readState(dir);
		expect(st.state).toBe("crashed");
		expect(st.reason).toBe("never-spawned");
		const events = await P.readEvents(dir);
		const lastTransition = [...events].reverse().find((e: Record<string, unknown>) => e.event === "transition")!;
		expect(lastTransition).toMatchObject({ from: "queued", to: "crashed", reason: "never-spawned" });
	});

	it("a stuck foreign queued task with kill_requested settles kill-requested instead", async () => {
		const dir = await createGhostTask();
		const spec = await P.readSpec(dir);
		spec.created_at = new Date(Date.now() - 20_000).toISOString();
		await writeFile(join(dir, "spec.json"), JSON.stringify(spec, null, 2));
		await P.requestKill(dir);
		await dispatchTasks({ tasks: [{ agent: "test-agent", task: "probe" }], mode: "tile", dispatcher: info(), bunBin, deps: deps({ hyprctl: async () => ({ code: 1, stdout: "", stderr: "" }) }) });
		const st = await P.readState(dir);
		expect(st).toMatchObject({ state: "crashed", reason: "kill-requested" });
	});

	it("deferred harvest: a session's non-terminal-at-admission id is harvested on a later call", async () => {
		// call 1: a hanging worker; the dispatcher aborts (the human gave up)
		process.env.VITRINE_FIXTURE_MODE = "hang";
		const ac = new AbortController();
		setTimeout(() => ac.abort(), 800);
		const r1 = await dispatchTasks({
			tasks: [{ agent: "test-agent", task: "hang for me" }],
			mode: "headless",
			dispatcher: info(),
			bunBin,
			deps: deps({ signal: ac.signal, sleep: () => new Promise((r) => setTimeout(r, 150)) }),
		});
		process.env.VITRINE_FIXTURE_MODE = "clean";
		expect(r1.aborted).toBe(true);
		const t1 = r1.results[0];
		expect(t1.state).not.toBe("completed");
		// the worker hangs; kill the wrapper, then the worker (re-read — the
		// wrapper may not have recorded it yet)
		const t1dir = join(tasksRoot, t1.id);
		const st1 = await P.readState(t1dir);
		if (st1.wrapper_pid !== undefined) {
			try {
				process.kill(st1.wrapper_pid, "SIGKILL");
			} catch {}
		}
		await new Promise((r) => setTimeout(r, 200));
		const st1b = await P.readState(t1dir).catch(() => st1);
		if (st1b.worker_pid !== undefined) {
			try {
				process.kill(st1b.worker_pid, "SIGKILL");
			} catch {}
		}
		// call 2 (same session): reconciliation settles it; the registry hits ⇒ deferred harvest
		const r2 = await dispatchTasks({
			tasks: [{ agent: "test-agent", task: "next" }],
			mode: "headless",
			dispatcher: info(),
			bunBin,
			deps: deps(),
		});
		expect(r2.deferred.length).toBe(1);
		expect(r2.deferred[0].id).toBe(t1.id);
		expect(r2.deferred[0].state).toBe("crashed");
		expect(r2.deferred[0].partial).toBe(true);
		expect(r2.text).toContain("deferred harvest");
		expect(pendingDispatchedIds("disp-test")).toEqual([]);
	}, 60_000);

	it("a foreign queued task that goes terminal DURING the call is deferred-harvested (cross-session)", async () => {
		// a foreign queued task (another session's in-flight queue) — it is
		// queued at admission (so it is snapshotted, not adopted as running),
		// then goes terminal while this call waits ⇒ deferred harvest.
		const foreignDir = await createGhostTask();
		const foreignId = P.taskIdOf(foreignDir);
		// give it a result so the harvest has content
		await P.writeResult(foreignDir, "foreign answer");
		// the dispatched task keeps the call alive past the foreign transition
		// (the in-place wrapper settles it on its own ~1 s tick)
		const timer = setTimeout(async () => {
			await P.transitionState(foreignDir, "queued", "crashed", {}, "foreign settled").catch(() => {});
		}, 400);
		const r = await dispatchTasks({
			tasks: [{ agent: "test-agent", task: "keep me alive" }],
			mode: "headless",
			dispatcher: info(),
			bunBin,
			deps: deps(),
		});
		clearTimeout(timer);
		// the dispatched task is in results; the foreign one is deferred
		const def = r.deferred.find((d) => d.id === foreignId);
		expect(def).toBeDefined();
		expect(def?.state).toBe("crashed");
		expect(def?.result ?? "").toContain("foreign answer");
		expect(r.adopted.find((a) => a.id === foreignId)).toBeUndefined();
		expect(r.results.find((x) => x.id === foreignId)).toBeUndefined();
	}, 60_000);
});

describe("abort semantics", () => {
	it("unspawned tasks settle never-spawned; spawned ones keep running", async () => {
		const ac = new AbortController();
		setTimeout(() => ac.abort(), 500);
		const r = await dispatchTasks({
			tasks: [1, 2, 3, 4].map((n) => ({ agent: "test-agent", task: `review ${n}` })),
			mode: "headless",
			dispatcher: info(),
			bunBin,
			deps: deps({ signal: ac.signal }),
		});
		expect(r.aborted).toBe(true);
		// two slots: two spawned (not yet terminal at abort), two never-spawned
		const never = r.results.filter((x) => x.neverSpawned);
		expect(never.length).toBe(2);
		for (const x of never) {
			const st = await P.readState(join(tasksRoot, x.id));
			expect(st).toMatchObject({ state: "crashed", reason: "never-spawned" });
		}
		const spawned = r.results.filter((x) => !x.neverSpawned);
		expect(spawned.length).toBe(2);
		// they were actually launched (running or already completed)
		for (const x of spawned) {
			const st = await P.readState(join(tasksRoot, x.id));
			expect(["queued", "running", "completed"]).toContain(st.state);
		}
	}, 30_000);
});

describe("countSlots (liveness-qualified)", () => {
	it("counts live running wrappers, young queued, and nothing else", () => {
		const proc = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
		proc.unref();
		const live = P.pidInfo(proc.pid!);
		const now = Date.now();
		const young = new Date().toISOString();
		const old = new Date(now - 60_000).toISOString();
		const n = countSlots(
			[
				{ dir: "/a", state: "running", wrapperPid: proc.pid, wrapperPidStart: live.startTime },
				{ dir: "/b", state: "running", wrapperPid: proc.pid, wrapperPidStart: "recycled-start-time" },
				{ dir: "/c", state: "running" },
				{ dir: "/d", state: "queued", wrapperPid: proc.pid },
				{ dir: "/e", state: "queued", createdAt: young },
				{ dir: "/f", state: "queued", createdAt: old },
				{ dir: "/g", state: "completed" },
			],
			now,
		);
		// a (live+start-match) + d (live wrapper) + e (young) = 3
		expect(n).toBe(3);
		process.kill(proc.pid!, "SIGTERM");
	});
});

describe("harvest (caps + 0600 overflow)", () => {
	async function terminalTaskDir(files: Record<string, string>): Promise<string> {
		const id = P.newTaskId();
		const dir = join(tasksRoot, id);
		await P.createTask(dir, ghostSpec(id), "probe\n");
		await P.transitionState(dir, "queued", "running", { started_at: new Date().toISOString() });
		await P.transitionState(dir, "running", "completed", { finished_at: new Date().toISOString() });
		for (const [f, content] of Object.entries(files)) await writeFile(join(dir, f), content);
		return dir;
	}

	it("a >50KB / >2000-line result is capped, with the full text in a 0600 overflow file", async () => {
		const lines = Array.from({ length: 2400 }, (_, i) => `line ${i} ` + "x".repeat(30));
		const full = lines.join("\n");
		const dir = await terminalTaskDir({ "result.md": full });
		const h = await harvestTask(dir, "completed", { tmpDir: join(base, "tmp") });

		expect(h.partial).toBe(false);
		expect(h.overflowFile).toBeDefined();
		expect(h.text).toContain("[capped");
		expect(h.text).toContain(h.overflowFile!);
		expect(h.text.length).toBeLessThan(full.length);
		const st = statSync(h.overflowFile!);
		expect(st.mode & 0o777).toBe(0o600);
		expect(await readFile(h.overflowFile!, "utf8")).toBe(full);
	});

	it("falls back to the session's last assistant text when result.md is absent", async () => {
		const id = P.newTaskId();
		const dir = join(tasksRoot, id);
		await P.createTask(dir, ghostSpec(id), "probe\n");
		await P.transitionState(dir, "queued", "running", { started_at: new Date().toISOString() });
		await P.transitionState(dir, "running", "completed", { finished_at: new Date().toISOString() });
		const sessFile = join(sessionsRoot, `worker-${id.slice(0, 8)}.jsonl`);
		await writeFile(
			sessFile,
			[
				JSON.stringify({ type: "message", id: "m1", message: { role: "assistant", content: [{ type: "text", text: "from the session" }] } }),
				JSON.stringify({ type: "message", id: "m2", message: { role: "user", content: "next" } }),
				JSON.stringify({ type: "message", id: "m3", message: { role: "assistant", content: [{ type: "text", text: "last answer" }] } }),
			].join("\n") + "\n",
		);
		await writeFile(join(dir, "session.json"), JSON.stringify({ session_id: `vitrine.${id}`, session_file: sessFile }));
		const h = await harvestTask(dir, "completed", { tmpDir: join(base, "tmp") });
		expect(h.text).toContain("last answer");
	});

	it("falls back to tail.log when neither result.md nor a session exists", async () => {
		const dir = await terminalTaskDir({ "tail.log": "transcript tail line\n" });
		const h = await harvestTask(dir, "completed", { tmpDir: join(base, "tmp") });
		expect(h.text).toContain("transcript tail line");
	});

	it("a vanished dir (concurrent gc) is tolerated and labelled", async () => {
		const h = await harvestTask(join(tasksRoot, "00000000-0000-0000-0000-000000000000"), "completed");
		expect(h.gone).toBe(true);
		expect(h.text).toContain("vanished");
	});
});

describe("result format (the shape)", () => {
	const res: DispatchedTaskResult[] = [
		{ id: "a1b2c3d4-0000-0000-0000-000000000001", agent: "refiner", state: "completed", elapsedMs: 252_000, result: "the verdict\nsecond line", sessionId: "vitrine.a1b2c3d4-0000-0000-0000-000000000001" },
		{ id: "a1b2c3d4-0000-0000-0000-000000000002", agent: "executor", state: "crashed", reason: "never-spawned", elapsedMs: 4_000, result: "partial work", partial: true, sessionId: "vitrine.a1b2c3d4-0000-0000-0000-000000000002", queuedThisCall: true },
	];
	const text = renderReport({ mode: "tile", dispatched: 2, results: res, queuedThisCall: 1, adopted: [], deferred: [], aborted: false });

	it("header: dispatched / succeeded / failed", () => {
		expect(text.split("\n")[0]).toBe("2 dispatched · 1 succeeded, 1 failed");
	});

	it("per-task block: [n] agent · shortid — state (elapsed), indented body, session line", () => {
		expect(text).toContain("[1] refiner · a1b2c3d4 — completed (4m12s)");
		expect(text).toContain("    the verdict");
		expect(text).toContain("    session vitrine.a1b2c3d4-0000-0000-0000-000000000001");
	});

	it("crashed tasks are labelled partial and named with the reason", () => {
		expect(text).toContain("[2] executor · a1b2c3d4 — crashed (4s) (never-spawned) — partial");
	});

	it("the queued-this-call line", () => {
		expect(text).toContain("1 queued this call, ran after slot freed: executor · a1b2c3d4 — crashed");
	});

	it("on abort, still-running tasks are counted separately, not as failures", () => {
		const abortedRes: DispatchedTaskResult[] = [
			{ id: "a1b2c3d4-0000-0000-0000-000000000001", agent: "refiner", state: "completed", elapsedMs: 1000, sessionId: "vitrine.a1b2c3d4-0000-0000-0000-000000000001" },
			{ id: "a1b2c3d4-0000-0000-0000-000000000002", agent: "executor", state: "running", elapsedMs: 1000, sessionId: "vitrine.a1b2c3d4-0000-0000-0000-000000000002" },
			{ id: "a1b2c3d4-0000-0000-0000-000000000003", agent: "executor", state: "crashed", reason: "never-spawned", elapsedMs: 10, partial: true, sessionId: "vitrine.a1b2c3d4-0000-0000-0000-000000000003" },
		];
		const t = renderReport({ mode: "headless", dispatched: 3, results: abortedRes, queuedThisCall: 0, adopted: [], deferred: [], aborted: true });
		// 1 succeeded, 1 failed (the never-spawned), 1 still running — NOT 2 failed
		expect(t.split("\n")[0]).toBe("3 dispatched · 1 succeeded, 1 failed, 1 still running · ABORTED (workers keep running)");
	});
});


