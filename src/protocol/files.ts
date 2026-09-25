/**
 * files.ts — the wrapper-owned and worker-owned task-dir files (the
 * single-writer rule): `session.json` (written exactly once, after spawn),
 * `system-prompt.md` (the worker's `--append-system-prompt` payload, by path
 * — never inline, so the contract stays out of `ps` argv), `result.md` +
 * `done.marker` (`vitrine_done` / auto-settle / headless-exit; the marker is
 * written once and never rewritten — its presence is what ordering rule 1
 * turns into `completed`), `kill_requested` (presence-only).
 *
 * "Written once" is stat-then-write: mechanical best-effort; the single
 * writer regime owns the guarantee.
 */
import { readFile, stat, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ProtocolError } from "./errors";
import { appendEvent, assertTaskDir, atomicAppend, atomicWriteFile, readTaskFile } from "./fs";

export interface TaskSessionRecord {
	session_id: string;
	session_file: string;
}

/**
 * Write `session.json` — the discovered worker session file — **exactly
 * once**. Returns `true` when the file was written (or was already
 * there); `false` when a concurrent writer landed a different session file
 * in the stat/write gap and we bailed (the caller should stop retrying).
 */
export async function writeSessionOnce(dir: string, rec: TaskSessionRecord): Promise<boolean> {
	const d = await assertTaskDir(dir);
	const p = join(d, "session.json");
	if (existsSync(p)) return true; // already written — the "once" is by file existence
	await atomicWriteFile(p, `${JSON.stringify(rec, null, 2)}\n`);
	// TOCTOU: a second wrapper of the same task could have landed in the
	// existsSync/write gap — re-read and bail (unlink) if the file holds a
	// DIFFERENT record. A read failure (`after === null`) is a transient I/O
	// error on a file we just renamed: treat the write as landed and do NOT
	// unlink our own record.
	const expected = `${JSON.stringify(rec, null, 2)}\n`;
	const after = await readFile(p, "utf8").catch(() => null);
	if (after !== null && after !== expected) {
		await unlink(p);
		return false;
	}
	await appendEvent(d, { event: "session", session_id: rec.session_id, session_file: rec.session_file });
	return true;
}

export async function writeSystemPrompt(dir: string, text: string): Promise<string> {
	const d = await assertTaskDir(dir);
	const t = join(d, "system-prompt.md");
	await atomicWriteFile(t, text);
	return t;
}

export async function readSession(dir: string): Promise<TaskSessionRecord> {
	const d = await assertTaskDir(dir);
	const rec = (await readTaskFile(d, "session.json", "no-session")) as TaskSessionRecord;
	if (typeof rec.session_id !== "string" || typeof rec.session_file !== "string") {
		throw new ProtocolError("bad-session", "session.json is malformed");
	}
	return rec;
}

// ---------------------------------------------------------------------------
// result.md + done.marker

export async function writeResult(dir: string, text: string): Promise<void> {
	const d = await assertTaskDir(dir);
	await atomicWriteFile(join(d, "result.md"), text);
}

/**
 * Write `result.json` — the typed data payload (`vitrine_done`'s `data`
 * parameter, validated at the call against the task's `output_schema`).
 * Sibling of `writeResult`: the prose answer (`result.md`) and the typed
 * contract (`result.json`) stay orthogonal.
 */
export async function writeResultJson(dir: string, data: unknown): Promise<void> {
	const d = await assertTaskDir(dir);
	await atomicWriteFile(join(d, "result.json"), `${JSON.stringify(data, null, 2)}\n`);
}

export interface DoneMarker {
	ts: string;
	/** `headless-exit` — the wrapper's own marker for a clean `--print` exit: headless completion is the process exit, made durable so ordering rule 1/2 see a marker for a genuinely-finished task. */
	source: "vitrine_done" | "auto_settle" | "headless-exit";
}

export async function writeDoneMarker(dir: string, source: DoneMarker["source"]): Promise<void> {
	const d = await assertTaskDir(dir);
	const p = join(d, "done.marker");
	try {
		await stat(p);
		throw new ProtocolError("marker-exists", `done.marker already present in ${d}`);
	} catch (e: unknown) {
		if (e instanceof ProtocolError) throw e;
		if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
	}
	const marker: DoneMarker = { ts: new Date().toISOString(), source };
	await atomicWriteFile(p, `${JSON.stringify(marker, null, 2)}\n`);
	await appendEvent(d, { event: "done-marker", source });
}

export async function readDoneMarker(dir: string): Promise<DoneMarker | null> {
	const d = await assertTaskDir(dir);
	let raw: string | null = null;
	try {
		raw = await readFile(join(d, "done.marker"), "utf8");
	} catch (e: unknown) {
		if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
	}
	if (raw === null) return null;
	const m = JSON.parse(raw) as DoneMarker;
	if (
		typeof m.ts !== "string" ||
		(m.source !== "vitrine_done" && m.source !== "auto_settle" && m.source !== "headless-exit")
	) {
		throw new ProtocolError("bad-marker", `done.marker is malformed: ${raw.slice(0, 120)}`);
	}
	return m;
}

// ---------------------------------------------------------------------------
// lease.json (owner claim — the stuck-queued gate)

/**
 * The lease-freshness window: a lease younger than this is a live owner
 * (someone is still ticking the queue). The stuck-queued settle and the
 * slot count both key on this — a queue is live while its owner refreshes,
 * whatever its creation age (a queue behind a slow worker is minutes long,
 * not 15 s).
 */
export const LEASE_TTL_MS = 30_000;

/**
 * The owner's claim on a queued task: written by the dispatch call that
 * created the task, and refreshed on every tick of that call's wait loop.
 * A live owner always leaves a fresh lease behind; a dead one (crash,
 * reboot, abort) stops refreshing. `reconcileStuckQueued` settles only
 * tasks whose lease is absent (a pre-lease task) or stale — never a task
 * whose owner is still ticking (a queue waiting on a full cap is not
 * "stuck").
 */
export interface TaskLease {
	/** The owning dispatcher session id. */
	owner: string;
	/** Per-call nonce (one session can have concurrent dispatch calls). */
	nonce: string;
	/** ISO timestamp of the owner's last refresh. */
	updated_at: string;
}

export async function writeLease(dir: string, lease: TaskLease): Promise<void> {
	const d = await assertTaskDir(dir);
	await atomicWriteFile(join(d, "lease.json"), `${JSON.stringify(lease, null, 2)}\n`);
}

export async function readLease(dir: string): Promise<TaskLease | null> {
	const d = await assertTaskDir(dir);
	let raw: string | null = null;
	try {
		raw = await readFile(join(d, "lease.json"), "utf8");
	} catch (e: unknown) {
		if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
	}
	if (raw === null) return null;
	const rec = JSON.parse(raw) as TaskLease;
	if (typeof rec.owner !== "string" || typeof rec.nonce !== "string" || typeof rec.updated_at !== "string") {
		throw new ProtocolError("bad-lease", `lease.json is malformed: ${raw.slice(0, 120)}`);
	}
	return rec;
}

// ---------------------------------------------------------------------------
// kill_requested (presence-only)

/** Idempotent: the first call writes the file + the event; repeats are no-ops. */
export async function requestKill(dir: string): Promise<void> {
	const d = await assertTaskDir(dir);
	try {
		await writeFile(join(d, "kill_requested"), "", { flag: "wx", mode: 0o600 });
		await appendEvent(d, { event: "kill-requested" });
	} catch (e: unknown) {
		if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
	}
}

export async function killRequested(dir: string): Promise<boolean> {
	const d = await assertTaskDir(dir);
	try {
		await stat(join(d, "kill_requested"));
		return true;
	} catch (e: unknown) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw e;
	}
}
