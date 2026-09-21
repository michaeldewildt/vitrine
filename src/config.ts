/**
 * config.ts — vitrine's configuration.
 *
 * `~/.vitrine/config.json` (0600; path overridable via `VITRINE_CONFIG` for
 * tests). All keys optional. An absent
 * file is CREATED with the defaults (best-effort: `wx`-guarded, the loser
 * of a concurrent first-creation re-reads) so a later `cat`/edit sees the
 * documented shape.
 *
 * Precedence (per-call field > agent frontmatter > config). The
 * agent-frontmatter leg is applied by the dispatch tool (it parsed the
 * frontmatter at agent resolution); this module owns the config leg and the
 * defaults.
 *
 * `VITRINE_TASKS_ROOT` / `VITRINE_SESSIONS_DIR` are test hooks, not config
 * keys (the wrapper reads them directly and never touches this file); the
 * dispatch tool and the CLI resolve the roots here and propagate them to
 * the wrapper's env at spawn time.
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import * as P from "./protocol";

/** This repo's root (config.ts lives in src/). The in-place `run_path` fallback. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Defaults are computed at CALL time (tests override `$HOME` per-file — and
// Bun snapshots `os.homedir()` at startup, so the env var is read directly).
function home(): string {
	return process.env.HOME ?? homedir();
}
export function defaultConfigPath(): string {
	return join(home(), ".vitrine", "config.json");
}
export function defaultTasksRoot(): string {
	return join(home(), ".vitrine", "tasks");
}
export function defaultSessionsRoot(): string {
	return join(home(), ".pi", "agent", "sessions");
}
export function defaultLocalBin(): string {
	return join(home(), ".local", "bin", "vitrine-run");
}

export interface VitrineConfig {
	/** Preferred workspace for tile spawns (9). */
	workspace: number;
	/** Concurrency cap per invocation, cross-session count (2). */
	max_concurrent: number;
	/** Default wall-clock budget, seconds (3600). */
	wall_timeout_s: number;
	/** Default inactivity watchdog, seconds (600). */
	inactivity_s: number;
	/** Default auto-settle idle window, seconds (600). */
	auto_settle_s: number;
	/** Auto-settle: how long the tile must be unfocused first, seconds (60). */
	auto_settle_grace_s: number;
	/** Auto-close for completed tiles: how long the tile must be unfocused AND idle before the wrapper closes it, seconds. 0 = never (600). */
	completed_close_s: number;
	/** `vitrine gc` retention, days from `finished_at` (14). */
	retention_days: number;
	/** Explicit vitrine-run entry: a direct executable, or — headless only — a file run by bun. */
	run_path?: string;
}

export const CONFIG_DEFAULTS: Omit<VitrineConfig, "run_path"> = {
	workspace: 9,
	max_concurrent: 2,
	wall_timeout_s: 3600,
	inactivity_s: 600,
	auto_settle_s: 600,
	auto_settle_grace_s: 60,
	completed_close_s: 600,
	retention_days: 14,
};

export class ConfigError extends P.ProtocolError {
	constructor(message: string) {
		super("bad-config", message);
		this.name = "ConfigError";
	}
}

export function configPath(): string {
	return process.env.VITRINE_CONFIG ?? defaultConfigPath();
}

/**
 * Read + validate the config. An absent file is created with the defaults
 * (0600, `wx`-guarded, best-effort); a present file that fails to parse or
 * type-check is a `bad-config` — never a silent partial.
 */
export function readConfigSync(): VitrineConfig {
	const p = configPath();
	let raw: string;
	try {
		raw = readFileSync(p, "utf8");
	} catch (e: unknown) {
		if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
		return firstCreation(p);
	}
	return parseConfig(raw, p);
}

/** First creation: a best-effort defaults file (0600, `wx` guard) + re-read. */
function firstCreation(p: string): VitrineConfig {
	try {
		mkdirSync(dirname(p), { recursive: true });
		writeFileSync(p, `${JSON.stringify(CONFIG_DEFAULTS, null, 2)}\n`, { flag: "wx", mode: 0o600 });
	} catch {
		// EEXIST — a concurrent first-creation won — or an unwritable dir.
	}
	try {
		return parseConfig(readFileSync(p, "utf8"), p);
	} catch {
		// Best-effort file: an unwritable/unreadable root is not a config
		// load failure — the defaults stand in memory.
		return { ...CONFIG_DEFAULTS };
	}
}

/** Parse + validate. A present file that fails is a `bad-config`. */
function parseConfig(raw: string, p: string): VitrineConfig {
	let o: unknown;
	try {
		o = JSON.parse(raw);
	} catch (e: unknown) {
		throw new ConfigError(`config file is not valid JSON: ${p} — ${(e as Error).message}`);
	}
	if (typeof o !== "object" || o === null || Array.isArray(o)) {
		throw new ConfigError(`config file must be a JSON object: ${p}`);
	}
	const c = o as Record<string, unknown>;
	const out: VitrineConfig = { ...CONFIG_DEFAULTS };
	const intKeys = ["workspace", "max_concurrent", "wall_timeout_s", "inactivity_s", "auto_settle_s", "auto_settle_grace_s", "retention_days"] as const;
	for (const k of intKeys) {
		const v = c[k];
		if (v === undefined) continue;
		if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
			throw new ConfigError(`config key '${k}' must be a positive integer`);
		}
		out[k] = v;
	}
	// completed_close_s is the only tunable where 0 is meaningful (never
	// auto-close a completed tile); the intKeys above reject 0.
	if (c.completed_close_s !== undefined) {
		if (typeof c.completed_close_s !== "number" || !Number.isInteger(c.completed_close_s) || (c.completed_close_s as number) < 0) {
			throw new ConfigError("config key 'completed_close_s' must be a non-negative integer (0 = never auto-close)");
		}
		out.completed_close_s = c.completed_close_s;
	}
	if (out.workspace > 99) throw new ConfigError("config key 'workspace' must be ≤ 99");
	if (out.max_concurrent > 99) throw new ConfigError("config key 'max_concurrent' must be ≤ 99");
	if (c.run_path !== undefined) {
		if (typeof c.run_path !== "string" || c.run_path === "") throw new ConfigError("config key 'run_path' must be a non-empty string");
		if (!isAbsolute(c.run_path)) throw new ConfigError(`config key 'run_path' must be an absolute path, got '${c.run_path}'`);
		out.run_path = c.run_path;
	}
	return out;
}

/** Tasks root: env > default. The dispatcher propagates this to the wrapper as `VITRINE_TASKS_ROOT`. */
export function tasksRootOf(cfg: VitrineConfig): string {
	return process.env.VITRINE_TASKS_ROOT ?? defaultTasksRoot();
}

/** Sessions root: env > default. The dispatcher propagates this to the wrapper as `VITRINE_SESSIONS_DIR`. */
export function sessionsRootOf(cfg: VitrineConfig): string {
	return process.env.VITRINE_SESSIONS_DIR ?? defaultSessionsRoot();
}

export interface RunPath {
	/** The wrapper command (an executable path or the bun binary). */
	command: string;
	/** The wrapper args (NOT including the task dir — the caller appends it). */
	args: string[];
	source: "config" | "local-bin" | "in-place";
}

/**
 * Where the wrapper entry lives, per mode:
 *
 * - `tile` — the DISPATCH STRING is the only transport to the wrapper:
 *   `run_path` must be a DIRECT executable (the compositor dispatch line
 *   cannot carry a bun interpreter argument), and the in-place fallback
 *   does not apply (it would name the dispatcher's repo, which the
 *   compositor's exec environment cannot assume).
 * - `headless` — the dispatcher spawns the wrapper itself, so a bun entry
 *   works: `run_path` may be an executable or a file bun runs; then the
 *   `~/.local/bin/vitrine-run` local bin; then the in-place
 *   `<repoRoot>/src/vitrine-run.ts` (valid for the in-place local-path
 *   install that is the default dev setup — probe: local packages register
 *   in place).
 */
export function resolveRunPath(cfg: VitrineConfig, mode: "tile" | "headless", bunBin?: string): RunPath {
	if (cfg.run_path !== undefined) {
		if (!isAbsolute(cfg.run_path)) throw new ConfigError(`config key 'run_path' must be an absolute path, got '${cfg.run_path}'`);
		if (!statSyncSafe(cfg.run_path)) throw new ConfigError(`run_path does not exist: ${cfg.run_path}`);
		const st = statSync(cfg.run_path);
		if (!st.isFile()) throw new ConfigError(`run_path is not a file: ${cfg.run_path}`);
		const executable = (st.mode & 0o111) !== 0;
		if (mode === "tile") {
			if (!executable) {
				throw new ConfigError(
					`tile mode needs a direct-executable run_path (the dispatch string cannot carry a bun interpreter argument): '${cfg.run_path}' — make it executable (chmod +x)`,
				);
			}
			return { command: cfg.run_path, args: [], source: "config" };
		}
		if (executable) {
			return { command: cfg.run_path, args: [], source: "config" };
		}
		// non-executable run_path in headless mode: run it with the dispatcher's
		// bun binary (headless-only input — tile mode must have thrown above).
		if (bunBin === undefined) {
			throw new ConfigError(`a non-executable run_path in headless mode needs the dispatcher's bun binary (bunBin) — internal: caller bug`);
		}
		return { command: bunBin, args: [cfg.run_path], source: "config" };
	}
	const local = defaultLocalBin();
	if (statSyncSafe(local)) {
		const st = statSync(local);
		if (st.isFile() && (st.mode & 0o111) !== 0) return { command: local, args: [], source: "local-bin" };
	}
	if (mode === "tile") {
		throw new ConfigError(
			"tile mode has no in-place wrapper fallback (the dispatch string needs a direct executable): set 'run_path' to an executable vitrine-run, or install one at ~/.local/bin/vitrine-run",
		);
	}
	// headless-only input: the in-place fallback needs the dispatcher's bun
	// binary. Tile mode never reaches this line without it (and must not —
	// it refuses the in-place fallback above), so `bunBin` is optional.
	if (bunBin === undefined) throw new ConfigError(`headless in-place fallback needs the dispatcher's bun binary (bunBin) — internal: caller bug`);
	return { command: bunBin, args: [join(REPO_ROOT, "src", "vitrine-run.ts")], source: "in-place" };
}

function statSyncSafe(p: string): boolean {
	try {
		statSync(p);
		return true;
	} catch {
		return false;
	}
}

/**
 * The env the dispatcher adds to the wrapper's spawn environment so the
 * wrapper's roots agree with the dispatcher's (the spec is the task payload;
 * the roots are regime plumbing and ride in the spawn env). Both are set
 * even when they equal the defaults — explicit is better than implicit at
 * the process boundary.
 */
export function wrapperRootEnv(cfg: VitrineConfig): Record<string, string> {
	return {
		VITRINE_TASKS_ROOT: tasksRootOf(cfg),
		VITRINE_SESSIONS_DIR: sessionsRootOf(cfg),
	};
}
