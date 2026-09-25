/**
 * battery.ts — the versioned live battery + its outcome oracles (PURE).
 *
 * This file IS the versioning: the battery content (task texts, cwd files,
 * the oracle descriptors) lives in the repo, and a run's provenance already
 * carries the git sha — so a later history row says exactly which battery
 * content it measured. Local seats only (the design's settled decision):
 * the seat names here are the local seats, and the models come from the
 * agent files.
 *
 * Each task is small and has an OUTCOME ORACLE — success rate is the first
 * number the live report prints; latency is the second. A run whose oracle
 * fails is excluded from the latency medians and reported in the failures
 * section. `runOracle` is pure (taskDir, scratchCwd) → verdict: it reads
 * the task dir / the scratch cwd and decides — it never throws (unreadable
 * → fail with detail).
 *
 * Oracle kinds (the shipped battery uses the first three):
 *   data-match    — result.json `data.content` equals the expected string
 *                   (exact) — the typed-harvest contract
 *   file-content  — a scratch-cwd file byte-equals the expected content
 *   line-count    — a scratch-cwd file has exactly N lines
 *   result-text   — the task settled `completed` AND result.md (the harvest
 *                   text) contains the expected substring — the
 *                   fixture-compatible kind the hermetic driver tests use
 *                   (the fake-pi fixture ignores prompts, so the three real
 *                   kinds are not testable hermetically)
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// the shape

/** A file the driver materializes in the per-run scratch cwd before dispatch. */
export interface CwdFile {
	name: string;
	content: string;
}

/** The oracle descriptor (the versioned content — the pure interpreter is `runOracle`). */
export type OracleSpec =
	| { kind: "data-match"; expected: string }
	| { kind: "file-content"; file: string; expected: string }
	| { kind: "line-count"; file: string; expected: number }
	| { kind: "result-text"; contains: string };

export interface OracleVerdict {
	pass: boolean;
	/** The human-readable reason (the failures section). */
	detail: string;
}

export interface BatteryEntry {
	/** The battery id (the history record's `battery` param carries the ids). */
	id: string;
	/** The seat (a pi agent name from the local seats). */
	agent: string;
	/** The task text, verbatim (the brief the worker gets). */
	task: string;
	/** Optional — the typed-harvest contract (the worker's `vitrine_done` `data` must satisfy it). */
	schema?: Record<string, unknown>;
	/** The files the driver writes into the scratch cwd before dispatch. */
	cwdFiles?: CwdFile[];
	oracle: OracleSpec;
	/** Task-level budgets (spec fields) — bound pathological runs. Defaults: 900 / 600. */
	timeout_s?: number;
	inactivity_s?: number;
}

// ---------------------------------------------------------------------------
// the oracles (pure: never throw — unreadable → fail with detail)

/** Count a file's lines (a trailing newline does not add a phantom line). */
function lineCount(raw: string): number {
	const lines = raw.split("\n");
	if (lines[lines.length - 1] === "") lines.pop();
	return lines.length;
}

/**
 * The pure oracle: (taskDir, scratchCwd) → verdict. Every leg degrades to a
 * fail verdict with a detail — the oracle never throws.
 */
export async function runOracle(oracle: OracleSpec, taskDir: string, scratchCwd: string): Promise<OracleVerdict> {
	const fail = (detail: string): OracleVerdict => ({ pass: false, detail });
	try {
		switch (oracle.kind) {
			case "data-match": {
				const raw = await readFile(join(taskDir, "result.json"), "utf8").catch(() => null);
				if (raw === null) return fail("data-match: result.json missing or unreadable");
				let data: unknown;
				try {
					data = JSON.parse(raw);
				} catch {
					return fail("data-match: result.json is malformed JSON");
				}
				const content = typeof data === "object" && data !== null ? (data as Record<string, unknown>)["content"] : undefined;
				if (typeof content !== "string") return fail("data-match: data.content missing or not a string");
				return content === oracle.expected ? { pass: true, detail: "data-match: content matches exactly" } : fail(`data-match: content differs (${content.length} chars vs ${oracle.expected.length})`);
			}
			case "file-content": {
				const raw = await readFile(join(scratchCwd, oracle.file), "utf8").catch(() => null);
				if (raw === null) return fail(`file-content: ${oracle.file} missing or unreadable`);
				return raw === oracle.expected ? { pass: true, detail: `file-content: ${oracle.file} matches byte-for-byte` } : fail(`file-content: ${oracle.file} differs (${raw.length} chars vs ${oracle.expected.length})`);
			}
			case "line-count": {
				const raw = await readFile(join(scratchCwd, oracle.file), "utf8").catch(() => null);
				if (raw === null) return fail(`line-count: ${oracle.file} missing or unreadable`);
				const n = lineCount(raw);
				return n === oracle.expected ? { pass: true, detail: `line-count: ${oracle.file} has ${n} lines` } : fail(`line-count: ${oracle.file} has ${n} lines (expected ${oracle.expected})`);
			}
			case "result-text": {
				const stateRaw = await readFile(join(taskDir, "state.json"), "utf8").catch(() => null);
				let state: unknown = null;
				if (stateRaw !== null) {
					try {
						state = (JSON.parse(stateRaw) as Record<string, unknown>).state;
					} catch {
						state = null;
					}
				}
				if (state !== "completed") return fail(`result-text: state is ${state === null ? "unreadable" : String(state)} (expected completed)`);
				const raw = await readFile(join(taskDir, "result.md"), "utf8").catch(() => null);
				if (raw === null) return fail("result-text: result.md missing or unreadable");
				return raw.includes(oracle.contains) ? { pass: true, detail: "result-text: harvest contains the expected text" } : fail("result-text: harvest does not contain the expected text");
			}
		}
	} catch (e) {
		return fail(`oracle error: ${e instanceof Error ? e.message : String(e)}`);
	}
}

// ---------------------------------------------------------------------------
// the battery (the versioned content)

/** The read-ground fixture file: a distinctive list of vitrine protocol facts (~15 lines). */
export const READ_GROUND_CONTENT = [
	"vitrine protocol — ground facts",
	"1. A task dir lives at ~/.vitrine/tasks/<uuid>/: the dir is 0700, its files 0600.",
	"2. spec.json is the only parent→worker transport — written once, read-only afterwards.",
	"3. state.json is monotonic: a state never moves backwards, terminal states never rewrite.",
	"4. The worker signals completion with vitrine_done, which writes result.md and done.marker.",
	"5. The wrapper is the watchdog: wall timeout, inactivity window, optional cost budget.",
	"6. A foot tile when the compositor is reachable; a detached headless worker when it is not.",
	"7. Every protocol fact is appended to events.jsonl — the append-only audit log.",
	"8. The dispatcher polls state.json until every admitted task is terminal.",
	"9. Killing a queued task settles it immediately; killing a live worker signals the recorded pid only after a start-time match.",
	"10. The worker's session file is recorded in session.json (session_file).",
	"11. An adopted task is live at admission but was dispatched by an earlier call.",
	"12. The deferred harvest covers tasks that went terminal between dispatch calls.",
	"13. The owner lease (30 s window) keeps a stuck-queued task from being settled by a foreign reconcile.",
	"14. Anti-recycling liveness reads the /proc start-time plus the boot_id — a recycled pid never reads as live.",
	"15. A reboot kills the workers but not the record: stale running tasks settle to crashed with a partial harvest.",
].join("\n") + "\n";

/** The bounded-write expected file: exactly these 10 lines, trailing newline. */
export const BOUNDED_WRITE_LINES = [
	"vitrine line 1 of 10",
	"vitrine line 2 of 10",
	"vitrine line 3 of 10",
	"vitrine line 4 of 10",
	"vitrine line 5 of 10",
	"vitrine line 6 of 10",
	"vitrine line 7 of 10",
	"vitrine line 8 of 10",
	"vitrine line 9 of 10",
	"vitrine line 10 of 10",
];
export const BOUNDED_WRITE_CONTENT = BOUNDED_WRITE_LINES.join("\n") + "\n";

/** The three tasks. Each is small; each has an outcome oracle. */
export const BATTERY: BatteryEntry[] = [
	{
		id: "read-ground",
		agent: "explore",
		task: [
			"Read the file facts.txt in your working directory.",
			"Then finish with vitrine_done: in the `data` payload, set `content` to the file's exact content —",
			"every line, byte for byte, with no additions, omissions, or rewording (the payload is the contract;",
			"your prose answer can be a single line).",
		].join(" "),
		schema: {
			type: "object",
			properties: { content: { type: "string" } },
			required: ["content"],
		},
		cwdFiles: [{ name: "facts.txt", content: READ_GROUND_CONTENT }],
		oracle: { kind: "data-match", expected: READ_GROUND_CONTENT },
		timeout_s: 900,
		inactivity_s: 600,
	},
	{
		id: "bounded-write",
		agent: "execute",
		task: [
			`Write a file named out.txt in your working directory containing exactly the following 10 lines — one per line, in this order, with a trailing newline after the last line:`,
			BOUNDED_WRITE_LINES.join("\n"),
			"Verify with: cat out.txt — every line must match the ten lines above exactly. Then finish with vitrine_done.",
		].join("\n"),
		oracle: { kind: "file-content", file: "out.txt", expected: BOUNDED_WRITE_CONTENT },
		timeout_s: 900,
		inactivity_s: 600,
	},
	{
		id: "decode-proxy",
		agent: "execute",
		task: [
			"Write a file named lines.txt in your working directory containing exactly 100 lines: the numbers",
			"1 through 100, one number per line, in ascending order, with a trailing newline after the last line.",
			"Verify with: wc -l lines.txt — the file must have exactly 100 lines. Then finish with vitrine_done.",
		].join(" "),
		oracle: { kind: "line-count", file: "lines.txt", expected: 100 },
		timeout_s: 900,
		inactivity_s: 600,
	},
];
