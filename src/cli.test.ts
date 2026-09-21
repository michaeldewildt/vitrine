/**
 * cli.test.ts — the human-side surface: list / show / kill / gc.
 * `runCli` is deps-injected (now, sinks) so every verb is asserted on its
 * exit code + emitted lines without touching the real streams.
 */
import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { writeFile } from "node:fs/promises";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as P from "./protocol";
import { runCli } from "./cli";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let base: string;
let realHome: string;
let realTasksRoot: string | undefined;
let realSessionsDir: string | undefined;
let realBenchHistory: string | undefined;
const NOW = Date.parse("2026-09-16T12:00:00Z");

function makeSpec(taskId: string, over: Partial<P.TaskSpec> = {}): P.TaskSpec {
	return {
		task_id: taskId,
		agent: { name: "refiner", body: "body\n" },
		dispatcher_session_id: "01a0a8c2-c3eb-76fe-9fa7-ed7ca4c13ba2",
		cwd: base,
		session_id: `vitrine.${taskId}`,
		session_name: `vitrine: refiner · ${taskId.slice(0, 8)}`,
		mode: "tile",
		attended: false,
		workspace: 9,
		wall_timeout_s: 3600,
		inactivity_s: 600,
		auto_settle_s: 600,
		auto_settle_grace_s: 60,
		created_at: new Date(NOW - 10_000).toISOString(),
		boot_id: P.currentBootId(),
		...over,
	};
}

async function newTask(over: Partial<P.TaskSpec> = {}): Promise<string> {
	const id = P.newTaskId();
	const dir = join(P.tasksRoot(), id);
	await P.createTask(dir, makeSpec(id, over), "mission\n");
	return dir;
}

const QUIET = { out: () => {}, err: () => {} };

beforeAll(async () => {
	base = await mkdtemp(join(tmpdir(), "vitrine-cli-"));
	realHome = process.env.HOME ?? "";
	realTasksRoot = process.env.VITRINE_TASKS_ROOT;
	realSessionsDir = process.env.VITRINE_SESSIONS_DIR;
	realBenchHistory = process.env.VITRINE_BENCH_HISTORY;
	process.env.HOME = base;
	process.env.VITRINE_TASKS_ROOT = join(base, "tasks");
	process.env.VITRINE_SESSIONS_DIR = join(base, "sessions");
	// The CLI-level `bench` tests run the full driver (hermetic + live) WITHOUT
	// skipHistory. The history path is the one IO seam they leave behind — the
	// drivers resolve it repo-relative, not through HOME — so point it at a tmp
	// file: no test may touch the machine's history (the warn-gate baseline).
	process.env.VITRINE_BENCH_HISTORY = join(base, "bench-history.jsonl");
});

afterAll(async () => {
	process.env.HOME = realHome;
	if (realTasksRoot === undefined) delete process.env.VITRINE_TASKS_ROOT;
	else process.env.VITRINE_TASKS_ROOT = realTasksRoot;
	if (realSessionsDir === undefined) delete process.env.VITRINE_SESSIONS_DIR;
	else process.env.VITRINE_SESSIONS_DIR = realSessionsDir;
	if (realBenchHistory === undefined) delete process.env.VITRINE_BENCH_HISTORY;
	else process.env.VITRINE_BENCH_HISTORY = realBenchHistory;
	await rm(base, { recursive: true, force: true });
});

describe("usage", () => {
	it("no verb ⇒ usage, exit 2", async () => {
		const r = await runCli([], QUIET);
		expect(r.code).toBe(2);
		expect(r.lines.join(" ")).toContain("usage");
	});

	it("unknown verb ⇒ exit 2, names the verb", async () => {
		const r = await runCli(["frobnicate"], QUIET);
		expect(r.code).toBe(2);
	});

	it("help ⇒ exit 0", async () => {
		const r = await runCli(["help"], QUIET);
		expect(r.code).toBe(0);
	});
});

describe("list", () => {
	it("an empty root reports no tasks", async () => {
		const r = await runCli(["list"], QUIET);
		expect(r.code).toBe(0);
		expect(r.lines).toContain("(no tasks)");
	});

	it("lists id, state, age, pids and title — newest first", async () => {
		const dirA = await newTask({ created_at: new Date(NOW - 60_000).toISOString() });
		const dirB = await newTask({ created_at: new Date(NOW - 10_000).toISOString() });
		await P.transitionState(dirB, "queued", "running", { wrapper_pid: process.pid, worker_pid: process.pid });
		const r = await runCli(["list"], { ...QUIET, now: () => NOW });
		const body = r.lines.slice(1);
		const idA = P.taskIdOf(dirA).slice(0, 8);
		const idB = P.taskIdOf(dirB).slice(0, 8);
		expect(body[0].startsWith(idB)).toBe(true); // newest first
		expect(body[0]).toContain("running");
		expect(body[0]).toContain(String(process.pid));
		expect(body[0]).toContain("vitrine: refiner ·");
		expect(body[1].startsWith(idA)).toBe(true);
		expect(body[1]).toContain("queued");
	});

	it("completed+ marks a completed task the human resumed after completion (v1.11)", async () => {
		const dir = await newTask();
		await P.transitionState(dir, "queued", "running", { wrapper_pid: process.pid, worker_pid: process.pid });
		await P.transitionState(dir, "running", "completed", {});
		await P.appendEvent(dir, { event: "resumed", source: "human" });
		const r = await runCli(["list"], { ...QUIET, now: () => NOW });
		expect(r.lines.join("\n")).toContain("completed+");
		// a completed task WITHOUT the event shows plain `completed`
		const dir2 = await newTask();
		await P.transitionState(dir2, "queued", "running", { wrapper_pid: process.pid, worker_pid: process.pid });
		await P.transitionState(dir2, "running", "completed", {});
		const r2 = await runCli(["list"], { ...QUIET, now: () => NOW });
		const plain = r2.lines.find((l) => l.includes(P.taskIdOf(dir2).slice(0, 8)));
		expect(plain).toContain("completed ");
		expect(plain).not.toContain("completed+");
	});
});

describe("show", () => {
	it("bad id shape ⇒ exit 1", async () => {
		const r = await runCli(["show", "not-a-uuid"], QUIET);
		expect(r.code).toBe(1);
	});

	it("unknown id ⇒ exit 1, 'no such task'", async () => {
		const r = await runCli(["show", P.newTaskId()], QUIET);
		expect(r.code).toBe(1);
	});

	it("a live task shows state, agent, session, events and result", async () => {
		const dir = await newTask();
		await P.transitionState(dir, "queued", "running", { wrapper_pid: process.pid, worker_pid: process.pid });
		await P.writeSessionOnce(dir, { session_id: `vitrine.${P.taskIdOf(dir)}`, session_file: join("/sessions", "x.jsonl") });
		await P.appendEvent(dir, { event: "state", to: "running" });
		await P.writeResult(dir, "the answer\n");
		const r = await runCli(["show", P.taskIdOf(dir)], { ...QUIET, now: () => NOW });
		expect(r.code).toBe(0);
		const text = r.lines.join("\n");
		expect(text).toContain("task   " + P.taskIdOf(dir));
		expect(text).toContain("state  running");
		expect(text).toContain("agent  refiner · tile ·");
		expect(text).toContain("session vitrine.");
		expect(text).toContain("events");
		expect(text).toContain("result.md:");
		expect(text).toContain("  the answer");
	});
});

describe("kill", () => {
	it("a queued task settles now (kill-requested)", async () => {
		const dir = await newTask();
		const id = P.taskIdOf(dir);
		const r = await runCli(["kill", id], QUIET);
		expect(r.code).toBe(0);
		expect(r.lines[0]).toContain(`${id}: settled`);
		expect(r.lines[0]).toContain("crashed");
		expect((await P.readState(dir)).state).toBe("crashed");
	});

	it("a terminal task is a no-op", async () => {
		const dir = await newTask();
		const id = P.taskIdOf(dir);
		await P.transitionState(dir, "queued", "running", {});
		await P.writeDoneMarker(dir, "vitrine_done");
		await P.transitionState(dir, "running", "completed"); // marker-wins path
		const r = await runCli(["kill", id], QUIET);
		expect(r.code).toBe(0);
		expect(r.lines[0]).toContain("none");
	});

	it("unknown id ⇒ exit 1", async () => {
		const r = await runCli(["kill", P.newTaskId()], QUIET);
		expect(r.code).toBe(1);
	});
});

describe("gc", () => {
	it("a fresh terminal task is kept (retention window)", async () => {
		const dir = await newTask();
		await P.transitionState(dir, "queued", "running", {});
		await P.transitionState(dir, "running", "completed", {}, "done");
		const r = await runCli(["gc"], { ...QUIET, now: () => NOW });
		expect(r.lines).toContain("gc: nothing to remove");
		expect(r.code).toBe(0);
	});

	it("a terminal task past retention is pruned; a recent one is kept", async () => {
		const keep = await newTask();
		await P.transitionState(keep, "queued", "running", {});
		await P.transitionState(keep, "running", "completed", {}, "done");
		const prune = await newTask();
		await P.transitionState(prune, "queued", "running", {});
		await P.transitionState(prune, "running", "completed", {}, "done");
		// age the pruned one 15 days (retention is 14 by default)
		const st = await P.readState(prune);
		st.finished_at = new Date(NOW - 15 * 24 * 3600 * 1000).toISOString();
		await writeFile(join(prune, "state.json"), JSON.stringify(st, null, 2) + "\n");
		const r = await runCli(["gc"], { ...QUIET, now: () => NOW });
		expect(r.code).toBe(0);
		expect(r.lines.join("\n")).toContain("removed " + P.taskIdOf(prune));
		expect(r.lines.join("\n")).not.toContain("removed " + P.taskIdOf(keep));
		const gone = await (await import("node:fs/promises")).stat(join(P.tasksRoot(), P.taskIdOf(prune))).then(() => false).catch(() => true);
		expect(gone).toBe(true);
	});

	it("a running task is never gc'd", async () => {
		const dir = await newTask();
		await P.transitionState(dir, "queued", "running", { wrapper_pid: process.pid, worker_pid: process.pid });
		const st = await P.readState(dir);
		st.finished_at = new Date(NOW - 15 * 24 * 3600 * 1000).toISOString();
		await writeFile(join(dir, "state.json"), JSON.stringify(st, null, 2) + "\n");
		const r = await runCli(["gc"], { ...QUIET, now: () => NOW });
		expect(r.lines).toContain("gc: nothing to remove");
	});

	it("an undelivered async task dir is never gc'd (the delivery owns it until the harvest-delivered marker)", async () => {
		const dir = await newTask({ async: true });
		await P.transitionState(dir, "queued", "running", {});
		await P.transitionState(dir, "running", "completed", {}, "done");
		// age it 15 days — past the retention window; without the skip it would be pruned
		const st = await P.readState(dir);
		st.finished_at = new Date(NOW - 15 * 24 * 3600 * 1000).toISOString();
		await writeFile(join(dir, "state.json"), JSON.stringify(st, null, 2) + "\n");
		const r = await runCli(["gc"], { ...QUIET, now: () => NOW });
		expect(r.lines).toContain("gc: nothing to remove");
		// once the delivery writes the marker, the plain retention rule applies again
		await P.writeHarvestDelivered(dir, "batch-x");
		const r2 = await runCli(["gc"], { ...QUIET, now: () => NOW });
		expect(r2.lines.join("\n")).toContain("removed " + P.taskIdOf(dir));
	});
});

describe("gc --dry-run", () => {
	// a fresh scratch root: exact candidate counts (the shared root accumulates
	// across tests)
	let root: string;

	beforeAll(async () => {
		root = await mkdtemp(join(tmpdir(), "vitrine-cli-gcdry-"));
		process.env.VITRINE_TASKS_ROOT = root;
	});

	afterAll(async () => {
		process.env.VITRINE_TASKS_ROOT = join(base, "tasks");
		await rm(root, { recursive: true, force: true });
	});

	it("no candidates ⇒ 'gc --dry-run: nothing to remove', exit 0", async () => {
		const r = await runCli(["gc", "--dry-run"], { ...QUIET, now: () => NOW });
		expect(r.code).toBe(0);
		expect(r.lines).toContain("gc --dry-run: nothing to remove");
	});

	it("previews eligible dirs; the injected remove spy is never called and the dirs stay", async () => {
		const keep = await newTask();
		await P.transitionState(keep, "queued", "running", {});
		await P.transitionState(keep, "running", "completed", {}, "done");
		const prune = await newTask();
		await P.transitionState(prune, "queued", "running", {});
		await P.transitionState(prune, "running", "completed", {}, "done");
		// age the pruned one 15 days (retention is 14 by default)
		const st = await P.readState(prune);
		st.finished_at = new Date(NOW - 15 * 24 * 3600 * 1000).toISOString();
		await writeFile(join(prune, "state.json"), JSON.stringify(st, null, 2) + "\n");
		const removed: string[] = [];
		const r = await runCli(["gc", "--dry-run"], {
			...QUIET,
			now: () => NOW,
			remove: async (dir: string) => {
				removed.push(dir);
			},
		});
		expect(r.code).toBe(0);
		expect(r.lines).toContain(`would remove ${P.taskIdOf(prune)} (completed, 15d old)`);
		expect(r.lines.join("\n")).not.toContain("would remove " + P.taskIdOf(keep));
		expect(removed).toEqual([]); // the spy was never called ⇒ nothing was deleted
		const st0 = await stat(prune).catch(() => null);
		expect(st0 !== null && st0.isDirectory()).toBe(true);
	});

	it("gc --bogus ⇒ usage error, exit 2", async () => {
		const errs: string[] = [];
		const r = await runCli(["gc", "--bogus"], { ...QUIET, err: (l) => errs.push(l) });
		expect(r.code).toBe(2);
		expect(errs.join(" ")).toContain("usage");
	});
});

describe("list --json", () => {
	// a fresh scratch root: an exact row array, and [] on an empty root
	let root: string;

	beforeAll(async () => {
		root = await mkdtemp(join(tmpdir(), "vitrine-cli-json-"));
		process.env.VITRINE_TASKS_ROOT = root;
	});

	afterAll(async () => {
		process.env.VITRINE_TASKS_ROOT = join(base, "tasks");
		await rm(root, { recursive: true, force: true });
	});

	it("an empty root emits [] — one line, exit 0", async () => {
		const r = await runCli(["list", "--json"], { ...QUIET, now: () => NOW });
		expect(r.code).toBe(0);
		expect(r.lines.length).toBe(1);
		expect(JSON.parse(r.lines[0])).toEqual([]);
	});

	it("one line of valid JSON, newest-first, fixed row shape", async () => {
		const dirA = await newTask({ created_at: new Date(NOW - 60_000).toISOString() });
		const dirB = await newTask({ created_at: new Date(NOW - 10_000).toISOString() });
		await P.transitionState(dirB, "queued", "running", { wrapper_pid: process.pid, worker_pid: process.pid });
		const r = await runCli(["list", "--json"], { ...QUIET, now: () => NOW });
		expect(r.code).toBe(0);
		expect(r.lines.length).toBe(1);
		const rows = JSON.parse(r.lines[0]) as Array<Record<string, unknown>>;
		expect(rows).toHaveLength(2);
		expect(rows[0].id).toBe(P.taskIdOf(dirB)); // newest first
		expect(rows[1].id).toBe(P.taskIdOf(dirA));
		for (const row of rows) {
			expect(Object.keys(row)).toEqual([
				"id",
				"state",
				"state_reason",
				"resumed",
				"created_at",
				"finished_at",
				"wrapper_pid",
				"worker_pid",
				"session_name",
			]);
		}
		const a = rows[1];
		expect(a.state).toBe("queued");
		expect(a.state_reason).toBe(null);
		expect(a.resumed).toBe(false);
		expect(a.created_at).toBe(new Date(NOW - 60_000).toISOString());
		expect(a.finished_at).toBe(null);
		expect(a.wrapper_pid).toBe(null);
		expect(a.worker_pid).toBe(null);
		expect(a.session_name).toBe(`vitrine: refiner · ${P.taskIdOf(dirA).slice(0, 8)}`);
		const b = rows[0];
		expect(b.state).toBe("running");
		expect(b.wrapper_pid).toBe(process.pid);
		expect(b.worker_pid).toBe(process.pid);
		expect(b.finished_at).toBe(null);
	});

	it("resumed is true only for a completed task with a resumed event", async () => {
		const dir = await newTask({ created_at: new Date(NOW - 5_000).toISOString() });
		await P.transitionState(dir, "queued", "running", {});
		await P.transitionState(dir, "running", "completed", {}, "done");
		await P.appendEvent(dir, { event: "resumed", source: "human" });
		const r = await runCli(["list", "--json"], { ...QUIET, now: () => NOW });
		const rows = JSON.parse(r.lines[0]) as Array<Record<string, unknown>>;
		const row = rows.find((x) => x.id === P.taskIdOf(dir));
		expect(row).toBeDefined();
		expect(row!.state).toBe("completed");
		expect(row!.resumed).toBe(true);
		expect(row!.finished_at).toBeTypeOf("string");
	});

	it("list --bogus ⇒ usage error, exit 2", async () => {
		const errs: string[] = [];
		const r = await runCli(["list", "--bogus"], { ...QUIET, err: (l) => errs.push(l) });
		expect(r.code).toBe(2);
		expect(errs.join(" ")).toContain("usage");
	});
});

describe("bench", () => {
	it("bench live --mode bogus / --mode (missing value) ⇒ usage, exit 2", async () => {
		for (const argv of [
			["bench", "live", "--mode", "bogus"],
			["bench", "live", "--mode"],
			["bench", "live", "--runs", "0"],
		]) {
			const errs: string[] = [];
			const r = await runCli(argv, { ...QUIET, err: (l) => errs.push(l) });
			expect(r.code).toBe(2);
			expect(errs.join(" ")).toContain("usage: vitrine bench");
		}
	});

	it("bench hermetic --mode ⇒ usage (headless-only), exit 2", async () => {
		const errs: string[] = [];
		const r = await runCli(["bench", "hermetic", "--mode", "headless"], { ...QUIET, err: (l) => errs.push(l) });
		expect(r.code).toBe(2);
		expect(errs.join(" ")).toContain("headless-only");
	});

	it("bench without a sub-verb ⇒ usage (stderr), exit 2", async () => {
		const errs: string[] = [];
		const r = await runCli(["bench"], { ...QUIET, err: (l) => errs.push(l) });
		expect(r.code).toBe(2);
		expect(errs.join(" ")).toContain("usage: vitrine bench");
	});

	it("bench hermetic --runs 0 / --runs abc / --runs (missing value) ⇒ usage, exit 2", async () => {
		for (const argv of [["bench", "hermetic", "--runs", "0"], ["bench", "hermetic", "--runs", "abc"], ["bench", "hermetic", "--runs"]]) {
			const r = await runCli(argv, QUIET);
			expect(r.code).toBe(2);
		}
	});

	it("bench hermetic --bogus ⇒ usage, exit 2", async () => {
		const r = await runCli(["bench", "hermetic", "--bogus"], QUIET);
		expect(r.code).toBe(2);
	});

	it("bench hermetic runs the driver and exits 0 (--json: one line of record JSON, no text report)", async () => {
		const r = await runCli(["bench", "hermetic", "--runs", "1", "--json"], QUIET);
		expect(r.code).toBe(0);
		// --json: exactly one line — the history record (fixed shape)
		expect(r.lines).toHaveLength(1);
		const rec = JSON.parse(r.lines[0]) as Record<string, unknown>;
		expect(rec.suite).toBe("hermetic");
		expect((rec.params as Record<string, unknown>).runs).toBe(1);
		expect(Array.isArray(rec.rows)).toBe(true);
		expect(typeof (rec.medians as Record<string, unknown>).boot_ms).toBe("number");
		expect(typeof (rec.medians as Record<string, unknown>).settle_ms).toBe("number");
	}, 120_000);
});

describe("bench live (the flag surface + the CLI→driver chain against the fixture)", () => {
	// The CLI runs the REAL driver against the REAL battery (three dispatches,
	// one at a time) — under the test env (tmp HOME/tasks/sessions) with a
	// fake-pi shim + the battery's seats, so no real model is touched. The
	// fixture ignores prompts, so every oracle fails: the run is a
	// success-0/3 REPORT — and the exit code stays 0 (the contract).
	let shim: string;
	let realPiBin: string | undefined;
	// a fresh scratch tasks root: the earlier tests leave foreign running tasks
	// (wrapper pid = the test process → live) in the shared root, and those
	// would hold the slot cap — the driver would queue its tasks behind them
	// forever. The bench describe runs on a clean root, like the gc --dry-run
	// and list --json describes do.
	let root: string;

	beforeAll(async () => {
		const { chmod, mkdir, writeFile } = await import("node:fs/promises");
		const agents = join(base, ".pi", "agent", "agents");
		await mkdir(agents, { recursive: true });
		await writeFile(
			join(agents, "explore.md"),
			"---\nname: explore\ndescription: fixture read-only investigator for the bench live CLI test.\nmodel: ninfer/bench-model\n---\n# Explore\n\nFixture.\n",
		);
		await writeFile(
			join(agents, "execute.md"),
			"---\nname: execute\ndescription: fixture bounded implementer for the bench live CLI test.\nmodel: ninfer/bench-model\n---\n# Execute\n\nFixture.\n",
		);
		shim = join(base, "pi-shim");
		await writeFile(shim, `#!/bin/sh\nexport VITRINE_FIXTURE_MODE=done\nexport VITRINE_FIXTURE_GAP_MS=30\nexec ${process.execPath} ${REPO_ROOT}/test/fixtures/fake-pi.ts "$@"\n`);
		await chmod(shim, 0o755);
		realPiBin = process.env.VITRINE_PI_BIN;
		process.env.VITRINE_PI_BIN = shim;
		root = await mkdtemp(join(tmpdir(), "vitrine-cli-benchlive-"));
		process.env.VITRINE_TASKS_ROOT = root;
	});

	afterAll(async () => {
		if (realPiBin === undefined) delete process.env.VITRINE_PI_BIN;
		else process.env.VITRINE_PI_BIN = realPiBin;
		process.env.VITRINE_TASKS_ROOT = join(base, "tasks");
		await rm(root, { recursive: true, force: true });
	});

	it("bench live --runs 1 --mode headless runs the battery and exits 0 (the failed oracles are a report)", async () => {
		const r = await runCli(["bench", "live", "--runs", "1", "--mode", "headless"], QUIET);
		expect(r.code).toBe(0);
		const text = r.lines.join("\n");
		expect(text).toContain("vitrine bench live — 1 runs · mode headless · battery: read-ground, bounded-write, decode-proxy");
		expect(text).toContain("success 0/3"); // the fixture cannot satisfy the real oracles
		expect(text).toContain("failures (3):");
		expect(text).toContain("oracle:");
	}, 120_000);

	it("bench live --json: one line of the live history record, no text report", async () => {
		const r = await runCli(["bench", "live", "--runs", "1", "--mode", "headless", "--json"], QUIET);
		expect(r.code).toBe(0);
		expect(r.lines).toHaveLength(1);
		const rec = JSON.parse(r.lines[0]) as Record<string, unknown>;
		expect(rec.suite).toBe("live");
		expect(rec.params).toEqual({ runs: 1, mode: "headless", battery: ["read-ground", "bounded-write", "decode-proxy"] });
		expect((rec.rows as unknown[]).length).toBe(3);
		expect((rec.medians as Record<string, unknown>).e2e_ms).toBe(null); // no successful runs ⇒ null medians
	}, 120_000);
});
