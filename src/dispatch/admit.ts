/**
 * admit.ts — slot admission + reconciliation: the liveness-
 * qualified slot count (a slot is held only by a `running` task
 * with a LIVE, start-time-matching wrapper, or a `queued` task with a live
 * wrapper or a FRESH owner lease — the lease is the key: a queue waiting on a
 * full cap is live as long as its owner ticks it, whatever its creation age;
 * "count all non-terminal" would deadlock the in-call queue) and the
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
	bootId?: string;
	/** `lease.json` `updated_at` (ISO) — `null` when there is no lease (or it failed to read). */
	leaseUpdatedAt?: string | null;
}

/**
 * The liveness-qualified slot count. Liveness is the
 * shared anti-recycling predicate (`P.livenessIsLive` — pid alive + /proc
 * start-time match when recorded + boot_id match when recorded; a sync
 * predicate so `countSlots` stays pure). A `running` task with a dead
 * (or recycled) wrapper is a rule-2 case — the pre-count reconciliation
 * settles it; until then it holds no slot. A `queued` task holds a slot
 * while its wrapper is live or its owner lease is fresh (the lease is the
 * key — the owner that created it, or the watcher that owns its queue from
 * it, refreshes it every tick, so a minutes-long queue stays accounted
 * while it is live; a lease that has gone stale is a dead owner's residue
 * and holds nothing — the reconciliation settles it before the next count
 * anyway).
 */
export function countSlots(tasks: SlotTask[], now: number): number {
	let n = 0;
	for (const t of tasks) {
		const live =
			t.wrapperPid !== undefined && P.livenessIsLive({ pid: t.wrapperPid, pidStart: t.wrapperPidStart, bootId: t.bootId });
		if (t.state === "running") {
			if (live) n++;
		} else if (t.state === "queued") {
			const leaseFresh = t.leaseUpdatedAt !== null && t.leaseUpdatedAt !== undefined
				&& Number.isFinite(now - Date.parse(t.leaseUpdatedAt))
				&& now - Date.parse(t.leaseUpdatedAt) < P.LEASE_TTL_MS;
			if (live || leaseFresh) n++;
		}
	}
	return n;
}

/** Read the non-terminal tasks across the tasks root (cross-session — the cap is global). `exclude` removes ids from the current owner's own unspawned queue — the queue is what the owner is about to spawn, not slot holders (counting it would deadlock the owner's own queue: a fresh batch of N queued tasks would hold N slots and none would ever spawn). */
export async function nonTerminalTasks(exclude: ReadonlySet<string> = new Set()): Promise<SlotTask[]> {
	const out: SlotTask[] = [];
	for (const dir of await P.listTaskDirs()) {
		const id = P.taskIdOf(dir);
		if (exclude.has(id)) continue;
		const st = await P.readState(dir).catch(() => null);
		if (st === null || P.isTerminal(st.state)) continue;
		const spec = await P.readSpec(dir).catch(() => null);
		const lease = await P.readLease(dir).catch(() => null);
		out.push({
			dir,
			state: st.state,
			wrapperPid: st.wrapper_pid,
			wrapperPidStart: st.wrapper_pid_start,
			bootId: spec !== null ? spec.boot_id : undefined,
			leaseUpdatedAt: lease !== null ? lease.updated_at : null,
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
