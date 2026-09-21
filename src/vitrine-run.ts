#!/usr/bin/env bun
/**
 * vitrine-run.ts — the wrapper's bin entry — thin.
 *
 * The lifecycle lives in src/wrapper/ — `lifecycle.ts` (ONE loop for both
 * modes), `worker.ts` (spawn/argv/env/contract), `watchdogs.ts` (the pure
 * evaluators), `tile.ts` (the tile specifics: titles, the fail-safe focus
 * check, the exit mapping, the v1.11 keep-alive phase), `headless.ts` (the
 * 5-branch pinned headless exit mapping) — with the session JSONL facts in
 * src/session.ts and the single hyprctl runner in src/hyprctl.ts.
 *
 * This file: the bin entry (spec.mode selects the lifecycle) + the stable
 * re-exports the tests, the dispatch tool and the fixtures import from here.
 *
 * Process tree (tile mode): foot (owns the window + pty) → vitrine-run
 * (this wrapper) → pi (the worker). The compositor's `hl.dsp.exec_cmd`
 * spawns foot with `-- vitrine-run <task-dir>`; env does NOT survive the
 * compositor boundary, so the worker invocation is built from spec.json,
 * never from inherited env.
 *
 * Lifecycle (the eight steps):
 * 1. read + validate spec.json; queued → running with the CAS hand-off
 *    (records wrapper_pid + wrapper_pid_start + foot_pid — the hand-off
 *    lost to a sibling is `handoff-lost`, never a double spawn);
 * 2. build the worker argv/env from spec.json (the `--tools`
 *    ceiling unioned with `vitrine_done`);
 * 3. spawn the worker; record worker_pid + worker_pid_start (CAS field
 *    merge); a rejected merge means a sibling owns the supervision — kill
 *    our worker and exit (zombie-tile guard);
 * 4. session discovery + session.json written ONCE;
 * 5. watchdog ticks (wall / inactivity / cost / auto-settle),
 *    the done-marker poll (rule 1 — the marker always wins), kill handling
 *    (SIGHUP/SIGTERM + kill_requested), the /proc/<foot_pid> backstop
 *    (window closed ⇒ killed);
 * 6. the worker's exit — mapped per mode;
 * 7. v1.11 keep-alive on completed (TILE ONLY): the worker is
 *    NOT killed — the tile stays open in its own regime (no watchdogs: a
 *    stale wallStart would SIGTERM the resident worker; no settle: the
 *    state is already terminal); closes on the unfocused-idle countdown,
 *    a close intent, or the worker self-exiting;
 * 8. the wrapper exits — foot owns the window; the tile closes only when
 *    the wrapper exits.
 *
 * Headless mode: the same skeleton without the tile's pieces —
 * no foot, no focus, no ppid backstop, no auto-settle, no keep-alive;
 * completion is the process exit, mapped by the pinned 5-branch rules.
 *
 * A module-scope homedir() is snapshotted at import — the default
 * roots are read at call time so a changed HOME (tests) is honoured.
 *
 * import.meta.main is jiti-incompatible (raw import.meta survives jiti's
 * CJS transpile and kills pi's extension load — see src/main-guard.ts).
 */
import { isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { isMainModule } from "./main-guard";
import * as P from "./protocol";
import { wrapperAgentsDir } from "./agents";
import { runHeadlessWrapper, runWrapper } from "./wrapper/lifecycle";

// The default sessions root is read at call time.
const defaultSessionsRoot = (): string => join(homedir(), ".pi", "agent", "sessions");

if (isMainModule(import.meta.url)) {
	const dir = process.argv[2];
	if (!dir || !isAbsolute(resolve(dir))) {
		console.error("usage: vitrine-run <task-dir>");
		process.exit(2);
	}
	const deps = {
		piBin: process.env.VITRINE_PI_BIN ?? "pi",
		sessionsRoot: process.env.VITRINE_SESSIONS_DIR ?? defaultSessionsRoot(),
		agentsDir: process.env.VITRINE_AGENTS_DIR ?? wrapperAgentsDir(),
	};
	try {
		// Mode is the protocol's decision: spec.mode selects the
		// lifecycle; the isatty policy lives inside the lifecycle (tile:
		// hard guard; headless: logged only).
		const spec = await P.readSpec(dir);
		if (spec.mode === "headless") {
			await runHeadlessWrapper(dir, deps);
		} else {
			await runWrapper(dir, { ...deps, footPid: process.ppid });
		}
	} catch (e) {
		// An unexpected wrapper death = dead-wrapper case; the dispatcher's
		// reconcile settles it. The exit code is not a protocol channel.
		console.error(`vitrine-run: fatal: ${e}`);
	}
	process.exit(0);
}

// ---------------------------------------------------------------------------
// stable re-exports — the tests, the dispatch tool and the fixture pi
// import the wrapper surface from here (the dispatch import is wired to
// the direct modules; these stay for the test surface).

export * from "./session";
export * from "./wrapper/worker";
export * from "./wrapper/watchdogs";
export { runHeadlessWrapper, runWrapper } from "./wrapper/lifecycle";
export type { ExitCtx, HeadlessDeps, SettleTarget, WorkerDeps, WrapperDeps, WrapperOutcome } from "./wrapper/lifecycle";
