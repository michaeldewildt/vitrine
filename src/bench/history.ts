/**
 * history.ts — the bench history: append/read run records to
 * `state/bench/history.jsonl`, resolved repo-relative through the
 * `import.meta.url` chain (the CLI runs from the repo tree; `state/` is
 * gitignored — a history write must never show in `git status`).
 *
 * The record carries provenance (vitrine version + git sha, the pi
 * version, a hash of `~/.vitrine/config.json`) so a later run's baseline
 * comparison can say WHAT it is comparing against. Provenance collection
 * is best-effort: every leg degrades to null, never throws.
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BenchRow, Medians } from "./collector";

/** The repo root (history.ts lives in `src/bench/` — two levels up). */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export interface BenchProvenance {
	vitrine: { version: string; git_sha: string | null };
	/** `pi --version` output (first line), null on failure. */
	pi: string | null;
	/** sha256 of `~/.vitrine/config.json` contents, null when unreadable. */
	config: string | null;
}

/** The bench suites (one history file, both suites — records are suite-stamped). */
export type BenchSuite = "hermetic" | "live";

export interface HermeticParams {
	runs: number;
	gap_ms: number;
	cost: number;
	tick_sweep: boolean;
}

export interface LiveParams {
	runs: number;
	mode: "tile" | "headless";
	/** The battery entry ids (the versioned battery in battery.ts). */
	battery: string[];
}

export interface BenchHistoryRecord {
	ts: string;
	suite: BenchSuite;
	hostname: string;
	provenance: BenchProvenance;
	params: HermeticParams | LiveParams;
	rows: BenchRow[];
	medians: Medians;
}

/** The history file: `<repo>/state/bench/history.jsonl` (gitignored). */
export function historyPath(): string {
	return join(REPO_ROOT, "state", "bench", "history.jsonl");
}

/** Append one run record as a single JSONL line (creates `state/bench/`). */
export async function appendHistory(rec: BenchHistoryRecord, path: string = historyPath()): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await appendFile(path, `${JSON.stringify(rec)}\n`, "utf8");
}

/** Read the history leniently: a missing file → `[]`; malformed lines are skipped. */
export async function readHistory(path: string = historyPath()): Promise<BenchHistoryRecord[]> {
	const raw = await readFile(path, "utf8").catch((e: unknown) => {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw e;
	});
	if (raw === null) return [];
	const out: BenchHistoryRecord[] = [];
	for (const line of raw.split("\n")) {
		if (line.trim() === "") continue;
		try {
			const o = JSON.parse(line) as BenchHistoryRecord;
			if (typeof o.ts === "string" && (o.suite === "hermetic" || o.suite === "live")) out.push(o);
		} catch {
			// skip the malformed line — a corrupt history must not break a run
		}
	}
	return out;
}

/** The LAST record before `beforeTs` with the same suite + hostname (the baseline comparison). */
export function lastPriorFor(records: BenchHistoryRecord[], hostname: string, beforeTs: string, suite: BenchSuite = "hermetic"): BenchHistoryRecord | null {
	let last: BenchHistoryRecord | null = null;
	for (const r of records) {
		if (r.suite === suite && r.hostname === hostname && r.ts < beforeTs) last = r;
	}
	return last;
}

// ---------------------------------------------------------------------------
// provenance (all best-effort: null on failure, never throws)

function execFileP(cmd: string, args: string[], opts: { cwd?: string; timeout?: number } = {}): Promise<string> {
	return new Promise((res, rej) => {
		execFile(cmd, args, { timeout: opts.timeout ?? 5000, ...opts }, (e, stdout) => (e === null ? res(stdout) : rej(e)));
	});
}

/** The vitrine version from `package.json` (null when unreadable). */
export async function vitrineVersion(): Promise<string | null> {
	const raw = await readFile(join(REPO_ROOT, "package.json"), "utf8").catch(() => null);
	if (raw === null) return null;
	try {
		const v = (JSON.parse(raw) as { version?: unknown }).version;
		return typeof v === "string" && v !== "" ? v : null;
	} catch {
		return null;
	}
}

/** `git rev-parse --short HEAD` in the repo (null on failure). */
export async function gitSha(): Promise<string | null> {
	try {
		const out = (await execFileP("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO_ROOT })).trim();
		return out !== "" ? out : null;
	} catch {
		return null;
	}
}

/** `pi --version` (first line), null on failure. */
export async function piVersion(): Promise<string | null> {
	try {
		const out = await execFileP("pi", ["--version"], { timeout: 8000 });
		const line = out.split("\n").map((l) => l.trim()).find((l) => l !== "");
		return line !== undefined && line !== "" ? line : null;
	} catch {
		return null;
	}
}

/** sha256 of the vitrine config contents (`VITRINE_CONFIG` or `~/.vitrine/config.json`), null when absent. */
export async function configHash(): Promise<string | null> {
	const home = process.env.HOME ?? homedir();
	const p = process.env.VITRINE_CONFIG ?? join(home, ".vitrine", "config.json");
	const raw = await readFile(p, "utf8").catch(() => null);
	if (raw === null) return null;
	return createHash("sha256").update(raw).digest("hex");
}

/** Collect the full provenance (called BEFORE any env switch, so the config hash is the machine's). */
export async function collectProvenance(): Promise<BenchProvenance> {
	const [version, sha, pi, config] = await Promise.all([vitrineVersion(), gitSha(), piVersion(), configHash()]);
	return { vitrine: { version: version ?? "unknown", git_sha: sha }, pi, config };
}
