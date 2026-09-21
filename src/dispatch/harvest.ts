/**
 * harvest.ts — the result harvest (Results) + the deferred-harvest
 * registry (module state: survives across tool calls in one pi session —
 * the cheap robust scope; a dispatcher that dispatches and then dies/
 * reboots has its ids harvested by the NEXT call's registry… only if the
 * same session id re-dispatches. Cross-reboot harvest is the adopt path —
 * reconciliation reports live/terminal foreign tasks).
 *
 * The harvest's session read goes through the shared lenient string parse
 * (a torn last line on a live file is normal) + `lastAssistantText` from
 * src/session.ts (the single session-facts module — the import is direct,
 * not via the vitrine-run re-export).
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { mkdirSync, writeFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import * as P from "../protocol";
import { lastAssistantText } from "../session";

/** The harvest's result cap (50 KB / 2000 lines). */
export const CAP_BYTES_DEFAULT = 50 * 1024;
export const CAP_LINES_DEFAULT = 2000;

/** The typed-data render cap, bytes (the report's compact JSON). */
export const CAP_DATA_BYTES = 8 * 1024;

/**
 * The label of a capped text — it drives the suffix tag
 * (`[<tag>: N lines / M bytes total; full <label> below]`) and the overflow
 * file's name + extension. `harvestTask` caps the harvest text ("harvest")
 * and the data render ("data"); `vitrine_collect` caps the resumed-session
 * advisory note ("advisory") with the IDENTICAL treatment (R6: the cap/
 * overflow is identical to the delivery).
 */
export type CapLabel = "harvest" | "data" | "advisory";
const CAP_TAG: Record<CapLabel, string> = { harvest: "capped", data: "data capped", advisory: "advisory capped" };
const CAP_EXT: Record<CapLabel, string> = { harvest: "md", data: "json", advisory: "md" };

/**
 * The shared cap mechanism: at most maxLines lines, at most maxBytes bytes;
 * the overflow is preserved in a 0600 temp file whose path the (capped)
 * text names — the result never loses content, only its inline size. The
 * sanctioned response to a truncated body is to read the named file.
 */
export function capToText(text: string, opts: { maxBytes: number; maxLines: number; tmpDir: string; id: string; label: CapLabel }): { text: string; overflowFile?: string } {
	const lines = text.split("\n");
	const overLines = lines.length > opts.maxLines;
	const overBytes = Buffer.byteLength(text, "utf8") > opts.maxBytes;
	if (!overLines && !overBytes) return { text: text.trimEnd() };
	// Cap: the first maxLines lines, then truncate at maxBytes.
	let capped = lines.slice(0, opts.maxLines).join("\n");
	const enc = new TextEncoder();
	if (enc.encode(capped).length > opts.maxBytes) {
		let lo = 0;
		let hi = capped.length;
		// binary search the prefix that fits maxBytes
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if (enc.encode(capped.slice(0, mid)).length <= opts.maxBytes) lo = mid;
			else hi = mid - 1;
		}
		capped = capped.slice(0, lo);
	}
	const suffix = `\n… [${CAP_TAG[opts.label]}: ${lines.length} lines / ${Buffer.byteLength(text, "utf8")} bytes total; full ${opts.label} below]`;
	const tmp = join(opts.tmpDir, `vitrine-${opts.id}-${opts.label}-${randomUUID().slice(0, 8)}.${CAP_EXT[opts.label]}`);
	mkdirSync(opts.tmpDir, { recursive: true });
	writeFileSync(tmp, text, { mode: 0o600 });
	return { text: capped + suffix + `\nfull text: ${tmp}`, overflowFile: tmp };
}

// ---------------------------------------------------------------------------
// the deferred-harvest registry

const sessionRegistry = new Map<string, Set<string>>();

export function registryAdd(sessionId: string, ids: string[]): void {
	const set = sessionRegistry.get(sessionId) ?? new Set<string>();
	for (const id of ids) set.add(id);
	sessionRegistry.set(sessionId, set);
}

export function registryRemove(sessionId: string, id: string): void {
	sessionRegistry.get(sessionId)?.delete(id);
}

/** The ids this dispatcher session registered but never saw terminal (diagnostics/CLI). */
export function pendingDispatchedIds(sessionId: string): string[] {
	return [...(sessionRegistry.get(sessionId) ?? [])];
}

export function clearDispatchedRegistry(sessionId: string): void {
	sessionRegistry.delete(sessionId);
}

// ---------------------------------------------------------------------------
// the harvest

export interface Harvest {
	text: string;
	partial: boolean;
	overflowFile?: string;
	/** True when the task dir vanished mid-call (a concurrent `vitrine gc`). */
	gone: boolean;
	/** The typed data (the parsed `result.json` — the worker's `vitrine_done` `data`) — machine-readable, uncapped. */
	data?: unknown;
	/** The data for the report (compact JSON, capped; the capped text names its overflow file). */
	dataText?: string;
	/** The 0600 overflow file for the capped data (the capped text names it). */
	overflowDataFile?: string;
}

/**
 * Harvest a terminal task: result.md → last assistant message (session
 * JSONL) → transcript tail (tail.log). The 50 KB / 2000-line cap applies;
 * overflow is preserved in a 0600 temp file whose path the result names.
 * A vanished dir (concurrent gc) is tolerated: catch, label, continue.
 */
export async function harvestTask(
	dir: string,
	state: P.TaskState,
	deps: { maxResultBytes?: number; maxResultLines?: number; tmpDir?: string } = {},
): Promise<Harvest> {
	const maxBytes = deps.maxResultBytes ?? CAP_BYTES_DEFAULT;
	const maxLines = deps.maxResultLines ?? CAP_LINES_DEFAULT;
	const tmpDir = deps.tmpDir ?? tmpdir();
	const partial = state !== "completed";
	try {
		const d = await P.assertTaskDir(dir);
		// a vanished dir (a concurrent `vitrine gc`) is tolerated: label, continue
		try {
			await stat(d);
		} catch (e: unknown) {
			if (e instanceof Error && (e as NodeJS.ErrnoException).code === "ENOENT") {
				return { text: "(task dir vanished mid-call — a concurrent `vitrine gc`?)", partial, gone: true };
			}
			throw e;
		}
		// 1. result.md (the worker's final answer — vitrine_done).
		let text: string | null = null;
		let source = "result.md";
		const resultRaw = await readFile(join(d, "result.md"), "utf8").catch((e: NodeJS.ErrnoException) => (e.code === "ENOENT" ? null : Promise.reject(e)));
		if (resultRaw !== null && resultRaw.trim() !== "") {
			text = resultRaw;
		} else {
			// 2. last assistant message of the worker session.
			source = "session";
			const rec = await P.readSession(d).catch(() => null);
			if (rec !== null) {
				const file = await readFile(rec.session_file, "utf8").catch(() => null);
				if (file !== null) {
					const { entries } = parseSessionEntriesLenient(file);
					text = lastAssistantText(entries) ?? null;
				}
			}
			// 3. transcript tail.
			if (text === null) {
				source = "tail.log";
				text = (await readFile(join(d, "tail.log"), "utf8").catch(() => null)) ?? null;
			}
		}
		const base: Harvest =
			text === null
				? { text: `(no harvestable content — ${source} absent)`, partial, gone: false }
				: capText(text, { maxBytes, maxLines, tmpDir, id: P.taskIdOf(d), partial, source });
		// The typed data (`result.json` — `vitrine_done`'s `data`, written after
		// the prose answer): harvested alongside it, orthogonal to the text chain.
		const dataRaw = await readFile(join(d, "result.json"), "utf8").catch((e: NodeJS.ErrnoException) => (e.code === "ENOENT" ? null : Promise.reject(e)));
		if (dataRaw === null) return base;
		let parsed: unknown;
		try {
			parsed = JSON.parse(dataRaw);
		} catch {
			// a corrupt result.json does not sink the prose harvest
			return base;
		}
		const data = capData(parsed, { tmpDir, id: P.taskIdOf(d) });
		return { ...base, data: parsed, dataText: data.text, overflowDataFile: data.overflowFile };
	} catch (e: unknown) {
		if (e instanceof P.ProtocolError && (e.code === "bad-path" || e.code === "no-spec")) {
			return { text: "(task dir vanished mid-call — a concurrent `vitrine gc`?)", partial, gone: true };
		}
		throw e;
	}
}

/**
 * Cap a data render (the report's compact JSON) at CAP_DATA_BYTES — the
 * shared mechanism (label "data"), so the 0600 overflow file and the
 * naming are identical to the text cap.
 */
function capData(data: unknown, opts: { tmpDir: string; id: string }): { text: string; overflowFile?: string } {
	const full = JSON.stringify(data);
	if (Buffer.byteLength(full, "utf8") <= CAP_DATA_BYTES) return { text: full };
	return capToText(full, { maxBytes: CAP_DATA_BYTES, maxLines: Infinity, tmpDir: opts.tmpDir, id: opts.id, label: "data" });
}

/** Parse a session JSONL leniently (a torn last line on a live file is normal). */
function parseSessionEntriesLenient(text: string): { entries: Array<Record<string, unknown>> } {
	const entries: Array<Record<string, unknown>> = [];
	for (const line of text.split("\n")) {
		if (line.trim() === "") continue;
		try {
			entries.push(JSON.parse(line) as Record<string, unknown>);
		} catch {
			// skipped (torn/foreign line)
		}
	}
	return { entries };
}

/**
 * Cap a harvest at maxLines/maxBytes — the shared mechanism (label
 * "harvest") wrapped in the Harvest shape. The overflow is preserved in a
 * 0600 temp file whose path the (capped) text names.
 */
function capText(text: string, opts: { maxBytes: number; maxLines: number; tmpDir: string; id: string; partial: boolean; source: string }): Harvest {
	const capped = capToText(text, { maxBytes: opts.maxBytes, maxLines: opts.maxLines, tmpDir: opts.tmpDir, id: opts.id, label: "harvest" });
	return { text: capped.text, partial: opts.partial, overflowFile: capped.overflowFile, gone: false };
}
