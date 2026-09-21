/**
 * protocol.test.ts — the protocol suite:
 *
 * - atomic writes (tmp + rename; no tmp residue after any write or rejection)
 * - monotonic state machine (every (from, to) pair attempted — 49 fresh tasks)
 * - ordering rules: marker wins (rule 1), dead-wrapper reconcile (rule 2,
 *   incl. both recycled-pid guard branches and the contested outcome),
 *   hand-off CAS (rule 3) incl. the concurrent queued→running interleaving
 *   (the accepted both-pass window is safe; the bail is covered by the
 *   stale-view test)
 * - path validation (containment, symlink escape, uuid shape)
 * - spec round-trip (write → read → deep-equal; malformed specs rejected)
 *
 * Hermetic: VITRINE_TASKS_ROOT points at a tmp dir. No pi, no Hyprland, no LLM.
 */
import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as P from "./protocol";

let base: string;
let root: string;

beforeAll(async () => {
	base = await mkdtemp(join(tmpdir(), "vitrine-u1-"));
	root = join(base, "tasks");
	process.env.VITRINE_TASKS_ROOT = root;
});

afterAll(async () => {
	delete process.env.VITRINE_TASKS_ROOT;
	await rm(base, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// helpers

function makeSpec(taskId: string): P.TaskSpec {
	return {
		task_id: taskId,
		agent: { name: "refiner", model: "ninfer/qwen3.8-27b", thinking: "high", tools: ["read", "grep"], inactivityTimeout: 600 },
		dispatcher_session_id: "01a0a8c2-c3eb-76fe-9fa7-ed7ca4c13ba2",
		cwd: "/tmp",
		session_id: `vitrine.${taskId}`,
		session_name: `refiner · ${taskId.slice(0, 8)}`,
		mode: "tile",
		attended: false,
		workspace: 9,
		wall_timeout_s: 3600,
		inactivity_s: 600,
		auto_settle_s: 600,
		auto_settle_grace_s: 60,
		created_at: new Date().toISOString(),
		// the real current boot id — the anti-recycling liveness check compares
		// against this, so a fixture spec must be on the live boot to count as live
		boot_id: P.currentBootId(),
	};
}

const PROMPT = "vitrine task <id> agent=refiner dispatcher=01a0a8c2-c3eb-76fe-9fa7-ed7ca4c13ba2 cwd=/tmp\nmission text";

async function newTask(taskId?: string): Promise<{ id: string; dir: string }> {
	const id = taskId ?? P.newTaskId();
	const dir = join(root, id);
	await P.createTask(dir, makeSpec(id), PROMPT.replace("<id>", id));
	return { id, dir };
}

async function reachState(dir: string, target: P.TaskState): Promise<void> {
	if (target === "queued") return;
	const r1 = await P.transitionState(dir, "queued", "running", { wrapper_pid: 111, foot_pid: 222 });
	expect(r1.ok).toBe(true);
	if (target !== "running") {
		const r2 = await P.transitionState(dir, "running", target);
		expect(r2.ok).toBe(true);
	}
}

async function rejects(code: P.ProtocolErrorCode, fn: () => Promise<unknown>): Promise<void> {
	try {
		await fn();
	} catch (e) {
		expect(e).toBeInstanceOf(P.ProtocolError);
		expect((e as P.ProtocolError).code).toBe(code);
		return;
	}
	throw new Error(`expected ProtocolError(${code}) but nothing was thrown`);
}

async function deadPid(): Promise<number> {
	const cp = spawn("true", [], { stdio: "ignore" });
	await new Promise<void>((res) => cp.on("exit", () => res()));
	return cp.pid!;
}

async function liveSleep(): Promise<{ pid: number; cp: ReturnType<typeof spawn> }> {
	const cp = spawn("sleep", ["30"], { stdio: "ignore" });
	await new Promise<void>((res) => cp.on("spawn", () => res()));
	return { pid: cp.pid!, cp };
}

async function isDead(pid: number): Promise<boolean> {
	try {
		process.kill(pid, 0);
		return false;
	} catch (e: unknown) {
		return (e as NodeJS.ErrnoException).code === "ESRCH";
	}
}

async function waitDead(pid: number, ms = 5000): Promise<boolean> {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		if (await isDead(pid)) return true;
		await new Promise((r) => setTimeout(r, 50));
	}
	return false;
}

async function noTmpResidue(dir: string): Promise<void> {
	const entries = await readdir(dir);
	expect(entries.filter((e) => e.includes(".tmp.")).length).toBe(0);
}

// ---------------------------------------------------------------------------
// path validation

describe("path validation", () => {
	it("accepts a fresh and an existing valid task dir", async () => {
		const id = P.newTaskId();
		expect(await P.assertTaskDir(join(root, id))).toBe(join(root, id));
		const { dir } = await newTask(id);
		expect(await P.assertTaskDir(dir)).toBe(dir);
	});

	it("rejects relative paths, foreign roots, nesting, the root itself, and non-uuid names", async () => {
		const id = P.newTaskId();
		await rejects("bad-path", () => P.assertTaskDir(join("tasks", id)));
		await rejects("bad-path", () => P.assertTaskDir(join("/tmp/elsewhere", id)));
		await rejects("bad-path", () => P.assertTaskDir(join(root, id, id)));
		await rejects("bad-path", () => P.assertTaskDir(root));
		await rejects("bad-path", () => P.assertTaskDir(join(root, "not-a-uuid")));
	});

	it("rejects lexical escapes outside the root", async () => {
		const id = P.newTaskId();
		await rejects("bad-path", () => P.assertTaskDir(join(root, "..", "outside", id)));
	});

	it("rejects an uppercase uuid", async () => {
		const id = P.newTaskId().toUpperCase();
		await rejects("bad-path", () => P.assertTaskDir(join(root, id)));
	});

	it("rejects a symlink that escapes the root", async () => {
		const id = P.newTaskId();
		await mkdir(join(base, "outside"), { recursive: true });
		await symlink(join(base, "outside"), join(root, id));
		await rejects("bad-path", () => P.assertTaskDir(join(root, id)));
	});

	it("taskIdOf and listTaskDirs behave", async () => {
		const { id, dir } = await newTask();
		expect(P.taskIdOf(dir)).toBe(id);
		await mkdir(join(root, "not-uuid"), { recursive: true });
		await writeFile(join(root, "a-file"), "x");
		const dirs = await P.listTaskDirs();
		expect(dirs).toContain(dir);
		expect(dirs).not.toContain(join(root, "not-uuid"));
		expect(dirs).not.toContain(join(root, "a-file"));
		expect(dirs).toEqual([...dirs].sort());
	});

	it("accepts a symlinked tasks root (containment is realpath-based; no orphan dir)", async () => {
		const real = join(base, "realroot");
		await mkdir(real, { recursive: true, mode: 0o700 });
		const sym = join(base, "symroot");
		await symlink(real, sym);
		const prev = process.env.VITRINE_TASKS_ROOT;
		process.env.VITRINE_TASKS_ROOT = sym;
		try {
			const id = P.newTaskId();
			const dir = join(sym, id);
			await P.createTask(dir, makeSpec(id), PROMPT.replace("<id>", id));
			expect((await P.readSpec(dir)).task_id).toBe(id);
			expect(await readdir(sym)).toEqual([id]); // the task lives under the real root
		} finally {
			process.env.VITRINE_TASKS_ROOT = prev;
		}
	});
});

// ---------------------------------------------------------------------------
// createTask & spec round-trip

describe("createTask and spec round-trip", () => {
	it("creates the dir 0700 and all files 0600 with the queued state", async () => {
		const { id, dir } = await newTask();
		expect((await stat(dir)).mode & 0o777).toBe(0o700);
		for (const f of ["spec.json", "prompt.md", "state.json", "events.jsonl"]) {
			expect((await stat(join(dir, f))).mode & 0o777).toBe(0o600);
		}
		const st = await P.readState(dir);
		expect(st.state).toBe("queued");
		const events = await P.readEvents(dir);
		expect(events[0].event).toBe("created");
		expect(await readFile(join(dir, "prompt.md"), "utf8")).toBe(PROMPT.replace("<id>", id));
	});

	it("rejects re-creation of an existing task dir", async () => {
		const { id, dir } = await newTask();
		await rejects("exists", () => P.createTask(dir, makeSpec(id), PROMPT)); // same id → the dir-exists check fires
	});

	it("rejects a spec whose task_id does not match the task dir", async () => {
		const dir = join(root, P.newTaskId());
		await rejects("bad-spec", () => P.createTask(dir, makeSpec(P.newTaskId()), PROMPT)); // a different uuid
		expect((await stat(dir).catch(() => null)) === null).toBe(true);
	});

	it("round-trips spec.json (write → read → deep-equal)", async () => {
		const id = P.newTaskId();
		const spec = makeSpec(id);
		await P.createTask(join(root, id), spec, PROMPT.replace("<id>", id));
		expect(await P.readSpec(join(root, id))).toEqual(spec);
	});

	it("round-trips the full field set (headless, attended, max_cost_usd, from_task_id, output_schema, async)", async () => {
		const id = P.newTaskId();
		const outputSchema = { type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"] };
		const spec = { ...makeSpec(id), mode: "headless" as const, attended: true, max_cost_usd: 1.5, from_task_id: P.newTaskId(), output_schema: outputSchema, async: true };
		await P.createTask(join(root, id), spec, PROMPT.replace("<id>", id));
		expect(await P.readSpec(join(root, id))).toEqual(spec);
	});

	it("validates the spec shape — malformed specs are rejected before anything is written", async () => {
		const bad = (mutate: (s: Record<string, unknown>) => void): Record<string, unknown> => {
			const s = JSON.parse(JSON.stringify(makeSpec(P.newTaskId()))) as Record<string, unknown>;
			mutate(s);
			return s;
		};
		const cases: Array<[string, (s: Record<string, unknown>) => void]> = [
			["missing task_id", (s) => delete s.task_id],
			["bad task_id uuid", (s) => (s.task_id = "nope")],
			["missing agent name", (s) => (s.agent = { model: "x" })],
			["relative cwd", (s) => (s.cwd = "tmp")],
			["bad mode", (s) => (s.mode = "bogus")],
			["attended not boolean", (s) => (s.attended = "yes")],
			["wall_timeout_s zero", (s) => (s.wall_timeout_s = 0)],
			["auto_settle_grace_s negative", (s) => (s.auto_settle_grace_s = -5)],
			["max_cost_usd string", (s) => (s.max_cost_usd = "x")],
			["output_schema array", (s) => (s.output_schema = [1, 2])],
			["output_schema string", (s) => (s.output_schema = "x")],
			["output_schema null", (s) => (s.output_schema = null)],
			["from_task_id not uuid", (s) => (s.from_task_id = "abc")],
			["boot_id missing", (s) => delete s.boot_id],
			["async not boolean", (s) => (s.async = "yes")],
			["agent.tools not strings", (s) => (s.agent = { name: "r", tools: [1] })],
			["empty agent name", (s) => (s.agent = { name: "" })],
			["empty session_id", (s) => (s.session_id = "")],
			["agent.thinking not string", (s) => (s.agent = { name: "r", thinking: 5 })],
			["inactivity_s zero", (s) => (s.inactivity_s = 0)],
		];
		for (const [label, mutate] of cases) {
			const dir = join(root, P.newTaskId());
			await rejects("bad-spec", () => P.createTask(dir, bad(mutate) as unknown as P.TaskSpec, PROMPT));
			expect((await stat(dir).catch(() => null)) === null).toBe(true);
		}
	});
});

// ---------------------------------------------------------------------------
// the monotonic state machine — every (from, to) pair on a fresh task

describe("state machine matrix (49 pairs, fresh task each)", () => {
	it("classifies every transition exactly", async () => {
		for (const from of P.TASK_STATES) {
			for (const to of P.TASK_STATES) {
				const { dir } = await newTask();
				await reachState(dir, from);
				const result = await P.transitionState(dir, from, to);
				if (P.isTerminal(from)) {
					expect(result).toMatchObject({ ok: false, code: "terminal-state", current: from, requested: to });
					// monotonic: the file is untouched
					expect((await P.readState(dir)).state).toBe(from);
				} else if (P.LEGAL_TRANSITIONS[from].includes(to) && to !== from) {
					expect(result).toMatchObject({ ok: true, from, to });
					expect((await P.readState(dir)).state).toBe(to);
				} else {
					// includes the self-loop and the no-marker queued→completed case
					expect(result).toMatchObject({ ok: false, code: "illegal-transition", current: from, requested: to });
					expect((await P.readState(dir)).state).toBe(from);
				}
				await noTmpResidue(dir);
			}
		}
	});

	it("stamps started_at on queued→running and finished_at on terminal writes", async () => {
		const { dir } = await newTask();
		await P.transitionState(dir, "queued", "running");
		const running = await P.readState(dir);
		expect(running.started_at).toBeTypeOf("string");
		expect(running.finished_at).toBeUndefined();
		await P.transitionState(dir, "running", "failed", {}, "worker exit 1");
		const failed = await P.readState(dir);
		expect(failed.finished_at).toBeTypeOf("string");
		expect(failed.reason).toBe("worker exit 1");
		expect((await P.readState(dir)).state).toBe("failed");
	});
});

// ---------------------------------------------------------------------------
// ordering rules

describe("ordering rule 1 — marker wins", () => {
	it("remaps every terminal request to completed when done.marker exists (from running)", async () => {
		for (const requested of ["killed", "crashed", "timeout", "failed"] as const) {
			const { dir } = await newTask();
			await P.transitionState(dir, "queued", "running");
			await P.writeDoneMarker(dir, "vitrine_done");
			const r = await P.transitionState(dir, "running", requested);
			if (!r.ok) throw new Error(`expected the marker-wins remap, got ${r.code}`);
			expect(r).toMatchObject({ to: "completed", requested });
			expect(r.reason).toContain("marker-wins");
			expect((await P.readState(dir)).state).toBe("completed");
		}
	});

	it("remaps queued→crashed to completed when done.marker exists", async () => {
		const { dir } = await newTask();
		await P.writeDoneMarker(dir, "auto_settle");
		const r = await P.transitionState(dir, "queued", "crashed", {}, "never-spawned");
		expect(r).toMatchObject({ ok: true, to: "completed", requested: "crashed" });
		expect((await P.readState(dir)).state).toBe("completed");
	});

	it("a direct completed request with the marker present takes the plain path", async () => {
		const { dir } = await newTask();
		await P.transitionState(dir, "queued", "running");
		await P.writeDoneMarker(dir, "vitrine_done");
		const r = await P.transitionState(dir, "running", "completed");
		expect(r).toMatchObject({ ok: true, to: "completed" });
		expect("requested" in (r as object)).toBe(false);
	});

	it("queued→completed without a marker is illegal (no diagram edge)", async () => {
		const { dir } = await newTask();
		const r = await P.transitionState(dir, "queued", "completed");
		expect(r).toMatchObject({ ok: false, code: "illegal-transition", current: "queued" });
	});

	it("done.marker is written once", async () => {
		const { dir } = await newTask();
		await P.writeDoneMarker(dir, "vitrine_done");
		expect(await P.readDoneMarker(dir)).toEqual(expect.objectContaining({ source: "vitrine_done" }));
		await rejects("marker-exists", () => P.writeDoneMarker(dir, "auto_settle"));
	});

	it("readDoneMarker rejects a marker without a ts", async () => {
		const { dir } = await newTask();
		await writeFile(join(dir, "done.marker"), JSON.stringify({ source: "auto_settle" }));
		await rejects("bad-marker", () => P.readDoneMarker(dir));
	});
});

describe("ordering rule 2 — dead-wrapper reconcile", () => {
	it("no marker, dead worker: records crashed, no kill attempted", async () => {
		const { dir } = await newTask();
		const dead = await deadPid();
		await P.transitionState(dir, "queued", "running", { wrapper_pid: await deadPid(), worker_pid: dead, worker_pid_start: "1" });
		const kills: number[] = [];
		const r = await P.reconcileDeadWrapper(dir, { killWorker: async (pid) => { kills.push(pid); } });
		expect(r.outcome).toBe("crashed");
		expect(r.workerKilled).toBe(false);
		expect(kills).toEqual([]);
		expect(r.reason).toBe("dead-wrapper");
		expect((await P.readState(dir)).state).toBe("crashed");
	});

	it("no marker, live worker with matching start time: SIGTERMs it, records crashed", async () => {
		const { dir } = await newTask();
		const { pid, cp } = await liveSleep();
		const info = P.pidInfo(pid);
		expect(info.alive).toBe(true);
		await P.transitionState(dir, "queued", "running", { wrapper_pid: await deadPid(), worker_pid: pid, worker_pid_start: info.startTime });
		const r = await P.reconcileDeadWrapper(dir); // default kill = real SIGTERM
		expect(r.outcome).toBe("crashed");
		expect(r.workerKilled).toBe(true);
		expect(await waitDead(pid)).toBe(true);
		cp.kill("SIGKILL");
		expect((await P.readState(dir)).state).toBe("crashed");
	});

	it("recycled-pid guard: a live worker whose start time does not match is NOT killed", async () => {
		const { dir } = await newTask();
		const { pid, cp } = await liveSleep();
		await P.transitionState(dir, "queued", "running", { wrapper_pid: await deadPid(), worker_pid: pid, worker_pid_start: "000000000000" });
		const r = await P.reconcileDeadWrapper(dir);
		expect(r.outcome).toBe("crashed");
		expect(r.workerKilled).toBe(false);
		expect(await isDead(pid)).toBe(false); // the recycled pid must survive — the guard must hold
		cp.kill("SIGKILL");
		expect((await P.readState(dir)).state).toBe("crashed");
	});

	it("recycled-pid guard: a live worker with no recorded start time is NOT killed (record only)", async () => {
		const { dir } = await newTask();
		const { pid, cp } = await liveSleep();
		await P.transitionState(dir, "queued", "running", { wrapper_pid: await deadPid(), worker_pid: pid }); // no worker_pid_start
		const r = await P.reconcileDeadWrapper(dir);
		expect(r.outcome).toBe("crashed");
		expect(r.workerKilled).toBe(false);
		expect(await isDead(pid)).toBe(false); // no recorded start time means no kill
		cp.kill("SIGKILL");
	});

	it("a contested reconcile reports the actual state, not the intent", async () => {
		const { dir } = await newTask();
		const { pid, cp } = await liveSleep();
		await P.transitionState(dir, "queued", "running", { wrapper_pid: await deadPid(), worker_pid: pid, worker_pid_start: P.pidInfo(pid).startTime });
		const r = await P.reconcileDeadWrapper(dir, {
			killWorker: async (p) => {
				expect(p).toBe(pid);
				await P.transitionState(dir, "running", "killed", {}, "sibling settle"); // a sibling actor wins the race
				process.kill(p, "SIGTERM");
			},
		});
		expect(r.outcome).toBe("contested");
		expect(r.state).toBe("killed");
		expect(r.workerKilled).toBe(true);
		expect((await P.readState(dir)).state).toBe("killed");
		cp.kill("SIGKILL");
	});

	it("marker present: completed, worker not killed", async () => {
		const { dir } = await newTask();
		const { pid, cp } = await liveSleep();
		await P.transitionState(dir, "queued", "running", { wrapper_pid: await deadPid(), worker_pid: pid, worker_pid_start: P.pidInfo(pid).startTime });
		await P.writeDoneMarker(dir, "vitrine_done");
		const r = await P.reconcileDeadWrapper(dir);
		expect(r.outcome).toBe("completed");
		expect(r.workerKilled).toBe(false);
		expect(await isDead(pid)).toBe(false); // the worker must still be alive — the wrapper's completion path owns its kill
		cp.kill("SIGKILL");
		expect((await P.readState(dir)).state).toBe("completed");
	});

	it("worker completes between the read and the kill: the re-check wins", async () => {
		const { dir } = await newTask();
		const { pid, cp } = await liveSleep();
		await P.transitionState(dir, "queued", "running", { wrapper_pid: await deadPid(), worker_pid: pid, worker_pid_start: P.pidInfo(pid).startTime });
		const r = await P.reconcileDeadWrapper(dir, {
			killWorker: async (p) => {
				expect(p).toBe(pid);
				await P.writeDoneMarker(dir, "vitrine_done"); // the worker "completes" mid-kill
			},
		});
		expect(r.outcome).toBe("completed");
		expect(r.workerKilled).toBe(true);
		cp.kill("SIGKILL");
		expect((await P.readState(dir)).state).toBe("completed");
	});

	it("a live wrapper is not a dead-wrapper case", async () => {
		const { dir } = await newTask();
		await P.transitionState(dir, "queued", "running", { wrapper_pid: process.pid, worker_pid: process.pid });
		const r = await P.reconcileDeadWrapper(dir);
		expect(r.outcome).toBe("none");
		expect((await P.readState(dir)).state).toBe("running");
	});

	it("a non-running state is untouched", async () => {
		const { dir } = await newTask();
		const r = await P.reconcileDeadWrapper(dir);
		expect(r.outcome).toBe("none");
		expect((await P.readState(dir)).state).toBe("queued");
	});
});

describe("ordering rule 3 — hand-off CAS", () => {
	it("a stale expected state bails, logged, leaving the record untouched", async () => {
		const { dir } = await newTask();
		await P.transitionState(dir, "queued", "running");
		const r = await P.transitionState(dir, "queued", "completed"); // stale view
		expect(r).toMatchObject({ ok: false, code: "state-moved", current: "running" });
		expect((await P.readState(dir)).state).toBe("running");
		const evs = await P.readEvents(dir);
		expect(evs.some((e) => e.event === "transition-rejected" && e.code === "state-moved")).toBe(true);
	});

	it("the concurrent queued→running interleaving is safe (25 rounds: the accepted both-pass window)", async () => {
		for (let i = 0; i < 25; i++) {
			const { dir } = await newTask();
			const [a, b] = await Promise.all([
				P.transitionState(dir, "queued", "running", { wrapper_pid: process.pid, foot_pid: process.pid }),
				P.transitionState(dir, "queued", "crashed", {}, "never-spawned"),
			]);
			const oks = [a, b].filter((r) => r.ok === true).length;
			expect(oks >= 1).toBe(true); // at least one writer must land
			const st = await P.readState(dir);
			expect(P.TASK_STATES).toContain(st.state);
			if (st.state === "running") expect(st.wrapper_pid).toBe(process.pid);
			if (st.state === "crashed") expect(st.reason).toBe("never-spawned");
			const evs = await P.readEvents(dir);
			expect(evs.length).toBeGreaterThanOrEqual(2); // created + the attempts are all visible
			await noTmpResidue(dir);
		}
	});

	it("rejected writes leave no tmp residue", async () => {
		const { dir } = await newTask();
		await P.transitionState(dir, "queued", "running");
		for (const to of P.TASK_STATES) await P.transitionState(dir, "completed", to); // all rejected: state-moved (expected completed, current running)
		await noTmpResidue(dir);
		expect((await P.readState(dir)).state).toBe("running");
	});
});

// ---------------------------------------------------------------------------
// single-writer files

describe("session.json, result.md, kill_requested, events, tail", () => {
	it("session.json is written exactly once", async () => {
		const { dir } = await newTask();
		const rec = { session_id: "vitrine.x", session_file: "/tmp/s.jsonl" };
		expect(await P.writeSessionOnce(dir, rec)).toBe(true);
		expect(await P.readSession(dir)).toEqual(rec);
		// a second write (a sibling wrapper of the same task re-discovering the
		// same file) is a no-op that reports attached — the "once" is by file
		// existence, not by throwing
		expect(await P.writeSessionOnce(dir, rec)).toBe(true);
		expect(await P.readSession(dir)).toEqual(rec);
		await rejects("no-session", () => P.readSession(join(root, P.newTaskId())));
	});

	it("result.md is written by the protocol for vitrine_done", async () => {
		const { dir } = await newTask();
		await P.writeResult(dir, "final answer");
		expect(await readFile(join(dir, "result.md"), "utf8")).toBe("final answer");
		expect((await stat(join(dir, "result.md"))).mode & 0o077).toBe(0);
	});

	it("kill_requested is presence-only and idempotent", async () => {
		const { dir } = await newTask();
		expect(await P.killRequested(dir)).toBe(false);
		await P.requestKill(dir);
		expect(await P.killRequested(dir)).toBe(true);
		await P.requestKill(dir); // idempotent
		const evs = await P.readEvents(dir);
		expect(evs.filter((e) => e.event === "kill-requested").length).toBe(1);
	});

	it("events.jsonl is an ordered, parseable audit log", async () => {
		const { dir } = await newTask();
		await P.appendEvent(dir, { event: "tile-title", title: "⚡ refiner (ab12) — running" });
		await P.appendEvent(dir, { event: "watchdog", kind: "wall", budget: 3600 });
		await P.appendEvent(dir, { event: "resumed", source: "human" });
		const evs = await P.readEvents(dir);
		expect(evs.map((e) => e.event)).toEqual(["created", "tile-title", "watchdog", "resumed"]);
		for (const e of evs) expect(typeof e.ts).toBe("string");
	});

	it("tail.log appends", async () => {
		const { dir } = await newTask();
		await P.appendTail(dir, "wrapper line 1\n");
		await P.appendTail(dir, "worker line 2\n");
		expect(await readFile(join(dir, "tail.log"), "utf8")).toBe("wrapper line 1\nworker line 2\n");
	});
});

// ---------------------------------------------------------------------------
// harvest-delivered (the delivery marker — absence = undelivered)

describe("harvest-delivered (the delivery marker)", () => {
	it("writes one event carrying the delivery-batch id; the reader returns it", async () => {
		const { dir } = await newTask();
		expect(await P.harvestDeliveredId(dir)).toBeNull(); // absence = undelivered
		expect(await P.writeHarvestDelivered(dir, "batch-1")).toBe(true);
		expect(await P.harvestDeliveredId(dir)).toBe("batch-1");
		const evs = await P.readEvents(dir);
		expect(evs.filter((e) => e.event === "harvest-delivered")).toEqual([{ ts: expect.any(String), event: "harvest-delivered", id: "batch-1" }]);
	});

	it("is write-once: a second write is a no-op (the first batch id stands)", async () => {
		const { dir } = await newTask();
		expect(await P.writeHarvestDelivered(dir, "batch-1")).toBe(true);
		expect(await P.writeHarvestDelivered(dir, "batch-2")).toBe(false);
		expect(await P.harvestDeliveredId(dir)).toBe("batch-1");
		const evs = await P.readEvents(dir);
		expect(evs.filter((e) => e.event === "harvest-delivered").length).toBe(1);
	});

	it("two tasks delivered in one message share the batch id (membership reconstructable from disk)", async () => {
		const a = await newTask();
		const b = await newTask();
		await P.writeHarvestDelivered(a.dir, "batch-x");
		await P.writeHarvestDelivered(b.dir, "batch-x");
		expect(await P.harvestDeliveredId(a.dir)).toBe("batch-x");
		expect(await P.harvestDeliveredId(b.dir)).toBe("batch-x");
	});

	it("a historical task dir (no marker) reads undelivered", async () => {
		const { dir } = await newTask();
		await P.appendEvent(dir, { event: "watchdog", kind: "wall", budget: 3600 });
		expect(await P.harvestDeliveredId(dir)).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// environment facts & hygiene

describe("environment facts and hygiene", () => {
	it("currentBootId is a 32-char hex id (dashes stripped — the format is kernel-dependent)", () => {
		expect(P.currentBootId().replaceAll("-", "")).toMatch(/^[0-9a-f]{32}$/);
	});

	it("pidInfo: self is alive with a stable start time; a dead pid is not alive", async () => {
		const me = P.pidInfo(process.pid);
		expect(me.alive).toBe(true);
		expect(me.startTime).toBeTypeOf("string");
		expect(P.pidInfo(process.pid).startTime).toBe(me.startTime);
		const dead = await deadPid();
		expect(P.pidInfo(dead).alive).toBe(false);
	});

	it("a full lifecycle leaves only the protocol files, all 0600", async () => {
		const { dir } = await newTask();
		await P.transitionState(dir, "queued", "running", { wrapper_pid: process.pid, foot_pid: process.pid });
		await P.writeSessionOnce(dir, { session_id: "vitrine.t", session_file: "/tmp/t.jsonl" });
		await P.writeResult(dir, "done");
		await P.writeDoneMarker(dir, "vitrine_done");
		await P.requestKill(dir);
		await P.transitionState(dir, "running", "completed");
		const entries = await readdir(dir);
		expect(entries.sort()).toEqual(
			["done.marker", "events.jsonl", "kill_requested", "prompt.md", "result.md", "session.json", "spec.json", "state.json"].sort(),
		);
		for (const e of entries) {
			const s = await stat(join(dir, e));
			expect(s.mode & 0o777).toBe(0o600);
		}
	});

	it("removeTask removes the dir", async () => {
		const { dir } = await newTask();
		await P.removeTask(dir);
		expect(await stat(dir).catch(() => null)).toBeNull();
	});
});

describe("from_session_file (context fork)", () => {
	it("rejects a spec with both from_task_id and from_session_file", async () => {
		const id = P.newTaskId();
		const raw = join(root, "raw-both.jsonl");
		await writeFile(raw, "{}\n");
		await rejects("bad-spec", () =>
			P.createTask(
				join(root, id),
				{ ...makeSpec(id), from_task_id: "22222222-2222-4222-8222-222222222222", from_session_file: raw },
				PROMPT,
			),
		);
	});

	it("rejects a missing raw fork source at creation (bad-spec, nothing left behind)", async () => {
		const id = P.newTaskId();
		await rejects("bad-spec", () =>
			P.createTask(join(root, id), { ...makeSpec(id), from_session_file: join(root, "nope.jsonl") }, PROMPT),
		);
		expect(await stat(join(root, id)).catch(() => null)).toBeNull();
	});

	it("round-trips a valid raw fork source through spec.json", async () => {
		const id = P.newTaskId();
		const raw = join(root, `raw-${id}.jsonl`);
		await writeFile(raw, "{}\n");
		const dir = join(root, id);
		await P.createTask(dir, { ...makeSpec(id), from_session_file: raw }, PROMPT);
		expect((await P.readSpec(dir)).from_session_file).toBe(raw);
	});
});

// ---------------------------------------------------------------------------
// stuck-queued reconcile, killTask, marker-source widening, agent name

describe("reconcileStuckQueued", () => {
	it("settles an old wrapperless queued task crashed/never-spawned", async () => {
		const id = P.newTaskId();
		const dir = join(root, id);
		await P.createTask(dir, makeSpec(id), PROMPT);
		const created = Date.parse((await P.readSpec(dir)).created_at);
		const r = await P.reconcileStuckQueued(dir, { now: created + 20_000 });
		expect(r).toEqual({ dir, settled: "crashed", state: "crashed", reason: "never-spawned" });
		expect((await P.readState(dir)).reason).toBe("never-spawned");
	});

	it("leaves a young queued task alone", async () => {
		const id = P.newTaskId();
		const dir = join(root, id);
		await P.createTask(dir, makeSpec(id), PROMPT);
		const created = Date.parse((await P.readSpec(dir)).created_at);
		const r = await P.reconcileStuckQueued(dir, { now: created + 1_000 });
		expect(r.settled).toBe("none");
		expect(r.state).toBe("queued");
	});

	it("never touches a spawn in flight (live wrapper pid)", async () => {
		const id = P.newTaskId();
		const dir = join(root, id);
		await P.createTask(dir, makeSpec(id), PROMPT);
		// a live wrapper pid = the spawn is in flight, however old
		await P.transitionState(dir, "queued", "running", { wrapper_pid: process.pid, wrapper_pid_start: P.pidInfo(process.pid).startTime });
		const created = Date.parse((await P.readSpec(dir)).created_at);
		const r = await P.reconcileStuckQueued(dir, { now: created + 20_000 });
		expect(r.settled).toBe("none");
		expect(r.state).toBe("running");
	});

	it("the marker wins even on queued (ordering rule 1)", async () => {
		const id = P.newTaskId();
		const dir = join(root, id);
		await P.createTask(dir, makeSpec(id), PROMPT);
		await P.writeDoneMarker(dir, "vitrine_done");
		const created = Date.parse((await P.readSpec(dir)).created_at);
		const r = await P.reconcileStuckQueued(dir, { now: created + 20_000 });
		expect(r.settled).toBe("completed");
		expect(r.state).toBe("completed");
	});

	it("a kill-requested queued task settles kill-requested, not never-spawned", async () => {
		const id = P.newTaskId();
		const dir = join(root, id);
		await P.createTask(dir, makeSpec(id), PROMPT);
		await P.requestKill(dir);
		const created = Date.parse((await P.readSpec(dir)).created_at);
		const r = await P.reconcileStuckQueued(dir, { now: created + 20_000 });
		expect(r).toMatchObject({ settled: "crashed", reason: "kill-requested" });
	});

	it("reports none with the actual state on a contested settle", async () => {
		const id = P.newTaskId();
		const dir = join(root, id);
		await P.createTask(dir, makeSpec(id), PROMPT);
		// a wrapper grabs the task between the age check and the settle
		await P.transitionState(dir, "queued", "running", { wrapper_pid: process.pid, wrapper_pid_start: P.pidInfo(process.pid).startTime });
		const created = Date.parse((await P.readSpec(dir)).created_at);
		const r = await P.reconcileStuckQueued(dir, { now: created + 20_000 });
		expect(r.settled).toBe("none");
		expect(r.state).toBe("running");
	});

	it("a fresh owner lease protects an old queued task (the owner is still ticking)", async () => {
		const id = P.newTaskId();
		const dir = join(root, id);
		await P.createTask(dir, makeSpec(id), PROMPT);
		const created = Date.parse((await P.readSpec(dir)).created_at);
		const now = created + 20_000;
		await P.writeLease(dir, { owner: "sess", nonce: "nonce", updated_at: new Date(now - 1_000).toISOString() });
		const r = await P.reconcileStuckQueued(dir, { now });
		expect(r.settled).toBe("none");
		expect(r.state).toBe("queued");
		expect(r.reason).toContain("lease fresh");
	});

	it("a stale owner lease settles (the owner stopped ticking)", async () => {
		const id = P.newTaskId();
		const dir = join(root, id);
		await P.createTask(dir, makeSpec(id), PROMPT);
		const created = Date.parse((await P.readSpec(dir)).created_at);
		const now = created + 45_000;
		await P.writeLease(dir, { owner: "sess", nonce: "nonce", updated_at: new Date(now - 31_000).toISOString() });
		const r = await P.reconcileStuckQueued(dir, { now });
		expect(r.settled).toBe("crashed");
		expect(r.state).toBe("crashed");
		expect(r.reason).toBe("never-spawned");
	});

	it("a minutes-old queue with a tick-refreshed lease survives past the window (the lease is the key, not creation age)", async () => {
		// the async-dispatch case: a task created 60 s ago, still queued behind
		// a slow worker, with the owner (the dispatch call / the session watcher)
		// refreshing the lease every tick — the 15 s stuck window is a grace on
		// creation age, not on lease freshness
		const id = P.newTaskId();
		const dir = join(root, id);
		await P.createTask(dir, makeSpec(id), PROMPT);
		const spec = await P.readSpec(dir);
		const created = Date.parse(spec.created_at) - 60_000; // backdate the creation
		spec.created_at = new Date(created).toISOString();
		await writeFile(join(dir, "spec.json"), JSON.stringify(spec, null, 2));
		const now = created + 60_000;
		await P.writeLease(dir, { owner: "sess", nonce: "nonce", updated_at: new Date(now - 1_000).toISOString() }); // the last tick, 1 s ago
		const r = await P.reconcileStuckQueued(dir, { now });
		expect(r.settled).toBe("none");
		expect(r.state).toBe("queued");
		expect(r.reason).toContain("lease fresh");
	});

	it("a fresh lease does not hold back a done marker (ordering rule 1)", async () => {
		const id = P.newTaskId();
		const dir = join(root, id);
		await P.createTask(dir, makeSpec(id), PROMPT);
		await P.writeDoneMarker(dir, "vitrine_done");
		const created = Date.parse((await P.readSpec(dir)).created_at);
		const now = created + 20_000;
		await P.writeLease(dir, { owner: "sess", nonce: "nonce", updated_at: new Date(now - 1_000).toISOString() });
		const r = await P.reconcileStuckQueued(dir, { now });
		expect(r.settled).toBe("completed");
		expect(r.state).toBe("completed");
	});
});

describe("killTask", () => {
	it("queued: settles crashed/kill-requested now", async () => {
		const id = P.newTaskId();
		const dir = join(root, id);
		await P.createTask(dir, makeSpec(id), PROMPT);
		const r = await P.killTask(dir);
		expect(r).toEqual({ dir, action: "settled", state: "crashed", workerSignalled: false, reason: "kill-requested" });
		const st = await P.readState(dir);
		expect(st.state).toBe("crashed");
		expect(st.reason).toBe("kill-requested");
	});

	it("running with a live wrapper: writes kill_requested and signals the start-time-checked worker", async () => {
		const id = P.newTaskId();
		const dir = join(root, id);
		await P.createTask(dir, makeSpec(id), PROMPT);
		await P.transitionState(dir, "queued", "running", { wrapper_pid: process.pid, wrapper_pid_start: P.pidInfo(process.pid).startTime });
		const { pid, cp } = await liveSleep();
		try {
			const info = P.pidInfo(pid);
			expect(info.alive).toBe(true);
			await P.mergeStateFields(dir, "running", { worker_pid: pid, worker_pid_start: info.startTime }, "worker-spawned");
			const r = await P.killTask(dir);
			expect(r).toMatchObject({ action: "requested", state: "running", workerSignalled: true });
			expect(await P.killRequested(dir)).toBe(true);
			// the SIGTERM hint actually reached the worker
			for (let i = 0; i < 50 && !(await isDead(pid)); i++) await new Promise((res) => setTimeout(res, 50));
			expect(await isDead(pid)).toBe(true);
		} finally {
			cp.kill("SIGKILL");
		}
	});

	it("does not signal a start-time-mismatched worker (recycled-pid guard)", async () => {
		const id = P.newTaskId();
		const dir = join(root, id);
		await P.createTask(dir, makeSpec(id), PROMPT);
		await P.transitionState(dir, "queued", "running", { wrapper_pid: process.pid, wrapper_pid_start: P.pidInfo(process.pid).startTime });
		const { pid, cp } = await liveSleep();
		try {
			// a recorded start time the live pid does NOT have
			await P.mergeStateFields(dir, "running", { worker_pid: pid, worker_pid_start: "999999999" }, "worker-spawned");
			const r = await P.killTask(dir);
			expect(r).toMatchObject({ action: "requested", workerSignalled: false });
			// the worker survives the guard
			await new Promise((res) => setTimeout(res, 100));
			expect(P.pidInfo(pid).alive).toBe(true);
		} finally {
			cp.kill("SIGKILL");
		}
	});

	it("running with a dead wrapper: falls through to rule 2 (marker ⇒ completed)", async () => {
		const id = P.newTaskId();
		const dir = join(root, id);
		await P.createTask(dir, makeSpec(id), PROMPT);
		const dead = await deadPid();
		await P.transitionState(dir, "queued", "running", { wrapper_pid: dead });
		await P.writeDoneMarker(dir, "headless-exit");
		const r = await P.killTask(dir);
		expect(r).toMatchObject({ action: "reconciled", state: "completed" });
	});

	it("B2: a LIVE but recycled wrapper pid (start-time mismatch) is NOT the wrapper — rule 2, not the requested branch", async () => {
		const id = P.newTaskId();
		const dir = join(root, id);
		await P.createTask(dir, makeSpec(id), PROMPT);
		const { pid, cp } = await liveSleep();
		try {
			// a LIVE pid, but a recorded wrapper start-time it does NOT have —
			// the anti-recycling predicate must read this as "not our wrapper".
			// (Bare `pidInfo(alive)` reads it as live — the pre-fix bug took the
			// requested branch and signalled an unrelated process.)
			await P.transitionState(dir, "queued", "running", { wrapper_pid: pid, wrapper_pid_start: "recycled-start-mismatch" });
			const r = await P.killTask(dir);
			// rule 2 (reconciled), NOT the requested branch
			expect(r).toMatchObject({ action: "reconciled", state: "crashed", workerSignalled: false });
			// the live (recycled) pid was NOT signalled — it survives
			await new Promise((res) => setTimeout(res, 100));
			expect(P.pidInfo(pid).alive).toBe(true);
			// and no kill_requested was written (that is the requested branch's side effect)
			expect(await P.killRequested(dir)).toBe(false);
		} finally {
			cp.kill("SIGKILL");
		}
	});

	it("terminal: no-op report", async () => {
		const id = P.newTaskId();
		const dir = join(root, id);
		await P.createTask(dir, makeSpec(id), PROMPT);
		await P.transitionState(dir, "queued", "running", {});
		await P.transitionState(dir, "running", "completed", {}, "done");
		const r = await P.killTask(dir);
		expect(r).toMatchObject({ action: "none", state: "completed", workerSignalled: false });
	});
});

describe("marker source + agent name (protocol)", () => {
	it("a headless-exit marker round-trips", async () => {
		const id = P.newTaskId();
		const dir = join(root, id);
		await P.createTask(dir, makeSpec(id), PROMPT);
		await P.writeDoneMarker(dir, "headless-exit");
		expect(await P.readDoneMarker(dir)).toEqual(expect.objectContaining({ source: "headless-exit" }));
	});

	it("readDoneMarker rejects an unknown source", async () => {
		const id = P.newTaskId();
		const dir = join(root, id);
		await P.createTask(dir, makeSpec(id), PROMPT);
		await writeFile(join(dir, "done.marker"), JSON.stringify({ ts: new Date().toISOString(), source: "bogus" }));
		await rejects("bad-marker", () => P.readDoneMarker(dir));
	});

	it("validateSpec rejects a traversal agent name", () => {
		const id = P.newTaskId();
		for (const name of ["../../etc/passwd", "evil; rm -rf /", "a b", "a\nb"]) {
			let err: unknown = null;
			try {
				P.validateSpec({ ...makeSpec(id), agent: { ...makeSpec(id).agent, name } });
			} catch (e) {
				err = e;
			}
			expect(err).toBeInstanceOf(P.ProtocolError);
			expect((err as P.ProtocolError).code).toBe("bad-spec");
		}
	});

	it("validateSpec carries the agent body through spec.json", async () => {
		const id = P.newTaskId();
		const spec: P.TaskSpec = { ...makeSpec(id), agent: { ...makeSpec(id).agent, body: "# refiner\nbe adversarial" } };
		P.validateSpec(spec);
		const dir = join(root, id);
		await P.createTask(dir, spec, PROMPT);
		expect((await P.readSpec(dir)).agent.body).toBe("# refiner\nbe adversarial");
	});
});
