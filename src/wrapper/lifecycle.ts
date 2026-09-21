/**
 * lifecycle.ts — the unified wrapper lifecycle: ONE loop for
 * both modes. The modes share the skeleton (queued→running CAS, spawn,
 * signals + recycled-pid-guarded kill, worker_pid merge, terminal guard,
 * stderr drain, session discovery/attach, session facts, marker/kill polls,
 * the watchdog evaluator, the kill/timeout cases, the finally) and diverge
 * at exactly seven named points — each marked inline as
 * `Point 1..7` (mode guard; pre-spawn check order + tty policy; spawn-event
 * shape; worker-exit decision; completed behavior; settle union +
 * partialHarvest sites; focus source). The tile-only extras (titles, ppid
 * backstop, keep-alive phase) live here and in wrapper/tile.ts.
 */
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import * as P from "../protocol";
import { readAgentBody } from "../agents";
import {
	discoverSessionFile,
	lastAssistantText,
	lastMessageKind,
	parseSessionEntries,
	readSessionHeader,
	totalCostUsd,
	type LastEntryKind,
} from "../session";
import {
	buildHeadlessWorkerArgv,
	buildWorkerArgv,
	buildWorkerEnv,
	exitCodeOf,
	spawnWorkerHandle,
	VITRINE_CONTRACT,
	type WorkerExit,
	type WorkerHandle,
} from "./worker";
import { evaluateWatchdogs } from "./watchdogs";
import {
	createTitleKit,
	defaultWriteTitle,
	focusOnWorkerCheck,
	runKeepAlivePhase,
	tileWorkerExit,
	type TitleKit,
} from "./tile";
import { headlessWorkerExit } from "./headless";

export type WrapperOutcome =
	| "completed"
	| "killed"
	| "timeout"
	| "crashed"
	| "failed"
	| "not-queued"
	| "handoff-lost"
	| "spawn-failed";

// ---------------------------------------------------------------------------
// deps

/** The deps shared by both modes (the clock/sleep/kill/proc/spawn surface). */
export interface WorkerDeps {
	/** Clock (default `Date.now`). */
	now?: () => number;
	/** Sleep (default `setTimeout`); tests run fast ticks. */
	sleep?: (ms: number) => Promise<void>;
	/** pi binary (default `pi`; `VITRINE_PI_BIN`). */
	piBin?: string;
	/** Session storage root (default `~/.pi/agent/sessions`; `VITRINE_SESSIONS_DIR`). */
	sessionsRoot: string;
	/** Agent files dir (dev/fixture fallback for specs without `agent.body`). */
	agentsDir: string;
	/** Watchdog tick (default 1000 ms). */
	tickMs?: number;
	/** SIGTERM→SIGKILL grace (default 5000 ms). */
	killGraceMs?: number;
	log?: (line: string) => void;
	/** Worker spawner (default: `spawnWorkerHandle(piBin, …)`). */
	spawnWorker?: (argv: string[], env: Record<string, string>, opts: { cwd: string }) => Promise<WorkerHandle>;
	kill?: (pid: number, sig: NodeJS.Signals) => void;
	procAlive?: (pid: number) => boolean;
	procStartTime?: (pid: number) => string | undefined;
	/** Is our stdout a TTY? Default `process.stdout.isTTY`. Tile: hard guard; headless: logged only. */
	isTty?: () => boolean;
}

/** The tile-mode wrapper deps (the audited tile lifecycle). */
export interface WrapperDeps extends WorkerDeps {
	/** The window-owning foot (the wrapper's parent in production). */
	footPid: number;
	/** Focus + title re-assert period (default 2000 ms). */
	focusPollMs?: number;
	/** /proc/<foot_pid> backstop period (default 2000 ms). */
	ppidPollMs?: number;
	/** Is the tile focused? Errors must count as focused (fail-safe). */
	focusOnWorker?: () => Promise<boolean>;
	/** Title sink (default: OSC 0 on stdout — the tile's pty). */
	writeTitle?: (title: string) => void;
}

/** The headless wrapper deps — the shared surface only. */
export interface HeadlessDeps extends WorkerDeps {}

// ---------------------------------------------------------------------------
// the shared context for the mode-specific exit mappings

/** The settle's target union (both modes; each mode uses its own subset). */
export type SettleTarget = "completed" | "killed" | "timeout" | "crashed" | "failed";

/** The context the mode-specific worker-exit mappings (points 4/5/6) need. */
export interface ExitCtx {
	/** The task dir. */
	d: string;
	log: (line: string) => void;
	appendEvent: (e: Record<string, unknown>) => Promise<void>;
	/** The worker's exit (null while it runs). */
	getExit: () => WorkerExit | null;
	killWorkerGraceful: () => Promise<void>;
	settle: (to: SettleTarget, reason: string, exit: WorkerExit | null) => Promise<void>;
	/** The partial harvest (the session tail into tail.log). */
	partialHarvest: () => Promise<void>;
	/** The attached session file (null when never attached). */
	sessionFile: () => string | null;
	/** The first SIGHUP/SIGTERM intent (null while none). */
	signalIntent: () => string | null;
}

type Mode =
	| {
			kind: "tile";
			footPid: number;
			focusPollMs: number;
			ppidPollMs: number;
			focusOnWorker: () => Promise<boolean>;
			writeTitle: (title: string) => void;
	  }
	| { kind: "headless" };

// ---------------------------------------------------------------------------
// the entries

/**
 * The tile wrapper lifecycle (the audited path). `footPid` is the
 * window-owning foot — in production the wrapper's parent (the compositor's
 * `hl.dsp.exec_cmd` spawns foot, which execs us).
 */
export async function runWrapper(taskDir: string, deps: WrapperDeps): Promise<WrapperOutcome> {
	return runLifecycle(taskDir, deps, {
		kind: "tile",
		footPid: deps.footPid,
		focusPollMs: deps.focusPollMs ?? 2000,
		ppidPollMs: deps.ppidPollMs ?? 2000,
		focusOnWorker: deps.focusOnWorker ?? focusOnWorkerCheck(deps.footPid),
		writeTitle: deps.writeTitle ?? defaultWriteTitle,
	});
}

/**
 * The headless wrapper lifecycle: the wrapper spawns
 * `pi --print` directly — no foot, no tile, no focus, no ppid backstop.
 * Completion is the process exit, mapped by the headless exit rules
 * (wrapper/headless.ts). Deliberately a SEPARATE entry point from
 * `runWrapper`: same skeleton, different mode (the seven points above).
 */
export async function runHeadlessWrapper(taskDir: string, deps: HeadlessDeps): Promise<WrapperOutcome> {
	return runLifecycle(taskDir, deps, { kind: "headless" });
}

// ---------------------------------------------------------------------------
// the unified loop

async function runLifecycle(taskDir: string, deps: WorkerDeps, mode: Mode): Promise<WrapperOutcome> {
	const d = await P.assertTaskDir(taskDir);
	const tickMs = deps.tickMs ?? 1000;
	const killGraceMs = deps.killGraceMs ?? 5000;
	const now = deps.now ?? Date.now;
	const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
	const log = deps.log ?? ((line: string) => process.stderr.write(`vitrine-run(${mode.kind}): ${line}\n`));
	const piBin = deps.piBin ?? "pi";
	const kill =
		deps.kill ??
		((pid: number, sig: NodeJS.Signals) => {
			try {
				process.kill(pid, sig);
			} catch (e: unknown) {
				// ESRCH — already gone; EPERM — a recycled pid now belongs to
				// another user (the start-time gate should have prevented
				// this): both mean "stop", not "crash".
				const code = (e as NodeJS.ErrnoException).code;
				if (code !== "ESRCH" && code !== "EPERM") throw e;
			}
		});
	const procAlive = deps.procAlive ?? ((pid: number) => P.pidInfo(pid).alive);
	const procStartTime = deps.procStartTime ?? ((pid: number) => P.pidInfo(pid).startTime);
	const spawnWorker = deps.spawnWorker ?? ((argv, env, opts) => spawnWorkerHandle(piBin, argv, env, opts));

	const spec = await P.readSpec(d);

	// Point 1 — mode guard: headless refuses a non-headless spec (a dispatch
	// bug or a hand-built dir). Do not touch state — the correct wrapper /
	// the dispatcher's reconcile owns it. The tile mode has NO mode guard.
	if (mode.kind === "headless" && spec.mode !== "headless") {
		await P.appendEvent(d, { event: "mode-mismatch", expected: "headless", actual: spec.mode });
		log(`spec.mode is ${spec.mode}, not headless — exiting without spawning`);
		return "not-queued";
	}
	// Point 2 — pre-spawn checks (the order is pinned): headless logs a TTY
	// (unexpected — the dispatcher spawns us detached — but harmless); tile
	// then hard-guards the pty: tile mode needs the tile's pty. If
	// our stdout is not a TTY the spawn shape is wrong (foot died, or we
	// were spawned without a pty) and the TUI worker would not render —
	// settle spawn-failed immediately rather than spawn a broken worker.
	if (mode.kind === "headless" && (deps.isTty?.() ?? process.stdout.isTTY === true)) {
		log("sanity: headless wrapper on a TTY (unexpected — the dispatcher spawns us detached; harmless, --print works either way)");
	}
	const st0 = await P.readState(d);
	if (st0.state !== "queued") {
		log(`state is ${st0.state}, not queued — exiting without spawning (the dispatcher owns non-queued tasks)`);
		return "not-queued";
	}
	if (mode.kind === "tile") {
		const hasTty = deps.isTty?.() ?? process.stdout.isTTY === true;
		if (!hasTty) {
			await P.appendEvent(d, { event: "spawn-failed", source: "wrapper", reason: "tile mode without a pty (isatty sanity)" });
			await P.transitionState(d, "queued", "crashed", {}, "failed-to-spawn: no pty (tile mode requires the tile's pty)");
			log("tile mode without a pty (stdout is not a TTY) — settling spawn-failed");
			return "spawn-failed";
		}
	}

	// Titles — display decoration only (tile mode).
	const titles: TitleKit | null =
		mode.kind === "tile"
			? createTitleKit(spec.attended, `${spec.agent.name} (${spec.task_id.slice(0, 8)})`, mode.writeTitle)
			: null;

	// 1. queued → running (records wrapper_pid + wrapper_pid_start
	// + foot_pid — point 3; boot_id rides the event). The wrapper's own
	// /proc start time closes the within-boot recycled-wrapper-pid window
	// for reconciliation.
	const wrapperPidStart = P.pidInfo(process.pid).startTime ?? undefined;
	const t = await P.transitionState(
		d,
		"queued",
		"running",
		mode.kind === "tile"
			? { wrapper_pid: process.pid, wrapper_pid_start: wrapperPidStart, foot_pid: mode.footPid }
			: { wrapper_pid: process.pid, wrapper_pid_start: wrapperPidStart },
		"spawn",
	);
	if (!t.ok) {
		log(`queued→running hand-off lost (${t.code}); state is ${t.current} — exiting`);
		return "handoff-lost";
	}
	// Point 3 — the spawn-event shape (tile: the window identity; headless:
	// the mode tag).
	await P.appendEvent(
		d,
		mode.kind === "tile"
			? { event: "spawn", boot_id: spec.boot_id, wrapper_pid: process.pid, foot_pid: mode.footPid }
			: { event: "spawn", mode: "headless", boot_id: spec.boot_id, wrapper_pid: process.pid },
	);
	const wallStart = now();
	titles?.render(); // the "running" title (tile)

	// 4. Session-discovery snapshot — taken BEFORE the spawn: the
	// worker may create its session file within milliseconds of starting.
	// The worker's argv passes `--session-dir <sessionsRoot>` and pi 0.85.1
	// writes the session file FLAT in that root (the cwd-keyed subdir is pi's
	// DEFAULT layout WITHOUT the flag — diffing it never attached: no
	// session.json, inactivity/auto-settle blind, 2026-09-19).
	const sessionDir = deps.sessionsRoot;
	const beforeFiles = new Set(await readdir(sessionDir).catch((e: NodeJS.ErrnoException) => (e.code === "ENOENT" ? [] : Promise.reject(e))));

	// 2. Build the invocation from spec.json and spawn.
	let worker: WorkerHandle;
	try {
		let fromSession: string | null = null;
		if (spec.from_task_id !== undefined) {
			const fromDir = join(P.tasksRoot(), spec.from_task_id);
			const rec = await P.readSession(fromDir);
			fromSession = rec.session_file;
		} else if (spec.from_session_file !== undefined) {
			// `context` task: fork the dispatcher's own live session file —
			// it lives in no task dir, so it is passed as a raw path.
			fromSession = spec.from_session_file;
		}
		// a fork source must still exist at spawn (a context file can be
		// archived between createTask and spawn) — else spawn-failed
		if (fromSession !== null) await stat(fromSession);
		// the spec carries the resolved agent body (the dispatcher
		// resolved it — spec.json is the only parent→worker transport). The
		// agentsDir lookup is the dev/fixture fallback only (specs without a
		// body: hand-built dirs, old tests).
		const agentBody = spec.agent.body !== undefined ? spec.agent.body : await readAgentBody(spec.agent.name, deps.agentsDir);
		const systemPromptPath = await P.writeSystemPrompt(d, `${agentBody.trim()}\n\n${VITRINE_CONTRACT}`);
		const argv =
			mode.kind === "tile"
				? buildWorkerArgv(d, spec, fromSession, systemPromptPath, deps.sessionsRoot)
				: buildHeadlessWorkerArgv(d, spec, fromSession, systemPromptPath, deps.sessionsRoot);
		const env = buildWorkerEnv(d, process.env);
		worker = await spawnWorker(argv, env, { cwd: spec.cwd });
	} catch (e) {
		// State is already `running` with no worker_pid: the wrapper dies and
		// the dispatcher's dead-wrapper reconcile (ordering rule 2) settles it.
		await P.appendEvent(d, { event: "spawn-failed", error: String(e) });
		log(`spawn failed: ${e}`);
		return "spawn-failed";
	}
	// 5. Signals: SIGHUP/SIGTERM ⇒ kill the worker, record killed.
	// Registered BEFORE the worker_pid merge so a signal any time after the
	// hand-off is captured (a signal before the hand-off takes the default
	// action — the task stays `queued` and the dispatcher's reconcile owns it).
	let signalIntent: string | null = null;
	const onSignal = (sig: string): void => {
		if (signalIntent === null) signalIntent = sig;
	};
	process.on("SIGHUP", onSignal);
	process.on("SIGTERM", onSignal);

	const wpid = worker.pid;
	let workerPidStart: string | null = null;
	let unfocusedSince: number | null = null;
	let lastPpidCheck = 0;
	let lastFocusCheck = 0;
	let lastTitleAt = 0;
	const exitBox: { v: WorkerExit | null } = { v: null };
	const getExit = (): WorkerExit | null => exitBox.v;
	worker.onExit.then((r) => {
		exitBox.v = r;
	});

	const killWorkerGraceful = async (): Promise<void> => {
		// Recycled-pid guard: only signal a pid that is (a) still
		// our unreaped child and (b) whose /proc start time matches the one
		// recorded at spawn — when we recorded one.
		const live = (): boolean => {
			if (exitBox.v !== null || !procAlive(wpid)) return false;
			const st = procStartTime(wpid);
			return st === null || workerPidStart === null || st === workerPidStart;
		};
		if (live()) kill(wpid, "SIGTERM");
		const d1 = now() + killGraceMs;
		while (live() && now() < d1) await sleep(50);
		if (live()) {
			kill(wpid, "SIGKILL");
			const d2 = now() + 1000;
			while (live() && now() < d2) await sleep(50);
		}
		const d3 = now() + 1000; // reap window after the kills
		while (exitBox.v === null && now() < d3) await sleep(20);
	};

	// 3. Record worker_pid + worker_pid_start (CAS field merge — still
	// running). The /proc start time is read ONCE: a
	// second read for the kill gate would be a micro-TOCTOU on the very
	// value the guard exists for.
	const wstart = procStartTime(wpid) ?? null;
	const merge = await P.mergeStateFields(d, "running", { worker_pid: wpid, worker_pid_start: wstart ?? undefined }, "worker-spawned");
	if (merge.merged) workerPidStart = wstart;
	if (!merge.merged) {
		// A sibling (another wrapper of the same task) already owns the
		// supervision (the accepted hand-off both-pass window). Kill OUR
		// worker — the wrapper never exits with its own child running in an
		// open tile (zombie-tile guard). This return is before the
		// try/finally, so the listeners registered above are removed here.
		log(`worker_pid merge rejected (${merge.current}) — a sibling owns the task; killing our worker and exiting`);
		process.removeListener("SIGHUP", onSignal);
		process.removeListener("SIGTERM", onSignal);
		const se0 = worker.stderrTake();
		if (se0 !== "") await P.appendTail(d, se0);
		await killWorkerGraceful();
		return "handoff-lost";
	}

	let sessionFile: string | null = null;
	let sessionAttached = false;
	/** Entry count from the last successful session parse (persists across ticks; null until the first good parse). */
	let lastGoodEntryCount: number | null = null;
	// v1.11 keep-alive entry: set when a completed settle happens
	// in THIS wrapper (marker observed or auto-settled) — the main loop then
	// leaves into the keep-alive phase. `kaSnapshot` is the session entry
	// count at keep-alive entry, taken from the last GOOD parse (a transient
	// read failure on the entry tick must not yield 0 — that would scan from
	// the initial prompt and misfire `resumed`). `null` when the
	// session file was never successfully parsed — resume detection is
	// disabled (a missed resume beats a false one).
	let enteredKeepAlive = false;
	let kaSnapshot: number | null = null;

	// Point 6 — one settle over the full target union (each mode calls it
	// from its own pinned sites; `state.json` is monotonic — a rejected
	// transition is logged, never thrown).
	const settle: (to: SettleTarget, reason: string, exit: WorkerExit | null) => Promise<void> = async (to, reason, exit) => {
		const fields: Omit<Partial<P.TaskStateRecord>, "reason" | "state"> = {};
		const code = exitCodeOf(exit);
		if (code !== undefined) fields.exit_code = code;
		const r = await P.transitionState(d, "running", to, fields, reason);
		if (!r.ok) log(`settle ${to} rejected (${r.code}); state is ${r.current}`);
	};

	// Point 6 — the partial harvest: the session tail into
	// tail.log; best effort — it must never block the terminal write.
	const partialHarvest = async (): Promise<void> => {
		if (sessionFile === null) return;
		try {
			const { entries } = await parseSessionEntries(sessionFile);
			const text = lastAssistantText(entries);
			await P.appendTail(d, `\n--- session tail ---\n${text ?? "(no assistant text)"}\n`);
		} catch {
			// best effort — the harvest must never block the terminal write
		}
	};

	const appendEvent = (e: Record<string, unknown>): Promise<void> => P.appendEvent(d, e);
	const exitCtx: ExitCtx = {
		d,
		log,
		appendEvent,
		getExit,
		killWorkerGraceful,
		settle,
		partialHarvest,
		sessionFile: () => sessionFile,
		signalIntent: () => signalIntent,
	};

	try {
		while (true) {
			await sleep(tickMs);
			const t0 = now();

			// Terminal guard: a sibling (the dispatcher's reconcile) may have
			// settled us — never double-write a terminal state.
			const stNow = await P.readState(d).catch(() => null);
			if (stNow !== null && P.isTerminal(stNow.state)) {
				log(`state is ${stNow.state} — a sibling settled the task; exiting`);
				return stNow.state as WrapperOutcome;
			}

			// stderr → tail.log (throttled to the tick).
			const se = worker.stderrTake();
			if (se !== "") await P.appendTail(d, se);

			// Session discovery until attached.
			if (!sessionAttached) {
				const found = await discoverSessionFile(sessionDir, spec.session_name, spec.session_id, beforeFiles);
				if (found !== null) {
					try {
						const hdr = await readSessionHeader(found);
						const wrote = await P.writeSessionOnce(d, { session_id: hdr !== null ? hdr.id : spec.session_id, session_file: found });
						// `wrote` is false only when a concurrent writer landed a
						// different session file and we bailed — then stop trying
						// (that writer owns the record); on any other transient
						// failure keep retrying next tick.
						if (wrote) {
							sessionFile = found;
							sessionAttached = true;
						} else {
							log("session attach bailed (concurrent writer) — not retrying");
						}
					} catch (e) {
						if ((e as P.ProtocolError).code === "session-exists") {
							sessionFile = found;
							sessionAttached = true;
						} else log(`session attach failed: ${e}`); // transient — retry next tick
					}
				}
			}

			// /proc/<foot_pid> backstop — TILE ONLY (point 7:
			// headless has no window; the dispatcher's death must not kill
			// the worker): gone ⇒ window closed.
			if (mode.kind === "tile") {
				if (t0 - lastPpidCheck >= mode.ppidPollMs) {
					lastPpidCheck = t0;
					if (!procAlive(mode.footPid)) {
						log("foot pid gone — treating as window close");
						await appendEvent({ event: "window-closed", foot_pid: mode.footPid });
						await killWorkerGraceful();
						await partialHarvest(); // killed ⇒ partial harvest
						await settle("killed", "window-closed", getExit());
						titles?.set("killed", String(exitCodeOf(getExit()) ?? 0));
						titles?.render();
						return "killed";
					}
				}

				// Focus poll (unattended only; errors ⇒ focused — fail-safe).
				if (!spec.attended && t0 - lastFocusCheck >= mode.focusPollMs) {
					lastFocusCheck = t0;
					const focused = await mode.focusOnWorker();
					if (focused) unfocusedSince = null;
					else unfocusedSince ??= t0;
				}
			}
			const unfocusedMs = unfocusedSince === null ? 0 : t0 - unfocusedSince;

			// Session facts.
			let mtime: number | null = null;
			let lastEntry: LastEntryKind = null;
			let cost = 0;
			if (sessionFile !== null) {
				const st = await stat(sessionFile).catch(() => null);
				mtime = st !== null ? st.mtimeMs : null;
				const parsed = await parseSessionEntries(sessionFile).catch(() => null);
				if (parsed !== null) {
					lastEntry = lastMessageKind(parsed.entries);
					cost = totalCostUsd(parsed.entries);
					// The keep-alive snapshot input (tile only, point 5).
					if (mode.kind === "tile") lastGoodEntryCount = parsed.entries.length;
				}
			}
			const marker = await P.readDoneMarker(d).catch(() => null);
			const killReq = (await P.killRequested(d).catch(() => false)) || signalIntent !== null;

			// Point 7 — headless feeds unfocusedMs 0: auto-settle is
			// structurally OFF (the completion path is the process exit; the
			// fail-safe direction is "never auto-complete"). Wall/inactivity/
			// cost are unchanged.
			const action = evaluateWatchdogs({
				nowMs: t0,
				wallStartMs: wallStart,
				wallTimeoutS: spec.wall_timeout_s,
				sessionMtimeMs: mtime,
				lastEntry,
				totalCostUsd: cost,
				maxCostUsd: spec.max_cost_usd ?? null,
				inactivityS: spec.inactivity_s,
				attended: spec.attended,
				autoSettleS: spec.auto_settle_s,
				autoSettleGraceS: spec.auto_settle_grace_s,
				unfocusedMs: mode.kind === "headless" ? 0 : unfocusedMs,
				markerPresent: marker !== null,
				markerSource: marker !== null ? marker.source : null,
				killRequested: killReq,
			});

			// The auto-settle countdown (the idle title while it runs).
			if (mode.kind === "tile") {
				titles?.setSettleCountdown(
					!spec.attended && lastEntry === "idle-assistant" && mtime !== null && t0 - mtime >= 1000
						? Math.max(0, Math.ceil((spec.auto_settle_s * 1000 - (t0 - mtime)) / 1000))
						: null,
				);
			}

			switch (action.kind) {
				case "completed": {
					await appendEvent({ event: "marker-observed", source: action.source });
					// Point 5 — completed behavior: headless SIGTERMs the
					// (possibly hung) worker and returns; tile
					// enters the keep-alive phase (the worker is NOT killed).
					await settle("completed", action.source, getExit());
					if (mode.kind === "headless") {
						await killWorkerGraceful();
						return "completed";
					}
					titles?.set("completed");
					kaSnapshot = lastGoodEntryCount;
					enteredKeepAlive = true;
					break;
				}
				case "kill": {
					await appendEvent({ event: "kill", source: signalIntent ?? "kill_requested", pid: wpid });
					await killWorkerGraceful();
					await partialHarvest(); // killed ⇒ partial harvest
					await settle("killed", signalIntent !== null ? `signal-${signalIntent}` : "kill_requested", getExit());
					titles?.set("killed", String(exitCodeOf(getExit()) ?? 0));
					titles?.render();
					return "killed";
				}
				case "timeout": {
					await appendEvent({ event: "timeout", reason: action.reason });
					await killWorkerGraceful();
					await partialHarvest();
					await settle("timeout", action.reason, getExit());
					titles?.set("timeout");
					titles?.render();
					return "timeout";
				}
				case "auto-settle": {
					// Headless: unreachable (unfocusedMs 0 — point 7) — kept
					// for the evaluator's contract.
					if (mode.kind === "headless") break;
					// one final focus re-check immediately before the
					// done.marker write — collapses the settle-vs-focus race to
					// a single poll interval.
					const focusedNow = await mode.focusOnWorker();
					if (focusedNow) break; // the user just showed up — skip this round
					const parsedSettle = sessionFile !== null ? await parseSessionEntries(sessionFile).catch(() => null) : null;
					const harvested = parsedSettle !== null ? (lastAssistantText(parsedSettle.entries) ?? "(no assistant text harvested)") : "(no assistant text harvested)";
					// harvest only if absent: a racing vitrine_done's result.md
					// wins (it wrote the result before the marker).
					const rs = await stat(join(d, "result.md")).catch(() => null);
					if (rs === null) await P.writeResult(d, harvested);
					let source = "auto_settle";
					try {
						await P.writeDoneMarker(d, "auto_settle");
						await appendEvent({ event: "auto-settle", source: "auto_settle" });
					} catch (e) {
						// The worker's vitrine_done landed in the settle window —
						// ordering rule 1: its marker wins, so settle `completed`
						// with the worker's note (and SIGTERM the worker — the
						// hang-after-done case). Without this catch the exception
						// would kill the wrapper and leave the worker alive.
						if (!(e instanceof P.ProtocolError && e.code === "marker-exists")) throw e;
						source = "worker";
						await appendEvent({ event: "marker-observed", source: "worker" });
					}
					await settle("completed", source, getExit());
					titles?.set("completed");
					// v1.11 keep-alive: the auto-settle entry point
					// lands in the same phase as the marker case.
					kaSnapshot = lastGoodEntryCount;
					enteredKeepAlive = true;
					break;
				}
				case "wait":
					break;
			}

			// v1.11: a completed settle in THIS wrapper leaves the main loop
			// into the keep-alive phase — the loop's terminal guard and stale
			// wallStart must not run on a completed task.
			if (enteredKeepAlive) {
				titles?.render();
				break;
			}

			// Worker death (the child-exit event, not polling) —
			// point 4: the exit mapping is mode-specific (tile: killed/
			// crashed; headless: the 5-branch pinned mapping).
			if (getExit() !== null && marker === null) {
				const to = mode.kind === "tile" ? await tileWorkerExit(exitCtx) : await headlessWorkerExit(exitCtx);
				if (mode.kind === "tile") {
					titles?.set(to === "killed" ? "killed" : "crashed", to === "killed" ? String(exitCodeOf(getExit()) ?? 0) : undefined);
					titles?.render();
				}
				return to;
			}

			// Title upkeep: re-assert every focusPoll — subsumes the ~2 s
			// post-start re-assert (pi's startup title overwrites the first
			// write) and carries the idle countdown. Tile only.
			if (mode.kind === "tile" && t0 - lastTitleAt >= mode.focusPollMs) {
				lastTitleAt = t0;
				titles?.render();
			}
		}

		// Keep-alive phase (v1.11) — tile only; point 5.
		if (mode.kind === "tile") {
			return await runKeepAlivePhase({
				d,
				spec,
				worker,
				wpid,
				killWorkerGraceful,
				getExit,
				log,
				appendEvent,
				sessionFile: () => sessionFile,
				kaSnapshot,
				focusOnWorker: mode.focusOnWorker,
				procAlive,
				footPid: mode.footPid,
				tickMs,
				focusPollMs: mode.focusPollMs,
				ppidPollMs: mode.ppidPollMs,
				now,
				sleep,
				titles: titles!,
				signalIntent: () => signalIntent,
			});
		}
		// Unreachable at runtime — every terminal path in the loop returns —
		// but TypeScript's control-flow analysis leaves the break-bearing
		// while(true) loop's end nominally reachable, so the function needs a
		// terminating branch (typecheck gate).
		throw new Error("unreachable: runLifecycle's loop returns on every terminal path");
	} finally {
		process.removeListener("SIGHUP", onSignal);
		process.removeListener("SIGTERM", onSignal);
		// Zombie-tile guard: any exit path that finds the worker still alive
		// (the sibling-settle terminal return, the merge-reject return) kills
		// it — the wrapper never leaves its own child running in an open tile.
		if (exitBox.v === null) {
			try {
				await killWorkerGraceful();
			} catch {
				// best effort — the process is exiting anyway
			}
		}
		const se = worker.stderrTake();
		if (se !== "") await P.appendTail(d, se);
	}
}
