/**
 * hyprctl.ts — the single Hyprland runner.
 *
 * Every hyprctl call goes through `hyprctlRun`: execFile with a timeout,
 * where a NON-ZERO exit is a *result* (`code !== 0`) and only a spawn
 * failure (a string errno like ENOENT) rejects. The call sites apply their
 * own failure policy on top:
 * - the spawn path (dispatch): any failure ⇒ degrade (fail-soft);
 * - the compositor probe (dispatch): `code === 0` ⇒ reachable, else headless;
 * - the wrapper's focus check (wrapper/tile.ts): any error ⇒ FOCUSED
 *   (fail-safe: a human watching can never be auto-completed).
 *
 * NOTE — focus FOLLOWS the workspace: `hl.dsp.focus({ window = "pid:N" })`
 * switches the visible workspace to the target window's. The spawn path
 * NEVER focuses anything for that reason — it routes the tile silently
 * (`workspace "N silent"`) and joins it into the panel's group via the
 * focus-neutral Lua layer (`HL.Group:add`), both as one-shot expressions
 * (see dispatch/spawn.ts).
 *
 * A bare `hyprctl -j` (no request) is NOT a valid query on this Hyprland
 * (0.56.2) — it exits 1. Compositor reachability is `probeCompositor`;
 * window state is read through specific requests only.
 */
import { execFile } from "node:child_process";

export interface HyprctlResult {
	/** The numeric exit code (non-zero on a non-zero exit; 0 on success). */
	code: number;
	stdout: string;
	stderr: string;
}

/**
 * A hyprctl runner with a timeout. A non-zero exit is a RESULT (code !== 0);
 * a spawn failure rejects (the compositor binary is missing — a hard error
 * the caller may want to surface).
 */
export function hyprctlRun(timeoutMs: number): (args: string[]) => Promise<HyprctlResult> {
	return (args: string[]) =>
		new Promise<HyprctlResult>((res, rej) => {
			const t = setTimeout(() => rej(new Error("hyprctl timeout")), timeoutMs);
			execFile("hyprctl", args, (e, so, se) => {
				clearTimeout(t);
				if (e === null) {
					res({ code: 0, stdout: so ?? "", stderr: se ?? "" });
					return;
				}
				// execFile sets `code` to the numeric exit code on a non-zero
				// exit, and to a string errno (ENOENT, …) when the spawn itself
				// failed: non-zero is a RESULT (probe failures surface as
				// code !== 0); a spawn failure rejects.
				const code = (e as NodeJS.ErrnoException).code;
				if (typeof code === "number") res({ code, stdout: so ?? "", stderr: se ?? String(e) });
				else rej(e);
			});
		});
}

/** The default runner factory (5 s — the dispatcher's default dep). */
export const defaultHyprctl = (timeoutMs = 5000): ((args: string[]) => Promise<HyprctlResult>) => hyprctlRun(timeoutMs);

/** The foot window's `--app-id` (the window identity). */
export const WORKER_APP_ID = "vitrine-worker";

/** A vitrine-worker window as `hyprctl clients -j` reports it. */
export interface WorkerWindow {
	pid: number;
	/** Hyprland group ids the window belongs to ([] when ungrouped). */
	grouped: string[];
}

/**
 * A window as `hyprctl clients -j` reports it (the spawn prep's snapshot
 * shape — any class, not just workers).
 */
export interface AnyWindow {
	pid: number;
	class: string;
	/** Hyprland group ids the window belongs to ([] when ungrouped). */
	grouped: string[];
	/** The window's workspace id (absent when the field is missing/malformed). */
	workspaceId?: number;
}

/**
 * Live windows from `hyprctl clients -j` — the spawn prep's single snapshot.
 * `null` on any failure (non-zero code, malformed or
 * missing JSON, non-array body) — the spawn path is fail-soft and degrades
 * to the plain (no routing, no join) behaviour.
 */
export async function listAllWindows(
	hyprctl: (args: string[]) => Promise<HyprctlResult>,
): Promise<AnyWindow[] | null> {
	try {
		const r = await hyprctl(["clients", "-j"]);
		if (r.code !== 0) return null;
		const j: unknown = JSON.parse(r.stdout);
		if (!Array.isArray(j)) return null;
		const out: AnyWindow[] = [];
		for (const entry of j) {
			if (entry === null || typeof entry !== "object") continue;
			const w = entry as Record<string, unknown>;
			if (typeof w.pid !== "number") continue;
			const grouped = Array.isArray(w.grouped)
				? w.grouped.filter((g): g is string => typeof g === "string")
				: [];
			const ws = (w.workspace ?? null) as Record<string, unknown> | null;
			const workspaceId = ws !== null && typeof ws === "object" && typeof ws.id === "number" ? ws.id : undefined;
			out.push({ pid: w.pid, class: typeof w.class === "string" ? w.class : "", grouped, ...(workspaceId !== undefined ? { workspaceId } : {}) });
		}
		return out;
	} catch {
		return null;
	}
}

/**
 * Live vitrine-worker windows from `hyprctl clients -j` (the map-wait's
 * snapshot), as a class filter over `listAllWindows`.
 * `null` on any failure — the spawn path is fail-soft and degrades to the
 * ungrouped behaviour.
 */
export async function listWorkerWindows(
	hyprctl: (args: string[]) => Promise<HyprctlResult>,
): Promise<WorkerWindow[] | null> {
	const all = await listAllWindows(hyprctl);
	return all === null ? null : all.filter((w) => w.class === WORKER_APP_ID).map((w) => ({ pid: w.pid, grouped: w.grouped }));
}

/**
 * Compositor reachability probe (`hl.dsp.no_op()`, short
 * timeout; any short-timeout hyprctl call works as the probe). Unreachable
 * ⇒ headless mode, never the reverse. Tool-side only.
 */
export async function probeCompositor(deps: { hyprctl?: (args: string[]) => Promise<HyprctlResult> } = {}): Promise<boolean> {
	const hyprctl = deps.hyprctl ?? hyprctlRun(2000);
	try {
		const r = await hyprctl(["dispatch", "hl.dsp.no_op()"]);
		return r.code === 0;
	} catch {
		return false;
	}
}
