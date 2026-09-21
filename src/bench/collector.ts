/**
 * collector.ts — the bench metrics collector (PURE LEAF): one task dir →
 * one metrics row. `node:fs/promises` + JSON + the `src/session.ts` leaf
 * helpers only — nothing from `src/dispatch`, `src/wrapper`, or the
 * protocol write paths. Reads only, ever.
 *
 * VERSION TOLERANCE is the contract, not a nicety: ~half the historical
 * task dirs under `~/.vitrine/tasks/` lack `session.json` (it first appears
 * ~2026-09-19) and files have drifted (prompt.md vs prompt.txt) — so every
 * field read is lenient: per-field failure → explicit null, never throw,
 * and one malformed dir never breaks a batch.
 *
 * Segments (all ms, from `events.jsonl` + `state.json`):
 *   queue  = `created` → `transition` queued→running
 *   boot   = that transition → `session` event
 *   work   = `session` → `done-marker`
 *   poll   = `done-marker` → `marker-observed`
 *   settle = `marker-observed` → terminal `transition`
 *   e2e    = `created` → `state.json` `finished_at` — cross-checked against
 *            the terminal transition; a mismatch > 50 ms is noted in the row
 *   harness ratio = (boot+poll+settle)/e2e — queue excluded
 *
 * Session metrics (from the worker session JSONL, `session.json` →
 * `session_file`; assistant entries only): summed token counters, cost
 * total, and tokens-per-second = total output tokens / (last assistant
 * entry ts − first) when there is >1 assistant entry. The `reasoning`
 * usage field is optional in the shape (the fixture omits it) — null when
 * no assistant entry carries it.
 */
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseSessionEntries, totalCostUsd } from "../session";

/** The terminal states (local — the collector imports no protocol module).
 * Exported so a test can assert set equality with the protocol's
 * `TERMINAL_STATES` (`src/protocol/state.ts`): a new protocol terminal state
 * must not silently null out the collector's `settle` segment. */
export const TERMINAL_STATES: ReadonlySet<string> = new Set(["completed", "failed", "killed", "timeout", "crashed"]);

/** The e2e cross-check threshold: |terminal transition − finished_at| above this is noted. */
export const E2E_MISMATCH_THRESHOLD_MS = 50;

/** The named segments (the explicit-null vocabulary). */
export const SEGMENTS = ["queue", "boot", "work", "poll", "settle", "e2e"] as const;
export type Segment = (typeof SEGMENTS)[number];

export interface BenchRow {
	task_id: string;
	agent: string | null;
	model: string | null;
	thinking: string | null;
	mode: string | null;
	state: string | null;
	reason: string | null;
	queue_ms: number | null;
	boot_ms: number | null;
	work_ms: number | null;
	poll_ms: number | null;
	settle_ms: number | null;
	/** The observation point behind poll/settle: null on the normal path (a `marker-observed` event is present), or `"worker-exit"` when the headless content-gate completion path wrote a done-marker but emitted no marker-observed event — the wrapper's `worker-exit` event stands in for the observation point. */
	marker_observed_by: string | null;
	e2e_ms: number | null;
	/** Cross-check: |terminal transition ts − state.json finished_at| when it exceeds the 50 ms threshold (else null). */
	e2e_mismatch_ms: number | null;
	/** (boot+poll+settle)/e2e, queue excluded; null when any of the three or e2e is null. */
	harness_ratio: number | null;
	input_tokens: number | null;
	output_tokens: number | null;
	cache_read_tokens: number | null;
	cache_write_tokens: number | null;
	/** Optional in the shape (absent in the fixture): null when no assistant entry carries it. */
	reasoning_tokens: number | null;
	cost_usd: number | null;
	/** Total output tokens / assistant-entry span (seconds); null when <2 assistant entries with numeric timestamps. */
	tokens_per_s: number | null;
	/** True when every segment and the session metrics are present. */
	complete: boolean;
	/** Names of the absent segments/metric groups (the explicit nulls). */
	missing: string[];
}

// ---------------------------------------------------------------------------
// lenient field readers

interface Ev {
	ts: number;
	event: string;
	from?: string;
	to?: string;
}

/**
 * Parse `events.jsonl` leniently: a malformed line (bad JSON, missing/
 * unparseable `ts`, missing `event`) is skipped, never thrown. (The
 * protocol's `readEvents` throws on malformed lines — that strictness is
 * for the writers; a batch collector must survive the historical dirs.)
 */
async function readEventsLenient(dir: string): Promise<Ev[]> {
	const raw = await readFile(join(dir, "events.jsonl"), "utf8").catch(() => null);
	if (raw === null) return [];
	const out: Ev[] = [];
	for (const line of raw.split("\n")) {
		if (line.trim() === "") continue;
		try {
			const o = JSON.parse(line) as Record<string, unknown>;
			if (typeof o.ts !== "string" || typeof o.event !== "string") continue;
			const ts = Date.parse(o.ts);
			if (Number.isNaN(ts)) continue;
			out.push({
				ts,
				event: o.event,
				...(typeof o.from === "string" ? { from: o.from } : {}),
				...(typeof o.to === "string" ? { to: o.to } : {}),
			});
		} catch {
			// skip the malformed line — per-field failure → null, never throw
		}
	}
	return out;
}

function num(v: unknown): number | null {
	return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Sum the non-null values; null when all are null (absence ≠ 0). */
function sumNullable(values: Array<number | null>): number | null {
	let out: number | null = null;
	for (const v of values) if (v !== null) out = (out ?? 0) + v;
	return out;
}

async function readJson<T>(path: string): Promise<T | null> {
	const raw = await readFile(path, "utf8").catch(() => null);
	if (raw === null) return null;
	try {
		return JSON.parse(raw) as T;
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// the collector

/**
 * One task dir → one metrics row. Never throws: a missing/unreadable file
 * yields the explicit-null row (the dir's basename as `task_id`), so a
 * malformed dir in a batch degrades to nulls instead of breaking the run.
 */
export async function collectRow(dir: string): Promise<BenchRow> {
	const id = basename(dir);
	const row: BenchRow = {
		task_id: id,
		agent: null,
		model: null,
		thinking: null,
		mode: null,
		state: null,
		reason: null,
		queue_ms: null,
		boot_ms: null,
		work_ms: null,
		poll_ms: null,
		settle_ms: null,
		marker_observed_by: null,
		e2e_ms: null,
		e2e_mismatch_ms: null,
		harness_ratio: null,
		input_tokens: null,
		output_tokens: null,
		cache_read_tokens: null,
		cache_write_tokens: null,
		reasoning_tokens: null,
		cost_usd: null,
		tokens_per_s: null,
		complete: false,
		missing: [...SEGMENTS, "session"],
	};
	try {
		const spec = await readJson<Record<string, unknown>>(join(dir, "spec.json"));
		if (spec !== null) {
			const agent = typeof spec.agent === "object" && spec.agent !== null ? (spec.agent as Record<string, unknown>) : {};
			if (typeof agent.name === "string") row.agent = agent.name;
			if (typeof agent.model === "string") row.model = agent.model;
			if (typeof agent.thinking === "string") row.thinking = agent.thinking;
			if (typeof spec.mode === "string") row.mode = spec.mode;
		}

		const state = await readJson<Record<string, unknown>>(join(dir, "state.json"));
		if (state !== null) {
			if (typeof state.state === "string") row.state = state.state;
			if (typeof state.reason === "string" && state.reason !== "") row.reason = state.reason;
		}

		const events = await readEventsLenient(dir);
		const firstEv = (pred: (e: Ev) => boolean): Ev | undefined => events.find(pred);
		const created = firstEv((e) => e.event === "created");
		const bootEv = firstEv((e) => e.event === "transition" && e.from === "queued" && e.to === "running");
		const sessionEv = firstEv((e) => e.event === "session");
		// the marker point: `done-marker` (the protocol write — the real
		// `vitrine_done` tool appends it BEFORE its own `vitrine_done` event,
		// and the wrapper's auto-settle/headless-exit writes it directly)
		// with the `vitrine_done` event as the fallback (the fixture writes
		// the marker file + that event only — version tolerance)
		const markerEv = firstEv((e) => e.event === "done-marker" || e.event === "vitrine_done");
		const observedEv = firstEv((e) => e.event === "marker-observed");
		const terminalEv = firstEv((e) => e.event === "transition" && TERMINAL_STATES.has(e.to ?? ""));
		// The observation point behind poll/settle. The normal path has a
		// `marker-observed` event (the wrapper's observation of the done-marker).
		// The headless content-gate completion path (headless.ts branch 3: clean
		// exit 0, idle assistant, no vitrine_done) writes the done-marker but
		// emits NO marker-observed event — the worker exits and the wrapper
		// settles. There the `worker-exit` event IS the observation point (it
		// lands right after the marker, before the terminal transition), so
		// fall back to it: poll = done-marker → worker-exit, settle =
		// worker-exit → terminal. The row is marked `marker_observed_by:
		// "worker-exit"` so the path stays distinguishable from drift. Genuinely
		// absent data (no marker, or no worker-exit) stays null (missing).
		const exitEv = firstEv((e) => e.event === "worker-exit");
		const observed = observedEv !== undefined ? observedEv : markerEv !== undefined && exitEv !== undefined ? exitEv : undefined;
		if (observedEv === undefined && observed !== undefined) row.marker_observed_by = "worker-exit";

		const span = (a: Ev | undefined, b: Ev | undefined): number | null => (a !== undefined && b !== undefined ? b.ts - a.ts : null);
		row.queue_ms = span(created, bootEv);
		row.boot_ms = span(bootEv, sessionEv);
		row.work_ms = span(sessionEv, markerEv);
		row.poll_ms = span(markerEv, observed);
		row.settle_ms = span(observed, terminalEv);

		// e2e = created → state.json finished_at; cross-check both against the
		// terminal transition (a >50 ms mismatch is noted, not silently trusted)
		const finishedAt = state !== null && typeof state.finished_at === "string" ? Date.parse(state.finished_at) : Number.NaN;
		if (created !== undefined && !Number.isNaN(finishedAt)) {
			row.e2e_ms = finishedAt - created.ts;
			if (terminalEv !== undefined && Math.abs(terminalEv.ts - finishedAt) > E2E_MISMATCH_THRESHOLD_MS) {
				row.e2e_mismatch_ms = Math.abs(terminalEv.ts - finishedAt);
			}
		}
		if (row.boot_ms !== null && row.poll_ms !== null && row.settle_ms !== null && row.e2e_ms !== null && row.e2e_ms > 0) {
			row.harness_ratio = (row.boot_ms + row.poll_ms + row.settle_ms) / row.e2e_ms;
		}

		// session metrics (assistant entries only) — the path from session.json;
		// absent file/dir/file-gone all degrade to nulls
		const sessionRec = await readJson<Record<string, unknown>>(join(dir, "session.json"));
		const sessionFile = sessionRec !== null && typeof sessionRec.session_file === "string" ? sessionRec.session_file : null;
		if (sessionFile !== null) {
			const parsed = await parseSessionEntries(sessionFile).catch(() => null);
			if (parsed !== null) {
				const assistants = parsed.entries.filter((e) => {
					const m = e.message;
					return e.type === "message" && typeof m === "object" && m !== null && (m as Record<string, unknown>).role === "assistant";
				});
				if (assistants.length > 0) {
					row.input_tokens = sumNullable(assistants.map((e) => num(usageOf(e)?.input)));
					row.output_tokens = sumNullable(assistants.map((e) => num(usageOf(e)?.output)));
					row.cache_read_tokens = sumNullable(assistants.map((e) => num(usageOf(e)?.cacheRead)));
					row.cache_write_tokens = sumNullable(assistants.map((e) => num(usageOf(e)?.cacheWrite)));
					row.reasoning_tokens = sumNullable(assistants.map((e) => num(usageOf(e)?.reasoning)));
					row.cost_usd = totalCostUsd(parsed.entries);
					// tokens-per-second: message.timestamp (epoch ms) — the
					// entry-level ISO ts as fallback
					const stamps = assistants
						.map((e) => {
							const m = e.message as Record<string, unknown>;
							const t = num(m.timestamp);
							if (t !== null) return t;
							return typeof e.timestamp === "string" ? Date.parse(e.timestamp) : Number.NaN;
						})
						.filter((t) => !Number.isNaN(t));
					if (stamps.length > 1 && row.output_tokens !== null) {
						const spanMs = stamps[stamps.length - 1] - stamps[0];
						if (spanMs > 0) row.tokens_per_s = row.output_tokens / (spanMs / 1000);
					}
				}
			}
		}

		row.missing = [
			...SEGMENTS.filter((s) => row[`${s}_ms` as `${Segment}_ms`] === null),
			...(row.input_tokens === null ? ["session"] : []),
		];
		row.complete = row.missing.length === 0;
	} catch {
		// per-field failure → null, never throw — the all-null row stands
	}
	return row;
}

function usageOf(e: Record<string, unknown>): Record<string, unknown> | null {
	const m = e.message;
	if (typeof m !== "object" || m === null) return null;
	const u = (m as Record<string, unknown>).usage;
	return typeof u === "object" && u !== null ? (u as Record<string, unknown>) : null;
}

/**
 * A batch: one row per dir, in order. A throwing collect (should be
 * impossible — it catches internally) still degrades to an all-null row
 * rather than breaking the batch.
 */
export async function collectRows(dirs: string[]): Promise<BenchRow[]> {
	const nullRow = (dir: string): BenchRow => ({
		task_id: basename(dir),
		agent: null,
		model: null,
		thinking: null,
		mode: null,
		state: null,
		reason: null,
		queue_ms: null,
		boot_ms: null,
		work_ms: null,
		poll_ms: null,
		settle_ms: null,
		marker_observed_by: null,
		e2e_ms: null,
		e2e_mismatch_ms: null,
		harness_ratio: null,
		input_tokens: null,
		output_tokens: null,
		cache_read_tokens: null,
		cache_write_tokens: null,
		reasoning_tokens: null,
		cost_usd: null,
		tokens_per_s: null,
		complete: false,
		missing: [...SEGMENTS, "session"],
	});
	return Promise.all(
		dirs.map(async (dir) => {
			try {
				return await collectRow(dir);
			} catch {
				return nullRow(dir);
			}
		}),
	);
}

// ---------------------------------------------------------------------------
// medians over runs

/** The median of a non-empty finite list (even count: mean of the two middles). */
export function median(values: number[]): number | null {
	const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
	if (v.length === 0) return null;
	const m = Math.floor(v.length / 2);
	return v.length % 2 === 1 ? v[m] : (v[m - 1] + v[m]) / 2;
}

export const MEDIAN_KEYS = ["queue_ms", "boot_ms", "work_ms", "poll_ms", "settle_ms", "e2e_ms", "harness_ratio", "tokens_per_s", "cost_usd"] as const;
export type MedianKey = (typeof MEDIAN_KEYS)[number];
export type Medians = Record<MedianKey, number | null>;

/** Medians over the rows' numeric fields (null where every row is null). */
export function mediansOf(rows: BenchRow[]): Medians {
	const out = {} as Medians;
	for (const k of MEDIAN_KEYS) {
		out[k] = median(rows.map((r) => r[k]).filter((v): v is number => v !== null));
	}
	return out;
}
