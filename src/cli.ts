#!/usr/bin/env bun
/**
 * vitrine — the CLI: the human-side escape hatch (the dispatch
 * tool is the agent-side surface).
 *
 *   vitrine list [--json]   all task dirs: id, state (completed+ = resumed
 *                           by the human after completion), age, pids, title;
 *                           --json = one line of fixed-shape JSON rows
 *   vitrine show <task_id>  state.json + session.json + events (last 20) + result.md
 *   vitrine kill <task_id>  the shared kill path (protocol.killTask): queued ⇒
 *                           settle now; running + live wrapper ⇒ kill_requested
 *                           + start-time-checked SIGTERM hint; dead wrapper ⇒
 *                           ordering rule 2; terminal ⇒ no-op
 *   vitrine gc [--dry-run]  prune terminal task dirs past the retention window
 *                           (config retention_days + a 60 s grace; never a dir
 *                           whose wrapper pid is still alive; manual, not a
 *                           daemon; --dry-run previews and removes
 *                           nothing)
 *   vitrine bench hermetic [--runs n] [--json]
 *                           the hermetic perf suite: runs the full chain
 *                           (real dispatch → real wrapper subprocess → the pi
 *                           shim → fake-pi) k times at fixed latency (battery
 *                           A), a 4-task batch-admission call (battery B), and
 *                           the in-process wrapper tick sweep; prints the
 *                           metrics table, appends the run to
 *                           state/bench/history.jsonl (gitignored) and
 *                           soft-warns (>20% boot/settle regression vs the
 *                           last prior run on this host — report-only)
 *   vitrine bench live [--runs n] [--mode tile|headless] [--json]
 *                       the live perf suite: the versioned battery
 *                       (src/bench/battery.ts) against real pi (the real
 *                       model, the local seats) — the success rate first
 *                       (the outcome oracles), the latency medians second
 *                       (over successful runs only); failed runs land in
 *                       the failures section (a report, not a failure
 *                       exit); appends the run to
 *                       state/bench/history.jsonl (suite "live")
 *
 * `runCli` is exported and deps-injected; the entry below just wires it to
 * argv/stdout. Exit codes: 0 ok · 1 failure (bad id, unknown task, kill error)
 * · 2 usage.
 */
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { isMainModule } from "./main-guard";
import * as P from "./protocol";
import * as C from "./config";

const VERBS = ["list", "show", "kill", "gc", "bench", "help"] as const;
const GC_GRACE_MS = 60_000;

function formatAge(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	if (h < 48) return `${h}h`;
	return `${Math.floor(h / 24)}d`;
}

/**
 * The gc-boundary note (R5): an undelivered async task dir is SKIPPED by gc
 * (its harvest has not been delivered — retiring it would lose an undelivered
 * result), and the skip is noted in the output. Retiring one is an explicit
 * operator act: deliver it (e.g. `vitrine_collect` with the task's id, which
 * writes the harvest-delivered marker) and the plain retention rule applies.
 */
function gcSkipNote(n: number): string {
	return `gc: skipped ${n} undelivered async task(s) (no harvest-delivered marker — vitrine_collect with the task id delivers and marks it; retiring one is an explicit operator act)`;
}

export interface CliDeps {
	now?: () => number;
	/** Injectable task-dir removal (gc). */
	remove?: (dir: string) => Promise<void>;
	/** Line sink for success output (default: stdout). */
	out?: (line: string) => void;
	/** Line sink for errors (default: stderr). */
	err?: (line: string) => void;
}

export interface CliResult {
	code: number;
	lines: string[];
}

/**
 * Run a verb. `argv` is the args after `vitrine` (e.g. `["kill", "<id>"]`).
 * Returns the exit code + every line produced (so tests can assert on both
 * without touching the real streams).
 */
export async function runCli(argv: string[], deps: CliDeps = {}): Promise<CliResult> {
	const now = deps.now ?? Date.now;
	const out = deps.out ?? ((l: string) => console.log(l));
	const err = deps.err ?? ((l: string) => console.error(l));
	const lines: string[] = [];
	const emit = (l: string): void => {
		lines.push(l);
		out(l);
	};
	const fail = (msg: string, code: number): CliResult => {
		err(msg);
		return { code, lines };
	};
	const verb = argv[0];

	if (verb === undefined || verb === "help") {
		emit("usage: vitrine <list [--json] | show <task_id> | kill <task_id> | gc [--dry-run] | bench <hermetic|live> [--runs n] [--mode tile|headless] [--json] | help>");
		return { code: verb === "help" ? 0 : 2, lines };
	}
	if (!(VERBS.includes(verb as (typeof VERBS)[number]) as boolean)) {
		return fail(`vitrine: unknown verb '${verb}' (expected: ${VERBS.join(", ")})`, 2);
	}

	// flags: list --json · gc --dry-run · bench <sub> [--runs n] [--mode m] [--json] — any other flag is a usage error
	let json = false;
	let dryRun = false;
	let benchRuns = 5;
	let benchMode: "tile" | "headless" = "tile";
	const benchUsage = "usage: vitrine bench <hermetic|live> [--runs n] [--mode tile|headless] [--json]";
	if (verb === "bench") {
		const sub = argv[1];
		if (sub !== "hermetic" && sub !== "live") return fail(`${benchUsage}${sub !== undefined ? ` — unknown sub-verb '${sub}'` : ""}`, 2);
		for (let i = 2; i < argv.length; i++) {
			const a = argv[i];
			if (a === "--json") json = true;
			else if (a === "--runs") {
				const n = argv[i + 1] ?? "";
				if (!/^[1-9][0-9]*$/.test(n)) return fail(`${benchUsage} — --runs takes a positive integer`, 2);
				benchRuns = Number(n);
				i++;
			} else if (a === "--mode") {
				const m = argv[i + 1] ?? "";
				if (m !== "tile" && m !== "headless") return fail(`${benchUsage} — --mode takes tile or headless`, 2);
				i++;
				if (sub === "hermetic") return fail(`${benchUsage} — bench hermetic is headless-only (--mode does not apply)`, 2);
				benchMode = m;
			} else if (a.startsWith("--")) return fail(`${benchUsage} — unknown flag '${a}'`, 2);
			else return fail(`${benchUsage} — unexpected argument '${a}'`, 2);
		}
	} else {
		for (const a of argv.slice(1)) {
			if (a === "--json" && verb === "list") json = true;
			else if (a === "--dry-run" && verb === "gc") dryRun = true;
			else if (a.startsWith("--"))
				return fail(
					`usage: vitrine ${verb === "list" ? "list [--json]" : verb === "gc" ? "gc [--dry-run]" : verb} — unknown flag '${a}'`,
					2,
				);
		}
	}

	// show / kill share the id validation + the task-dir gate (same codes:
	// 2 = usage (no id), 1 = bad shape / missing dir / not a task dir)
	const taskDir = async (verb: string): Promise<string | CliResult> => {
		const id = argv[1];
		if (id === undefined) return fail(`usage: vitrine ${verb} <task_id>`, 2);
		if (!P.UUID_RE.test(id)) return fail(`invalid task id '${id}' (expect a UUID)`, 1);
		const dir = join(P.tasksRoot(), id);
		try {
			await P.assertTaskDir(dir);
		} catch (e: unknown) {
			return fail(String(e), 1);
		}
		// assertTaskDir does not reject a missing dir (shape is enough for its
		// contract) — the existence gate is the verb's ("no such task")
		const st0 = await stat(dir).catch(() => null);
		if (st0 === null || !st0.isDirectory()) return fail(`no such task: ${id}`, 1);
		return dir;
	};

	// ---- list ------------------------------------------------------------------
	if (verb === "list") {
		const dirs = await P.listTaskDirs();
		const rows = await Promise.all(
			dirs.map(async (dir) => {
				const st = await P.readState(dir).catch(() => null);
				const spec = await P.readSpec(dir).catch(() => null);
				// `completed+` (v1.11): a completed task the human
				// resumed in its tile — the state itself is untouched; the
				// marker tells the parent the session keeps growing.
				const resumed =
					st?.state === "completed"
						? ((await P.readEvents(dir).catch(() => null)) ?? []).some((e) => e.event === "resumed")
						: false;
				return { dir, st, spec, resumed };
			}),
		);
		rows.sort((a, b) => (b.spec?.created_at ?? "").localeCompare(a.spec?.created_at ?? ""));
		if (json) {
			// --json: exactly one line, fixed row shape, newest first
			const jrows = rows.map(({ dir, st, spec, resumed }) => ({
				id: P.taskIdOf(dir),
				state: st?.state ?? null,
				state_reason: st?.reason !== undefined && st.reason !== "" ? st.reason : null,
				resumed,
				created_at: spec?.created_at ?? null,
				finished_at: st?.finished_at ?? null,
				wrapper_pid: st?.wrapper_pid ?? null,
				worker_pid: st?.worker_pid ?? null,
				session_name: spec?.session_name ?? null,
			}));
			emit(JSON.stringify(jrows));
			return { code: 0, lines };
		}
		if (dirs.length === 0) {
			emit("(no tasks)");
			return { code: 0, lines };
		}
		emit(`${"id".padEnd(9)} ${"state".padEnd(9)} ${"age".padEnd(5)} ${"pids".padEnd(18)} title`);
		for (const { dir, st, spec, resumed } of rows) {
			const id = P.taskIdOf(dir);
			const age = spec?.created_at !== undefined ? formatAge(now() - Date.parse(spec.created_at)) : "-";
			// anti-recycling liveness (a bare pid-alive would show a recycled pid as a live wrapper)
			const wAlive = st?.wrapper_pid !== undefined ? (await P.wrapperLiveness(dir, st)).live : false;
			const wStr = st?.wrapper_pid !== undefined ? `w ${st.wrapper_pid}${wAlive ? "" : " (dead)"}` : "-";
			const pids = st?.worker_pid !== undefined ? `${wStr} x ${st.worker_pid}` : wStr;
			emit(`${id.slice(0, 8).padEnd(9)} ${(String(st?.state ?? "?") + (resumed ? "+" : "")).padEnd(9)} ${age.padEnd(5)} ${pids.slice(0, 18).padEnd(18)} ${spec?.session_name ?? "-"}`);
		}
		return { code: 0, lines };
	}

	// ---- show ------------------------------------------------------------------
	if (verb === "show") {
		const maybe = await taskDir("show");
		if (typeof maybe === "object") return maybe;
		const dir = maybe;
		const st = await P.readState(dir);
		emit(`task   ${P.taskIdOf(dir)}`);
		emit(`state  ${st.state}${st.reason !== undefined && st.reason !== "" ? ` (${st.reason})` : ""}${st.exit_code !== undefined ? ` exit=${st.exit_code}` : ""}`);
		const spec = await P.readSpec(dir).catch(() => null);
		if (spec !== null) emit(`agent  ${spec.agent.name} · ${spec.mode} · dispatcher ${spec.dispatcher_session_id.slice(0, 8)}`);
		if (spec?.created_at !== undefined) emit(`created ${spec.created_at}${st.finished_at !== undefined ? ` → ${st.finished_at}` : ""}`);
		const sess = await P.readSession(dir).catch(() => null);
		if (sess !== null) {
			emit(`session ${sess.session_id}`);
			emit(`file    ${sess.session_file}`);
		}
		const events = await P.readEvents(dir);
		const last = events.slice(-20);
		if (last.length > 0) {
			emit(`events (last ${last.length} of ${events.length}):`);
			for (const e of last) emit(`  ${JSON.stringify(e)}`);
		}
		const resultRaw = await readFile(join(dir, "result.md"), "utf8").catch(() => null);
		if (resultRaw !== null) {
			emit("result.md:");
			for (const line of resultRaw.split("\n")) emit(`  ${line}`);
		}
		return { code: 0, lines };
	}

	// ---- kill ------------------------------------------------------------------
	if (verb === "kill") {
		const maybe = await taskDir("kill");
		if (typeof maybe === "object") return maybe;
		const dir = maybe;
		let r: P.KillTaskResult;
		try {
			r = await P.killTask(dir);
		} catch (e: unknown) {
			return fail(String(e), 1);
		}
		emit(`${P.taskIdOf(dir)}: ${r.action} — state ${r.state}${r.reason !== "" ? ` (${r.reason})` : ""}${r.workerSignalled ? "; worker signalled" : ""}`);
		return { code: 0, lines };
	}

	// ---- gc --------------------------------------------------------------------
	if (verb === "gc") {
		const cfg = C.readConfigSync();
		const retentionMs = cfg.retention_days * 24 * 3600 * 1000;
		const dirs = await P.listTaskDirs();
		let removed = 0;
		let previewed = 0;
		let skippedUndelivered = 0;
		for (const dir of dirs) {
			const st = await P.readState(dir).catch(() => null);
			if (st === null || !P.isTerminal(st.state)) continue;
			// defensive: never remove a dir whose wrapper is still alive — the
			// anti-recycling liveness (start-time + boot_id), not a bare pid check:
			// a small pid recycled by an unrelated process must not read as "live"
			if (st.wrapper_pid !== undefined && (await P.wrapperLiveness(dir, st)).live) continue;
			const spec = await P.readSpec(dir).catch(() => null);
			// the undelivered async dir: terminal, but its harvest has not been
			// delivered yet (the session's watcher settles the delivery and
			// writes the harvest-delivered marker — gc picks the dir up only
			// once delivered). The `async` spec flag is the upgrade boundary:
			// historical dirs carry no flag, so the plain retention rule applies
			// to them as before
			if (spec?.async === true && (await P.harvestDeliveredId(dir)) === null) {
				skippedUndelivered++;
				continue;
			}
			const finished = st.finished_at !== undefined ? Date.parse(st.finished_at) : spec?.created_at !== undefined ? Date.parse(spec.created_at) : now();
			const age = now() - finished;
			if (age < retentionMs + GC_GRACE_MS) continue;
			if (dryRun) {
				// --dry-run: preview only — the remove dep is never called
				emit(`would remove ${P.taskIdOf(dir)} (${st.state}, ${formatAge(age)} old)`);
				previewed++;
				continue;
			}
			await (deps.remove ?? P.removeTask)(dir);
			emit(`removed ${P.taskIdOf(dir)} (${st.state}, ${formatAge(age)} old)`);
			removed++;
		}
		if (dryRun) {
			if (previewed === 0) emit("gc --dry-run: nothing to remove");
			if (skippedUndelivered > 0) emit(gcSkipNote(skippedUndelivered));
			return { code: 0, lines };
		}
		if (removed === 0) emit("gc: nothing to remove");
		if (skippedUndelivered > 0) emit(gcSkipNote(skippedUndelivered));
		return { code: 0, lines };
	}

	// ---- bench -----------------------------------------------------------------
	if (verb === "bench") {
		if (argv[1] === "live") {
			// the driver is heavy (dispatch + wrapper chain) — load it on demand
			const { runLive } = await import("./bench/live");
			// --json: one line of fixed-shape JSON (the history record); the text
			// report goes to the no-op sink so the JSON line stands alone
			const r = await runLive({ mode: benchMode, runs: benchRuns }, json ? () => {} : (l) => emit(l));
			if (json) emit(JSON.stringify(r.record));
			return { code: r.code, lines };
		}
		const { runHermetic } = await import("./bench/hermetic");
		// --json: one line of fixed-shape JSON (the history record); the text
		// report goes to the no-op sink so the JSON line stands alone
		const r = await runHermetic({ runs: benchRuns }, json ? () => {} : (l) => emit(l));
		if (json) emit(JSON.stringify(r.record));
		return { code: r.code, lines };
	}

	// unreachable (the verb is checked above)
	return fail(`vitrine: unknown verb '${String(verb)}'`, 2);
}

// ---------------------------------------------------------------------------
// entry

// import.meta.main is jiti-incompatible — see src/main-guard.ts.
if (isMainModule(import.meta.url)) {
	runCli(process.argv.slice(2)).then((r) => {
		process.exit(r.code);
	});
}
