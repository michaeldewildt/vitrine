/**
 * fs.ts — the task-dir paths and the atomic I/O everything else is built on.
 *
 * - Path containment: every entry point validates the task dir is
 *   `<tasksRoot>/<uuid>/` (lexical shape + no symlink escape).
 * - Modes: dirs `0700`, files `0600`, enforced at creation/write.
 * - Atomic writes: unique `*.tmp` + fsync + rename + dir fsync. The tmp name
 *   carries a per-writer suffix (`.tmp.<pid>.<seq>`) so the two writers the
 *   hand-off race admits (ordering rule 3) cannot clobber each
 *   other's tmp between write and rename — one module-global `tmpSeq`,
 *   shared by every writer in this module and the state CAS core.
 *
 * `VITRINE_TASKS_ROOT` overrides the tasks root (test hook). No pi, no
 * Hyprland — pure fs/POSIX.
 */
import { mkdir, open, readFile, readdir, realpath, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { ProtocolError } from "./errors";

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The tasks root. `VITRINE_TASKS_ROOT` overrides it (test hook). */
export function tasksRoot(): string {
	return process.env.VITRINE_TASKS_ROOT ?? resolve(homedir(), ".vitrine", "tasks");
}

/**
 * Validate and return the resolved task dir. Throws `bad-path` unless it is
 * `<tasksRoot>/<uuid>/`: absolute, lexically inside the root, a bare uuidv4
 * (lowercase hex, no nesting, no `..`), and — if it exists on disk — not a
 * symlink escape (realpath must land back at `<realRoot>/<uuid>`).
 */
export async function assertTaskDir(input: string): Promise<string> {
	if (!isAbsolute(input)) throw new ProtocolError("bad-path", `task dir must be absolute: ${input}`);
	const resolved = resolve(input);
	const root = tasksRoot();
	const rel = resolved.startsWith(root + "/") ? resolved.slice(root.length + 1) : null;
	const uuid = rel !== null && !rel.includes("/") && UUID_RE.test(rel) ? rel : null;
	if (uuid === null) throw new ProtocolError("bad-path", `task dir must be ${root}/<uuid>/ — got: ${resolved}`);
	const realTask = await realpath(resolved).catch(() => null);
	if (realTask !== null) {
		const realRoot = await realpath(root).catch(() => root);
		if (realTask !== join(realRoot, uuid)) {
			throw new ProtocolError("bad-path", `task dir escapes the tasks root via a symlink: ${resolved}`);
		}
		if (!(await stat(resolved)).isDirectory()) throw new ProtocolError("bad-path", `task dir is not a directory: ${resolved}`);
	}
	return resolved;
}

export function taskIdOf(dir: string): string {
	return basename(resolve(dir));
}

/** All task dirs under the root (uuid-named directories only). Missing root → `[]`. */
export async function listTaskDirs(): Promise<string[]> {
	const root = tasksRoot();
	const entries = await readdir(root, { withFileTypes: true }).catch((e: NodeJS.ErrnoException) =>
		e.code === "ENOENT" ? [] : Promise.reject(e),
	);
	return entries
		.filter((e) => e.isDirectory() && UUID_RE.test(e.name))
		.map((e) => join(root, e.name))
		.sort();
}

// ---------------------------------------------------------------------------
// Atomic I/O

// ONE module-global sequence for every tmp name in the protocol: a split
// counter would let two writers mint the same tmp name in the same boot.
let tmpSeq = 0;

/** A unique tmp path for `file` (per pid + sequence). */
export function uniqueTmpName(file: string): string {
	return `${file}.tmp.${process.pid}.${(tmpSeq += 1)}`;
}

/** Atomic write: tmp, write, fsync, rename, dir fsync. Readers only ever see `file` whole. */
export async function atomicWriteFile(file: string, content: string): Promise<void> {
	const tmp = uniqueTmpName(file);
	const fh = await open(tmp, "w", 0o600);
	try {
		await fh.writeFile(content);
		await fh.sync();
	} finally {
		await fh.close();
	}
	try {
		await rename(tmp, file);
	} catch (e: unknown) {
		await unlink(tmp).catch(() => {});
		throw e;
	}
	await fsyncDir(dirname(file));
}

/** Atomic append (single O_APPEND write) — `events.jsonl`, `tail.log`. */
export async function atomicAppend(file: string, line: string): Promise<void> {
	const fh = await open(file, "a", 0o600);
	try {
		await fh.appendFile(line);
		await fh.sync();
	} finally {
		await fh.close();
	}
}

export async function fsyncDir(dirPath: string): Promise<void> {
	const dfh = await open(dirPath, "r");
	try {
		await dfh.sync();
	} finally {
		await dfh.close();
	}
}

/**
 * Read + parse a task-dir JSON file — the one reader for the three shapes
 * that THROW on ENOENT with their typed `no-*` error (spec.json, state.json,
 * session.json). `readEvents` returns `[]` and `readDoneMarker`/
 * `killRequested` return null/false on a missing file — those keep their own
 * reads.
 */
export async function readTaskFile(d: string, file: string, noCode: "no-spec" | "no-state" | "no-session"): Promise<unknown> {
	const raw = await readFile(join(d, file), "utf8").catch((e: NodeJS.ErrnoException) => {
		if (e.code === "ENOENT") throw new ProtocolError(noCode, `no ${file} in ${d}`);
		throw e;
	});
	return JSON.parse(raw);
}

// ---------------------------------------------------------------------------
// events.jsonl, tail.log

export async function appendEvent(dir: string, event: Record<string, unknown>): Promise<void> {
	const d = await assertTaskDir(dir);
	await atomicAppend(join(d, "events.jsonl"), `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`);
}

export async function readEvents(dir: string): Promise<Array<Record<string, unknown>>> {
	const d = await assertTaskDir(dir);
	const raw = await readFile(join(d, "events.jsonl"), "utf8").catch((e: NodeJS.ErrnoException) => {
		if (e.code === "ENOENT") return "";
		throw e;
	});
	return raw
		.split("\n")
		.filter((l) => l.length > 0)
		.map((l) => {
			try {
				const o = JSON.parse(l) as Record<string, unknown>;
				if (typeof o.ts !== "string") throw new Error("missing ts");
				return o;
			} catch {
				throw new ProtocolError("bad-events", `malformed events.jsonl line: ${l.slice(0, 120)}`);
			}
		});
}

/** The wrapper's own stderr + the worker's stderr (`tail.log`). */
export async function appendTail(dir: string, text: string): Promise<void> {
	const d = await assertTaskDir(dir);
	await atomicAppend(join(d, "tail.log"), text);
}

// ---------------------------------------------------------------------------

/** Remove a task dir and everything in it (`vitrine gc` building block). */
export async function removeTask(dir: string): Promise<void> {
	const d = await assertTaskDir(dir);
	await rm(d, { recursive: true, force: true });
}
