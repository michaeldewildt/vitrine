/**
 * conformance.test.ts — the conformance canary.
 *
 * fake-pi is a SHAPED-LIKE fixture, not pi: this test runs it and asserts —
 * for every FIELD THE COLLECTOR READS — that the fixture's session output
 * and the real (anonymized, text-truncated) sample agree in TYPE and
 * PRESENCE. The known, documented exceptions are the named allow-lists
 * below (FIXTURE_OMITS / VALUE_DRIFT_OK).
 *
 * What this actually pins: fixture↔sample drift, for every field the
 * collector reads. The sample is a FROZEN capture of real pi, so a field
 * rename in a FUTURE real pi changes neither side and this test stays green
 * — it cannot see a pi upgrade. The guard is against the FIXTURE drifting
 * from the shape the collector was built against, not against pi itself:
 * a pi upgrade that changes the session shape requires regenerating
 * test/fixtures/pi-session-sample.jsonl (a fresh capture) before the bench
 * can trust the collector's fields.
 */
import { describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSessionEntries, sessionDirFor } from "../session";

const SAMPLE = join(import.meta.dir, "..", "..", "test", "fixtures", "pi-session-sample.jsonl");
const FIXTURE_PI = join(import.meta.dir, "..", "..", "test", "fixtures", "fake-pi.ts");

// ---------------------------------------------------------------------------
// the allow-lists (the known, documented exceptions)

/**
 * Fields the collector reads that the REAL pi shape carries but the FIXTURE
 * OMITS. `reasoning` is optional in the shape — the collector treats a
 * missing value as absent (null), so the omission is expected and pinned
 * here.
 */
const FIXTURE_OMITS: readonly string[] = ["usage.reasoning"];

/**
 * Fields whose VALUES legitimately differ between the fixture and real pi
 * (the fixture pins its own api/provider/model identity) — presence and
 * type must still agree.
 */
const VALUE_DRIFT_OK: readonly string[] = ["message.api", "message.provider", "message.model"];

// ---------------------------------------------------------------------------
// the field table (every field the collector reads, per role)

/**
 * The collector reads, from every message entry: the entry identity (type,
 * id, parentId, the ISO `timestamp`) and `message.role` (the assistant
 * filter). From assistant entries it additionally reads
 * `message.usage.{input,output,cacheRead,cacheWrite,totalTokens,cost.*}` +
 * the optional `reasoning`, and `message.timestamp` (epoch ms) for the
 * tokens-per-second span.
 */
const COMMON_FIELDS: Array<{ path: string; type: "string" | "string|null" | "number" }> = [
	{ path: "entry.type", type: "string" },
	{ path: "entry.id", type: "string" },
	{ path: "entry.parentId", type: "string|null" },
	{ path: "entry.timestamp", type: "string" },
	{ path: "message.role", type: "string" },
	{ path: "message.timestamp", type: "number" },
];
const ASSISTANT_FIELDS: Array<{ path: string; type: "string" | "string|null" | "number" }> = [
	...COMMON_FIELDS,
	{ path: "usage.input", type: "number" },
	{ path: "usage.output", type: "number" },
	{ path: "usage.cacheRead", type: "number" },
	{ path: "usage.cacheWrite", type: "number" },
	{ path: "usage.totalTokens", type: "number" },
	{ path: "usage.reasoning", type: "number" }, // in FIXTURE_OMITS on the fixture side
	{ path: "usage.cost.input", type: "number" },
	{ path: "usage.cost.output", type: "number" },
	{ path: "usage.cost.cacheRead", type: "number" },
	{ path: "usage.cost.cacheWrite", type: "number" },
	{ path: "usage.cost.total", type: "number" },
];

/** Resolve a dotted path (`entry.*` / `message.*` / `usage.*`) against the entry. */
function valueAt(e: Record<string, unknown>, path: string): unknown {
	const [head, ...rest] = path.split(".");
	const m = typeof e.message === "object" && e.message !== null ? (e.message as Record<string, unknown>) : undefined;
	const root: unknown = head === "entry" ? e : head === "message" ? m : m?.usage;
	let o: unknown = root;
	for (const part of rest) {
		if (typeof o !== "object" || o === null) return undefined;
		o = (o as Record<string, unknown>)[part];
	}
	return o;
}

function typeOf(v: unknown, expect: "string" | "string|null" | "number"): boolean {
	if (expect === "string") return typeof v === "string";
	if (expect === "number") return typeof v === "number" && Number.isFinite(v);
	if (expect === "string|null") return v === null || typeof v === "string";
	return false;
}

/** Run fake-pi (clean mode) in a tmp env; returns its session file path. */
async function runFixturePi(): Promise<{ file: string; cleanup: () => Promise<void> }> {
	const tmp = await mkdtemp(join(tmpdir(), "vitrine-bench-conf-"));
	const sessionsRoot = join(tmp, "sessions");
	const cwd = join(tmp, "work");
	await mkdir(cwd, { recursive: true });
	await new Promise<void>((res) => {
		const child = spawn(process.execPath, [FIXTURE_PI, "--name", "conf · canary"], {
			cwd,
			env: { ...process.env, VITRINE_FIXTURE_MODE: "clean", VITRINE_FIXTURE_GAP_MS: "20", VITRINE_SESSIONS_DIR: sessionsRoot },
			stdio: "ignore",
		});
		child.once("exit", () => res());
	});
	// the fixture writes to the cwd-keyed slug dir (no --session-dir flag)
	const dir = sessionDirFor(cwd, sessionsRoot);
	const files = await readdir(dir);
	const jsonl = files.find((f) => f.endsWith(".jsonl"));
	if (jsonl === undefined) throw new Error(`no session file in ${dir} (files: ${files.join(", ") || "none"})`);
	return { file: join(dir, jsonl), cleanup: () => rm(tmp, { recursive: true, force: true }) };
}

describe("conformance: fake-pi vs the real pi session shape", () => {
	it("the fixture output agrees with the real sample in type and presence for every field the collector reads", async () => {
		const { file: fixtureFile, cleanup } = await runFixturePi();
		try {
			const sample = await parseSessionEntries(SAMPLE);
			const fixture = await parseSessionEntries(fixtureFile);
			expect(sample.skipped, "sample: every line parses").toBe(0);
			expect(fixture.skipped, "fixture: every line parses").toBe(0);

			const messagesOf = (entries: Array<Record<string, unknown>>): Array<Record<string, unknown>> =>
				entries.filter((e) => e.type === "message" && typeof e.message === "object" && e.message !== null);
			const sampleMsgs = messagesOf(sample.entries);
			const fixtureMsgs = messagesOf(fixture.entries);

			// the same message shape, in the same order: user, assistant,
			// toolResult, assistant
			expect(sampleMsgs.map((m) => (m.message as Record<string, unknown>).role)).toEqual(["user", "assistant", "toolResult", "assistant"]);
			expect(fixtureMsgs.map((m) => (m.message as Record<string, unknown>).role)).toEqual(["user", "assistant", "toolResult", "assistant"]);

			type Msg = Record<string, unknown>;
			const checkField = (side: string, e: Msg, f: { path: string; type: "string" | "string|null" | "number" }): void => {
				const omitted = side === "fixture" && FIXTURE_OMITS.includes(f.path);
				const v = valueAt(e, f.path);
				if (omitted) {
					// a documented fixture omission — pinned here: the field
					// must be absent in the fixture (if the fixture re-adds it,
					// this assertion flips and forces the allow-list pruned)
					expect(v, `${side}: ${f.path} is a documented fixture omission — must stay absent`).toBeUndefined();
					return;
				}
				expect(v !== undefined, `${side}: ${f.path} must be present`).toBe(true);
				expect(typeOf(v, f.type), `${side}: ${f.path} must be of type ${f.type} (got ${v === null ? "null" : typeof v})`).toBe(true);
			};

			for (const [side, msgs] of [["sample", sampleMsgs], ["fixture", fixtureMsgs]] as const) {
				for (const m of msgs) {
					const isAssistant = (m.message as Record<string, unknown>).role === "assistant";
					for (const f of isAssistant ? ASSISTANT_FIELDS : COMMON_FIELDS) checkField(side, m, f);
				}
			}

			// the structural values that are NOT free to drift
			for (const [side, msgs] of [["sample", sampleMsgs], ["fixture", fixtureMsgs]] as const) {
				for (const m of msgs) {
					expect(m.type, `${side}: entry.type`).toBe("message");
					const ts = m.timestamp;
					expect(typeof ts, `${side}: entry.timestamp is a string`).toBe("string");
					expect(Number.isNaN(Date.parse(String(ts))), `${side}: entry.timestamp is ISO (parses)`).toBe(false);
					const mts = (m.message as Record<string, unknown>).timestamp;
					expect(typeof mts, `${side}: message.timestamp is epoch ms (a number)`).toBe("number");
				}
				// the value-drift allow-list: presence asserted above, the
				// values are the fixture's own (documented)
				for (const p of VALUE_DRIFT_OK) {
					for (const m of msgs.filter((x) => (x.message as Record<string, unknown>).role === "assistant")) {
						expect(valueAt(m, p) !== undefined, `${side}: ${p} must be present (value drift is allowed)`).toBe(true);
					}
				}
			}

			// the sample carries the documented `reasoning` field (the
			// fixture's omission is the exception, not the other way round)
			for (const m of sampleMsgs.filter((x) => (x.message as Record<string, unknown>).role === "assistant")) {
				expect(typeOf(valueAt(m, "usage.reasoning"), "number"), "sample: usage.reasoning is a number").toBe(true);
			}
		} finally {
			await cleanup();
		}
	});
});
