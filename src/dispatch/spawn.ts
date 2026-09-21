/**
 * spawn.ts — the dispatch-side spawn construction: the
 * tile-spawn argv (the invariant) + the join juggle (v1.9 grouping), the
 * headless bun-bin resolution, and the small shared formatting pieces
 * (prompt header, elapsed, short id — used by the core + the report).
 */
import { statSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import * as C from "../config";
import {
	focusWindowByPid,
	listAllWindows,
	listWorkerWindows,
	readActiveWindow,
	toggleGroup,
	WORKER_APP_ID,
	type HyprctlResult,
	type WorkerWindow,
} from "../hyprctl";
import { findPanelInWindows, type PanelDeps } from "./panel";

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
 * The tile-spawn argv (an argv array, no intermediate shell;
 * the dispatch string contains single quotes a shell would eat). The
 * generated paths contain only UUIDs/word chars (the agent name is
 * AGENT_NAME_RE-validated at the spec chokepoint), so the string is
 * dispatch-safe. Named test target.
 */
export function tileSpawnArgv(agentName: string, taskId: string, runPath: C.RunPath, taskDir: string): string[] {
	const cmd = [runPath.command, ...runPath.args, taskDir].join(" ");
	return ["dispatch", `hl.dsp.exec_cmd("foot -T '${agentName} ${shortId(taskId)}' --app-id ${WORKER_APP_ID} -- ${cmd}")`];
}

export interface TileJoinDeps {
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

export interface TileJoinOutcome {
	/** We focused a live worker group before the spawn (join expected). */
	joinedFocus: boolean;
	/** The new tile was observed mapped within the map-wait budget. */
	mapped: boolean;
	/** The user's previous focus was restored after the map. */
	restored: boolean;
}

/**
 * One tile spawn with the main-agent join juggle (main-agent group): the dispatcher's panel is the group the new tile joins.
 *
 * 1. **Find the panel** — first ancestor of the tool's own process whose pid
 *    is a live window (the panel is owned by the terminal above pi).
 * 2. **Ensure grouped** — already grouped (a previous dispatch made it) ⇒
 *    the join target is that group. Ungrouped ⇒ the panel becomes a group
 *    RIGHT NOW: `hl.dsp.group.toggle()` acts on the ACTIVE window, so the
 *    panel is focused first (only then is the toggle issued — never on the
 *    user's window).
 * 3. **Focus the group** — EVERY spawn re-asserts focus on the panel so
 *    the static rule (`group = "set"`) joins the tile into the focused
 *    unlocked group at MAP time. Focus is never trusted: a join makes the
 *    new tile the group's active window, and with `input:follow_mouse = 1`
 *    the map events of a back-to-back batch can move focus out of the
 *    group — trusted focus let 4/5 tiles open as their own groups (the
 *    2026-09-19 five-spawn repro); pre-spawn focus joins 5/5. P0 not in
 *    the group ⇒ P0 is restored after the map; P0 in the group (the panel
 *    itself, or a worker already in it) ⇒ focus stays in the group, nothing
 *    to restore.
 * 4. **Spawn** (the argv is the invariant — unchanged by this design),
 *    **map-wait** (the join fires at map time, so the focus restore must NOT
 *    precede it), **restore P0** if this juggle moved the focus.
 *
 * Fail-soft: any juggle failure degrades to the v1.9 behaviour (the tile
 * opens as its own group, or joins whatever the compositor happens to have
 * focused); only `spawnTile`'s own failure settles `failed-to-spawn`.
 *
 * Operator-visible behaviour (accepted): while the juggle runs,
 * the user's focus is on the panel's group for the whole map-wait window
 * (≤ mapWaitMs + one probe latency — the deadline is checked BETWEEN
 * polls), and the new tile lands as the group's active window at map time,
 * so the visible tab can swap and keystrokes typed mid-dispatch can land in
 * the new worker's terminal. One more accepted race: with
 * `input:follow_mouse = 1`, a mouse move between the focus call and the
 * map can re-focus the cursor's window — the join then lands in whatever
 * group that left focused (possibly the user's own, or another
 * dispatcher's main group), or drops (the tile opens as its own group).
 * There is no atomic focus+map in the compositor; the map-wait bounds the
 * exposure.
 */
export async function spawnTileWithJoin(
	spawnTile: () => Promise<boolean>,
	deps: TileJoinDeps,
): Promise<{ spawnOk: boolean; join: TileJoinOutcome }> {
	const { hyprctl, sleep, now } = deps;
	const mapWaitMs = deps.mapWaitMs ?? 2000;
	const tickMs = deps.mapWaitTickMs ?? 200;

	// -- prep: ONE `clients -j` (workers + the panel) + ONE `activewindow -j`
	//    (P0) — fail-soft throughout ----------------------------------------
	let joinFocus = false;
	let restorePid: number | null = null;
	let preWorkerPids = new Set<number>();
	let snapshotOk = false;
	try {
		const all = await listAllWindows(hyprctl);
		const active = await readActiveWindow(hyprctl);
		if (all !== null) {
			preWorkerPids = new Set(all.filter((w) => w.class === WORKER_APP_ID).map((w) => w.pid));
			snapshotOk = true;
		}
		const panel = all === null ? null : findPanelInWindows(all, deps.panel ?? {});
		if (panel !== null && active !== null) {
			if (panel.grouped.length > 0) {
				// Already a group (a previous dispatch made it, idempotent): the join target is that group. Re-assert focus
				// on the panel for EVERY spawn: the `set` join resolves against
				// the group focused at MAP time, and focus can leave the group
				// between this prep and the map (a previous join made its tile
				// the group's active window; `input:follow_mouse = 1` re-focuses
				// the cursor's window on map events) — 2026-09-19 five-spawn
				// repro: trusted focus ⇒ 4/5 strays; pre-spawn focus ⇒ 5/5
				// joined. P0 in the group ⇒ focus stays in the group after the
				// map (nothing to restore).
				const inGroup = active.grouped.length > 0 && panel.grouped[0] === active.grouped[0];
				restorePid = inGroup ? null : active.pid;
				joinFocus = await focusWindowByPid(hyprctl, panel.pid);
			} else if (active.pid === panel.pid) {
				// The panel becomes a group just before this dispatch. P0
				// is the panel itself — toggle in place; nothing to restore.
				joinFocus = await toggleGroup(hyprctl);
			} else if (await focusWindowByPid(hyprctl, panel.pid)) {
				// P0 elsewhere: focus the panel FIRST (the toggle acts on the
				// active window — it must never act on the user's window),
				// then make it a group.
				restorePid = active.pid;
				if (await toggleGroup(hyprctl)) {
					joinFocus = true; // the panel's new group is the focused group
				} else {
					// Focus moved but the toggle failed: no join is possible —
					// restore the user's focus right away (there is no map to
					// preserve) and degrade to the v1.9 behaviour.
					await focusWindowByPid(hyprctl, active.pid);
					restorePid = null;
				}
			}
			// A failed panel focus ⇒ no group at all (degrade): the tile opens
			// as its own group, or joins whatever the compositor has focused.
		}
	} catch {
		// fail-soft: skip the juggle, spawn as before
	}

	// -- spawn (the argv is the invariant — see tileSpawnArgv) ---------------
	const spawnOk = await spawnTile().catch(() => false);

	// -- map-wait: the join fires at map time; wait ≤ mapWaitMs --------------
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
			if (snapshotOk && workers !== null && workers.some((w) => !preWorkerPids.has(w.pid))) {
				mapped = true;
				break;
			}
		}
	}

	// -- restore the user's focus (best-effort, AFTER the map) ---------------
	let restored = false;
	if (joinFocus && restorePid !== null) {
		restored = await focusWindowByPid(hyprctl, restorePid);
	}

	return { spawnOk, join: { joinedFocus: joinFocus, mapped, restored } };
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
