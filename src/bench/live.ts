/**
 * live.ts — the live bench driver (impure). The versioned battery
 * (battery.ts) against REAL pi: the real model, the local seats (their model
 * pins come from the agent files — no override), per (task × run): a mkdtemp
 * scratch cwd (the battery's `cwdFiles` materialized in it), a single-task
 * `dispatchTasks` call with per-task budgets (wall 900 s / inactivity 600 s
 * by default — spec fields that bound pathological runs), then the outcome
 * oracle and the collector over the task dir.
 *
 * Success rate is the FIRST number of the report; the latency medians are
 * the second — computed over successful (oracle-passed) rows only. A run
 * whose oracle fails lands in the failures section (task, run, state,
 * reason, oracle verdict) — a REPORT, not a failure exit (the run
 * completed; the code stays 0).
 *
 * Env: the driver NEVER switches process.env — it runs against the
 * machine's env as-is (the real seats, the real config, the real tasks
 * root). Hermetic tests point the env at tmp roots + a fake-pi shim
 * (VITRINE_PI_BIN, HOME, VITRINE_TASKS_ROOT, VITRINE_SESSIONS_DIR) before
 * calling it. The only scratch the driver owns is its own tmp base (the
 * per-run scratch cwds + the bench dispatcher's session file), removed at
 * the end; the task dirs themselves stay under the tasks root (the
 * protocol's record — gc'd by the retention rules).
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import * as P from "../protocol";
import { dispatchTasks, waitForTasks, type DispatcherInfo, type DispatchedTaskResult } from "../dispatch";
import { BATTERY, runOracle, type BatteryEntry, type OracleVerdict } from "./battery";
import { collectRow, mediansOf, type BenchRow } from "./collector";
import { renderMedians, renderTable } from "./report";
import { appendHistory, collectProvenance, type BenchHistoryRecord } from "./history";

/** The defaults (the design's settled values). */
export const DEFAULT_MODE: "tile" | "headless" = "tile";
export const DEFAULT_RUNS = 5;
/** The task-level budgets (spec fields) — bound pathological runs; the small tasks normally take 1–3 min. */
export const DEFAULT_TIMEOUT_S = 900;
export const DEFAULT_INACTIVITY_S = 600;

export interface LiveOptions {
	/** `--mode`: the spawn shape (default tile — the real path; no forcing, the compositor fallback is the existing one). */
	mode?: "tile" | "headless";
	/** `--runs`: the run count per battery task (default 5). */
	runs?: number;
	/** The battery (default the versioned BATTERY; tests inject a fixture-compatible one). */
	battery?: BatteryEntry[];
	/** Skip the history append (test hook — keeps a run out of the machine's history file). */
	skipHistory?: boolean;
	/** The dispatch poll tick in ms (default 1000 — production). */
	tickMs?: number;
}

/** One failed (task × run): the failures-section entry. */
export interface LiveFailure {
	/** The battery entry id. */
	battery: string;
	/** The 1-based run number. */
	run: number;
	/** The task id (`-` when the dispatch call itself failed). */
	task_id: string;
	state: string;
	reason: string;
	verdict: OracleVerdict;
}

export interface LiveResult {
	/** 0 = the run completed (oracle failures are a REPORT — they do not change it); 1 = driver error. */
	code: number;
	/** Every line produced (the text report). */
	lines: string[];
	/** The history record (appended unless `skipHistory`). */
	record: BenchHistoryRecord;
	/** The latency rows — the successful runs (the table). */
	rows: BenchRow[];
	/** The failed runs (state + oracle verdict). */
	failures: LiveFailure[];
	/** Oracle-passed runs. */
	passed: number;
	/** Total runs (runs × battery entries). */
	total: number;
}

/**
 * Run the live suite. `out` receives every report line as it is produced
 * (pass a no-op sink for `--json`). The battery runs SEQUENTIALLY (one
 * task at a time — the local card holds the seats' models, and the
 * medians are per (task × run) anyway).
 */
export async function runLive(opts: LiveOptions = {}, out: (l: string) => void = (l) => console.log(l)): Promise<LiveResult> {
	const mode = opts.mode ?? DEFAULT_MODE;
	const runs = opts.runs ?? DEFAULT_RUNS;
	const battery = opts.battery ?? BATTERY;
	const tickMs = opts.tickMs ?? 1000;
	const lines: string[] = [];
	const emit = (l: string): void => {
		lines.push(l);
		out(l);
	};

	// Provenance first (the config hash is the machine's config — the
	// driver does not switch the env).
	const provenance = await collectProvenance();
	const ts = new Date().toISOString();
	const host = hostname();

	const base = await mkdtemp(join(tmpdir(), "vitrine-bench-live-"));
	const info: DispatcherInfo = {
		sessionId: "bench-live",
		sessionFile: join(base, "bench-live-dispatcher.jsonl"),
		model: null,
		cwd: base,
		projectTrusted: false,
	};
	const bunBin = (): string => process.execPath;

	let code = 0;
	const rows: BenchRow[] = []; // successful runs — the latency table
	const allRows: BenchRow[] = []; // every run (the history record's rows)
	const failures: LiveFailure[] = [];
	let passed = 0;
	let total = 0;

	try {
		await writeFile(info.sessionFile, JSON.stringify({ type: "session_info", id: info.sessionId, cwd: base }) + "\n");

		for (let run = 1; run <= runs; run++) {
			for (const entry of battery) {
				// the per (task × run) scratch cwd + the battery's files
				const scratch = await mkdtemp(join(base, "scratch-"));
				await mkdir(scratch, { recursive: true });
				for (const f of entry.cwdFiles ?? []) await writeFile(join(scratch, f.name), f.content, "utf8");
				total++;

				let res: DispatchedTaskResult | undefined;
				try {
					const r = await dispatchTasks({
						tasks: [
							{
								agent: entry.agent,
								task: entry.task,
								cwd: scratch,
								timeout: entry.timeout_s ?? DEFAULT_TIMEOUT_S,
								inactivity: entry.inactivity_s ?? DEFAULT_INACTIVITY_S,
								...(entry.schema !== undefined ? { output_schema: entry.schema } : {}),
							},
						],
						mode,
						dispatcher: info,
						bunBin,
						deps: { tickMs },
					});
					res = r.results[0];
					// the async contract: the call returned before settlement —
					// wait in-process (the factored loop) for the terminal state
					// before the oracle/collector run
					if (res !== undefined) {
						const w = await waitForTasks({
							ids: [res.id],
							mode,
							bunBin,
							lease: { owner: info.sessionId, nonce: "bench-live-wait" },
							deps: { tickMs },
						});
						const ws = w.states[0];
						if (ws !== undefined) {
							res.state = ws.state;
							res.reason = ws.reason;
						}
					}
				} catch (e) {
					// a dispatch-level failure (bad agent, no compositor, …) is a
					// failed run, not a driver error — the suite continues
					failures.push({
						battery: entry.id,
						run,
						task_id: "-",
						state: "dispatch-error",
						reason: e instanceof Error ? e.message : String(e),
						verdict: { pass: false, detail: "oracle not run (dispatch failed)" },
					});
					continue;
				}

				const dir = join(P.tasksRoot(), res.id);
				const verdict = await runOracle(entry.oracle, dir, scratch);
				const row = await collectRow(dir);
				allRows.push(row);
				if (verdict.pass) {
					passed++;
					rows.push(row);
				} else {
					failures.push({ battery: entry.id, run, task_id: res.id, state: res.state, reason: res.reason ?? "", verdict });
				}
			}
		}

		const medians = mediansOf(rows);

		// ---- the report (the success line is the FIRST number) -------------
		emit(`vitrine bench live — ${runs} runs · mode ${mode} · battery: ${battery.map((b) => b.id).join(", ")}`);
		emit(`success ${passed}/${total}`);
		emit("");
		emit(`latency (successful runs, ${rows.length}/${total}):`);
		if (rows.length > 0) for (const l of renderTable(rows)) emit(l);
		else emit("  (no successful runs)");
		emit(`medians: ${renderMedians(medians)}`);
		if (failures.length > 0) {
			emit("");
			emit(`failures (${failures.length}):`);
			for (const f of failures) {
				emit(`  ${f.battery} · run ${f.run} · ${f.task_id.slice(0, 8)} — ${f.state}${f.reason !== "" ? ` (${f.reason})` : ""} · oracle: ${f.verdict.detail}`);
			}
		}

		// ---- history (suite "live") ----------------------------------------
		const record: BenchHistoryRecord = {
			ts,
			suite: "live",
			hostname: host,
			provenance,
			params: { runs, mode, battery: battery.map((b) => b.id) },
			rows: allRows,
			medians,
		};
		if (!opts.skipHistory) {
			await appendHistory(record).catch((e) => emit(`note: history append failed: ${e instanceof Error ? e.message : String(e)}`));
		}
		return { code, lines, record, rows, failures, passed, total };
	} catch (e) {
		emit(`ERROR: bench live failed: ${e instanceof Error ? e.message : String(e)}`);
		code = 1;
		return {
			code,
			lines,
			record: {} as BenchHistoryRecord,
			rows,
			failures,
			passed,
			total,
		};
	} finally {
		await rm(base, { recursive: true, force: true }).catch(() => {});
	}
}
