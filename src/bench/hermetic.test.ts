/**
 * hermetic.test.ts — the bench driver: a mini hermetic run (1 battery-A run,
 * a 2-point tick sweep) proving the full chain stays alive — real
 * dispatchTasks → real wrapper subprocess (`bun src/vitrine-run.ts`) → the
 * driver's pi shim → fake-pi → settle → the collector → the report — plus
 * the history append/read round-trip (against a tmp file, never the
 * machine's history).
 */
import { describe, expect, it } from "bun:test";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHermetic } from "./hermetic";
import { appendHistory, historyPath, lastPriorFor, readHistory, REPO_ROOT, type BenchHistoryRecord } from "./history";

describe("hermetic driver", () => {
	it("a mini run completes the full chain (skipHistory keeps the machine's file clean)", async () => {
		const out: string[] = [];
		const r = await runHermetic({ runs: 1, gapMs: 50, cost: 0.01, tickSweep: [100, 2000], skipHistory: true }, (l) => out.push(l));
		expect(r.code).toBe(0);
		// Battery A: the one run settled completed and the collector saw every segment
		expect(r.batteryA).toHaveLength(1);
		const a = r.batteryA[0];
		expect(a.state).toBe("completed");
		expect(a.queue_ms).toBeTypeOf("number");
		expect(a.boot_ms).toBeTypeOf("number");
		expect(a.work_ms).toBeTypeOf("number");
		expect(a.poll_ms).toBeTypeOf("number");
		expect(a.settle_ms).toBeTypeOf("number");
		expect(a.e2e_ms).toBeTypeOf("number");
		expect(a.harness_ratio).toBeTypeOf("number");
		expect(a.cost_usd).toBe(0.02); // the fixture writes 2 assistant entries × 0.01
		expect(a.complete).toBe(true);
		// Battery B: 4 tasks, cap 2 — all completed, the queue segment present
		expect(r.batteryB).toHaveLength(4);
		expect(r.batteryB.every((x) => x.state === "completed")).toBe(true);
		expect(r.batteryB.some((x) => x.queue_ms !== null && x.queue_ms > 1000)).toBe(true); // a queued task waits a slot
		// the tick sweep: both points completed with measurable poll+settle
		expect(r.sweep).toHaveLength(2);
		expect(r.sweep.map((s) => s.tick_ms)).toEqual([100, 2000]);
		expect(r.sweep.every((s) => s.outcome === "completed")).toBe(true);
		expect(r.sweep.every((s) => s.poll_ms !== null && s.settle_ms !== null && s.tail_ms !== null)).toBe(true);
		// the report
		const text = out.join("\n");
		expect(text).toContain("Battery A — fixed latency");
		expect(text).toContain("Battery B — batch admission");
		expect(text).toContain("Tick sweep");
		expect(text).toContain("medians:");
		// the record
		expect(r.record.suite).toBe("hermetic");
		expect(r.record.params).toEqual({ runs: 1, gap_ms: 50, cost: 0.01, tick_sweep: true });
		expect(r.record.rows).toHaveLength(1 + 4 + 2);
		expect(r.record.provenance.vitrine.version).toBeTypeOf("string");
	}, 120_000);
});

describe("history", () => {
	it("historyPath honors the VITRINE_BENCH_HISTORY override (the test hook keeps the machine's file clean)", () => {
		expect(historyPath()).toBe(join(REPO_ROOT, "state", "bench", "history.jsonl")); // the default (repo-relative)
		const override = join(tmpdir(), "vitrine-bench-history-override.jsonl");
		process.env.VITRINE_BENCH_HISTORY = override;
		try {
			expect(historyPath()).toBe(override); // the override wins — appendHistory/readHistory route through it
		} finally {
			delete process.env.VITRINE_BENCH_HISTORY;
		}
	});

	it("append + read round-trip; lastPriorFor finds the last prior record with the same hostname", async () => {
		const tmp = await mkdtemp(join(tmpdir(), "vitrine-bench-hist-"));
		const path = join(tmp, "history.jsonl");
		const mk = (ts: string, host: string, boot: number, settle: number): BenchHistoryRecord => ({
			ts,
			suite: "hermetic",
			hostname: host,
			provenance: { vitrine: { version: "0.0.0", git_sha: "abc1234" }, pi: "0.86.1", config: "hash" },
			params: { runs: 5, gap_ms: 400, cost: 0.05, tick_sweep: true },
			rows: [],
			medians: { queue_ms: 1, boot_ms: boot, work_ms: 1, poll_ms: 1, settle_ms: settle, e2e_ms: 1, harness_ratio: 0.1, tokens_per_s: 1, cost_usd: 0.1 },
		});
		await appendHistory(mk("2026-10-01T00:00:00.000Z", "omarchy", 1000, 10), path);
		await appendHistory(mk("2026-10-02T00:00:00.000Z", "other-host", 9999, 99), path);
		await appendHistory(mk("2026-10-03T00:00:00.000Z", "omarchy", 2000, 20), path);
		const recs = await readHistory(path);
		expect(recs).toHaveLength(3);
		const before = lastPriorFor(recs, "omarchy", "2026-10-03T12:00:00.000Z");
		expect(before?.ts).toBe("2026-10-03T00:00:00.000Z"); // the LAST prior, not the first
		const beforeFirst = lastPriorFor(recs, "omarchy", "2026-10-01T12:00:00.000Z");
		expect(beforeFirst?.ts).toBe("2026-10-01T00:00:00.000Z");
		expect(lastPriorFor(recs, "omarchy", "2026-09-01T00:00:00.000Z")).toBe(null); // nothing before the first record
		expect(lastPriorFor(recs, "missing-host", "2026-10-03T12:00:00.000Z")).toBe(null);
		// a missing file reads as empty
		expect(await readHistory(join(tmp, "absent.jsonl"))).toEqual([]);
		// a malformed line is skipped, not fatal
		await appendFile(path, "not json\n", "utf8");
		expect(await readHistory(path)).toHaveLength(3);
		await rm(tmp, { recursive: true, force: true });
	});
});
