/**
 * session.ts — the session storage + JSONL facts — shared by
 * the wrapper (watchdog inputs, harvest, resume detection) and the dispatch
 * (deferred harvest).
 *
 * `parseSessionEntries` is the single lenient parser: the session file is
 * pi-owned and append-only, so a torn last line (a read mid-write) is
 * expected and skipped — the wrapper must never die on a transient read of a
 * live file.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// session storage (session.json = the created session file)

/** pi's session-dir slug for a cwd: `~/.pi/agent/sessions/--<cwd>---` — each `/`
 * becomes `-`, the leading slash dropped, wrapped in double dashes.
 * (Pinned against observed real-pi dirs in vitrine-run.test.ts.) */
export function sessionDirFor(cwd: string, sessionsRoot: string): string {
	return join(sessionsRoot, `--${cwd.replace(/^\//, "").replaceAll("/", "-")}--`);
}

export interface SessionFacts {
	entries: Array<Record<string, unknown>>;
	/** Lines that failed to parse and were skipped (a torn last line is normal on a live file). */
	skipped: number;
}

/**
 * Parse a session JSONL leniently. The session file is pi-owned and
 * append-only; a torn last line (read mid-write) is expected and skipped.
 * Other unparseable lines are skipped too (counted) — the wrapper must never
 * die on a transient read of a live file.
 */
export async function parseSessionEntries(path: string): Promise<SessionFacts> {
	const text = await readFile(path, "utf8");
	const lines = text.split("\n");
	const entries: Array<Record<string, unknown>> = [];
	let skipped = 0;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();
		if (line === "") continue;
		try {
			entries.push(JSON.parse(line) as Record<string, unknown>);
		} catch {
			skipped++;
		}
	}
	return { entries, skipped };
}

interface SessionHeader {
	id: string;
	cwd?: string;
	parentSession?: string;
}

/** The header line (`type: "session"`) of a session file. `null` when absent. */
export async function readSessionHeader(path: string): Promise<SessionHeader | null> {
	const { entries } = await parseSessionEntries(path);
	const hdr = entries.find((e) => e.type === "session");
	if (hdr === undefined || typeof hdr.id !== "string") return null;
	return {
		id: hdr.id,
		...(typeof hdr.cwd === "string" ? { cwd: hdr.cwd } : {}),
		...(typeof hdr.parentSession === "string" ? { parentSession: hdr.parentSession } : {}),
	};
}

/** The `--name`/session_info display name, if set. */
export async function readSessionName(path: string): Promise<string | null> {
	const { entries } = await parseSessionEntries(path);
	// The LATEST session_info entry wins: pi's getSessionName() uses the most
	// recent one, and a forked file carries the SOURCE's session_info (copied
	// entries) before the worker's own — first-match would read the stale name.
	let name: string | null = null;
	for (const e of entries) {
		if (e.type === "session_info" && typeof e.name === "string") name = e.name;
	}
	return name;
}

/**
 * Find the session file this task's worker created: diff the
 * cwd-keyed session dir against the pre-spawn snapshot, then match the new
 * files — header id (`vitrine.<task_id>`) first, `session_info`/`--name`
 * entry second — so a fork that got a different id still matches on its name.
 */
export async function discoverSessionFile(
	sessionDir: string,
	sessionName: string,
	sessionId: string,
	before: Set<string>,
): Promise<string | null> {
	const names = await readdir(sessionDir).catch((e: NodeJS.ErrnoException) =>
		e.code === "ENOENT" ? [] : Promise.reject(e),
	);
	const fresh = names.filter((n) => n.endsWith(".jsonl") && !before.has(n));
	// Pass 1: header id. Pass 2: session_info name.
	for (const want of [
		(p: string) => readSessionHeader(p).then((h) => h !== null && h.id === sessionId),
		(p: string) => readSessionName(p).then((n) => n === sessionName),
	] as Array<(p: string) => Promise<boolean>>) {
		for (const n of fresh) {
			const p = join(sessionDir, n);
			try {
				if (await want(p)) return p;
			} catch {
				// unreadable mid-write — try again next tick
			}
		}
	}
	return null;
}

// ---------------------------------------------------------------------------
// watchdog facts (parsed from the session file)

/** The last session message entry's kind — see `lastMessageKind`. */
export type LastEntryKind = "pending-tool" | "idle-assistant" | "other" | null;

function messageOf(e: Record<string, unknown>): { role: string; content?: Array<Record<string, unknown>>; toolCallId?: string } | null {
	const m = e.message;
	if (typeof m !== "object" || m === null) return null;
	return m as { role: string; content?: Array<Record<string, unknown>>; toolCallId?: string };
}

/**
 * v1.11 resume detection: true when a user-role message entry
 * sits at index >= `snapshot` (a 0-based entry count — the snapshot taken at
 * keep-alive entry). Snapshot-based, not marker-based: the initial prompt is
 * itself a user entry, and a forked session carries copied user entries —
 * both predate the snapshot. No machine path writes user entries (the
 * worker's own turns are assistant/tool entries; dispatcher-side steering is
 * later, and the `resumed` event's `source` field leaves room for it).
 */
export function hasUserEntryBeyond(entries: Array<Record<string, unknown>>, snapshot: number): boolean {
	for (let i = snapshot; i < entries.length; i++) {
		const m = messageOf(entries[i]);
		if (m !== null && m.role === "user") return true;
	}
	return false;
}

/**
 * Classify the last *message* entry:
 * - `pending-tool` — an assistant entry whose toolCall parts lack toolResult
 *   entries (a long `bash` legitimately writes nothing while running);
 * - `idle-assistant` — an assistant entry with every toolCall matched by a
 *   toolResult (a settled turn — the auto-settle idle condition);
 * - `other` — anything else (user message, toolResult, non-Message entry last,
 *   or no message at all).
 */
export function lastMessageKind(entries: Array<Record<string, unknown>>): LastEntryKind {
	let last: Record<string, unknown> | null = null;
	for (const e of entries) if (e.type === "message") last = e;
	if (last === null) return null;
	const m = messageOf(last);
	if (m === null || m.role !== "assistant") return "other";
	// Which toolCall ids in this entry have a toolResult anywhere in the file?
	const callIds: string[] = [];
	for (const part of m.content ?? []) if (part.type === "toolCall" && typeof part.id === "string") callIds.push(part.id);
	if (callIds.length === 0) return "idle-assistant";
	const results = new Set<string>();
	for (const e of entries) {
		if (e.type !== "message") continue;
		const me = messageOf(e);
		if (me !== null && me.role === "toolResult" && typeof me.toolCallId === "string") results.add(me.toolCallId);
	}
	return callIds.some((id) => !results.has(id)) ? "pending-tool" : "idle-assistant";
}

/** The text of the last assistant message (auto-settle harvest / partial harvest). */
export function lastAssistantText(entries: Array<Record<string, unknown>>): string | null {
	let last: Record<string, unknown> | null = null;
	for (const e of entries) {
		if (e.type !== "message") continue;
		const m = messageOf(e);
		if (m !== null && m.role === "assistant") last = e;
	}
	if (last === null) return null;
	const m = messageOf(last)!;
	const text = (m.content ?? [])
		.filter((p) => p.type === "text" && typeof p.text === "string")
		.map((p) => p.text as string);
	return text.length > 0 ? text.join("\n\n") : null;
}

/** Sum of `usage.cost.total` over assistant entries (the cost watchdog). */
export function totalCostUsd(entries: Array<Record<string, unknown>>): number {
	let total = 0;
	for (const e of entries) {
		if (e.type !== "message") continue;
		const m = messageOf(e);
		if (m === null || m.role !== "assistant") continue;
		const rec = e.message as Record<string, unknown>;
		const usage = rec.usage as Record<string, unknown> | undefined;
		const cost = usage?.cost as Record<string, unknown> | undefined;
		if (typeof cost?.total === "number") total += cost.total;
	}
	return total;
}
