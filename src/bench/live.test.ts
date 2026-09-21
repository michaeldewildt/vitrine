/**
 * live.test.ts — the live driver's code path, hermetic: the unit-1
 * hermetic pattern (VITRINE_PI_BIN shim → the fake-pi fixture, tmp
 * HOME/tasks root/sessions dir) with a 1-task TEST battery whose oracle is
 * `result-text` (state-completed + harvest-text) — the fixture ignores
 * prompts, so the real oracles are NOT testable hermetically; the test
 * battery proves the dispatch→oracle→report→history wiring end to end.
 * Incl. the skipHistory round-trip and the failures-section path (a strict
 * oracle forces one failure row).
 *
 * The driver never switches the env — the env here is the test's (the
 * machine's real seats/config are untouched).
 */
import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runLive } from "./live";
import { appendHistory, lastPriorFor, readHistory } from "./history";
import type { BatteryEntry } from "./battery";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIXTURE_PI = join(REPO_ROOT, "test", "fixtures", "fake-pi.ts");

let base: string;
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ["HOME", "VITRINE_TASKS_ROOT", "VITRINE_SESSIONS_DIR", "VITRINE_PI_BIN", "VITRINE_CONFIG"] as const;

/** The 1-task test battery: the fixture-compatible oracle (state-completed + harvest-text). */
const TEST_BATTERY: BatteryEntry[] = [
	{
		id: "bench-live",
		agent: "bench-live",
		task: "do the bench thing",
		oracle: { kind: "result-text", contains: "fixture result" },
		timeout_s: 120,
		inactivity_s: 60,
	},
];

beforeAll(async () => {
	for (const k of ENV_KEYS) saved[k] = process.env[k];
	base = await mkdtemp(join(tmpdir(), "vitrine-bench-live-test-"));
	process.env.HOME = base;
	process.env.VITRINE_TASKS_ROOT = join(base, "tasks");
	process.env.VITRINE_SESSIONS_DIR = join(base, "sessions");
	process.env.VITRINE_CONFIG = join(base, ".vitrine", "config.json");
	await mkdir(join(base, "sessions"), { recursive: true });
	await mkdir(join(base, ".pi", "agent", "agents"), { recursive: true });
	await writeFile(
		join(base, ".pi", "agent", "agents", "bench-live.md"),
		"---\nname: bench-live\ndescription: fixture bench agent for the live driver test.\nmodel: ninfer/bench-live-model\n---\n# Bench live\n\nYou are the bench fixture agent.\n",
	);
	// the driver's pi shim (the wrapper's buildWorkerEnv does not forward
	// VITRINE_FIXTURE_* — the fixture env is baked into the shim's env)
	const shim = join(base, "pi-shim");
	await writeFile(shim, `#!/bin/sh\nexport VITRINE_FIXTURE_MODE=done\nexport VITRINE_FIXTURE_GAP_MS=30\nexec ${process.execPath} ${FIXTURE_PI} "$@"\n`);
	await chmod(shim, 0o755);
	process.env.VITRINE_PI_BIN = shim;
});

afterAll(async () => {
	for (const k of ENV_KEYS) {
		const v = saved[k];
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	await rm(base, { recursive: true, force: true });
});

describe("the live driver (hermetic)", () => {
	it("a passing run: the full chain (dispatch → oracle → report → history record)", async () => {
		const out: string[] = [];
		const r = await runLive({ runs: 1, mode: "headless", battery: TEST_BATTERY, skipHistory: true, tickMs: 50 }, (l) => out.push(l));
		expect(r.code).toBe(0);
		// the success line is the first number, before the table
		const text = out.join("\n");
		const successIdx = out.findIndex((l) => l.startsWith("success "));
		expect(out[successIdx]).toBe("success 1/1");
		expect(text.indexOf("success 1/1")).toBeLessThan(text.indexOf("latency (successful runs"));
		// the latency row: every segment present (the collector saw the full chain)
		expect(r.rows).toHaveLength(1);
		const row = r.rows[0];
		expect(row.state).toBe("completed");
		expect(row.complete).toBe(true);
		expect(row.queue_ms).toBeTypeOf("number");
		expect(row.boot_ms).toBeTypeOf("number");
		expect(row.work_ms).toBeTypeOf("number");
		expect(row.poll_ms).toBeTypeOf("number");
		expect(row.settle_ms).toBeTypeOf("number");
		expect(row.e2e_ms).toBeTypeOf("number");
		expect(r.failures).toHaveLength(0);
		// the table + medians render
		expect(text).toContain("task");
		expect(text).toContain("medians:");
		expect(text).toContain(`vitrine bench live — 1 runs · mode headless · battery: bench-live`);
		// the history record (suite "live")
		expect(r.record.suite).toBe("live");
		expect(r.record.params).toEqual({ runs: 1, mode: "headless", battery: ["bench-live"] });
		expect(r.record.rows).toHaveLength(1);
		expect(r.record.hostname).toBe(hostname());
		expect(r.record.provenance.vitrine.version).toBeTypeOf("string");
	}, 120_000);
});

describe("the live driver — failures section", () => {
	it("a strict oracle forces one failure row (state + oracle verdict); the code stays 0", async () => {
		const strict: BatteryEntry[] = [
			{ id: "bench-live", agent: "bench-live", task: "do the bench thing", oracle: { kind: "result-text", contains: "not there" }, timeout_s: 120, inactivity_s: 60 },
		];
		const out: string[] = [];
		const r = await runLive({ runs: 1, mode: "headless", battery: strict, skipHistory: true, tickMs: 50 }, (l) => out.push(l));
		expect(r.code).toBe(0); // a failed oracle is a REPORT, not a failure exit
		expect(r.passed).toBe(0);
		expect(r.total).toBe(1);
		expect(r.rows).toHaveLength(0);
		expect(r.failures).toHaveLength(1);
		const f = r.failures[0];
		expect(f.battery).toBe("bench-live");
		expect(f.run).toBe(1);
		expect(f.state).toBe("completed"); // the run itself completed; the oracle is strict
		expect(f.verdict.pass).toBe(false);
		expect(f.verdict.detail).toContain("does not contain");
		// the failures section renders (task, run, state, oracle verdict)
		const text = out.join("\n");
		expect(text).toContain("success 0/1");
		expect(text).toContain("failures (1):");
		expect(text).toContain("bench-live · run 1 ·");
		expect(text).toContain("oracle:");
		// medians over zero successful rows are all null
		expect(r.record.medians.e2e_ms).toBe(null);
	}, 120_000);
});

describe("the live driver — skipHistory round-trip", () => {
	it("the skipped record appends + reads back (suite \"live\"; lastPriorFor is suite-aware)", async () => {
		const r = await runLive({ runs: 1, mode: "headless", battery: TEST_BATTERY, skipHistory: true, tickMs: 50 }, () => {});
		expect(r.code).toBe(0);
		expect(r.record.suite).toBe("live");
		// skipHistory kept the machine's history file untouched — the record
		// round-trips through an explicit tmp path instead
		const histBase = await mkdtemp(join(tmpdir(), "vitrine-bench-live-hist-"));
		const path = join(histBase, "history.jsonl");
		await appendHistory(r.record, path);
		const recs = await readHistory(path);
		expect(recs).toHaveLength(1);
		expect(recs[0].suite).toBe("live");
		expect(recs[0].params).toEqual({ runs: 1, mode: "headless", battery: ["bench-live"] });
		const host = r.record.hostname;
		// the live record is the prior FOR THE LIVE SUITE…
		expect(lastPriorFor(recs, host, "2099-01-01T00:00:00.000Z", "live")?.ts).toBe(r.record.ts);
		// …and is NOT picked up by the hermetic default (the warn gate compares like with like)
		expect(lastPriorFor(recs, host, "2099-01-01T00:00:00.000Z")).toBe(null);
		await rm(histBase, { recursive: true, force: true });
	}, 120_000);
});
