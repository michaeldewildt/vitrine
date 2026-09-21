/**
 * tile.ts — the tile-mode wrapper specifics: the title kit
 * (display decoration only), the fail-safe focus check (any error ⇒ FOCUSED:
 * a human watching can never be auto-completed), the worker-exit mapping
 * (killed/crashed), and the v1.11 keep-alive phase (the
 * completed tile stays open in its own regime: no watchdogs, no settle).
 */
import { hyprctlRun } from "../hyprctl";
import * as P from "../protocol";
import {
	hasUserEntryBeyond,
	lastMessageKind,
	parseSessionEntries,
	type LastEntryKind,
} from "../session";
import { completedCloseCountdownS, evaluateKeepAlive, keepAliveCloseS } from "./watchdogs";
import type { WorkerExit, WorkerHandle } from "./worker";
import type { ExitCtx, WrapperOutcome } from "./lifecycle";

// ---------------------------------------------------------------------------
// titles — display decoration only

type BaseTitle = "running" | "idle" | "completed" | "continued" | "killed" | "timeout" | "crashed";

/** The per-state title grammar — one row per state. */
const TITLE_GRAMMAR: Record<BaseTitle, (label: string, extra: string | undefined) => string> = {
	running: (label) => `⚡ ${label} — running`,
	idle: (label, extra) => `💤 ${label} — idle (${extra ?? 0}s)`,
	// `extra` is the keep-alive close countdown — the same
	// grammar as the auto-settle idle countdown.
	completed: (label, extra) => (extra !== undefined ? `✅ ${label} — completed (${extra}s)` : `✅ ${label} — completed`),
	continued: (label, extra) =>
		extra !== undefined ? `🔄 ${label} — continued (human) (${extra}s)` : `🔄 ${label} — continued (human)`,
	killed: (label, extra) => `❌ ${label} — killed (exit ${extra ?? "?"})`,
	timeout: (label) => `⏱ ${label} — timeout`,
	crashed: (label) => `❌ ${label} — crashed`,
};

/** The default title sink: OSC 0 on stdout — the tile's pty. */
export const defaultWriteTitle = (t: string): void => {
	try {
		process.stdout.write(`\u001b]0;${t}\u0007`);
	} catch {
		/* best effort */
	}
};

export interface TitleKit {
	/** Transition the base title (`extra` carries the exit code). */
	set(base: BaseTitle, extra?: string): void;
	/** The auto-settle idle countdown (title while it runs). */
	setSettleCountdown(s: number | null): void;
	/** The keep-alive close countdown (title while it runs). */
	setCloseCountdown(s: number | null): void;
	/** The current title. */
	current(): string;
	/** Write the current title (display decoration only). */
	render(): void;
}

export type { BaseTitle };

/**
 * The title state for one tile. Display decoration only — no
 * machine path reads a title (window identity is the foot pid).
 */
export function createTitleKit(attended: boolean, label: string, writeTitle: (title: string) => void = defaultWriteTitle): TitleKit {
	let base: BaseTitle = "running";
	let extra: string | undefined;
	let settleCountdown: number | null = null;
	let closeCountdown: number | null = null;
	const current = (): string => {
		// The countdown titles carry the live seconds. Both are
		// unattended-only (attended tiles never auto-settle or auto-close).
		if (!attended && base === "running" && settleCountdown !== null) {
			return TITLE_GRAMMAR["idle"](label, String(settleCountdown));
		}
		if (!attended && (base === "completed" || base === "continued") && closeCountdown !== null) {
			return TITLE_GRAMMAR[base](label, String(closeCountdown));
		}
		return TITLE_GRAMMAR[base](label, extra);
	};
	return {
		set: (b, e) => {
			base = b;
			extra = e;
		},
		setSettleCountdown: (s) => {
			settleCountdown = s;
		},
		setCloseCountdown: (s) => {
			closeCountdown = s;
		},
		current,
		render: () => {
			writeTitle(current());
		},
	};
}

/**
 * The default focus check: `hyprctl activewindow -j` — the tile
 * is focused iff `.pid === foot_pid`; any error/timeout counts as FOCUSED
 * (fail-safe: a human watching can never be auto-completed). Note the
 * asymmetry with the dispatcher's juggle reads (any error ⇒ degrade): the
 * two fail in opposite directions on purpose.
 */
export function focusOnWorkerCheck(footPid: number): () => Promise<boolean> {
	return async () => {
		try {
			const r = await hyprctlRun(3000)(["activewindow", "-j"]);
			if (r.code !== 0) return true;
			const j = JSON.parse(r.stdout) as { pid?: number };
			return j.pid === footPid;
		} catch {
			return true;
		}
	};
}

// ---------------------------------------------------------------------------
// worker exit (the child-exit event, not polling)

/**
 * The tile-mode worker-exit mapping: kill intent (signal / kill_requested)
 * or a clean exit 0 ⇒ `killed`; anything else ⇒ `crashed`. The headless
 * mapping is the 5-branch pinned version (wrapper/headless.ts).
 */
export async function tileWorkerExit(c: ExitCtx): Promise<WrapperOutcome> {
	const exit = c.getExit()!;
	const wasKilled = (await P.killRequested(c.d).catch(() => false)) || c.signalIntent() !== null;
	const to: "killed" | "crashed" = wasKilled || exit.code === 0 ? "killed" : "crashed";
	const reason = wasKilled
		? c.signalIntent() !== null
			? `signal-${c.signalIntent()}`
			: "kill_requested"
		: to === "killed"
		  ? "clean-exit"
		  : exit.signal !== null
		    ? `signal-${exit.signal}`
		    : `exit-${exit.code ?? "unknown"}`;
	await c.appendEvent({ event: "worker-exit", code: exit.code, signal: exit.signal, error: exit.error });
	await c.partialHarvest();
	await c.settle(to, reason, exit);
	return to;
}

// ---------------------------------------------------------------------------
// keep-alive phase (v1.11)

export interface KeepAliveArgs {
	/** The task dir. */
	d: string;
	spec: P.TaskSpec;
	worker: WorkerHandle;
	/** The worker's pid (the `kill` event's `pid` field). */
	wpid: number;
	/** Kill the worker (SIGTERM → SIGKILL grace, recycled-pid guarded). */
	killWorkerGraceful: () => Promise<void>;
	/** The worker's exit (null while it runs). */
	getExit: () => WorkerExit | null;
	log: (line: string) => void;
	appendEvent: (e: Record<string, unknown>) => Promise<void>;
	/** The attached session file (null when never attached). */
	sessionFile: () => string | null;
	/** The session entry count at keep-alive entry (last GOOD parse; null = resume detection disabled). */
	kaSnapshot: number | null;
	focusOnWorker: () => Promise<boolean>;
	procAlive: (pid: number) => boolean;
	/** The window-owning foot (the wrapper's parent in production). */
	footPid: number;
	tickMs: number;
	focusPollMs: number;
	ppidPollMs: number;
	now: () => number;
	sleep: (ms: number) => Promise<void>;
	titles: TitleKit;
	signalIntent: () => string | null;
}

/**
 * The keep-alive phase (v1.11): the completed tile stays open so
 * the human can read the transcript while the dispatcher is back in control.
 * Deliberately NOT the watchdog regime (a stale wallStart would SIGTERM the
 * resident worker on the first tick) and no settle (state is already
 * terminal — an attempt would only log transition-rejected noise). Exits, in
 * precedence: the worker self-exited ⇒ close the tile with it; a close
 * intent (SIGHUP/SIGTERM, or the /proc/<foot_pid> backstop) ⇒ kill the
 * worker, no settle; the unfocused-idle countdown ⇒ close.
 * `kill_requested` cannot appear here: `vitrine kill` refuses terminal
 * states before writing it.
 */
export async function runKeepAlivePhase(a: KeepAliveArgs): Promise<WrapperOutcome> {
	const closeS = keepAliveCloseS(a.spec);
	a.titles.setSettleCountdown(null);
	let kaUnfocusedSince: number | null = null;
	let resumedFired = false;
	let lastKaFocus = 0;
	let lastKaPpid = 0;
	let lastKaTitle = 0;
	while (true) {
		await a.sleep(a.tickMs);
		const t0 = a.now();

		// stderr → tail.log (throttled to the tick).
		const se = a.worker.stderrTake();
		if (se !== "") await P.appendTail(a.d, se);

		// Window-closed backstop, as in the main loop.
		let footAlive = true;
		if (t0 - lastKaPpid >= a.ppidPollMs) {
			lastKaPpid = t0;
			footAlive = a.procAlive(a.footPid);
		}

		// Focus poll (unattended only; errors ⇒ focused — fail-safe).
		// Resume detection below is NOT focus-gated: attended completed
		// tiles must resume-detect even though they never close.
		if (!a.spec.attended && t0 - lastKaFocus >= a.focusPollMs) {
			lastKaFocus = t0;
			const focused = await a.focusOnWorker();
			if (focused) kaUnfocusedSince = null;
			else kaUnfocusedSince ??= t0;
		}

		// Session facts + resume detection (snapshot-based).
		let lastEntry: LastEntryKind = null;
		const sFile = a.sessionFile();
		if (sFile !== null) {
			const parsed = await parseSessionEntries(sFile).catch(() => null);
			// A read failure is never "idle": a turn we cannot classify
			// must not be closed by the countdown.
			if (parsed === null) lastEntry = "other";
			if (parsed !== null) {
				lastEntry = lastMessageKind(parsed.entries);
				// A user entry beyond the keep-alive snapshot ⇒ the human
				// typed into the completed tile. One event per task, ever:
				// latch + idempotency check (the check also covers a future
				// `vitrine attach` re-opening the session in a fresh
				// wrapper).
				if (!resumedFired && a.kaSnapshot !== null && hasUserEntryBeyond(parsed.entries, a.kaSnapshot)) {
					resumedFired = true;
					a.titles.set("continued");
					const existing = await P.readEvents(a.d).catch(() => null);
					if (existing === null || !existing.some((e) => e.event === "resumed")) {
						await a.appendEvent({ event: "resumed", source: "human" });
						a.log("resumed by the human after completion — recorded (state stays completed)");
					}
					a.titles.render();
				}
			}
		}
		a.titles.setCloseCountdown(
			completedCloseCountdownS({
				attended: a.spec.attended,
				completedCloseS: closeS,
				unfocusedSinceMs: kaUnfocusedSince,
				nowMs: t0,
				lastEntry,
			}),
		);

		const action = evaluateKeepAlive({
			nowMs: t0,
			workerExited: a.getExit() !== null,
			closeIntent: a.signalIntent() !== null || !footAlive,
			attended: a.spec.attended,
			completedCloseS: closeS,
			unfocusedSinceMs: kaUnfocusedSince,
			lastEntry,
		});

		switch (action.kind) {
			case "close-worker-exit": {
				const exit = a.getExit()!;
				await a.appendEvent({
					event: "worker-exit-after-completion",
					code: exit.code,
					signal: exit.signal,
					error: exit.error,
				});
				a.log(`worker exited after completion (code ${exit.code ?? "?"}, signal ${exit.signal ?? "?"}) — closing the tile`);
				return "completed";
			}
			case "close-intent": {
				// No settle: state is already `completed` (a transition
				// attempt would only log rejected noise).
				if (a.signalIntent() !== null) {
					await a.appendEvent({ event: "kill", source: `signal-${a.signalIntent()}`, pid: a.wpid });
					a.log(`signal-${a.signalIntent()} during keep-alive — closing the completed tile`);
				} else {
					a.log("foot pid gone during keep-alive — treating as window close");
					await a.appendEvent({ event: "window-closed", foot_pid: a.footPid });
				}
				await a.killWorkerGraceful();
				return "completed";
			}
			case "close-countdown": {
				// One final focus re-check immediately before the close
				// (collapses the close-vs-read race to a single poll
				// interval, as auto-settle does).
				const focusedNow = await a.focusOnWorker();
				if (focusedNow) {
					kaUnfocusedSince = null; // the user just showed up
					a.titles.setCloseCountdown(null);
				} else {
					a.log(`completed tile unfocused and idle for ${closeS}s — closing`);
					await a.appendEvent({ event: "completed-close", source: "unfocused-idle" });
					await a.killWorkerGraceful();
					return "completed";
				}
				break;
			}
			case "wait":
				break;
		}

		// Title upkeep (every focusPoll, so the close countdown shows live).
		if (t0 - lastKaTitle >= a.focusPollMs) {
			lastKaTitle = t0;
			a.titles.render();
		}
	}
}
