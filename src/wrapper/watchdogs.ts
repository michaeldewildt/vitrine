/**
 * watchdogs.ts — the watchdog + keep-alive decision cores
 * — pure functions of their facts, shared by both wrapper lifecycles. Every
 * expiry they authorise is logged to events.jsonl by the caller.
 */
import type { LastEntryKind } from "../session";
import type { DoneMarker, TaskSpec } from "../protocol";

export interface WatchdogFacts {
	nowMs: number;
	wallStartMs: number;
	wallTimeoutS: number;
	/** Session-file mtime (quietness = no file growth). `null` = file not discovered yet. */
	sessionMtimeMs: number | null;
	/** Kind of the last session message entry (see lastMessageKind). */
	lastEntry: LastEntryKind;
	totalCostUsd: number;
	maxCostUsd: number | null;
	inactivityS: number;
	attended: boolean;
	autoSettleS: number;
	autoSettleGraceS: number;
	/** How long the tile has been continuously unfocused (0 while focused/unknown). */
	unfocusedMs: number;
	markerPresent: boolean;
	markerSource: DoneMarker["source"] | null;
	killRequested: boolean;
}

export type WatchdogAction =
	| { kind: "completed"; source: DoneMarker["source"] }
	| { kind: "kill" }
	| { kind: "timeout"; reason: "wall" | "inactivity" | "cost" }
	| { kind: "auto-settle" }
	| { kind: "wait" };

/**
 * The watchdog decision for one tick. Precedence (rule 1 first):
 * marker ⇒ completed; kill intent ⇒ kill; then wall, inactivity (×3 while the
 * last entry is a pending tool call), cost; then auto-settle (unattended,
 * idle — last entry an assistant with no pending tool calls — quiet for
 * `auto_settle_s`, and the tile unfocused for `auto_settle_grace_s`).
 * The final focus re-check happens in the caller, immediately before the
 * auto-settle `done.marker` write.
 */
export function evaluateWatchdogs(f: WatchdogFacts): WatchdogAction {
	if (f.markerPresent) return { kind: "completed", source: f.markerSource ?? "vitrine_done" };
	if (f.killRequested) return { kind: "kill" };
	if (f.nowMs - f.wallStartMs >= f.wallTimeoutS * 1000) return { kind: "timeout", reason: "wall" };
	if (f.sessionMtimeMs !== null) {
		const factor = f.lastEntry === "pending-tool" ? 3 : 1;
		if (f.nowMs - f.sessionMtimeMs >= f.inactivityS * 1000 * factor) return { kind: "timeout", reason: "inactivity" };
	}
	if (f.maxCostUsd !== null && f.totalCostUsd >= f.maxCostUsd) return { kind: "timeout", reason: "cost" };
	if (
		!f.attended &&
		f.lastEntry === "idle-assistant" &&
		f.sessionMtimeMs !== null &&
		f.nowMs - f.sessionMtimeMs >= f.autoSettleS * 1000 &&
		f.unfocusedMs >= f.autoSettleGraceS * 1000
	) {
		return { kind: "auto-settle" };
	}
	return { kind: "wait" };
}

/**
 * v1.11: the keep-alive regime — the completed tile stays open
 * (worker resident) and closes on its own terms. Deliberately NOT
 * `evaluateWatchdogs`: a stale `wallStart` would SIGTERM the resident worker
 * on the first tick, and a completed task has nothing left to settle.
 */
export interface KeepAliveFacts {
	nowMs: number;
	/** The worker has exited after completion (TUI premise failed, or it died). */
	workerExited: boolean;
	/** A close intent: a SIGHUP/SIGTERM signal, or the foot pid gone. */
	closeIntent: boolean;
	attended: boolean;
	/** How long the completed tile may stay open before closing (0 = never). */
	completedCloseS: number;
	/** Start of the current unfocused window (null while focused/unknown). */
	unfocusedSinceMs: number | null;
	/** Kind of the last session message entry (null = no session / no messages). */
	lastEntry: LastEntryKind | null;
}

export type KeepAliveAction =
	| { kind: "close-worker-exit" }
	| { kind: "close-intent" }
	| { kind: "close-countdown" }
	| { kind: "wait" };

/**
 * The keep-alive decision for one tick. Precedence: worker exit (close the
 * tile with it) > close intent (the human closed the tile — kill the worker,
 * no settle) > the unfocused-idle countdown (unattended, `completedCloseS`
 * > 0, unfocused for the full window, and the worker idle — a busy resumed
 * turn with a pending tool call is never killed by the countdown). The final
 * focus re-check happens in the caller, immediately before the close (as
 * auto-settle's pre-marker re-check collapses the settle-vs-focus race).
 */
export function evaluateKeepAlive(f: KeepAliveFacts): KeepAliveAction {
	if (f.workerExited) return { kind: "close-worker-exit" };
	if (f.closeIntent) return { kind: "close-intent" };
	if (
		!f.attended &&
		f.completedCloseS > 0 &&
		f.unfocusedSinceMs !== null &&
		f.nowMs - f.unfocusedSinceMs >= f.completedCloseS * 1000 &&
		(f.lastEntry === "idle-assistant" || f.lastEntry === null)
	) {
		return { kind: "close-countdown" };
	}
	return { kind: "wait" };
}

/**
 * The keep-alive close countdown for the tile title: seconds until
 * the unfocused-idle close, or null (focused, attended, `completedCloseS` =
 * 0, or a busy last entry — a resumed turn in flight). Same grammar as the
 * auto-settle idle countdown.
 */
export function completedCloseCountdownS(f: {
	attended: boolean;
	completedCloseS: number;
	unfocusedSinceMs: number | null;
	nowMs: number;
	lastEntry: LastEntryKind | null;
}): number | null {
	if (f.attended || f.completedCloseS <= 0 || f.unfocusedSinceMs === null) return null;
	if (f.lastEntry !== "idle-assistant" && f.lastEntry !== null) return null;
	return Math.max(0, Math.ceil((f.completedCloseS * 1000 - (f.nowMs - f.unfocusedSinceMs)) / 1000));
}

/** The effective keep-alive close window: `completed_close_s` from the spec,
 *  falling back to 600 when the field is absent (specs written by a
 *  dispatcher that predates the field). `0` = never auto-close. */
export function keepAliveCloseS(spec: { completed_close_s?: number | undefined }): number {
	return spec.completed_close_s ?? 600;
}
