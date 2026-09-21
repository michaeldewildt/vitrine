/**
 * state.ts — `state.json`: the monotonic, CAS-checked, marker-aware state
 * machine.
 *
 * - Monotonic: terminal states are never rewritten; only `LEGAL_TRANSITIONS`
 *   (plus the marker-wins `completed`) may occur.
 * - Ordering rule 1 (marker wins): a terminal transition attempted while
 *   `done.marker` exists records `completed` instead, from `queued` or
 *   `running` — checked before the CAS read AND re-checked at the CAS (the
 *   marker can land between).
 * - Hand-off CAS (ordering rule 3): after the decision checks the record is
 *   written to a tmp file and the live `state.json` is re-read *immediately
 *   before the rename* — if the state moved off the decision state, the tmp
 *   is unlinked and the write bails (logged to `events.jsonl`). The
 *   `queued→running` race becomes visible, not silent; the residual window
 *   (both readers see `queued`, both renames land) is accepted by the spec —
 *   monotonicity + marker-wins make either outcome safe.
 */
import { open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ProtocolError } from "./errors";
import { appendEvent, assertTaskDir, fsyncDir, readTaskFile, uniqueTmpName } from "./fs";
import { readDoneMarker, type DoneMarker } from "./files";

// ---------------------------------------------------------------------------
// States (state diagram)

export const TASK_STATES = ["queued", "running", "completed", "failed", "killed", "timeout", "crashed"] as const;
export type TaskState = (typeof TASK_STATES)[number];

export const TERMINAL_STATES: readonly TaskState[] = ["completed", "failed", "killed", "timeout", "crashed"];

/**
 * The legal transitions, exactly the state diagram. `completed` is
 * reachable from `queued` *only* via marker-wins (ordering rule 1) — the
 * diagram has no `queued→completed` edge, and `transitionState` enforces that.
 */
export const LEGAL_TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
	queued: ["running", "crashed"],
	running: ["completed", "failed", "killed", "timeout", "crashed"],
	completed: [],
	failed: [],
	killed: [],
	timeout: [],
	crashed: [],
};

export function isTerminal(s: TaskState): boolean {
	return TERMINAL_STATES.includes(s);
}

export function isLegalTransition(from: TaskState, to: TaskState): boolean {
	return LEGAL_TRANSITIONS[from].includes(to);
}

export interface TaskStateRecord {
	state: TaskState;
	wrapper_pid?: number;
	/** /proc start time of the wrapper, recorded at the queued→running merge — the recycled-wrapper-pid guard for reconciliation (boot_id alone does not catch within-boot recycling). */
	wrapper_pid_start?: string;
	foot_pid?: number;
	worker_pid?: number;
	worker_pid_start?: string;
	exit_code?: number;
	started_at?: string;
	finished_at?: string;
	reason?: string;
}

/** Read + validate the live record (throws `no-state` / `bad-state`) — through the shared `readTaskFile` (the one ENOENT→no-state shape). */
async function readLiveState(d: string): Promise<TaskStateRecord> {
	const rec = (await readTaskFile(d, "state.json", "no-state")) as TaskStateRecord;
	if (!TASK_STATES.includes(rec.state)) throw new ProtocolError("bad-state", `state.json holds an unknown state: ${String(rec.state)}`);
	return rec;
}

export async function readState(dir: string): Promise<TaskStateRecord> {
	const d = await assertTaskDir(dir);
	return readLiveState(d);
}

// ---------------------------------------------------------------------------
// The CAS write (ordering rule 3)

/**
 * The shared CAS core of `transitionState` and `mergeStateFields`: write the
 * record to a tmp file, then — immediately before the rename — re-read the
 * live `state.json`: if the state moved off the decision state, the tmp is
 * unlinked and the bail is returned (the caller logs it). When
 * `rebuildIfMarker` is set (terminal non-`completed` intents only), the
 * marker is re-checked at the same point (ordering rule 1): if it just
 * arrived, the record is rebuilt via the callback and rewritten.
 */
async function casWriteState(
	statePath: string,
	taskDir: string,
	decideState: TaskState,
	initialContent: string,
	rebuildIfMarker?: (markerNow: DoneMarker) => string,
): Promise<{ wrote: true; remapped: boolean } | { wrote: false; current: TaskState }> {
	const tmp = uniqueTmpName(statePath);
	const writeTmp = async (content: string): Promise<void> => {
		const fh = await open(tmp, "w", 0o600);
		try {
			await fh.writeFile(content);
			await fh.sync();
		} finally {
			await fh.close();
		}
	};
	try {
		await writeTmp(initialContent);
		const fresh = JSON.parse(await readFile(statePath, "utf8")) as TaskStateRecord;
		if (fresh.state !== decideState) {
			await unlink(tmp).catch(() => {});
			return { wrote: false, current: fresh.state };
		}
		let remapped = false;
		if (rebuildIfMarker) {
			const markerNow = await readDoneMarker(taskDir);
			if (markerNow !== null) {
				await writeTmp(rebuildIfMarker(markerNow));
				remapped = true;
			}
		}
		await rename(tmp, statePath);
		await fsyncDir(dirname(statePath));
		return { wrote: true, remapped };
	} catch (e: unknown) {
		await unlink(tmp).catch(() => {});
		throw e;
	}
}

// ---------------------------------------------------------------------------
// transitionState

export interface TransitionOk {
	ok: true;
	from: TaskState;
	/** The state actually recorded — `completed` when marker-wins remapped the request. */
	to: TaskState;
	/** Present when marker-wins remapped the requested state. */
	requested?: TaskState;
	reason?: string;
}
export type TransitionResult =
	| TransitionOk
	| { ok: false; code: "terminal-state" | "state-moved" | "illegal-transition"; current: TaskState; requested: TaskState };

/**
 * Atomically move the task's state, enforcing every mechanical rule:
 * the hand-off CAS (ordering rule 3), marker-wins (ordering rule 1),
 * monotonicity, and the LEGAL_TRANSITIONS diagram. `fields` merge over the
 * current record (pids, exit code, …). `started_at` is stamped on the way
 * into `running` if absent; `finished_at` on any terminal write if absent.
 */
export async function transitionState(
	dir: string,
	expected: TaskState,
	requested: TaskState,
	fields: Omit<Partial<TaskStateRecord>, "reason"> = {},
	reason?: string,
): Promise<TransitionResult> {
	const d = await assertTaskDir(dir);
	const statePath = join(d, "state.json");
	// Ordering rule 1: the marker check happens before the CAS read so a
	// marker present at attempt time wins over the requested terminal state.
	const marker = isTerminal(requested) ? await readDoneMarker(d) : null;
	const markerWon = marker !== null && requested !== "completed";
	const next: TaskState = markerWon ? "completed" : requested;

	const prev = await readLiveState(d);
	const current: TaskState = prev.state;

	if (isTerminal(current)) {
		await appendEvent(d, { event: "transition-rejected", code: "terminal-state", current, requested });
		return { ok: false, code: "terminal-state", current, requested };
	}
	if (current !== expected) {
		await appendEvent(d, { event: "transition-rejected", code: "state-moved", current, expected, requested });
		return { ok: false, code: "state-moved", current, requested };
	}
	// Legality: marker-wins maps to `completed`, which is legal from both
	// non-terminal states; otherwise the diagram (LEGAL_TRANSITIONS) rules.
	const legal = markerWon ? true : isLegalTransition(current, requested);
	if (!legal) {
		await appendEvent(d, { event: "transition-rejected", code: "illegal-transition", current, requested, marker_won: markerWon });
		return { ok: false, code: "illegal-transition", current, requested };
	}

	const build = (m: DoneMarker | null, mWon: boolean, at: string): TaskStateRecord => {
		const to: TaskState = mWon ? "completed" : requested;
		const rec: TaskStateRecord = { ...prev, ...fields, state: to };
		if (to === "running" && rec.started_at === undefined) rec.started_at = at;
		if (isTerminal(to) && rec.finished_at === undefined) rec.finished_at = at;
		rec.reason = mWon ? `marker-wins (source=${m!.source})` : (reason ?? prev.reason);
		return rec;
	};
	// Ordering rule 3: the CAS re-read happens immediately before the rename,
	// inside the write path (casWriteState); the marker is re-checked there too.
	let finalReason = markerWon ? `marker-wins (source=${marker!.source})` : (reason ?? prev.reason);
	const res = await casWriteState(
		statePath,
		d,
		current,
		`${JSON.stringify(build(marker, markerWon, new Date().toISOString()), null, 2)}\n`,
		isTerminal(requested) && next !== "completed"
			? (m) => {
					finalReason = `marker-wins (source=${m.source})`;
					return `${JSON.stringify(build(m, true, new Date().toISOString()), null, 2)}\n`;
				}
			: undefined,
	);
	if (res.wrote === false) {
		const code: "terminal-state" | "state-moved" = isTerminal(res.current) ? "terminal-state" : "state-moved";
		await appendEvent(d, { event: "transition-rejected", code, current: res.current, expected: current, requested });
		return { ok: false, code, current: res.current, requested };
	}
	const to: TaskState = res.remapped ? "completed" : next;
	// Marker-wins may have occurred at the decision (markerWon) or at the CAS
	// (remapped) — the event and the result must say so in either case.
	const markerWonTotal = markerWon || res.remapped;
	await appendEvent(d, {
		event: "transition",
		from: current,
		to,
		...(markerWonTotal ? { requested, reason: finalReason } : {}),
		...(reason !== undefined && !markerWonTotal ? { reason } : {}),
	});
	return { ok: true, from: current, to, ...(markerWonTotal ? { requested } : {}), ...(finalReason !== undefined ? { reason: finalReason } : {}) };
}

/**
 * CAS-checked field merge WITHOUT a state change (wrapper regime):
 * the wrapper records `worker_pid` + `worker_pid_start` after spawning pi,
 * while the state is still `running`. Shares the CAS mechanics of
 * `transitionState` (ordering rule 3: re-read immediately before the rename;
 * bail if the state moved off `expected`). No marker check applies: a field
 * merge never changes the state, so ordering rule 1 is not at stake.
 *
 * `fields` may not set `state` or `reason`. The merge is logged as a
 * `state-fields` event; a bail is logged as `merge-rejected`.
 */
export async function mergeStateFields(
	dir: string,
	expected: TaskState,
	fields: Omit<Partial<TaskStateRecord>, "state" | "reason">,
	note: string,
): Promise<{ merged: true; state: TaskState } | { merged: false; current: TaskState }> {
	const d = await assertTaskDir(dir);
	const statePath = join(d, "state.json");
	const prev = await readLiveState(d);
	if (isTerminal(prev.state) || prev.state !== expected) {
		const code: "terminal-state" | "state-moved" = isTerminal(prev.state) ? "terminal-state" : "state-moved";
		await appendEvent(d, { event: "merge-rejected", code, current: prev.state, expected, note });
		return { merged: false, current: prev.state };
	}
	const next: TaskStateRecord = { ...prev, ...fields };
	const res = await casWriteState(statePath, d, expected, `${JSON.stringify(next, null, 2)}\n`);
	if (res.wrote === false) {
		const code: "terminal-state" | "state-moved" = isTerminal(res.current) ? "terminal-state" : "state-moved";
		await appendEvent(d, { event: "merge-rejected", code, current: res.current, expected, note });
		return { merged: false, current: res.current };
	}
	await appendEvent(d, { event: "state-fields", note, fields });
	return { merged: true, state: expected };
}
