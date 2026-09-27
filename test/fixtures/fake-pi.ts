#!/usr/bin/env bun
/**
 * fake-pi — the fixture worker ("A fixture `pi` binary (canned
 * session-JSONL growth shaped like real entries — assistant/toolResult ordering
 * per session-format — tool hangs, clean/exotic exits)").
 *
 * Mimics the observable behaviour of real pi: parses the same argv
 * (buildWorkerArgv's output), writes a session file in the pi format
 * (header + session_info + message entries, append-only) under the
 * cwd-keyed session dir.
 *
 * Scenario env (set by the tests):
 *   VITRINE_FIXTURE_MODE:
 *     clean         — canned turn (toolCall → toolResult → final text), exit 0
 *                     (the headless completion channel: settled turn, the
 *                     process exit settles it via the headless-exit marker)
 *     hang          — one settled turn, then hangs (idle-assistant forever —
 *                     the tile completion channel: the wrapper's stop-settle
 *                     settles it; the keep-alive countdown closes it)
 *     crash         — a mid-turn break: a pending toolCall as the LAST entry,
 *                     stderr line, exit 3 (a settled-then-died turn is a STOP,
 *                     not a crash — the crash mapping is the non-idle case)
 *     crash-sig     — same mid-turn break, then SIGKILLs itself
 *     exit0-broken  — a pending toolCall (no result) as the LAST entry, exit 0
 *                     (the headless content gate: broken turn, clean exit)
 *     slow          — entry, long gap, entry (the inactivity window fires mid-gap)
 *     pending-tool  — assistant toolCall with NO toolResult, then hangs
 *   `--print` (parsed, echoed to stderr) — the headless wrapper's argv flag.
 *   VITRINE_FIXTURE_GAP_MS  — entry gap (default 100)
 *   VITRINE_FIXTURE_COST    — usage.cost.total per assistant entry (default 0)
 *   VITRINE_FIXTURE_IGNORE_SESSION_ID=1 — random session id (name-based discovery)
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { sessionDirFor } from "../../src/session";

interface Cfg {
	sessionId?: string;
	name?: string;
	fork?: string;
	sessionDir?: string;
	prompt?: string;
	print?: boolean;
}
const cfg: Cfg = {};
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
	const a = args[i];
	if (a === "--session-id") cfg.sessionId = args[++i];
	else if (a === "--name") cfg.name = args[++i];
	else if (a === "--fork") cfg.fork = args[++i];
	else if (a === "--session-dir") cfg.sessionDir = args[++i];
	else if (a === "--model" || a === "--thinking" || a === "--tools" || a === "--append-system-prompt") i++;
	else if (a === "--print") cfg.print = true;
	else if (a === "--") {
		const p = args[i + 1] ?? "";
		cfg.prompt = p.startsWith("@") ? p.slice(1) : p;
	}
}

const mode = process.env.VITRINE_FIXTURE_MODE ?? "clean";
if (mode === "immediate-crash") {
	process.stderr.write("fixture: immediate crash at boot\n");
	process.exit(3);
}
if (cfg.print === true) {
	// The headless wrapper's argv carries --print (probe 2: real pi honours
	// it in print mode, writes the session, exits on turn end). Echo it so
	// the tests can verify the wrapper passed it (stderr → tail.log).
	process.stderr.write("fixture: --print mode\n");
}
const gapMs = Number(process.env.VITRINE_FIXTURE_GAP_MS ?? 100);
const cost = Number(process.env.VITRINE_FIXTURE_COST ?? 0);
// VITRINE_FIXTURE_IGNORE_SESSION_ID=1 — the fixture honours --name but
// ignores --session-id (random id instead): exercises the wrapper's
// name-based (pass-2) session discovery.
const ignoreSessionId = process.env.VITRINE_FIXTURE_IGNORE_SESSION_ID === "1";
const sessionsRoot = process.env.VITRINE_SESSIONS_DIR ?? cfg.sessionDir ?? join(homedir(), ".pi", "agent", "sessions");
const cwd = process.cwd();

// Real pi 0.85.1: `--session-dir <dir>` writes the session file FLAT in
// <dir>; only the DEFAULT layout (no flag) is cwd-keyed (<root>/---<cwd>---).
const dir = cfg.sessionDir !== undefined ? cfg.sessionDir : sessionDirFor(cwd, sessionsRoot);
mkdirSync(dir, { recursive: true });
const id = (): string => randomBytes(4).toString("hex");
const iso = (): string => new Date().toISOString();
// pi's local timestamp in the file name: 2026-09-16T10-35-54-134Z
const tsName = (): string => new Date().toISOString().replace(/:/g, "-").replace(".", "-");
const effectiveId = ignoreSessionId ? `ignored-${id()}` : cfg.sessionId ?? "vitrine.unknown";
const file = join(dir, `${tsName()}_${effectiveId}.jsonl`);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let parent: string | null = null;
const push = (o: unknown): void => {
	appendFileSync(file, JSON.stringify(o) + "\n");
};
const entry = (o: Record<string, unknown>): void => {
	const e = { id: id(), parentId: parent, timestamp: iso(), ...o };
	parent = e.id as string;
	push(e);
};

// If this is a fork, copy the source's entries (minus its header) — real pi
// forks to a NEW file whose header carries `parentSession`.
if (cfg.fork !== undefined && existsSync(cfg.fork)) {
	for (const line of readFileSync(cfg.fork, "utf8").split("\n")) {
		if (line.trim() === "") continue;
		try {
			const o = JSON.parse(line) as Record<string, unknown>;
			if (o.type !== "session") push({ ...o, parentId: null });
		} catch {
			// skip
		}
	}
}

push({
	type: "session",
	version: 3,
	id: effectiveId,
	timestamp: iso(),
	cwd,
	...(cfg.fork !== undefined ? { parentSession: cfg.fork } : {}),
});
if (cfg.name !== undefined) entry({ type: "session_info", name: cfg.name });
entry({ type: "message", message: { role: "user", content: cfg.prompt ?? "fixture prompt", timestamp: Date.now() } });

const asst = (content: unknown[], stopReason: string): void => {
	entry({
		type: "message",
		message: {
			role: "assistant",
			content,
			api: "openai",
			provider: "fixture",
			model: "fixture-model",
			usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } },
			stopReason,
			timestamp: Date.now(),
		},
	});
};
const toolResult = (toolCallId: string): void => {
	entry({
		type: "message",
		message: {
			role: "toolResult",
			toolCallId,
			toolName: "bash",
			content: [{ type: "text", text: "fixture tool output" }],
			isError: false,
			timestamp: Date.now(),
		},
	});
};

const finishClean = async (): Promise<void> => {
	await sleep(gapMs);
	const callId = "call_fix1";
	asst([{ type: "toolCall", id: callId, name: "bash", arguments: { command: "echo hi" } }], "toolUse");
	await sleep(gapMs);
	toolResult(callId);
	await sleep(gapMs);
	asst([{ type: "text", text: "fixture finished the work" }], "stop");
	await sleep(gapMs);
};

switch (mode) {
	case "clean":
		await finishClean();
		process.exit(0);
		break;
	case "hang":
		asst([{ type: "text", text: "fixture finished the work" }], "stop");
		await new Promise(() => {});
		break;
	case "crash":
		// a mid-turn break (the last entry is a PENDING toolCall — non-idle):
		// a settled-then-died turn is a STOP (the wrapper settles `stop`), so
		// the crash mapping is pinned on the non-idle last entry
		process.stderr.write("fixture: about to crash\n");
		asst([{ type: "toolCall", id: "call_crash", name: "bash", arguments: { command: "will-crash" } }], "toolUse");
		process.exit(3);
		break;
	case "crash-sig":
		asst([{ type: "toolCall", id: "call_crash_sig", name: "bash", arguments: { command: "will-crash" } }], "toolUse");
		process.kill(process.pid, "SIGKILL");
		break;
	case "exit0-broken":
		// A mid-turn break that STILL exits 0 (the unprobed real-pi case the
		// content gate exists for): the last entry is a pending toolCall —
		// not an idle-assistant — so headless must record crashed, not completed.
		asst([{ type: "toolCall", id: "call_broken", name: "bash", arguments: { command: "broken" } }], "toolUse");
		await sleep(gapMs);
		process.exit(0);
		break;
	case "slow":
		asst([{ type: "text", text: "step one" }], "stop");
		await sleep(gapMs); // the inactivity window fires mid-gap
		asst([{ type: "text", text: "step two" }], "stop");
		await new Promise(() => {});
		break;
	case "pending-tool":
		asst([{ type: "toolCall", id: "call_fix9", name: "bash", arguments: { command: "long-running" } }], "toolUse");
		await new Promise(() => {}); // a long bash writes nothing
		break;
	default:
		process.stderr.write(`fixture: unknown mode ${mode}\n`);
		process.exit(64);
}
