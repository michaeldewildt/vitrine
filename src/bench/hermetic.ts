/**
 * hermetic.ts — the hermetic bench driver (impure). Runs the FULL chain —
 * real `dispatchTasks` → real wrapper subprocess (`bun src/vitrine-run.ts`)
 * → the pi shim → fake-pi (`test/fixtures/fake-pi.ts`) → settle → harvest —
 * against a tmp HOME, then the in-process tick sweep
 * (`runHeadlessWrapper` with `deps.tickMs` — the only way the sweep can
 * happen, since the production wrapper tick is a hard-coded 1000 ms with no
 * config seam), then the collector over the task dirs, the table via
 * `report.ts`, the history append, and the soft warn gate.
 *
 * Fixture env gap (settled): the real wrapper's `buildWorkerEnv`
 * (`src/wrapper/worker.ts`) does NOT forward `VITRINE_FIXTURE_*` — so the
 * driver writes its OWN pi shim (an executable `#!/bin/sh` script, the
 * dispatch.test.ts pattern) with `VITRINE_FIXTURE_MODE=done`,
 * `VITRINE_FIXTURE_GAP_MS` and `VITRINE_FIXTURE_COST` baked into the
 * shim's env, and points `VITRINE_PI_BIN` at it.
 *
 * Headless-only by construction — the compositor is never touched.
 */
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as P from "../protocol";
import * as C from "../config";
import { dispatchTasks, type DispatcherInfo } from "../dispatch";
import { runHeadlessWrapper } from "../wrapper/lifecycle";
import { collectRows, mediansOf, type BenchRow } from "./collector";
import { fmtMs, renderMedians, renderTable } from "./report";
import { appendHistory, collectProvenance, lastPriorFor, readHistory, type BenchHistoryRecord } from "./history";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIXTURE_PI = join(REPO_ROOT, "test", "fixtures", "fake-pi.ts");
const BUN_PATH = process.execPath;
/** The wrapper tick in production (lifecycle.ts: a hard-coded 1000 ms default — no config seam exists, and this bench must not add one). */
const PROD_TICK_MS = 1000;
/** The tick sweep (wrapper tick values, in-process). */
const DEFAULT_TICK_SWEEP = [100, 250, 500, 1000, 2000];
/** The soft warn gate: > this relative regression of boot/settle medians vs the last prior run. */
const REGRESSION_THRESHOLD = 0.2;

export interface HermeticOptions {
	/** Battery A run count (default 5). */
	runs?: number;
	/** The fixture entry gap in ms (default 400). */
	gapMs?: number;
	/** The fixture cost per assistant entry, USD (default 0.05). */
	cost?: number;
	/** The in-process wrapper tick sweep (default 100…2000). */
	tickSweep?: number[];
	/** Skip the history append (test hook — keeps a run out of the machine's history file). */
	skipHistory?: boolean;
}

export interface SweepPoint {
	tick_ms: number;
	/** done-marker → marker-observed: the residual of the wrapper tick the done-marker landed in — the tick-sensitive cost (phase-dependent; expect ≤ tick_ms). */
	poll_ms: number | null;
	/** marker-observed → terminal transition: the in-tick state write — flat (~0–1 ms), not tick-sensitive. */
	settle_ms: number | null;
	/** done-marker → terminal (poll + settle, the tail under that tick). */
	tail_ms: number | null;
	outcome: string;
}

export interface HermeticResult {
	/** 0 = the run completed (report-only — a WARN never changes it); 1 = driver failure. */
	code: number;
	/** Every line produced (the text report). */
	lines: string[];
	/** The history record (appended unless `skipHistory`). */
	record: BenchHistoryRecord;
	batteryA: BenchRow[];
	batteryB: BenchRow[];
	sweep: SweepPoint[];
}

interface SavedEnv {
	HOME: string | undefined;
	VITRINE_TASKS_ROOT: string | undefined;
	VITRINE_SESSIONS_DIR: string | undefined;
	VITRINE_PI_BIN: string | undefined;
	VITRINE_CONFIG: string | undefined;
}

/**
 * Run the hermetic suite. `out` receives every report line as it is
 * produced (pass a no-op sink for `--json`). The env is switched for the
 * duration of the run and restored in `finally` (the tmp base is removed).
 */
export async function runHermetic(opts: HermeticOptions = {}, out: (l: string) => void = (l) => console.log(l)): Promise<HermeticResult> {
	const runs = opts.runs ?? 5;
	const gapMs = opts.gapMs ?? 400;
	const cost = opts.cost ?? 0.05;
	const sweepTicks = opts.tickSweep ?? DEFAULT_TICK_SWEEP;
	const lines: string[] = [];
	const emit = (l: string): void => {
		lines.push(l);
		out(l);
	};

	// Provenance BEFORE the env switch — the config hash must be the
	// machine's config, not the tmp base's.
	const provenance = await collectProvenance();
	const ts = new Date().toISOString();
	const host = hostname();
	const saved: SavedEnv = {
		HOME: process.env.HOME,
		VITRINE_TASKS_ROOT: process.env.VITRINE_TASKS_ROOT,
		VITRINE_SESSIONS_DIR: process.env.VITRINE_SESSIONS_DIR,
		VITRINE_PI_BIN: process.env.VITRINE_PI_BIN,
		VITRINE_CONFIG: process.env.VITRINE_CONFIG,
	};
	const restore = (k: keyof SavedEnv): void => {
		const v = saved[k];
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	};

	const base = await mkdtemp(join(tmpdir(), "vitrine-bench-"));
	const tasksRoot = join(base, "tasks");
	const sessionsRoot = join(base, "sessions");
	const agentsDir = join(base, ".pi", "agent", "agents");
	const shim = join(base, "pi-shim");
	const info: DispatcherInfo = { sessionId: "bench-disp", sessionFile: join(sessionsRoot, "disp.jsonl"), model: "bench/fixture", cwd: base, projectTrusted: false };
	const bunBin = (): string => BUN_PATH;
	const deps = { tickMs: PROD_TICK_MS }; // production timing (the dispatcher side; the wrapper subprocess ticks at its production 1000 ms)

	let code = 0;
	let rowsA: BenchRow[] = [];
	let rowsB: BenchRow[] = [];
	let sweep: SweepPoint[] = [];
	let record: BenchHistoryRecord | undefined;
	try {
		process.env.HOME = base;
		process.env.VITRINE_TASKS_ROOT = tasksRoot;
		process.env.VITRINE_SESSIONS_DIR = sessionsRoot;
		process.env.VITRINE_CONFIG = join(base, ".vitrine", "config.json");
		await mkdir(sessionsRoot, { recursive: true });
		await mkdir(agentsDir, { recursive: true });
		await writeFile(join(sessionsRoot, "disp.jsonl"), JSON.stringify({ type: "session_info", id: "bench-disp", cwd: base }) + "\n");
		await writeFile(
			join(agentsDir, "bench-agent.md"),
			"---\nname: bench-agent\ndescription: fixture bench agent for the hermetic suite.\nmodel: ninfer/bench-model\n---\n# Bench agent\n\nYou are the bench fixture agent.\n",
		);
		C.readConfigSync(); // creates the default config under the tmp HOME (max_concurrent 2 — Battery B's cap)
		// The driver's own pi shim: the wrapper's buildWorkerEnv does not forward
		// VITRINE_FIXTURE_*, so the fixture env is baked into the shim's env.
		await writeFile(
			shim,
			`#!/bin/sh\nexport VITRINE_FIXTURE_MODE=done\nexport VITRINE_FIXTURE_GAP_MS=${gapMs}\nexport VITRINE_FIXTURE_COST=${cost}\nexec ${BUN_PATH} ${FIXTURE_PI} "$@"\n`,
		);
		await chmod(shim, 0o755);
		process.env.VITRINE_PI_BIN = shim;

		emit(`vitrine bench hermetic — ${runs} runs · gap ${gapMs} ms · cost $${cost} · tick sweep ${sweepTicks.join(",")} ms · wrapper tick (production) ${PROD_TICK_MS} ms`);

		// ---- Battery A: fixed latency — k runs, 1 task each, production timing ----
		const dirsA: string[] = [];
		const notesA: string[] = [];
		for (let i = 0; i < runs; i++) {
			try {
				const r = await dispatchTasks({
					tasks: [{ agent: "bench-agent", task: `bench A ${i + 1}/${runs}` }],
					mode: "headless",
					dispatcher: info,
					bunBin,
					deps,
				});
				const res = r.results[0];
				if (res !== undefined && res.state === "completed") dirsA.push(join(tasksRoot, res.id));
				else notesA.push(`run ${i + 1}: state ${res?.state ?? "missing"}${res?.reason !== undefined ? ` (${res.reason})` : ""}`);
			} catch (e) {
				notesA.push(`run ${i + 1}: ${e instanceof Error ? e.message : String(e)}`);
			}
		}
		rowsA = await collectRows(dirsA);
		const medians = mediansOf(rowsA);
		emit("");
		emit(`Battery A — fixed latency (${dirsA.length}/${runs} completed):`);
		if (rowsA.length > 0) for (const l of renderTable(rowsA)) emit(l);
		else emit("  (no completed runs)");
		emit(`medians: ${renderMedians(medians)}`);
		for (const n of notesA) emit(`note: ${n}`);

		// ---- Battery B: batch admission — one call, 4 tasks, default max_concurrent (2 queue in-call) ----
		const rB = await dispatchTasks({
			tasks: [1, 2, 3, 4].map((n) => ({ agent: "bench-agent", task: `bench B ${n}` })),
			mode: "headless",
			dispatcher: info,
			bunBin,
			deps,
		});
		rowsB = await collectRows(rB.results.map((x) => join(tasksRoot, x.id)));
		emit("");
		emit(`Battery B — batch admission (4 tasks, cap ${C.readConfigSync().max_concurrent} — the queue segment under load):`);
		if (rowsB.length > 0) for (const l of renderTable(rowsB)) emit(l);
		else emit("  (no runs)");
		emit(`medians: ${renderMedians(mediansOf(rowsB))}`);

		// ---- Tick sweep: in-process wrapper (deps injection is the only seam) ----
		const dirsSweep: string[] = [];
		for (const tick of sweepTicks) {
			const id = P.newTaskId();
			const dir = join(tasksRoot, id);
			const spec: P.TaskSpec = {
				task_id: id,
				agent: { name: "bench-agent", body: "bench sweep agent\n" },
				dispatcher_session_id: info.sessionId,
				cwd: base,
				session_id: `vitrine.${id}`,
				session_name: `bench-agent · ${id.slice(0, 8)}`,
				mode: "headless",
				attended: false,
				workspace: 9,
				wall_timeout_s: 3600,
				inactivity_s: 3600,
				auto_settle_s: 3600,
				auto_settle_grace_s: 60,
				created_at: new Date().toISOString(),
				boot_id: P.currentBootId(),
			};
			await P.createTask(dir, spec, "bench sweep prompt\n");
			const outcome = await runHeadlessWrapper(dir, {
				piBin: shim,
				sessionsRoot,
				agentsDir,
				tickMs: tick,
				isTty: () => false,
			});
			dirsSweep.push(dir);
			sweep.push({ tick_ms: tick, poll_ms: null, settle_ms: null, tail_ms: null, outcome: String(outcome) });
		}
		const rowsSweep = await collectRows(dirsSweep);
		rowsSweep.forEach((r, i) => {
			sweep[i].poll_ms = r.poll_ms;
			sweep[i].settle_ms = r.settle_ms;
			sweep[i].tail_ms = r.poll_ms !== null && r.settle_ms !== null ? r.poll_ms + r.settle_ms : null;
		});
		emit("");
		emit(`Tick sweep — in-process wrapper: poll (done-marker → marker-observed, the residual of the tick the marker landed in — the tick-sensitive cost, phase-dependent, expect ≤ tick) vs settle (marker-observed → terminal, the in-tick state write — flat); nothing is asserted:`);
		for (const s of sweep) {
			emit(`  tick ${String(s.tick_ms).padEnd(5)}: poll ${fmtMs(s.poll_ms)} · settle ${fmtMs(s.settle_ms)} · marker→terminal ${fmtMs(s.tail_ms)} · ${s.outcome}`);
		}

		// ---- history + the soft warn gate (report-only: the exit code stays 0) ----
		const allRows = [...rowsA, ...rowsB, ...rowsSweep];
		record = { ts, suite: "hermetic", hostname: host, provenance, params: { runs, gap_ms: gapMs, cost, tick_sweep: true }, rows: allRows, medians };
		const prior = await readHistory().catch(() => [] as BenchHistoryRecord[]);
		const before = lastPriorFor(prior, host, ts);
		if (before !== null) {
			emit("");
			emit(
				`baseline ${before.ts} (${before.provenance.vitrine.git_sha ?? "no-sha"}): boot ${fmtMs(before.medians?.boot_ms ?? null)} · settle ${fmtMs(before.medians?.settle_ms ?? null)} | now: boot ${fmtMs(medians.boot_ms)} · settle ${fmtMs(medians.settle_ms)}`,
			);
			for (const key of ["boot_ms", "settle_ms"] as const) {
				const now = medians[key];
				const old = before.medians?.[key] ?? null;
				if (now !== null && old !== null && old > 0 && now > old * (1 + REGRESSION_THRESHOLD)) {
					emit(`WARN: ${key} regressed ${fmtMs(old)} → ${fmtMs(now)} (+${Math.round(((now - old) / old) * 100)}%) vs ${before.ts}`);
				}
			}
		}
		if (!opts.skipHistory) {
			await appendHistory(record).catch((e) => emit(`note: history append failed: ${e instanceof Error ? e.message : String(e)}`));
		}
	} catch (e) {
		emit(`ERROR: bench hermetic failed: ${e instanceof Error ? e.message : String(e)}`);
		code = 1;
	} finally {
		restore("HOME");
		restore("VITRINE_TASKS_ROOT");
		restore("VITRINE_SESSIONS_DIR");
		restore("VITRINE_PI_BIN");
		restore("VITRINE_CONFIG");
		await rm(base, { recursive: true, force: true }).catch(() => {});
	}
	return {
		code,
		lines,
		record: record ?? ({} as BenchHistoryRecord),
		batteryA: rowsA,
		batteryB: rowsB,
		sweep,
	};
}
