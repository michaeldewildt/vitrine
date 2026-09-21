/**
 * config.test.ts — verification: config read/validate, the
 * 0600 first-creation, root resolution (env > default), run_path resolution
 * per mode.
 * Hermetic: HOME points at a tmp dir so `~/.vitrine/config.json`,
 * `~/.local/bin/vitrine-run` and the default roots are all under test control.
 */
import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_DEFAULTS, ConfigError, configPath, defaultLocalBin, readConfigSync, resolveRunPath, sessionsRootOf, tasksRootOf, wrapperRootEnv,
} from "./config";
import { ProtocolError } from "./protocol";
let base: string;
const realHome = process.env.HOME;
const savedConfig = process.env.VITRINE_CONFIG;
const savedTasks = process.env.VITRINE_TASKS_ROOT;
const savedSessions = process.env.VITRINE_SESSIONS_DIR;
beforeAll(async () => {
	base = await mkdtemp(join(tmpdir(), "vitrine-config-"));
	process.env.HOME = base;
	delete process.env.VITRINE_CONFIG;
	delete process.env.VITRINE_TASKS_ROOT;
	delete process.env.VITRINE_SESSIONS_DIR;
});
afterAll(async () => {
	process.env.HOME = realHome;
	if (savedConfig !== undefined) process.env.VITRINE_CONFIG = savedConfig;
	else delete process.env.VITRINE_CONFIG;
	if (savedTasks !== undefined) process.env.VITRINE_TASKS_ROOT = savedTasks;
	else delete process.env.VITRINE_TASKS_ROOT;
	if (savedSessions !== undefined) process.env.VITRINE_SESSIONS_DIR = savedSessions;
	else delete process.env.VITRINE_SESSIONS_DIR;
	await rm(base, { recursive: true, force: true });
});
const cfgPath = () => join(base, ".vitrine", "config.json");
/** Assert the rejection carries the given protocol code. */
async function rejectsCfg(code: string, fn: () => unknown | Promise<unknown>): Promise<void> {
	try {
		await fn();
	}
	catch (e) {
		if (e instanceof ProtocolError && e.code === code) return;
		throw new Error(`expected protocol code '${code}', got: ${String(e)}`);
	}
	throw new Error(`expected rejection with code '${code}', resolved instead`);
}
async function writeCfg(obj: unknown): Promise<void> {
	await mkdir(join(base, ".vitrine"), { recursive: true });
	await writeFile(cfgPath(), typeof obj === "string" ? obj : JSON.stringify(obj, null, 2));
}
describe("readConfigSync", () => {
	it("an absent file is created with the defaults, 0600 (the pin)", async () => {
		expect(await readConfigSync()).toEqual({ ...CONFIG_DEFAULTS });
		const st = await stat(cfgPath());
		expect(st.mode & 0o777).toBe(0o600);
		const onDisk = JSON.parse(await Bun.file(cfgPath()).text());
		expect(onDisk).toEqual(CONFIG_DEFAULTS);
		// a second read parses the file (idempotent)
expect(await readConfigSync()).toEqual({ ...CONFIG_DEFAULTS });
});
it("round-trips every key", async () => {
	await writeCfg({ workspace: 4, max_concurrent: 3, wall_timeout_s: 999, inactivity_s: 900, auto_settle_s: 300, auto_settle_grace_s: 10, completed_close_s: 30, retention_days: 30, run_path: join(base, "vitrine-run"), });
	expect(await readConfigSync()).toEqual({ workspace: 4, max_concurrent: 3, wall_timeout_s: 999, inactivity_s: 900, auto_settle_s: 300, auto_settle_grace_s: 10, completed_close_s: 30, retention_days: 30, run_path: join(base, "vitrine-run"), });
});
it("a partial config fills the rest from the defaults", async () => {
	await writeCfg({ max_concurrent: 3 });
	const cfg = await readConfigSync();
	expect(cfg.max_concurrent).toBe(3);
	expect(cfg.workspace).toBe(CONFIG_DEFAULTS.workspace);
	expect(cfg.wall_timeout_s).toBe(CONFIG_DEFAULTS.wall_timeout_s);
});
it("completed_close_s: 0 is accepted (never auto-close)", async () => {
	await writeCfg({ completed_close_s: 0 });
	const cfg = await readConfigSync();
	expect(cfg.completed_close_s).toBe(0);
	expect(cfg.auto_settle_s).toBe(CONFIG_DEFAULTS.auto_settle_s);
});
const badCases: Array<[string, unknown]
> = [ ["non-JSON", "{ not json"]
, ["array", [1]
]
, ["string", "\"vitrine\""]
, ["non-integer workspace", { workspace: 4.5 }
]
, ["zero max_concurrent", { max_concurrent: 0 }
]
, ["negative wall_timeout_s", { wall_timeout_s: -10 }
]
, ["string inactivity_s", { inactivity_s: "900" }
]
, ["workspace too big", { workspace: 100 }
]
, ["max_concurrent too big", { max_concurrent: 100 }
]
, ["negative completed_close_s", { completed_close_s: -1 }
]
, ["non-integer completed_close_s", { completed_close_s: 1.5 }
]
, ["relative run_path", { run_path: "vitrine-run" }
]
, ["empty run_path", { run_path: "" }
]
, ];
for (const [name, obj]
of badCases) {
	it(`rejects ${name} (bad-config)`, async () => {

// a private config path: a poisoned default file must not leak into
// the other suites (they expect the clean default state)
const alt = join(base, `bad-${Math.random().toString(36).slice(2)}.json`);
await writeFile(alt, typeof obj === "string" ? obj : JSON.stringify(obj));
process.env.VITRINE_CONFIG = alt;
try {
	await rejectsCfg("bad-config", readConfigSync);
}
	finally { delete process.env.VITRINE_CONFIG;
}
});
}
it("a VITRINE_CONFIG override is honoured", async () => {
	const alt = join(base, "alt-config.json");
	await writeFile(alt, JSON.stringify({ max_concurrent: 4 }));
	process.env.VITRINE_CONFIG = alt;
	try {
		expect(configPath()).toBe(alt);
		expect((await readConfigSync()).max_concurrent).toBe(4);
	}
		finally { delete process.env.VITRINE_CONFIG;
	}
});

	});
	describe("root resolution (env > default)", () => {
		it("defaults when nothing is set", async () => {
			const cfg = await readConfigSync();
			expect(tasksRootOf(cfg)).toBe(join(base, ".vitrine", "tasks"));
			expect(sessionsRootOf(cfg)).toBe(join(base, ".pi", "agent", "sessions"));
		});
		it("env wins over the default", async () => {
			process.env.VITRINE_TASKS_ROOT = join(base, "env-tasks");
			process.env.VITRINE_SESSIONS_DIR = join(base, "env-sessions");
			try {
				const cfg = await readConfigSync();
				expect(tasksRootOf(cfg)).toBe(join(base, "env-tasks"));
				expect(sessionsRootOf(cfg)).toBe(join(base, "env-sessions"));
			}
				finally { delete process.env.VITRINE_TASKS_ROOT;
				delete process.env.VITRINE_SESSIONS_DIR;
			}
		});
		it("wrapperRootEnv carries both roots explicitly", async () => {
			const cfg = await readConfigSync();
			expect(wrapperRootEnv(cfg)).toEqual({ VITRINE_TASKS_ROOT: join(base, ".vitrine", "tasks"), VITRINE_SESSIONS_DIR: join(base, ".pi", "agent", "sessions"), });
		});
	});
	describe("resolveRunPath", () => {
		// `base` is only known after beforeAll — compute lazily (the describe body // runs at collection time).
const bunBin = () => join(base, "bun");
it("headless: the in-place fallback (no run_path, no local bin)", async () => {
	const cfg = await readConfigSync();
	const rp = resolveRunPath(cfg, "headless", bunBin());
	expect(rp.source).toBe("in-place");
	expect(rp.command).toBe(bunBin());
	expect(rp.args.length).toBe(1);
	expect(rp.args[0])
	.toContain("src/vitrine-run.ts");
});
it("headless: a non-executable run_path is run by bun", async () => {
	const entry = join(base, "vitrine-entry.ts");
	await writeFile(entry, "// entry\n");
	const cfg = { ...CONFIG_DEFAULTS, run_path: entry };
	const rp = resolveRunPath(cfg, "headless", bunBin());
		expect(rp).toEqual({ command: bunBin(), args: [entry]
	, source: "config" });
});
it("headless: an executable run_path runs directly", async () => {
	const entry = join(base, "vitrine-exec");
	await writeFile(entry, "#!/bin/sh\n");
	await chmod(entry, 0o755);
	const cfg = { ...CONFIG_DEFAULTS, run_path: entry };
	const rp = resolveRunPath(cfg, "headless", bunBin());
		expect(rp).toEqual({ command: entry, args: []
	, source: "config" });
});
it("headless: the local bin wins over the in-place fallback", async () => {
	await mkdir(join(base, ".local", "bin"), { recursive: true });
	await writeFile(defaultLocalBin(), "#!/bin/sh\n");
	await chmod(defaultLocalBin(), 0o755);
	try {
		const cfg = await readConfigSync();
		const rp = resolveRunPath(cfg, "headless", bunBin());
			expect(rp).toEqual({ command: defaultLocalBin(), args: []
		, source: "local-bin" });
	}
		finally { await rm(defaultLocalBin(), { force: true });
	}
});
it("tile: a direct-executable run_path runs directly", async () => {
	const entry = join(base, "vitrine-exec");
	await writeFile(entry, "#!/bin/sh\n");
	await chmod(entry, 0o755);
	const rp = resolveRunPath({ ...CONFIG_DEFAULTS, run_path: entry }
	, "tile", bunBin());
		expect(rp).toEqual({ command: entry, args: []
	, source: "config" });
});
it("tile: a non-executable run_path is rejected (the dispatch string cannot carry bun args)", async () => {
	const entry = join(base, "vitrine-entry.ts");
	await writeFile(entry, "// entry\n");
	await rejectsCfg("bad-config", () => resolveRunPath({ ...CONFIG_DEFAULTS, run_path: entry }
	, "tile", bunBin()));
});
it("tile: no run_path and no local bin is a hard error (no in-place fallback)", async () => {
	const cfg = await readConfigSync();
	await rejectsCfg("bad-config", () => resolveRunPath(cfg, "tile", bunBin()));
});
it("tile: the local bin works", async () => {
	await mkdir(join(base, ".local", "bin"), { recursive: true });
	await writeFile(defaultLocalBin(), "#!/bin/sh\n");
	await chmod(defaultLocalBin(), 0o755);
	try {
		const cfg = await readConfigSync();
		const rp = resolveRunPath(cfg, "tile", bunBin());
		expect(rp.source).toBe("local-bin");
	}
		finally { await rm(defaultLocalBin(), { force: true });
	}
});
it("a missing run_path is a bad-config error", async () => {
	await rejectsCfg("bad-config", () => resolveRunPath({ ...CONFIG_DEFAULTS, run_path: join(base, "nope") }
	, "headless", bunBin()));
});
it("a stale (dangling) run_path symlink is the same failure", async () => {
	const link = join(base, "stale-link");
	await Bun.write(join(base, "real-entry"), "x\n");

// fs.symlinkSync via Bun
const { symlinkSync }
= await import("node:fs");
symlinkSync(join(base, "missing-target"), link);
await rejectsCfg("bad-config", () => resolveRunPath({ ...CONFIG_DEFAULTS, run_path: link }
, "headless", bunBin()));
});
it("headless: the in-place fallback without a bun binary is a caller bug (defensive)", async () => {
	const cfg = await readConfigSync();
	await rejectsCfg("bad-config", () => resolveRunPath(cfg, "headless"));
});
it("headless: a non-executable run_path without a bun binary is the same caller bug (defensive)", async () => {
	const entry = join(base, "vitrine-entry2.ts");
	await writeFile(entry, "// entry\n");
	await rejectsCfg("bad-config", () => resolveRunPath({ ...CONFIG_DEFAULTS, run_path: entry }
	, "headless"));
});

	});

