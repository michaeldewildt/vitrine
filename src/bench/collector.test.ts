/**
 * collector.test.ts — the bench collector: one task dir → one metrics row.
 *
 * VERSION TOLERANCE is the contract: the suite covers a complete modern dir
 * (shapes snapshot-built), a dir missing `session.json` (the ~half of
 * historical task dirs from before ~2026-09-19), and a dir with a malformed
 * events line — none of which may break a batch.
 */
import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { collectRow, collectRows, median, mediansOf, TERMINAL_STATES as COLLECTOR_TERMINAL_STATES } from "./collector";
import { TERMINAL_STATES as PROTOCOL_TERMINAL_STATES } from "../protocol/state";
import { renderMedians, renderTable, toJson } from "./report";

let base: string;
let tasksRoot: string;
let realHome: string;
let realRoot: string | undefined;

beforeAll(async () => {
	base = await mkdtemp(join(tmpdir(), "vitrine-bench-col-"));
	tasksRoot = join(base, "tasks");
	realHome = process.env.HOME ?? "";
	realRoot = process.env.VITRINE_TASKS_ROOT;
	process.env.HOME = base;
	process.env.VITRINE_TASKS_ROOT = tasksRoot;
});

afterAll(async () => {
	process.env.HOME = realHome;
	if (realRoot === undefined) delete process.env.VITRINE_TASKS_ROOT;
	else process.env.VITRINE_TASKS_ROOT = realRoot;
	await rm(base, { recursive: true, force: true });
});

// a deterministic clock: segment offsets are exact deltas off T0
const T0 = Date.parse("2026-09-21T10:00:00.000Z");
const iso = (ms: number): string => new Date(T0 + ms).toISOString();

async function writeDir(files: Record<string, string>): Promise<string> {
	const id = randomUUID();
	const dir = join(tasksRoot, id);
	await mkdir(dir, { recursive: true });
	for (const [f, c] of Object.entries(files)) await writeFile(join(dir, f), c);
	return dir;
}

const specJson = (): string =>
	JSON.stringify(
		{
			task_id: "x",
			agent: { name: "bench", model: "ninfer/m", thinking: "high" },
			dispatcher_session_id: "disp",
			cwd: base,
			session_id: "vitrine.x",
			session_name: "bench · test",
			mode: "headless",
			attended: false,
			workspace: 9,
			wall_timeout_s: 3600,
			inactivity_s: 3600,
			auto_settle_s: 3600,
			auto_settle_grace_s: 60,
			created_at: iso(0),
			boot_id: "test-boot",
		},
		null,
		2,
	);

// the session file (fake-pi shaped + `reasoning`, which the real pi shape carries)
const sessionFile = (): string => {
	const lines = [
		{ type: "session", version: 3, id: "vitrine.x", timestamp: iso(0), cwd: base },
		{ type: "session_info", id: "a1", parentId: null, timestamp: iso(0), name: "bench · test" },
		{ type: "message", id: "a2", parentId: "a1", timestamp: iso(10), message: { role: "user", content: "prompt", timestamp: T0 + 10 } },
		{
			type: "message",
			id: "a3",
			parentId: "a2",
			timestamp: iso(20),
			message: {
				role: "assistant",
				content: [{ type: "text", text: "thinking hard" }],
				api: "openai-completions",
				provider: "ollama-cloud",
				model: "m",
				usage: { input: 100, output: 40, cacheRead: 50, cacheWrite: 0, reasoning: 5, totalTokens: 195, cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 } },
				stopReason: "stop",
				timestamp: T0 + 20,
			},
		},
		{
			type: "message",
			id: "a4",
			parentId: "a3",
			timestamp: iso(100),
			message: {
				role: "assistant",
				content: [{ type: "text", text: "done" }],
				usage: { input: 200, output: 60, cacheRead: 0, cacheWrite: 0, reasoning: 7, totalTokens: 267, cost: { input: 0.02, output: 0.05, cacheRead: 0, cacheWrite: 0, total: 0.07 } },
				stopReason: "stop",
				timestamp: T0 + 100,
			},
		},
	];
	return lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
};

// events with chosen segment deltas:
//   queue 1000 · boot 500 · work 3500 · poll 900 · settle 50 · e2e 5950
const eventsJsonl = (): string =>
	[
		{ ts: iso(0), event: "created", agent: "bench", mode: "headless", session_name: "bench · test" },
		{ ts: iso(1000), event: "transition", from: "queued", to: "running", reason: "spawn" },
		{ ts: iso(1005), event: "spawn", mode: "headless", wrapper_pid: 1 },
		{ ts: iso(1500), event: "session", session_id: "vitrine.x" },
		{ ts: iso(5000), event: "done-marker", source: "vitrine_done" },
		{ ts: iso(5900), event: "marker-observed", source: "vitrine_done" },
		{ ts: iso(5950), event: "transition", from: "running", to: "completed", reason: "worker" },
	]
		.map((l) => JSON.stringify(l))
		.join("\n") + "\n";

const stateJson = (): string => JSON.stringify({ state: "completed", started_at: iso(1000), finished_at: iso(5950), reason: "worker" }, null, 2) + "\n";

const sessionJson = (file: string): string => JSON.stringify({ session_id: "vitrine.x", session_file: file }, null, 2) + "\n";

describe("collector: a complete modern dir", () => {
	it("computes every segment, the e2e cross-check, the harness ratio and the session metrics", async () => {
		const sess = join(base, "sess.jsonl");
		await writeFile(sess, sessionFile());
		const dir = await writeDir({
			"spec.json": specJson(),
			"state.json": stateJson(),
			"session.json": sessionJson(sess),
			"events.jsonl": eventsJsonl(),
		});
		const row = await collectRow(dir);
		expect(row.task_id).toBe(basename(dir));
		expect(row.agent).toBe("bench");
		expect(row.model).toBe("ninfer/m");
		expect(row.thinking).toBe("high");
		expect(row.mode).toBe("headless");
		expect(row.state).toBe("completed");
		expect(row.reason).toBe("worker");
		expect(row.queue_ms).toBe(1000);
		expect(row.boot_ms).toBe(500);
		expect(row.work_ms).toBe(3500);
		expect(row.poll_ms).toBe(900);
		expect(row.settle_ms).toBe(50);
		expect(row.e2e_ms).toBe(5950);
		expect(row.e2e_mismatch_ms).toBe(null); // terminal transition == finished_at
		expect(row.harness_ratio).toBeCloseTo(1450 / 5950, 9); // (500+900+50)/5950, queue excluded
		expect(row.input_tokens).toBe(300);
		expect(row.output_tokens).toBe(100);
		expect(row.cache_read_tokens).toBe(50);
		expect(row.cache_write_tokens).toBe(0);
		expect(row.reasoning_tokens).toBe(12);
		expect(row.cost_usd).toBeCloseTo(0.1, 9);
		expect(row.tokens_per_s).toBeCloseTo(100 / ((T0 + 100 - (T0 + 20)) / 1000), 9); // 100 out / 0.08 s = 1250
		expect(row.complete).toBe(true);
		expect(row.missing).toEqual([]);
	});

	it("notes a >50 ms e2e mismatch without changing e2e", async () => {
		const sess = join(base, "sess2.jsonl");
		await writeFile(sess, sessionFile());
		// finished_at 120 ms after the terminal transition
		const dir = await writeDir({
			"spec.json": specJson(),
			"state.json": JSON.stringify({ state: "completed", finished_at: iso(6070), reason: "worker" }, null, 2) + "\n",
			"session.json": sessionJson(sess),
			"events.jsonl": eventsJsonl(),
		});
		const row = await collectRow(dir);
		expect(row.e2e_ms).toBe(6070);
		expect(row.e2e_mismatch_ms).toBe(120);
		expect(row.complete).toBe(true); // the mismatch is a note, not a gap
	});

	it("a ≤50 ms mismatch is within the threshold (not noted)", async () => {
		const sess = join(base, "sess3.jsonl");
		await writeFile(sess, sessionFile());
		const dir = await writeDir({
			"spec.json": specJson(),
			"state.json": JSON.stringify({ state: "completed", finished_at: iso(5960), reason: "worker" }, null, 2) + "\n",
			"session.json": sessionJson(sess),
			"events.jsonl": eventsJsonl(),
		});
		const row = await collectRow(dir);
		expect(row.e2e_mismatch_ms).toBe(null);
	});
});

describe("collector: version tolerance", () => {
	it("a dir missing session.json (the historical dirs) degrades the session metrics to nulls", async () => {
		const dir = await writeDir({ "spec.json": specJson(), "state.json": stateJson(), "events.jsonl": eventsJsonl() });
		const row = await collectRow(dir);
		expect(row.queue_ms).toBe(1000); // the event segments still compute
		expect(row.e2e_ms).toBe(5950);
		expect(row.input_tokens).toBe(null);
		expect(row.output_tokens).toBe(null);
		expect(row.reasoning_tokens).toBe(null);
		expect(row.cost_usd).toBe(null);
		expect(row.tokens_per_s).toBe(null);
		expect(row.complete).toBe(false);
		expect(row.missing).toContain("session");
	});

	it("a dir whose session file is gone (session.json present) degrades to nulls", async () => {
		const dir = await writeDir({
			"spec.json": specJson(),
			"state.json": stateJson(),
			"session.json": sessionJson(join(base, "gone.jsonl")),
			"events.jsonl": eventsJsonl(),
		});
		const row = await collectRow(dir);
		expect(row.boot_ms).toBe(500);
		expect(row.cost_usd).toBe(null);
		expect(row.complete).toBe(false);
	});

	it("a dir with a malformed events line: the bad lines are skipped, the row still computes", async () => {
		const sess = join(base, "sess4.jsonl");
		await writeFile(sess, sessionFile());
		const events =
			JSON.stringify({ ts: iso(0), event: "created" }) +
			"\n" +
			"{not json" + // malformed JSON line
			"\n" +
			JSON.stringify({ event: "transition", from: "queued", to: "running" }) + // missing ts
			"\n" +
			JSON.stringify({ ts: "not-a-date", event: "session" }) + // unparseable ts
			"\n" +
			JSON.stringify({ ts: iso(1000), event: "transition", from: "queued", to: "running" }) +
			"\n" +
			JSON.stringify({ ts: iso(1500), event: "session" }) +
			"\n" +
			JSON.stringify({ ts: iso(5000), event: "done-marker" }) +
			"\n" +
			JSON.stringify({ ts: iso(5900), event: "marker-observed" }) +
			"\n" +
			JSON.stringify({ ts: iso(5950), event: "transition", from: "running", to: "completed" }) +
			"\n" +
			"garbage" +
			"\n";
		const dir = await writeDir({ "spec.json": specJson(), "state.json": stateJson(), "session.json": sessionJson(sess), "events.jsonl": events });
		const row = await collectRow(dir);
		expect(row.queue_ms).toBe(1000);
		expect(row.boot_ms).toBe(500);
		expect(row.poll_ms).toBe(900);
		expect(row.e2e_ms).toBe(5950);
		expect(row.complete).toBe(true);
	});

	it("a batch with a malformed dir and a missing dir never throws", async () => {
		const dir = await writeDir({ "spec.json": specJson(), "state.json": stateJson(), "events.jsonl": eventsJsonl() });
		const rows = await collectRows([dir, join(tasksRoot, "deadbeef-0000-4000-8000-000000000001"), "/nonexistent/dir"]);
		expect(rows).toHaveLength(3);
		expect(rows[0].queue_ms).toBe(1000);
		expect(rows[1].complete).toBe(false);
		expect(rows[1].task_id).toBe("deadbeef-0000-4000-8000-000000000001");
		expect(rows[2].task_id).toBe("dir");
		expect(rows[2].queue_ms).toBe(null);
	});
});

describe("collector: medians + the report", () => {
	it("median: empty null, odd middle, even mean of middles", () => {
		expect(median([])).toBe(null);
		expect(median([3, 1, 2])).toBe(2);
		expect(median([1, 2, 3, 4])).toBe(2.5);
		expect(median([7])).toBe(7);
	});

	it("mediansOf + renderTable + renderMedians + toJson", async () => {
		const sess = join(base, "sess5.jsonl");
		await writeFile(sess, sessionFile());
		const mk = async (off: number): Promise<string> =>
			writeDir({
				"spec.json": specJson(),
				"state.json": JSON.stringify({ state: "completed", finished_at: iso(5950 + off), reason: "worker" }, null, 2) + "\n",
				"session.json": sessionJson(sess),
				"events.jsonl": eventsJsonl(),
			});
		const rows = await collectRows([await mk(0), await mk(0), await mk(100)]);
		const medians = mediansOf(rows);
		expect(medians.boot_ms).toBe(500);
		expect(medians.poll_ms).toBe(900);
		expect(medians.e2e_ms).toBe(5950); // median of {5950, 5950, 6050}
		const table = renderTable(rows);
		expect(table[0]).toContain("task");
		expect(table).toHaveLength(4);
		expect(renderMedians(medians)).toContain("boot 500ms");
		expect(renderMedians(medians)).toContain("poll 900ms");
		const dumped = JSON.parse(toJson(rows)) as Array<Record<string, unknown>>;
		expect(dumped).toHaveLength(3);
		expect(dumped[0]).toHaveProperty("queue_ms", 1000);
	});
});

describe("collector: the headless content-gate path (done-marker, no marker-observed)", () => {
	// headless.ts branch 3: clean exit 0, idle assistant, no vitrine_done →
	// done-marker (source headless-exit) → worker-exit → terminal transition.
	// NO marker-observed event — the worker-exit event stands in for the
	// observation point (poll = done-marker → worker-exit, settle =
	// worker-exit → terminal), and the row is marked marker_observed_by.
	const headlessEventsJsonl = (): string =>
		[
			{ ts: iso(0), event: "created", agent: "bench", mode: "headless", session_name: "bench · test" },
			{ ts: iso(1000), event: "transition", from: "queued", to: "running", reason: "spawn" },
			{ ts: iso(1500), event: "session", session_id: "vitrine.x" },
			{ ts: iso(5000), event: "done-marker", source: "headless-exit" },
			{ ts: iso(5900), event: "worker-exit", code: 0, signal: null, error: null },
			{ ts: iso(5950), event: "transition", from: "running", to: "completed", reason: "headless-exit" },
		]
			.map((l) => JSON.stringify(l))
			.join("\n") + "\n";

	it("falls back to worker-exit as the observation point: segments computed, not null, not flagged incomplete-for-drift", async () => {
		const sess = join(base, "sess6.jsonl");
		await writeFile(sess, sessionFile());
		const dir = await writeDir({
			"spec.json": specJson(),
			"state.json": stateJson(),
			"session.json": sessionJson(sess),
			"events.jsonl": headlessEventsJsonl(),
		});
		const row = await collectRow(dir);
		expect(row.marker_observed_by).toBe("worker-exit");
		expect(row.work_ms).toBe(3500); // session (1500) → done-marker (5000)
		expect(row.poll_ms).toBe(900); // done-marker (5000) → worker-exit (5900)
		expect(row.settle_ms).toBe(50); // worker-exit (5900) → terminal (5950)
		expect(row.e2e_ms).toBe(5950);
		expect(row.e2e_mismatch_ms).toBe(null); // terminal transition == finished_at
		// the headless-exit path is a LIVE completion, not drift: the row is complete
		expect(row.complete).toBe(true);
		expect(row.missing).toEqual([]);
	});
});

describe("collector: the terminal-state set tracks the protocol", () => {
	it("the collector's TERMINAL_STATES equal the protocol's (a new protocol terminal state can't silently null out settle)", () => {
		expect([...COLLECTOR_TERMINAL_STATES].sort()).toEqual([...PROTOCOL_TERMINAL_STATES].sort());
	});
});
