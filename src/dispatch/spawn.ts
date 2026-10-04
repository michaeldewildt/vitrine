/**
 * spawn.ts — the dispatch-side spawn construction: the
 * tile-spawn argv (the invariant) + the silent-route / background-join
 * flow (`spawnTile`), `issueSpawn` (the shared spawn dispatch: tile or
 * headless, with the immediate failure settle), the headless bun-bin
 * resolution, and the small shared formatting pieces (prompt header,
 * elapsed, short id — used by the core + the report + the wait loop).
 *
 * The tile flow (v2 — no focus, ever):
 * 1. **Prep** — ONE `clients -j`: the panel (the dispatcher's own window)
 *    + its group state + its workspace, and the pre-spawn worker pids.
 * 2. **Ensure-grouped** — the panel ungrouped ⇒ a compositor-atomic
 *    check-and-toggle IIFE (one round trip; a concurrent ensure cannot
 *    double-toggle — the check and the toggle run inside one compositor-
 *    serialized Lua evaluation).
 * 3. **Spawn** — `hl.dsp.exec_cmd` with a per-spawn rule
 *    `{ workspace = "<panelWs> silent" }`: the tile opens on the panel's
 *    workspace WITHOUT switching to it, ungrouped (the static rule carries
 *    no `group` effect — the default is no auto-join), never focused
 *    (`no_initial_focus`). No workspace switch, no focus steal, no cursor
 *    warp — the user's view is untouched.
 * 4. **Map-wait** — poll `clients -j` for the new worker pid (≤ mapWaitMs).
 * 5. **Join** — a one-shot IIFE resolves both windows fresh at join time
 *    and `HL.Group:add`s the tile into the panel's group: focus-neutral,
 *    idempotent (`not t.group` guard), and a cross-workspace add relocates
 *    the tile to the group's workspace (so a panel that moved between
 *    spawn and join is self-healing). A group-identity verify (tile and
 *    panel report the same member set) reports `joined`; one retry on
 *    verify failure while the panel is grouped.
 *
 * Why IIFEs: `hyprctl dispatch` evaluates a Lua EXPRESSION (`return
 * hl.dispatch(<expr>)`) — a single `(function() … return hl.dsp.no_op()
 * end)()` runs the multi-step logic statelessly, with no listener, no
 * config surgery, no persistent state in the compositor. The stock
 * dispatchers cannot background-join (map-time `group = "set"` requires
 * the focused window on the tile's own workspace; `into_group` is
 * active-workspace-scoped and its helper focuses the tile) — the Lua
 * layer is the only no-focus route (verified live, Hyprland 0.56.2).
 */
import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import * as C from "../config";
import * as P from "../protocol";
import {
	listAllWindows,
	listWorkerWindows,
	WORKER_APP_ID,
	type HyprctlResult,
	type WorkerWindow,
} from "../hyprctl";
import { findPanelInWindows, type PanelDeps, type PanelWindow } from "./panel";

export const shortId = (id: string): string => id.slice(0, 8);

/** The prompt's header line — names the task and its provenance in the worker's prompt. */
export function promptHeader(opts: {
	taskId: string;
	agent: string;
	dispatcherSessionId: string;
	cwd: string;
	fromTaskId?: string;
}): string {
	const base = `vitrine task ${opts.taskId} agent=${opts.agent} dispatcher=${opts.dispatcherSessionId} cwd=${opts.cwd}`;
	return opts.fromTaskId !== undefined ? `${base} [from=${opts.fromTaskId}]` : base;
}

export function formatElapsed(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	const m = Math.floor(s / 60);
	return m > 0 ? `${m}m${s % 60}s` : `${s}s`;
}

/**
 * The tile-spawn argv (an argv array, no intermediate shell; the dispatch
 * string contains single quotes a shell would eat). The generated paths
 * contain only UUIDs/word chars (the agent name is AGENT_NAME_RE-
 * validated at the spec chokepoint), so the string is dispatch-safe.
 * `workspaceId` adds the silent-route rule (`workspace "N silent"` — the
 * tile opens on that workspace without switching to it); absent ⇒ plain
 * spawn on the current workspace (the panel-undiscoverable fallback).
 * Named test target.
 */
export function tileSpawnArgv(agentName: string, taskId: string, runPath: C.RunPath, taskDir: string, workspaceId?: number): string[] {
	const cmd = [runPath.command, ...runPath.args, taskDir].join(" ");
	const rules = workspaceId !== undefined ? `, { workspace = "${workspaceId} silent" }` : "";
	return ["dispatch", `hl.dsp.exec_cmd("foot -T '${agentName} ${shortId(taskId)}' --app-id ${WORKER_APP_ID} -- ${cmd}"${rules})`];
}

/**
 * The ensure-grouped expression (one round trip, compositor-atomic):
 * check-and-toggle on the panel window inside a SINGLE Lua evaluation, so
 * two concurrent ensures serialize on the compositor's main thread and the
 * second sees the group the first created (toggle is not idempotent — a
 * snapshot-then-toggle across two round trips could double-toggle and
 * dissolve the panel's group).
 */
export function ensureGroupExpression(panelPid: number): string {
	return `(function() local p = hl.get_window("pid:${panelPid}") if p and not p.group then hl.dispatch(hl.dsp.group.toggle({ window = "pid:${panelPid}" })) end return hl.dsp.no_op() end)()`;
}

/**
 * The one-shot join expression: `HL.Group:add` on the Lua layer is
 * focus-neutral (no focus change, no cursor warp, no workspace switch —
 * verified live) and relocates a cross-workspace window onto the group's
 * workspace. Both windows are resolved FRESH at join time (a panel that
 * moved between spawn and join is self-healing); the `not t.group` guard
 * makes a re-issued join a no-op. Returns `no_op` so the dispatch
 * evaluates to a valid dispatcher.
 */
export function joinGroupExpression(tilePid: number, panelPid: number): string {
	return `(function() local t = hl.get_window("pid:${tilePid}") local p = hl.get_window("pid:${panelPid}") if t and p and p.group and not t.group then p.group:add(t) end return hl.dsp.no_op() end)()`;
}

/** The spawn transport environment (the entry's spawn pass and the wait
 * loop share it — the spawn decision is one code path, R1/R2). */
export interface SpawnEnv {
	/** The spawn shape — decided by the compositor probe (tile if reachable, headless otherwise; never the reverse). */
	mode: "tile" | "headless";
	cfg: C.VitrineConfig;
	/** The dispatcher's own bun binary (absolute). THUNK — headless only; tile never evaluates it (the tile needs a direct executable, and the compositor's `sh -c` layer cannot be trusted to resolve `bun`). */
	bunBin: () => string;
	hyprctl: (args: string[]) => Promise<HyprctlResult>;
	sleep: (ms: number) => Promise<void>;
	now: () => number;
	mapWaitMs: number;
	mapWaitTickMs: number;
	panel?: PanelDeps;
}

/** One task's spawn identity (id + dir + the tile-title agent name + the spec's cwd for the headless spawn). */
export interface SpawnTarget {
	id: string;
	dir: string;
	agentName: string;
	spec: P.TaskSpec;
}

/**
 * Issue the spawn command for one task and settle the failure immediately:
 * tile — the hyprctl exec_cmd dispatch (silent-routed + background join); headless —
 * the detached wrapper spawn. A spawn-command failure settles the task
 * crashed/failed-to-spawn NOW (no waiting out the stuck window for a task
 * that is known not to have launched). Returns whether the spawn command
 * was issued: a code-1 hyprctl is a failed issue, not a throw — the
 * `spawn-failed` event marks the throw/catch path only (e.g. a broken
 * run-path resolution), `failed-to-spawn` the settle.
 *
 * The `spawn-issued` event is written BEFORE the spawn issues: the event is
 * the double-spawn guard for a concurrently-attaching wait loop, and the
 * issue window is real (the tile join's map-wait runs 1–2 s) — a loop
 * attaching mid-issue must see the guard, not a bare `queued` state with no
 * record. A failed issue then settles failed-to-spawn, so the stale event
 * is inert: a settled task is terminal, and the guard only reads `queued`
 * tasks. If the event itself cannot be written, the guard cannot be claimed
 * — fail conservative (no spawn, settle failed-to-spawn): a silently
 * dropped guard risks a double spawn for the whole boot window.
 */
export async function issueSpawn(target: SpawnTarget, env: SpawnEnv): Promise<boolean> {
	const doSpawn = async (): Promise<boolean> => {
		try {
			if (env.mode === "tile") {
				// Tile mode needs a direct executable and never uses the bun
				// binary, so the `bunBin` thunk is NOT evaluated here (a broken
				// headless-box bun PATH must not break tiling).
				const runPath = C.resolveRunPath(env.cfg, "tile");
				const buildArgv = (workspaceId?: number) => tileSpawnArgv(target.agentName, target.id, runPath, target.dir, workspaceId);
				const { spawnOk } = await spawnTile(
					(argv) => env.hyprctl(argv).then((r) => r.code === 0),
					buildArgv,
					{ hyprctl: env.hyprctl, sleep: env.sleep, now: env.now, mapWaitMs: env.mapWaitMs, mapWaitTickMs: env.mapWaitTickMs, panel: env.panel },
				);
				return spawnOk;
			}
			const runPath = C.resolveRunPath(env.cfg, "headless", env.bunBin());
			const child = spawn(runPath.command, [...runPath.args, target.dir], {
				cwd: target.spec.cwd,
				env: { ...process.env, ...C.wrapperRootEnv(env.cfg) },
				detached: true,
				stdio: "ignore",
			});
			child.unref();
			return true;
		} catch (e: unknown) {
			await P.appendEvent(target.dir, { event: "spawn-failed", source: "dispatch", error: String(e) });
			return false;
		}
	};
	// The spawn-issued record BEFORE the issue (the double-spawn guard — see
	// the module comment above). A failed append fails the spawn conservative.
	const guarded = await P.appendEvent(target.dir, { event: "spawn-issued", source: "dispatch" }).then(() => true).catch(() => false);
	if (!guarded) {
		await P.transitionState(target.dir, "queued", "crashed", {}, "failed-to-spawn").catch(() => null);
		await P.appendEvent(target.dir, { event: "spawn-guard-write-failed", source: "dispatch" }).catch(() => null);
		return false;
	}
	const ok = await doSpawn();
	if (!ok) {
		// A failed read of the state (the dir vanished) keeps the settle as a
		// no-op — the event still records the failure. The (now pre-issue)
		// spawn-issued event stays in the log: inert — the task is terminal
		// and the guard only applies to queued tasks.
		await P.transitionState(target.dir, "queued", "crashed", {}, "failed-to-spawn").catch(() => null);
		await P.appendEvent(target.dir, { event: "failed-to-spawn", source: "dispatch" });
	}
	return ok;
}

export interface TileSpawnDeps {
	hyprctl: (args: string[]) => Promise<HyprctlResult>;
	sleep: (ms: number) => Promise<void>;
	now: () => number;
	/** Hard map-wait budget (default 2000 ms). */
	mapWaitMs?: number;
	/** Map-wait tick (default 200 ms). */
	mapWaitTickMs?: number;
	/** Main-agent panel discovery (defaults: walk up from `process.ppid`
	 *  through `/proc` — see `panel.ts`). */
	panel?: PanelDeps;
}

export interface TileSpawnOutcome {
	/** The tile spawn command issued cleanly (code 0). */
	spawnOk: boolean;
	/** The new tile was observed mapped within the map-wait budget. */
	mapped: boolean;
	/** The tile joined the panel's group (group identity verified). */
	joined: boolean;
	/** The tile's window pid (observed at map), `null` when not mapped. */
	tilePid: number | null;
	/** The panel's pid, `null` when the panel was undiscoverable (plain spawn). */
	panelPid: number | null;
}

/**
 * One tile spawn with the silent route + background join: the dispatcher's
 * panel is the group the new tile joins — WITHOUT touching the user's
 * focus, workspace, or cursor (verified focus-neutral on Hyprland 0.56.2).
 *
 * 1. **Prep** — ONE `clients -j`: the panel (pid + group + workspace) and
 *    the pre-spawn worker pids. Fail-soft: any failure ⇒ plain spawn on the
 *    current workspace, no join (the panel was not found).
 * 2. **Ensure grouped** — the panel ungrouped ⇒ the atomic check-and-toggle
 *    IIFE (one round trip; a concurrent ensure cannot double-toggle).
 * 3. **Spawn** — silent-routed to the panel's workspace (`workspace "N
 *    silent"`) when the panel's workspace is known, else plain (current
 *    workspace). The tile opens ungrouped, never focused.
 * 4. **Map-wait** — poll `clients -j` for the new worker pid (≤ mapWaitMs).
 * 5. **Join** — the one-shot IIFE (fresh resolution, focus-neutral, relocates
 *    a cross-workspace tile). A group-identity verify (tile and panel report
 *    the same member set) reports `joined`; one retry on verify failure while
 *    the panel is grouped.
 *
 * The user's focus/workspace is NEVER moved: there is no focus call and no
 * restore, because nothing is focused. The compositor-side join is the only
 * state change, and it is focus-neutral.
 */
export async function spawnTile(
	spawn: (argv: string[]) => Promise<boolean>,
	buildArgv: (workspaceId?: number) => string[],
	deps: TileSpawnDeps,
): Promise<TileSpawnOutcome> {
	const { hyprctl, sleep, now } = deps;
	const mapWaitMs = deps.mapWaitMs ?? 2000;
	const tickMs = deps.mapWaitTickMs ?? 200;

	// -- prep: ONE `clients -j` (workers + the panel) — fail-soft -----------
	let panel: PanelWindow | null = null;
	let preWorkerPids = new Set<number>();
	let snapshotOk = false;
	try {
		const all = await listAllWindows(hyprctl);
		if (all !== null) {
			preWorkerPids = new Set(all.filter((w) => w.class === WORKER_APP_ID).map((w) => w.pid));
			snapshotOk = true;
			panel = findPanelInWindows(all, deps.panel ?? {});
		}
	} catch {
		panel = null; // fail-soft: plain spawn, no join
	}

	const panelPid = panel !== null ? panel.pid : null;
	const panelWs = panel !== null ? panel.workspaceId : undefined;

	// -- ensure grouped (atomic IIFE; only when the panel is ungrouped) ------
	if (panel !== null && panel.grouped.length === 0) {
		await hyprctl(["dispatch", ensureGroupExpression(panel.pid)]).catch(() => null);
	}

	// -- spawn (silent route to the panel's workspace when known) ------------
	const spawnOk = await spawn(buildArgv(panelWs)).catch(() => false);

	// -- map-wait: observe the new tile (≤ mapWaitMs) -------------------------
	let tilePid: number | null = null;
	let mapped = false;
	if (spawnOk) {
		const deadline = now() + mapWaitMs;
		while (now() < deadline) {
			await sleep(tickMs);
			let workers: WorkerWindow[] | null = null;
			try {
				workers = await listWorkerWindows(hyprctl);
			} catch {
				workers = null;
			}
			// `snapshotOk`: without a prep snapshot an empty preWorkerPids
			// would make ANY pre-existing worker read as "mapped"
			if (snapshotOk && workers !== null) {
				const fresh = workers.find((w) => !preWorkerPids.has(w.pid));
				if (fresh !== undefined) {
					tilePid = fresh.pid;
					mapped = true;
					break;
				}
			}
		}
	}

	// -- join (one-shot IIFE) + verify (group identity) + one retry ----------
	let joined = false;
	if (spawnOk && mapped && tilePid !== null && panel !== null) {
		const doJoin = async (): Promise<boolean> => {
			await hyprctl(["dispatch", joinGroupExpression(tilePid!, panel!.pid)]).catch(() => null);
			return await sameGroup(hyprctl, tilePid!, panel!.pid);
		};
		joined = await doJoin();
		if (!joined) {
			// one retry — only if the panel actually has a group to join
			const stillGrouped = await panelIsGrouped(hyprctl, panel.pid);
			if (stillGrouped) joined = await doJoin();
		}
	}

	return { spawnOk, mapped, joined, tilePid, panelPid };
}

/**
 * Group-identity verify: the tile and the panel report the SAME member set
 * (same group). Reads ONE `clients -j`. `false` on any failure, an
 * ungrouped tile/panel, or a mismatched member set.
 */
async function sameGroup(hyprctl: (args: string[]) => Promise<HyprctlResult>, tilePid: number, panelPid: number): Promise<boolean> {
	const all = await listAllWindows(hyprctl).catch(() => null);
	if (all === null) return false;
	const tile = all.find((w) => w.pid === tilePid);
	const panel = all.find((w) => w.pid === panelPid);
	if (tile === undefined || panel === undefined) return false;
	if (tile.grouped.length === 0 || panel.grouped.length === 0) return false;
	const a = [...tile.grouped].sort();
	const b = [...panel.grouped].sort();
	if (a.length !== b.length) return false;
	return a.every((g, i) => g === b[i]);
}

/** `true` when the panel window is currently in a group (one `clients -j`). */
async function panelIsGrouped(hyprctl: (args: string[]) => Promise<HyprctlResult>, panelPid: number): Promise<boolean> {
	const all = await listAllWindows(hyprctl).catch(() => null);
	if (all === null) return false;
	const panel = all.find((w) => w.pid === panelPid);
	return panel !== undefined && panel.grouped.length > 0;
}

/**
 * The bun binary the headless wrapper spawns with (the dispatch-time
 * PATH is the dispatcher's PATH — a bare `bun` in the wrapper's environment
 * might not resolve). `VITRINE_BUN_BIN` wins (tests), then a PATH lookup,
 * then the current executable if it IS bun (pi running under bun).
 */
export function resolveBunBin(): string {
	if (process.env.VITRINE_BUN_BIN !== undefined && process.env.VITRINE_BUN_BIN !== "") {
		const p = process.env.VITRINE_BUN_BIN;
		const st = statSync(p);
		if (!st.isFile() || (st.mode & 0o111) === 0) throw new Error(`VITRINE_BUN_BIN is not an executable file: ${p}`);
		return p;
	}
	for (const dir of (process.env.PATH ?? "").split(":")) {
		if (dir === "" || !isAbsolute(dir)) continue;
		const p = join(dir, "bun");
		try {
			const st = statSync(p);
			if (st.isFile() && (st.mode & 0o111) !== 0) return p;
		} catch {
			// keep looking
		}
	}
	if (basename(process.execPath) === "bun") return process.execPath;
	throw new Error("bun not found in PATH — headless dispatch needs the bun binary (set VITRINE_BUN_BIN to an absolute path)");
}
