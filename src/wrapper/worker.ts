/**
 * worker.ts — the worker process machinery:
 * spawn + stderr capture, the worker's argv/env builders, the exit-code
 * mapping, and the worker contract. Shared by both wrapper lifecycles.
 */
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import * as P from "../protocol";

// ---------------------------------------------------------------------------
// Worker contract (appended to the worker's system prompt)

/** The vitrine worker contract. The "final message is the deliverable" and
 * OPENED FILES lines harden small models that end the turn on a summary or
 * cite files they never opened (three-for-three nano run, 2026-09-19).
 * v1.21: completion is a fact the wrapper observes on its tick — the
 * worker's final message is the deliverable; there is no done tool to call.
 */
export const VITRINE_CONTRACT = [
	"VITRINE WORKER CONTRACT",
	"You are a vitrine worker dispatched for a single task (the prompt given at startup).",
	"Your final message is the deliverable: the complete report, with path-and-line evidence — no trailing summary of it.",
	"Cite only files you actually opened. End the final answer with an OPENED FILES section: every file you opened, one per line.",
].join("\n");

// ---------------------------------------------------------------------------
// Worker invocation (from spec.json, never from inherited env)

/**
 * The worker argv (pi). `fromSessionFile` is the `--fork` source (a
 * `from`/`context` task); `agentBody` is the agent file's body. The `--tools`
 * flag is the worker's ceiling — pushed only when the agent declares a
 * NON-EMPTY tools list (the list, deduped, verbatim): an empty or absent
 * list means no `--tools` flag at all (the full default surface — the
 * v1.21 re-derivation: the old union with `vitrine_done` is gone with the
 * tool, so an empty list no longer needs to force a flag). `--session-dir`
 * is always passed so the worker's session file lands FLAT
 * in the known root, where the wrapper's discovery diffs. The
 * flag is NOT a no-op: without it pi uses its DEFAULT layout — a cwd-keyed
 * subdir of the root (`sessionDirFor`) — which discovery does not look in.
 *
 * `--append-system-prompt` takes the PATH of the task-dir `system-prompt.md`
 * (written by the wrapper before the spawn), never inline text: an inline
 * value that happens to name an existing file would be read as a file by pi.
 */
export function buildWorkerArgv(
	dir: string,
	spec: P.TaskSpec,
	fromSessionFile: string | null,
	systemPromptPath: string,
	sessionsRoot: string,
): string[] {
	const args: string[] = [];
	if (fromSessionFile !== null) args.push("--fork", fromSessionFile);
	args.push("--session-id", spec.session_id, "--name", spec.session_name, "--session-dir", sessionsRoot);
	if (spec.agent.model !== undefined) args.push("--model", spec.agent.model);
	if (spec.agent.thinking !== undefined) args.push("--thinking", spec.agent.thinking);
	if (spec.agent.tools !== undefined && spec.agent.tools.length > 0) {
		args.push("--tools", [...new Set(spec.agent.tools)].join(","));
	}
	args.push("--append-system-prompt", systemPromptPath);
	args.push("--", `@${join(dir, "prompt.md")}`);
	return args;
}

/**
 * The headless worker argv: the tile argv plus `--print` — the
 * worker exits when its turn ends (headless completion is the process exit,
 * mapped in the headless lifecycle). `--print` goes BEFORE the `--` marker:
 * everything after `--` is the prompt.
 */
export function buildHeadlessWorkerArgv(
	dir: string,
	spec: P.TaskSpec,
	fromSessionFile: string | null,
	systemPromptPath: string,
	sessionsRoot: string,
): string[] {
	const args = buildWorkerArgv(dir, spec, fromSessionFile, systemPromptPath, sessionsRoot);
	const sep = args.lastIndexOf("--");
	args.splice(sep, 0, "--print");
	return args;
}

/**
 * The worker's env ("the worker's env is what vitrine-run sets" —
 * an explicit minimal set, NOT the wrapper's inherited env, which may carry
 * test hooks). Hyprland/Wayland/X11 vars ride along when present.
 */
export function buildWorkerEnv(taskDir: string, parent: Record<string, string | undefined>): Record<string, string> {
	const out: Record<string, string> = {
		PATH: parent.PATH ?? "/usr/local/bin:/usr/bin:/bin",
		HOME: parent.HOME ?? homedir(),
		TERM: parent.TERM ?? "xterm-256color",
		VITRINE_TASK_DIR: taskDir,
	};
	// `VITRINE_TASKS_ROOT` rides along (protocol.tasksRoot reads it at call
	// time): without it a tool/fixture that resolves the tasks root under a
	// custom (dispatcher-propagated) root would reject a task dir there with
	// `bad-path`.
	if (parent.VITRINE_TASKS_ROOT !== undefined) out.VITRINE_TASKS_ROOT = parent.VITRINE_TASKS_ROOT;
	// The worker's session store must match the wrapper's `sessionsRoot`
	// (default `~/.pi/agent/sessions`, overridable via `VITRINE_SESSIONS_DIR`):
	// the wrapper discovers the worker's session file under that root to write
	// `session.json` and drive the watchdogs. A custom root that isn't
	// propagated here would make the worker write its session elsewhere and the
	// wrapper would never find it (for the sessions root).
	if (parent.VITRINE_SESSIONS_DIR !== undefined) out.VITRINE_SESSIONS_DIR = parent.VITRINE_SESSIONS_DIR;
	for (const k of [
		"HYPRLAND_INSTANCE_SIGNATURE",
		"HYPRLAND_TOKEN",
		"WAYLAND_DISPLAY",
		"DISPLAY",
		"XDG_RUNTIME_DIR",
		"XDG_CONFIG_HOME",
	]) {
		const v = parent[k];
		if (v !== undefined) out[k] = v;
	}
	return out;
}

// ---------------------------------------------------------------------------
// The worker handle

export interface WorkerExit {
	code: number | null;
	signal: NodeJS.Signals | null;
	error?: string;
}

export interface WorkerHandle {
	pid: number;
	/** Resolves when the worker dies (exit OR spawn error). */
	onExit: Promise<WorkerExit>;
	/** Take (and clear) the stderr captured so far. */
	stderrTake(): string;
}

/** Spawn a worker process with stderr captured (stdin/stdout inherited from the tile's pty). */
export function spawnWorkerHandle(
	cmd: string,
	argv: string[],
	env: Record<string, string>,
	opts: { cwd: string },
): Promise<WorkerHandle> {
	return new Promise((res, rej) => {
		const child = spawn(cmd, argv, { cwd: opts.cwd, env: env as NodeJS.ProcessEnv, stdio: ["inherit", "inherit", "pipe"] });
		let stderrBuf = "";
		child.stderr?.on("data", (c: Buffer) => {
			stderrBuf += c.toString("utf8");
		});
		const onExit = new Promise<WorkerExit>((r) => {
			child.once("exit", (code, signal) => r({ code, signal }));
			child.once("error", (e: Error) => r({ code: null, signal: null, error: String(e) }));
		});
		Promise.race([
			new Promise((r) => child.once("spawn", r)),
			new Promise<never>((_, r2) => child.once("error", (e: Error) => r2(e))),
		])
			.then(() => res({ pid: child.pid!, onExit, stderrTake: () => { const b = stderrBuf; stderrBuf = ""; return b; } }))
			.catch((e: Error) => rej(new Error(`worker spawn failed: ${e.message}`)));
	});
}

const SIGNAL_NUMBERS: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15, SIGSEGV: 11, SIGABRT: 6 };

/** The settle's `exit_code` field: the child's exit code, or 128+signal. */
export function exitCodeOf(exit: WorkerExit | null): number | undefined {
	if (exit === null) return undefined;
	if (exit.code !== null) return exit.code;
	if (exit.signal !== null) return 128 + (SIGNAL_NUMBERS[exit.signal] ?? 9);
	return undefined;
}
