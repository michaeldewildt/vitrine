/**
 * env.ts — POSIX environment facts + the anti-recycling liveness predicate.
 *
 * A pid number can be recycled WITHIN a boot (hence the /proc start-time
 * match) and ACROSS boots (hence the boot_id match — after a reboot a small
 * pid number like the wrapper's may well be a live unrelated process). The
 * pure `livenessIsLive` is the single decision, fed by whichever caller has
 * the fields (the dispatch slot count reads them from its scan; the
 * dir-based `wrapperLiveness` re-reads the spec for the boot id).
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { ProtocolError } from "./errors";
import { readSpec } from "./spec";
import type { TaskStateRecord } from "./state";

/** The current boot id — `/proc/sys/kernel/random/boot_id`. */
export function currentBootId(): string {
	try {
		return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
	} catch {
		throw new ProtocolError("no-boot-id", "cannot read /proc/sys/kernel/random/boot_id");
	}
}

/**
 * Liveness + /proc start time for a pid. `startTime` is field 22 of
 * `/proc/<pid>/stat` (the last-`)`-anchored parse survives a comm with
 * spaces/parens). A zombie is not alive — a Z-state wrapper would otherwise
 * read alive and starve its slot.
 */
export function pidInfo(pid: number): { alive: boolean; startTime?: string } {
	try {
		const statRaw = readFileSync(`/proc/${pid}/stat`, "utf8");
		const lp = statRaw.lastIndexOf(")");
		const fields = statRaw.slice(lp + 2).split(" ");
		if (fields[0] === "Z" || fields[0] === "X") return { alive: false };
		return { alive: true, startTime: fields[19] };
	} catch {
		return { alive: false };
	}
}

/**
 * The pure anti-recycling liveness predicate: alive, recorded
 * start time matches when recorded (a missing recorded start time means the
 * guard is absent, not failed), and the recorded boot id matches the current
 * boot when recorded.
 */
export function livenessIsLive(opts: { pid: number; pidStart?: string; bootId?: string }): boolean {
	const info = pidInfo(opts.pid);
	if (!info.alive) return false;
	if (opts.pidStart !== undefined && info.startTime !== undefined && info.startTime !== opts.pidStart) return false;
	if (opts.bootId !== undefined && opts.bootId !== currentBootId()) return false;
	return true;
}

/**
 * Dir-based wrapper liveness (Reconciliation): the pure predicate
 * with the boot id re-read from the task's spec (a missing/corrupt spec
 * degrades to the pid checks — the spec is written before any pid is).
 */
export async function wrapperLiveness(dir: string, st: TaskStateRecord): Promise<{ live: boolean; reason: string }> {
	if (st.wrapper_pid === undefined) return { live: false, reason: "no wrapper pid recorded" };
	const spec = await readSpec(dir).catch(() => null);
	if (spec !== null && spec.boot_id !== currentBootId()) return { live: false, reason: "boot_id mismatch — the task is from a previous boot" };
	const info = pidInfo(st.wrapper_pid);
	if (!info.alive) return { live: false, reason: "wrapper pid is dead" };
	if (st.wrapper_pid_start !== undefined && info.startTime !== undefined && info.startTime !== st.wrapper_pid_start) {
		return { live: false, reason: "wrapper start-time mismatch — recycled pid" };
	}
	return { live: true, reason: "wrapper pid is alive" };
}

/** A fresh task id (uuidv4, lowercase — dispatch-string-safe). */
export function newTaskId(): string {
	return randomUUID();
}
