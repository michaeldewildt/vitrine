/**
 * dispatch.test.ts — the dispatch tool suite:
 * the R1 contract (the tool returns after the spawn/admission pass — before
 * the first settlement, no harvest in the result), admission (2 + queue
 * across a foreign running task; the work-conserving batch, driven to
 * terminal by the factored wait loop), reconciliation (the lease-keyed
 * stuck-queue settle + the `kill_requested` interaction; the dead-lease
 * residue path), exact argv-array spawn construction, result format (the
 * R1 shape) + caps + 0600 overflow (the harvest machinery), abort-hook
 * marking (a pre-aborted signal skips the spawn pass).
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
	ensureGroupExpression,
	findDispatcherWindow,
	findPanelInWindows,
	harvestTask,
	joinGroupExpression,
	listAllWindows,
	listWorkerWindows,
	probeCompositor,
	readPpid,
	renderDispatch,
	spawnTile,
	tileSpawnArgv,
	waitForTasks,
	type DispatchDeps,
	type DispatchedTaskResult,
	type DispatcherInfo,
	type HyprctlResult,
	type WaitResult,
	type WorkerWindow,
} from "./dispatch";
import { startSessionWatcher } from "./watcher";

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
	// The real wrapper subprocesses the headless E2Es spawn inherit the
	// test's env — a fast tick keeps them off the production 1000 ms/poll.
	process.env.VITRINE_TICK_MS = "30";
});

afterAll(async () => {
	process.env.HOME = realHome;
	delete process.env.VITRINE_SESSIONS_DIR;
	delete process.env.VITRINE_PI_BIN;
	delete process.env.VITRINE_TICK_MS;
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
		// zero-cost map-wait for the legacy tile-spawn tests (the spawn-flow
		// tests set their own budget + fake clock)
		mapWaitMs: 1,
		mapWaitTickMs: 1,
		sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
		...over,
	};
}

/**
 * Drive the factored wait loop in-process over a dispatch call's ids — the
 * watcher/bench pattern (R1/R10): the tool returns after the spawn pass,
 * and the wait (admit as slots free + spawn + poll) is the loop's job.
 */
function waitAll(ids: string[], over: Partial<DispatchDeps> = {}): Promise<WaitResult> {
	return waitForTasks({
		ids,
		mode: "headless",
		bunBin,
		lease: { owner: "disp-test", nonce: "test-wait" },
		deps: { tickMs: 150, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), ...over },
	});
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

	it("tile: a silent workspace route appends the exec rule (the tile opens there WITHOUT switching)", () => {
		const argv = tileSpawnArgv("test-agent", "a1b2c3d4-0000-0000-0000-000000000000", { command: "/home/u/.local/bin/vitrine-run", args: [], source: "local-bin" }, "/tmp/tasks/xyz", 7);
		expect(argv).toEqual(["dispatch", `hl.dsp.exec_cmd("foot -T 'test-agent a1b2c3d4' --app-id vitrine-worker -- /home/u/.local/bin/vitrine-run /tmp/tasks/xyz", { workspace = "7 silent" })`]);
	});

	it("the ensure-grouped IIFE: check-and-toggle in one evaluation (atomic), returns no_op", () => {
		expect(ensureGroupExpression(200)).toBe(`(function() local p = hl.get_window("pid:200") if p and not p.group then hl.dispatch(hl.dsp.group.toggle({ window = "pid:200" })) end return hl.dsp.no_op() end)()`);
	});

	it("the join IIFE: fresh resolution, focus-neutral add, idempotent guard, returns no_op", () => {
		expect(joinGroupExpression(333, 200)).toBe(`(function() local t = hl.get_window("pid:333") local p = hl.get_window("pid:200") if t and p and p.group and not t.group then p.group:add(t) end return hl.dsp.no_op() end)()`);
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
		// no abort: the async contract has no in-call wait — the pass is one
		// tick, and the thunk must stay unevaluated for the whole of it
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
			// the stub tile never ran a wrapper — the task stays queued, no settle
			expect(r.results[0].state).toBe("queued");
			const events = (await P.readEvents(join(tasksRoot, r.results[0].id))).map((e: Record<string, unknown>) => e.event);
			expect(events).not.toContain("spawn-failed");
		} finally {
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
// the spawn pass's double-spawn guard (the pass consults the loop's guards)

describe("the spawn pass's double-spawn guard (the pass consults the loop's guards)", () => {
	it("a concurrent watcher that spawns the task first is not double-spawned by the pass (the no-double-spawn invariant)", async () => {
		// The session's watcher (armed at session_start) ticks in the SAME
		// process between the pass's awaits and can spawn a pass task before
		// the pass's own issue reaches it: in tile mode each pass issue is
		// slow (the spawn path + the delayed exec_cmd), so the watcher's
		// ticks land inside the pass's issue windows. The pass must consult
		// the loop's spawn guards (wrapper liveness + spawnInFlight) and
		// skip a task whose spawn is already in flight — otherwise the task
		// gets a second `spawn-issued` (bounded today by the wrapper's
		// queued→running CAS — the loser exits handoff-lost — but the stated
		// invariant is no double-spawn).
		const localBinDir = join(process.env.HOME!, ".local", "bin");
		mkdirSync(localBinDir, { recursive: true });
		const localBin = join(localBinDir, "vitrine-run");
		writeFileSync(localBin, "#!/bin/sh\nexit 0\n");
		chmodSync(localBin, 0o755);
		// a fresh tasks root: the watcher's live scope is the session's tasks
		// (the shared root's leftovers would sit in it — and its own
		// unspawned queue excludes itself from the slot count, so a foreign
		// slot holder would starve the race)
		const raceRoot = join(base, "race-tasks");
		await mkdir(raceRoot, { recursive: true });
		const prevRoot = process.env.VITRINE_TASKS_ROOT;
		process.env.VITRINE_TASKS_ROOT = raceRoot;
		// a pre-existing crashed task of this session: the watcher's loop
		// stops on its first tick over an EMPTY scope (vacuously all
		// terminal) — production arms the watcher where the session's
		// tasks exist (session_start, or the dispatch's own re-arm). A
		// terminal task holds no slot (the slot count is liveness-
		// qualified), so it keeps the loop alive (the failing send keeps it
		// pending) without starving the cap.
		const gid = P.newTaskId();
		const gdir = join(raceRoot, gid);
		await P.createTask(
			gdir,
			{
				task_id: gid,
				agent: { name: "test-agent", body: "ghost body\n" },
				dispatcher_session_id: info().sessionId,
				cwd: base,
				session_id: `vitrine.${gid}`,
				session_name: `test-agent · ${gid.slice(0, 8)}`,
				mode: "tile",
				attended: false,
				workspace: 9,
				wall_timeout_s: 3600,
				inactivity_s: 600,
				auto_settle_s: 600,
				auto_settle_grace_s: 60,
				async: true,
				created_at: new Date().toISOString(),
				boot_id: P.currentBootId(),
			},
			"ghost prompt\n",
		);
		await writeFile(join(gdir, "result.md"), "ghost harvest\n");
		await P.transitionState(gdir, "queued", "running", { started_at: new Date().toISOString() });
		await P.transitionState(gdir, "running", "crashed", { finished_at: new Date().toISOString() });
		// the watcher: fast ticks, fast (stub) tile issue — it spawns the
		// pass's queued tasks during the pass's slow issue windows; the
		// failing send keeps the ghost pending (the loop's alive clause)
		const w = startSessionWatcher({
			sessionId: info().sessionId,
			send: () => Promise.reject(new Error("test send failure")),
			replay: false,
			tickMs: 50,
			mode: "tile",
			bunBin,
			spawnDeps: { hyprctl: async () => ({ code: 0, stdout: "", stderr: "" }), mapWaitMs: 1, mapWaitTickMs: 1 },
		});
		try {
			await new Promise((r) => setTimeout(r, 150)); // the watcher's first ticks land
			const r = await dispatchTasks({
				tasks: [1, 2].map((n) => ({ agent: "test-agent", task: `race ${n}` })),
				mode: "tile",
				dispatcher: info(),
				bunBin,
				deps: deps({
					hyprctl: async (args) => {
						// the pass's issue window is real: the exec_cmd dispatch
						// (the spawn call) is delayed, the spawn path's other
						// hyprctl calls are fast
						if (args.join(" ").includes("hl.dsp.exec_cmd")) await new Promise((res) => setTimeout(res, 1200));
						return { code: 0, stdout: "", stderr: "" };
					},
					mapWaitMs: 400,
					mapWaitTickMs: 50,
				}),
			});
			// the pass and the watcher contested the same queued tasks (the
			// pass's slow issue window is the race — each pass issue is 1.6 s,
			// so the watcher's ticks land inside the windows); two tasks =
			// the whole cap, so a contended task that the watcher issues first
			// holds a slot (fresh owner lease) and the pass's guard must skip
			// it — under the old unconditional issue the contended task would
			// carry a second `spawn-issued` (the loser's wrapper would exit
			// handoff-lost, but the stated invariant is no double-spawn)
			for (const res of r.results) {
				const dir = join(raceRoot, res.id);
				const issued = (await P.readEvents(dir)).filter((e) => e.event === "spawn-issued");
				expect(issued, `task ${res.id}`).toHaveLength(1);
			}
		} finally {
			w.close();
			process.env.VITRINE_TASKS_ROOT = prevRoot;
			rmSync(localBin, { force: true });
		}
	}, 40_000);
});

// ---------------------------------------------------------------------------
// silent route + background join (the focus-free spawn flow)

/**
 * A scripted compositor for the spawnTile tests: a STATEFUL sequence of
 * `clients -j` window lists (each `clients` call consumes the next list;
 * the last one repeats), recording every call. `dispatch` calls (the
 * ensure/join IIFEs) return code 0 and are recorded verbatim.
 */
function fakeSpawnCompositor(seq: unknown[][]): { hyprctl: (args: string[]) => Promise<HyprctlResult>; calls: string[][] } {
	let i = 0;
	const calls: string[][] = [];
	const hyprctl = async (args: string[]): Promise<HyprctlResult> => {
		calls.push(args);
		if (args[0] === "clients") {
			const list = seq[Math.min(i, seq.length - 1)];
			i++;
			return { code: 0, stdout: JSON.stringify(list), stderr: "" };
		}
		if (args[0] === "dispatch") return { code: 0, stdout: "", stderr: "" };
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
/** The main-agent panel (the dispatcher's own window), on workspace `ws` when given. */
const panelWin = (pid: number, grouped: string[] = [], ws?: number) => ({ pid, class: "foot", grouped, ...(ws !== undefined ? { workspace: { id: ws } } : {}) });
/** A pid chain ending at panel pid 200: start 100 → 150 → 200 (window). */
const PANEL_DEPS = { startPid: 100, ppidOf: (p: number) => (p === 100 ? 150 : p === 150 ? 200 : null) };
/** A dead chain (no window on it) — the plain-spawn degradation path. */
const NO_PANEL = { startPid: 100, ppidOf: () => null };

/** The spawnTile tests' fixed argv builder (the real tileSpawnArgv bound to a fixture run_path). */
const TILE_RUN_PATH = { command: "/home/u/.local/bin/vitrine-run", args: [], source: "local-bin" } as C.RunPath;
const TILE_TITLE = "test-agent a1b2c3d4";
const buildTileArgv = (workspaceId?: number) => tileSpawnArgv("test-agent", "a1b2c3d4-0000-0000-0000-000000000000", TILE_RUN_PATH, "/tmp/tasks/xyz", workspaceId);
const dispatchCalls = (calls: string[][]) => calls.filter((a) => a[0] === "dispatch").map((a) => a[1]);

describe("silent route + background join — spawnTile (no focus, ever)", () => {
	it("ungrouped panel: the atomic ensure IIFE precedes the silent-routed spawn; the join lands after the map (group identity verified)", async () => {
		const clock = fakeClock();
		const { hyprctl, calls } = fakeSpawnCompositor([
			// prep: the ungrouped panel on ws 9, no workers
			[panelWin(200, [], 9)],
			// map-wait poll: the new worker (333) has mapped
			[panelWin(200, ["0xP"], 9), workerWin(333, ["0xP"])],
			// join verify: tile + panel share the group's member set
			[panelWin(200, ["0xP", "0xT"], 9), workerWin(333, ["0xP", "0xT"])],
		]);
		const spawned: string[][] = [];
		const r = await spawnTile(
			async (argv) => {
				spawned.push(argv);
				return true;
			},
			buildTileArgv,
			{ hyprctl, ...clock, mapWaitMs: 500, mapWaitTickMs: 100, panel: PANEL_DEPS },
		);
		expect(r).toEqual({ spawnOk: true, mapped: true, joined: true, tilePid: 333, panelPid: 200 });
		// the silent route: the tile opens on the panel's workspace WITHOUT switching to it
		expect(spawned).toEqual([["dispatch", `hl.dsp.exec_cmd("foot -T '${TILE_TITLE}' --app-id vitrine-worker -- /home/u/.local/bin/vitrine-run /tmp/tasks/xyz", { workspace = "9 silent" })`]]);
		// the ONLY dispatch calls: the ensure IIFE + the join IIFE
		expect(dispatchCalls(calls)).toEqual([ensureGroupExpression(200), joinGroupExpression(333, 200)]);
		// no focus, ever — the user's workspace/tab/cursor is never touched
		expect(calls.some((a) => a[0] === "dispatch" && (a[1] ?? "").includes("hl.dsp.focus"))).toBe(false);
	});

	it("grouped panel: no ensure — the spawn routes silently and the join lands after the map", async () => {
		const clock = fakeClock();
		const { hyprctl, calls } = fakeSpawnCompositor([
			[panelWin(200, ["0xP"], 9), workerWin(222, ["0xP"])],
			[panelWin(200, ["0xP"], 9), workerWin(222, ["0xP"]), workerWin(333, ["0xP"])],
			[panelWin(200, ["0xP", "0xT"], 9), workerWin(222, ["0xP", "0xT"]), workerWin(333, ["0xP", "0xT"])],
		]);
		const r = await spawnTile(async () => true, buildTileArgv, { hyprctl, ...clock, mapWaitMs: 500, mapWaitTickMs: 100, panel: PANEL_DEPS });
		expect(r).toEqual({ spawnOk: true, mapped: true, joined: true, tilePid: 333, panelPid: 200 });
		expect(dispatchCalls(calls)).toEqual([joinGroupExpression(333, 200)]); // no ensure
	});

	it("panel undiscoverable: plain spawn on the current workspace, no ensure, no join (yank-free degradation)", async () => {
		const clock = fakeClock();
		const { hyprctl, calls } = fakeSpawnCompositor([
			[workerWin(222, ["0xW"])], // no panel on the chain
			[workerWin(222, ["0xW"]), workerWin(333, [])],
		]);
		const spawned: string[][] = [];
		const r = await spawnTile(
			async (argv) => {
				spawned.push(argv);
				return true;
			},
			buildTileArgv,
			{ hyprctl, ...clock, mapWaitMs: 500, mapWaitTickMs: 100, panel: NO_PANEL },
		);
		expect(r).toEqual({ spawnOk: true, mapped: true, joined: false, tilePid: 333, panelPid: null });
		// plain spawn: NO workspace rule (the tile opens where the user is)
		expect(spawned[0][1]).toBe(`hl.dsp.exec_cmd("foot -T '${TILE_TITLE}' --app-id vitrine-worker -- /home/u/.local/bin/vitrine-run /tmp/tasks/xyz")`);
		// no IIFEs at all
		expect(dispatchCalls(calls)).toEqual([]);
	});

	it("panel without a readable workspace: plain spawn, the join still runs (a cross-workspace add relocates the tile)", async () => {
		const clock = fakeClock();
		const { hyprctl, calls } = fakeSpawnCompositor([
			[panelWin(200, ["0xP"])], // no workspace field
			[panelWin(200, ["0xP"]), workerWin(333, ["0xP"])],
			[panelWin(200, ["0xP", "0xT"]), workerWin(333, ["0xP", "0xT"])],
		]);
		const spawned: string[][] = [];
		const r = await spawnTile(
			async (argv) => {
				spawned.push(argv);
				return true;
			},
			buildTileArgv,
			{ hyprctl, ...clock, mapWaitMs: 500, mapWaitTickMs: 100, panel: PANEL_DEPS },
		);
		expect(r).toEqual({ spawnOk: true, mapped: true, joined: true, tilePid: 333, panelPid: 200 });
		expect(spawned[0][1]).not.toContain("silent"); // no route
		expect(dispatchCalls(calls)).toEqual([joinGroupExpression(333, 200)]);
	});

	it("spawn failure: no map-wait, no join (the caller settles failed-to-spawn)", async () => {
		const clock = fakeClock();
		const { hyprctl, calls } = fakeSpawnCompositor([[panelWin(200, [], 9)]]);
		const r = await spawnTile(async () => false, buildTileArgv, { hyprctl, ...clock, mapWaitMs: 500, mapWaitTickMs: 100, panel: PANEL_DEPS });
		expect(r).toEqual({ spawnOk: false, mapped: false, joined: false, tilePid: null, panelPid: 200 });
		// prep only — the ensure ran (the panel is ungrouped) but the spawn failed
		expect(calls.filter((a) => a[0] === "clients")).toHaveLength(1);
		expect(dispatchCalls(calls)).toEqual([ensureGroupExpression(200)]);
	});

	it("map-wait budget exhausted (the tile never maps): no join is attempted", async () => {
		const clock = fakeClock();
		const { hyprctl, calls } = fakeSpawnCompositor([
			[panelWin(200, ["0xP"], 9)],
			[panelWin(200, ["0xP"], 9)], // the worker never appears
		]);
		const r = await spawnTile(async () => true, buildTileArgv, { hyprctl, ...clock, mapWaitMs: 300, mapWaitTickMs: 100, panel: PANEL_DEPS });
		expect(r).toEqual({ spawnOk: true, mapped: false, joined: false, tilePid: null, panelPid: 200 });
		expect(dispatchCalls(calls)).toEqual([]);
	});

	it("join verify fails (the tile never joined) and the panel is still grouped: one retry, then joined:false", async () => {
		const clock = fakeClock();
		const { hyprctl, calls } = fakeSpawnCompositor([
			[panelWin(200, ["0xP"], 9)],
			[panelWin(200, ["0xP"], 9), workerWin(333, ["0xP"])],
			// verify #1: the tile has its own group (the add didn't land)
			[panelWin(200, ["0xP"], 9), workerWin(333, ["0xT"])],
			// retry decision: the panel is still grouped
			[panelWin(200, ["0xP"], 9), workerWin(333, ["0xT"])],
			// verify #2: still not joined
			[panelWin(200, ["0xP"], 9), workerWin(333, ["0xT"])],
		]);
		const r = await spawnTile(async () => true, buildTileArgv, { hyprctl, ...clock, mapWaitMs: 500, mapWaitTickMs: 100, panel: PANEL_DEPS });
		expect(r).toEqual({ spawnOk: true, mapped: true, joined: false, tilePid: 333, panelPid: 200 });
		// join + ONE retry — never more
		expect(dispatchCalls(calls)).toEqual([joinGroupExpression(333, 200), joinGroupExpression(333, 200)]);
	});

	it("join verify fails and the panel is ungrouped: no retry (there is no group to join)", async () => {
		const clock = fakeClock();
		const { hyprctl, calls } = fakeSpawnCompositor([
			[panelWin(200, ["0xP"], 9)],
			[panelWin(200, ["0xP"], 9), workerWin(333, ["0xT"])],
			// verify #1: not joined; retry decision: the panel is now UNGROUPED
			[panelWin(200, [], 9), workerWin(333, ["0xT"])],
		]);
		const r = await spawnTile(async () => true, buildTileArgv, { hyprctl, ...clock, mapWaitMs: 500, mapWaitTickMs: 100, panel: PANEL_DEPS });
		expect(r.joined).toBe(false);
		expect(dispatchCalls(calls)).toEqual([joinGroupExpression(333, 200)]); // no retry
	});

	it("compositor gone (clients non-zero): plain spawn, no IIFEs (fail-soft)", async () => {
		const clock = fakeClock();
		const hyprctl: (args: string[]) => Promise<HyprctlResult> = async (args) =>
			args[0] === "clients" ? { code: 1, stdout: "", stderr: "boom" } : { code: 0, stdout: "", stderr: "" };
		const spawned: string[][] = [];
		const r = await spawnTile(
			async (argv) => {
				spawned.push(argv);
				return true;
			},
			buildTileArgv,
			{ hyprctl, ...clock, mapWaitMs: 100, mapWaitTickMs: 50, panel: PANEL_DEPS },
		);
		expect(r).toEqual({ spawnOk: true, mapped: false, joined: false, tilePid: null, panelPid: null });
		expect(spawned[0][1]).not.toContain("silent");
	});
});

describe("spawn probes (clients parsing)", () => {
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

	it("listAllWindows: the full snapshot — parses the workspace id, tolerates bad shapes", async () => {
		const good = async (a: string[]): Promise<HyprctlResult> =>
			a[0] === "clients"
				? {
						code: 0,
						stdout: JSON.stringify([
							{ pid: 1, class: WORKER_APP_ID, grouped: ["0x1", 42, null], workspace: { id: 9 } },
							{ pid: 2, class: "foot", grouped: [], workspace: "junk" }, // malformed workspace ⇒ omitted
							"junk",
							{ pid: 3 }, // no class ⇒ "", no workspace ⇒ omitted
							{ class: "foot" }, // no pid ⇒ skipped
						]),
						stderr: "",
					}
					: { code: 1, stdout: "", stderr: "" };
		const all = await listAllWindows(good);
		expect(all).toEqual([
			{ pid: 1, class: WORKER_APP_ID, grouped: ["0x1"], workspaceId: 9 },
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

describe("tile spawn through dispatchTasks (silent route + background join, per-tile ordering)", () => {
	it("two tasks in one call: both tiles spawn silent-routed and join the panel's group — zero focus calls", async () => {
		// a stateful compositor: the panel (pid 500, ws 7) starts UNGROUPED;
		// the ensure IIFE groups it; each tile's pid appears in `clients` only
		// after its own spawn dispatch — ungrouped until its join IIFE lands,
		// after which the group's members all report the SAME member list
		const panelPid = 500;
		let panelGrouped = false;
		const spawnedPids: number[] = [];
		const joinedPids = new Set<number>();
		const members = () => [`0x${panelPid}`, ...[...joinedPids].map((p) => `0x${p}`)];
		const inner = async (args: string[]): Promise<HyprctlResult> => {
			if (args[0] === "clients") {
				const wins = [{ pid: panelPid, class: "foot", grouped: panelGrouped ? members() : [], workspace: { id: 7 } }];
				for (const pid of spawnedPids) wins.push({ pid, class: WORKER_APP_ID, grouped: joinedPids.has(pid) ? members() : [], workspace: { id: 7 } });
				return { code: 0, stdout: JSON.stringify(wins), stderr: "" };
			}
			if (args[0] === "dispatch") {
				const expr = args[1] ?? "";
				if (expr.startsWith("hl.dsp.exec_cmd")) {
					spawnedPids.push(4000 + spawnedPids.length + 1);
					return { code: 0, stdout: "", stderr: "" };
				}
				if (expr.includes("group.toggle")) panelGrouped = true; // the ensure IIFE
				const m = expr.match(/t = hl\.get_window\("pid:(\d+)"\)/);
				if (m !== null && expr.includes("group:add")) joinedPids.add(Number(m[1])); // the join IIFE lands
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
		// no abort: the async pass spawns both tiles back-to-back (cap 2, no
		// foreign) — the per-tile spawn ordering is asserted on the call log
		try {
			await dispatchTasks({
				tasks: [{ agent: "test-agent", task: "first" }, { agent: "test-agent", task: "second" }],
				mode: "tile",
				dispatcher: info(),
				bunBin,
				deps: deps({
					hyprctl: wrapping,
					tickMs: 50,
					mapWaitMs: 400,
					mapWaitTickMs: 10,
					panel: { startPid: 100, ppidOf: () => panelPid },
				}),
			});
			const spawnIdxs = calls.reduce<number[]>((acc, a, i) => (a[0] === "dispatch" && a[1]?.startsWith("hl.dsp.exec_cmd") ? [...acc, i] : acc), []);
			expect(spawnIdxs).toHaveLength(2);
			// BOTH spawns are silent-routed to the panel's workspace
			for (const i of spawnIdxs) expect(calls[i][1]).toContain(`workspace = "7 silent"`);
			// exactly ONE ensure IIFE (task 1 — the panel was ungrouped once;
			// task 2 finds it grouped): the compositor-atomic check-and-toggle
			const ensureIdxs = calls.reduce<number[]>((acc, a, i) => (a[0] === "dispatch" && a[1]?.includes("group.toggle") ? [...acc, i] : acc), []);
			expect(ensureIdxs).toHaveLength(1);
			expect(ensureIdxs[0]).toBeLessThan(spawnIdxs[0]);
			// two join IIFEs (one per tile), each AFTER its tile's spawn
			const joinIdxs = calls.reduce<number[]>((acc, a, i) => (a[0] === "dispatch" && a[1]?.includes("group:add") ? [...acc, i] : acc), []);
			expect(joinIdxs).toHaveLength(2);
			expect(joinIdxs[0]).toBeGreaterThan(spawnIdxs[0]);
			expect(joinIdxs[1]).toBeGreaterThan(spawnIdxs[1]);
			// the whole point: NO focus call, no standalone toggle, no restore
			expect(calls.some((a) => a[0] === "dispatch" && (a[1] ?? "").includes("hl.dsp.focus"))).toBe(false);
			expect(calls.some((a) => a[0] === "dispatch" && a[1] === "hl.dsp.group.toggle()")).toBe(false);
		} finally {
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

describe("admission + queue (2+2, work-conserving — the queue runs under the lease)", () => {
	it("the work-conserving batch: 4 tasks, cap 2, no foreign — the pass admits 2, queues 2; the wait loop runs the queue", async () => {
		const r = await dispatchTasks({
			tasks: [1, 2, 3, 4].map((n) => ({ agent: "test-agent", task: `review ${n}` })),
			mode: "headless",
			dispatcher: info(),
			bunBin,
			deps: deps(),
		});
		// the R1 contract: the call returned AFTER the spawn/admission pass and
		// BEFORE the first settlement — no harvest in the result (the harvest is
		// reported on settlement, never in the tool result); 2 admitted
		// (spawned now), 2 queued under the pass
		expect(r.dispatched).toBe(4);
		expect(r.queued).toBe(2);
		expect(r.results.filter((x) => x.queued).length).toBe(2);
		expect(r.results.every((x) => !P.isTerminal(x.state))).toBe(true); // returned before any settlement
		expect(r.text).not.toContain("fixture finished the work"); // no harvest content in the result
		// the wait loop (the watcher's mechanism, R2) runs the queue: as the two
		// spawned tasks free their slots, the queued two spawn and complete
		const w = await waitAll(r.results.map((x) => x.id));
		expect(w.states.every((x) => x.state === "completed")).toBe(true);
		expect(w.states.filter((x) => x.spawned).length).toBe(2); // the loop itself spawned the queued two
		// the clean fixture leaves no result.md — the harvest (the delivery's
		// mechanism) falls back to the session's last assistant text
		const h = await harvestTask(join(tasksRoot, r.results[0].id), "completed", { tmpDir: join(base, "tmp") });
		expect(h.text).toContain("fixture finished the work");
		// spec-transport pin (v1.10): the config tunable rides spec.json —
		// createTask fills it, the wrapper reads it from the spec
		const firstSpec = await P.readSpec(join(tasksRoot, r.results[0].id));
		expect(firstSpec.completed_close_s).toBe(600);
		// the delivery-eligibility marker (R7): every task created from the
		// async change onward carries async: true — the clean upgrade boundary
		expect(firstSpec.async).toBe(true);
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
			const w = await waitAll(r.results.map((x) => x.id));
			expect(w.states[0].state).toBe("completed");
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
			expect((await waitAll(r1.results.map((x) => x.id))).states[0].state).toBe("completed");
			expect((await P.readSpec(join(tasksRoot, r1.results[0].id))).agent.thinking).toBe("medium");
			// the per-call value wins over the frontmatter
			const r2 = await dispatchTasks({
				tasks: [{ agent: "thinker", task: "per-call thinking", thinking: "max" }],
				mode: "headless",
				dispatcher: info(),
				bunBin,
				deps: deps(),
			});
			expect((await waitAll(r2.results.map((x) => x.id))).states[0].state).toBe("completed");
			expect((await P.readSpec(join(tasksRoot, r2.results[0].id))).agent.thinking).toBe("max");
		} finally {
			rmSync(thinker, { force: true });
		}
	}, 60_000);


	it("2 tasks across a foreign running task: 1 admitted, 1 queued; the queue runs when the slot frees", async () => {
		const foreign = await spawnForeignRunning(3500);
		try {
			const r = await dispatchTasks({
				tasks: [{ agent: "test-agent", task: "one" }, { agent: "test-agent", task: "two" }],
				mode: "headless",
				dispatcher: info(),
				bunBin,
				deps: deps(),
			});
			// 1 slot free at admission: one spawns now, one queues under the pass
			// (the foreign task is not ours to report — the old "adopted" report
			// section is gone with the blocking call; the foreign keeps running
			// under its own wrapper)
			expect(r.queued).toBe(1);
			expect(r.results.filter((x) => x.queued).length).toBe(1);
			// the queue is live under the lease — the wait loop spawns the queued
			// one when the foreign frees (~3.5 s)
			const w = await waitAll(r.results.map((x) => x.id));
			expect(w.states.every((x) => x.state === "completed")).toBe(true);
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
	it("a queued task behind a slow worker survives past the 15 s stuck window (the lease-keyed predicate, R2)", async () => {
		// A foreign running task holds one slot, so the second task of the
		// batch queues under the pass. The injected clock fast-forwards 10 s
		// per now() call: by the time the entry returns, the queued task's age
		// (created_at vs now) is PAST the 15 s stuck window — and a direct
		// reconcile must still leave it alone: its lease is fresh (written at
		// creation with the same clock). The freshness is the key, not the age.
		const foreign = await spawnForeignRunning(20_000);
		// A backdated ghost queued task with NO lease is residue: the same
		// reconcile must still settle it (the lease gate is the only protection;
		// the ghost has no owner)
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
			const queued = r.results.find((x) => x.queued)!;
			expect(queued.state).toBe("queued"); // the pass queued it — the slot is held
			const qdir = join(tasksRoot, queued.id);
			// the queue's fake age is past the window; its lease is fresh — the
			// reconcile must not settle it (the freshness key, not the age)
			const stuck = await P.reconcileStuckQueued(qdir, { now: now() });
			expect(stuck.settled).toBe("none");
			expect(stuck.reason).toContain("lease fresh");
			// the wait loop (same clock) refreshes the queue's lease every tick —
			// it survives and runs when the foreign frees
			const w = await waitAll(r.results.map((x) => x.id), { now });
			expect(w.states.find((x) => x.id === queued.id)!.state).toBe("completed");
			const qEvents = await P.readEvents(qdir);
			expect(qEvents.some((e) => e.event === "transition" && e.from === "queued" && e.to === "crashed")).toBe(false);
			// the residue was settled by the entry's reconcile (no lease, past
			// the window)
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

	it("a dead worker's task settles crashed on the next call's reconcile (the delivery replaces the in-call deferred harvest)", async () => {
		// call 1: a hanging worker — the tool returns after the spawn pass (the
		// async contract: the turn never blocks, so no abort is needed to get
		// out)
		process.env.VITRINE_FIXTURE_MODE = "hang";
		const r1 = await dispatchTasks({
			tasks: [{ agent: "test-agent", task: "hang for me" }],
			mode: "headless",
			dispatcher: info(),
			bunBin,
			deps: deps(),
		});
		process.env.VITRINE_FIXTURE_MODE = "clean";
		const t1 = r1.results[0];
		expect(P.isTerminal(t1.state)).toBe(false); // the tool returned before settlement
		// the wrapper boots and flips queued→running on its own; wait for that
		// so the dead-wrapper rule (2) — not the stuck-queue rule (3) — settles
		// the task after the kill
		const t1dir = join(tasksRoot, t1.id);
		for (let i = 0; i < 50 && (await P.readState(t1dir).catch(() => null))?.state !== "running"; i++) {
			await new Promise((r) => setTimeout(r, 100));
		}
		// the worker hangs; kill the wrapper, then the worker (re-read — the
		// wrapper may not have recorded it yet)
		const st1 = await P.readState(t1dir).catch(() => null);
		if (st1?.wrapper_pid !== undefined) {
			try {
				process.kill(st1.wrapper_pid, "SIGKILL");
			} catch {}
		}
		await new Promise((r) => setTimeout(r, 200));
		const st1b = await P.readState(t1dir).catch(() => null);
		if (st1b?.worker_pid !== undefined) {
			try {
				process.kill(st1b.worker_pid, "SIGKILL");
			} catch {}
		}
		// call 2: the entry's reconcile settles the dead-wrapper case (rule 2);
		// the crashed task's harvest is reported on settlement (the delivery),
		// never carried in the tool result
		const r2 = await dispatchTasks({
			tasks: [{ agent: "test-agent", task: "next" }],
			mode: "headless",
			dispatcher: info(),
			bunBin,
			deps: deps(),
		});
		const st1c = await P.readState(t1dir);
		expect(st1c.state).toBe("crashed");
		expect(st1c.reason).toBe("dead-wrapper");
		// call 2's own task completes under the wait loop
		const w = await waitAll(r2.results.map((x) => x.id));
		expect(w.states.every((x) => x.state === "completed")).toBe(true);
	}, 60_000);

	it("a foreign queued task that goes terminal in the background settles independently (cross-session)", async () => {
		// a foreign queued task (another session's in-flight queue) — the tool
		// no longer snapshots foreign queues (the blocking call's deferred
		// harvest is gone with it); it just must not interfere: the foreign
		// settles on its own while we wait for our own task.
		const foreignDir = await createGhostTask();
		const foreignId = P.taskIdOf(foreignDir);
		// the foreign is young (no lease, inside the age grace) so neither the
		// entry's nor the wait loop's reconcile touches it; the timer settles
		// it (another session's bookkeeping)
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
		const w = await waitAll(r.results.map((x) => x.id));
		clearTimeout(timer); // the foreign settles in the background while we wait (the tool returned long before)
		expect(w.states.every((x) => x.state === "completed")).toBe(true);
		// the foreign settled with its own reason — untouched by us
		const st = await P.readState(foreignDir);
		expect(st.state).toBe("crashed");
		expect(st.reason).toBe("foreign settled");
		// and it never appears in our results
		expect(r.results.find((x) => x.id === foreignId)).toBeUndefined();
	}, 60_000);
});

describe("abort semantics (the async contract: a turn abort never cancels the work)", () => {
	it("an already-aborted signal skips the spawn pass (no work added to a dying turn)", async () => {
		const ac = new AbortController();
		ac.abort();
		const r = await dispatchTasks({
			tasks: [1, 2, 3, 4].map((n) => ({ agent: "test-agent", task: `review ${n}` })),
			mode: "headless",
			dispatcher: info(),
			bunBin,
			deps: deps({ signal: ac.signal }),
		});
		expect(r.aborted).toBe(true);
		// nothing spawned: every task stays queued under its lease — the
		// session's watcher owns it if the session lives; a dead session's
		// stale lease settles it never-spawned (delivery is session-scoped,
		// not turn-scoped)
		expect(r.results.every((x) => x.state === "queued")).toBe(true);
		expect(r.queued).toBe(4);
		// the leases are written at creation — the queue is live, not residue
		for (const x of r.results) {
			expect(await P.readLease(join(tasksRoot, x.id))).not.toBeNull();
		}
		// the pass added no work — nothing to kill; remove the dirs
		for (const x of r.results) await P.removeTask(join(tasksRoot, x.id));
	});

	it("a dead owner's stale lease settles the queue never-spawned; the spawned workers run on", async () => {
		const r = await dispatchTasks({
			tasks: [1, 2, 3, 4].map((n) => ({ agent: "test-agent", task: `review ${n}` })),
			mode: "headless",
			dispatcher: info(),
			bunBin,
			deps: deps(),
		});
		expect(r.aborted).toBe(false);
		const spawned = r.results.filter((x) => !x.queued);
		const queued = r.results.filter((x) => x.queued);
		expect(spawned.length).toBe(2); // cap 2, no foreign
		expect(queued.length).toBe(2);
		// the tool returned; the spawned two run on under their wrappers (the
		// fixture completes on its own). Wait for them to settle.
		for (let i = 0; i < 50; i++) {
			const sts = await Promise.all(spawned.map((x) => P.readState(join(tasksRoot, x.id)).catch(() => null)));
			if (sts.every((s) => s !== null && P.isTerminal(s.state))) break;
			await new Promise((r) => setTimeout(r, 200));
		}
		for (const x of spawned) {
			const st = await P.readState(join(tasksRoot, x.id));
			expect(st.state).toBe("completed");
		}
		// the dispatcher is dead (no watcher exists in this hermetic test to
		// keep refreshing the queue's leases): 31 s past creation the leases
		// are stale and the queue is a dead owner's residue — the stuck-queued
		// rule settles it never-spawned
		for (const x of queued) {
			const dir = join(tasksRoot, x.id);
			const res = await P.reconcileStuckQueued(dir, { now: Date.now() + 31_000 });
			expect(res.settled).toBe("crashed");
			expect(await P.readState(dir)).toMatchObject({ state: "crashed", reason: "never-spawned" });
		}
	}, 60_000);
});

describe("countSlots (liveness-qualified)", () => {
	it("counts live running wrappers, fresh-lease queued, and nothing else (the lease is the key)", () => {
		const proc = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
		proc.unref();
		const live = P.pidInfo(proc.pid!);
		const now = Date.now();
		const freshLease = new Date(now - 1_000).toISOString(); // the owner ticked 1 s ago
		const staleLease = new Date(now - 45_000).toISOString(); // the owner stopped ticking
		const n = countSlots(
			[
				{ dir: "/a", state: "running", wrapperPid: proc.pid, wrapperPidStart: live.startTime },
				{ dir: "/b", state: "running", wrapperPid: proc.pid, wrapperPidStart: "recycled-start-time" },
				{ dir: "/c", state: "running" },
				{ dir: "/d", state: "queued", wrapperPid: proc.pid },
				{ dir: "/e", state: "queued", leaseUpdatedAt: freshLease },
				{ dir: "/f", state: "queued", leaseUpdatedAt: staleLease },
				{ dir: "/g", state: "queued", leaseUpdatedAt: null }, // no lease — a dead owner's residue
				{ dir: "/h", state: "completed" },
			],
			now,
		);
		// a (live+start-match) + d (live wrapper) + e (fresh lease — a live queue,
		// whatever its creation age) = 3
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

	it("result.json: the typed data is harvested (machine-readable + compact JSON for the report)", async () => {
		const data = { verdict: "pass", port: 8080 };
		const dir = await terminalTaskDir({ "result.md": "the answer\n", "result.json": JSON.stringify(data, null, 2) + "\n" });
		const h = await harvestTask(dir, "completed", { tmpDir: join(base, "tmp") });
		expect(h.data).toEqual(data);
		expect(h.dataText).toBe(JSON.stringify(data));
		expect(h.overflowDataFile).toBeUndefined();
	});

	it("a >8KB result.json is capped, with the full data in a 0600 overflow file", async () => {
		const data = { big: "x".repeat(9000), keep: "it" };
		const full = JSON.stringify(data);
		const dir = await terminalTaskDir({ "result.md": "the answer\n", "result.json": full + "\n" });
		const h = await harvestTask(dir, "completed", { tmpDir: join(base, "tmp") });
		expect(h.data).toEqual(data); // machine-readable stays uncapped
		expect(h.dataText).toContain("[data capped");
		expect(h.dataText).toContain(h.overflowDataFile!);
		expect(h.dataText!.length).toBeLessThan(full.length);
		const st = statSync(h.overflowDataFile!);
		expect(st.mode & 0o777).toBe(0o600);
		expect(await readFile(h.overflowDataFile!, "utf8")).toBe(full);
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

describe("result format (the R1 shape)", () => {
	// The tool result carries NO harvest: per task — short id, agent, state
	// (running/queued; crashed when the spawn failed in the pass) — and for
	// every non-terminal task the one line stating the harvest will be
	// reported on settlement.
	const res: DispatchedTaskResult[] = [
		{ id: "a1b2c3d4-0000-0000-0000-000000000001", agent: "refiner", state: "running", sessionId: "vitrine.a1b2c3d4-0000-0000-0000-000000000001" },
		{ id: "a1b2c3d4-0000-0000-0000-000000000002", agent: "executor", state: "queued", queued: true, sessionId: "vitrine.a1b2c3d4-0000-0000-0000-000000000002" },
		{ id: "a1b2c3d4-0000-0000-0000-000000000003", agent: "executor", state: "crashed", reason: "failed-to-spawn", sessionId: "vitrine.a1b2c3d4-0000-0000-0000-000000000003" },
	];
	const text = renderDispatch({ dispatched: 3, results: res, aborted: false });

	it("header: the dispatched count + the non-blocking contract line", () => {
		expect(text.split("\n")[0]).toBe("3 dispatched (non-blocking — each task's harvest will be reported on settlement, not in this result)");
	});

	it("per-task line: [n] agent · shortid — state (no harvest content)", () => {
		expect(text).toContain("[1] refiner · a1b2c3d4 — running — the harvest will be reported on settlement");
		expect(text).toContain("[2] executor · a1b2c3d4 — queued — the harvest will be reported on settlement");
	});

	it("a terminal task (the pass settled it) names state + reason, no settlement line", () => {
		expect(text).toContain("[3] executor · a1b2c3d4 — crashed (failed-to-spawn)");
		expect(text).not.toContain("crashed (failed-to-spawn) — the harvest");
	});

	it("no harvest content ever lands in the result text", () => {
		expect(text).not.toContain("the verdict");
		expect(text).not.toContain("data:");
	});

	it("on abort, the header names the skipped spawn pass (the tasks stay queued under their lease)", () => {
		const abortedRes: DispatchedTaskResult[] = [
			{ id: "a1b2c3d4-0000-0000-0000-000000000001", agent: "refiner", state: "queued", queued: true, sessionId: "vitrine.a1b2c3d4-0000-0000-0000-000000000001" },
			{ id: "a1b2c3d4-0000-0000-0000-000000000002", agent: "executor", state: "queued", queued: true, sessionId: "vitrine.a1b2c3d4-0000-0000-0000-000000000002" },
		];
		const t = renderDispatch({ dispatched: 2, results: abortedRes, aborted: true });
		expect(t.split("\n")[0]).toBe(
			"2 dispatched (non-blocking — each task's harvest will be reported on settlement, not in this result) · ABORTED (the spawn pass was skipped — the tasks stay queued under their lease)",
		);
	});
});
