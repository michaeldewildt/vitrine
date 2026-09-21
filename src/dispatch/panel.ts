/**
 * panel.ts — main-agent panel discovery (main-agent group): the
 * dispatcher's OWN window — the panel of the pi process running the dispatch
 * tool. Window identity is the terminal emulator's pid (foot), which sits
 * ABOVE the pi process in the pid chain — so the walk goes UP through the
 * `/proc` parents and takes the first ancestor whose pid is a live window
 * (`hyprctl clients -j`). Proven live 2026-09-18: `pi → bash → foot`, foot
 * is the panel's window pid (two hops).
 *
 * Fail-soft by design: no window on the chain ⇒ `null` ⇒ the juggle
 * degrades (the tile opens as its own group, or joins whatever the
 * compositor has focused — the v1.9 behaviour). The walk only reads
 * `/proc/<pid>/stat` (field 4 = ppid); it never writes.
 */
import { readFileSync } from "node:fs";
import { listAllWindows, type AnyWindow, type HyprctlResult } from "../hyprctl";

/** The dispatcher's panel window (its pid + group membership). */
export interface PanelWindow {
	pid: number;
	/** Hyprland group ids the panel belongs to ([] when ungrouped). */
	grouped: string[];
}

export interface PanelDeps {
	/** Pid to start the walk at (default: `process.ppid` — the tool runs
	 *  inside the pi process; the window-owning terminal sits above it). */
	startPid?: number;
	/** Parent-pid lookup (default: the `/proc/<pid>/stat` reader). */
	ppidOf?: (pid: number) => number | null;
	/** Hop cap (default 32 — also the pid-cycle guard). */
	maxHops?: number;
}

/**
 * The parent pid of `pid` from `/proc/<pid>/stat` — field 4 of the entry
 * after the `pid (comm)` prefix. The last-`)` split tolerates a comm that
 * contains spaces or parentheses. `null` when the process is gone or the
 * entry is malformed.
 */
export function readPpid(pid: number): number | null {
	try {
		const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
		const i = raw.lastIndexOf(")");
		if (i < 0) return null;
		const fields = raw.slice(i + 1).trim().split(/\s+/);
		const ppid = Number.parseInt(fields[1] ?? "", 10);
		return Number.isFinite(ppid) && ppid > 0 ? ppid : null;
	} catch {
		return null;
	}
}

/**
 * Pure walk over a pre-fetched window snapshot: the first ancestor of
 * `deps.startPid` (default `process.ppid`) whose pid is a window is the
 * panel. `null` when no window is on the chain, the chain ends (pid 1 /
 * dead process / malformed entry), or the hop cap is hit.
 */
export function findPanelInWindows(windows: AnyWindow[], deps: PanelDeps = {}): PanelWindow | null {
	const byPid = new Map(windows.map((w) => [w.pid, w]));
	const ppidOf = deps.ppidOf ?? readPpid;
	const maxHops = deps.maxHops ?? 32;
	let cur = deps.startPid ?? process.ppid;
	for (let i = 0; i < maxHops; i++) {
		const w = byPid.get(cur);
		if (w) return { pid: w.pid, grouped: w.grouped };
		const next = ppidOf(cur);
		if (next === null || next <= 1 || next === cur) return null;
		cur = next;
	}
	return null;
}

/** `findPanelInWindows` over a live `clients -j` snapshot (one call). */
export async function findDispatcherWindow(
	hyprctl: (args: string[]) => Promise<HyprctlResult>,
	deps: PanelDeps = {},
): Promise<PanelWindow | null> {
	const windows = await listAllWindows(hyprctl);
	return windows === null ? null : findPanelInWindows(windows, deps);
}
