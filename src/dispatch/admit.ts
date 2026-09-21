/**
 * admit.ts — slot admission + reconciliation: the liveness-
 * qualified slot count (a slot is held only by a `running` task
 * with a LIVE, start-time-matching wrapper, or a `queued` task with a live
 * wrapper / younger than this call's spawn window; "count all non-terminal"
 * would deadlock the in-call queue) and the
 * per-invocation reconciliation of every non-terminal task.
 */
import * as P from "../protocol";

/** The stuck-queued window (Reconciliation rule 2): a `queued` task
 * older than this with no live wrapper is a dead dispatcher's residue. */
export const STUCK_QUEUED_MS = 15_000;

interface SlotTask {
	dir: string;
	state: P.TaskState;
	wrapperPid?: number;
	wrapperPidStart?: string;
	createdAt?: string;
	bootId?: string;
}

/**
 * The liveness-qualified slot count. Liveness is the
 * shared anti-recycling predicate (`P.livenessIsLive` — pid alive + /proc
 * start-time match when recorded + boot_id match when recorded; a sync
 * predicate so `countSlots` stays pure). A `running` task with a dead
 * (or recycled) wrapper is a rule-2 case — the pre-count reconciliation
 * settles it; until then it holds no slot. A `queued` task holds a slot
 * while its wrapper is live or it is younger than the stuck window.
 */
export function countSlots(tasks: SlotTask[], now: number): number {
	let n = 0;
	for (const t of tasks) {
		const live =
			t.wrapperPid !== undefined && P.livenessIsLive({ pid: t.wrapperPid, pidStart: t.wrapperPidStart, bootId: t.bootId });
		if (t.state === "running") {
			if (live) n++;
		} else if (t.state === "queued") {
			const young = t.createdAt !== undefined && now - Date.parse(t.createdAt) < STUCK_QUEUED_MS;
			if (live || young) n++;
		}
	}
	return n;
}

/** Read the non-terminal tasks across the tasks root (cross-session — the cap is global). `exclude` removes ids from the current call's own queue — the call's unspawned tasks are the queue, not slot holders (counting them would deadlock the in-call queue: a fresh batch of N queued tasks would hold N slots and none would ever spawn). */
export async function nonTerminalTasks(exclude: ReadonlySet<string> = new Set()): Promise<SlotTask[]> {
	const out: SlotTask[] = [];
	for (const dir of await P.listTaskDirs()) {
		const id = P.taskIdOf(dir);
		if (exclude.has(id)) continue;
		const st = await P.readState(dir).catch(() => null);
		if (st === null || P.isTerminal(st.state)) continue;
		const spec = await P.readSpec(dir).catch(() => null);
		out.push({
			dir,
			state: st.state,
			wrapperPid: st.wrapper_pid,
			wrapperPidStart: st.wrapper_pid_start,
			createdAt: spec !== null ? spec.created_at : undefined,
			bootId: spec !== null ? spec.boot_id : undefined,
		});
	}
	return out;
}

/** Reconcile every non-terminal task (run on every invocation).
 * `excludeDirs` — the caller's own unspawned in-call queue: those are actively
 * managed by this call (spawned when a slot frees, settled on abort), so they
 * are never "stuck" — a queued task waiting on a full cap past the 15 s
 * window is a healthy queue, not a dead dispatcher's residue. */
export async function reconcileAll(now: number, excludeDirs: Set<string> = new Set()): Promise<void> {
	const dirs = await P.listTaskDirs();
	for (const dir of dirs) {
		if (excludeDirs.has(dir)) continue;
		const st = await P.readState(dir).catch(() => null);
		if (st === null || P.isTerminal(st.state)) continue;
		if (st.state === "queued") {
			await P.reconcileStuckQueued(dir, { now, minAgeMs: STUCK_QUEUED_MS }).catch(() => null);
		} else if (st.state === "running") {
			await P.reconcileDeadWrapper(dir).catch(() => null);
		}
	}
}
