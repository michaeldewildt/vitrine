/**
 * vitrine-run.test.ts — the wrapper suite:
 * A fixture `pi` binary (test/fixtures/fake-pi.ts — canned session-JSONL
 * growth shaped like real entries, assistant/toolResult ordering per
 * session-format, tool hangs, clean/exotic exits) drives:
 * - wall / inactivity / cost watchdogs, the ×3 pending-toolCall window,
 * - v1.21 stop-settle (completion on the tick: an unattended settled turn
 *   settles `completed (stop)` — no quiet window, no focus gate; attended
 *   suppresses it; a pending tool never settles),
 * - crash detection (exit code + signal, mid-turn = non-idle last entry),
 *   the SIGHUP trap, the /proc/<foot_pid> backstop (window closed ⇒ killed),
 * - stop ⇒ completed (the keep-alive regime, v1.11: the completed tile
 *   stays open — the unfocused-idle countdown closes it; a human-typed user
 *   entry resumes it — one `resumed` event, the title flips to `continued`;
 *   attended/0-`completed_close_s` tiles never auto-close), kill_requested ⇒
 *   killed,
 * - a tile worker that exits after a settled turn settles `stop` (the exit
 *   mapping), not killed/crashed,
 * - stuck-queued handling (the wrapper never spawns a non-queued task)
 * and spawn-failed (state stays running, dead-wrapper reconcile settles
 * it to crashed),
 * - session.json discovery from a cwd-keyed dir with concurrent spawns,
 * - the from-task fork hand-off (argv + parentSession + discovery),
 * - the headless exit mapping (`headless-exit` marker, the
 * idle-assistant content gate, clean non-zero ⇒ `failed`, signal ⇒
 * `crashed`, marker-wins),
 * - plus the pure cores: evaluateWatchdogs, session parsing/harvest,
 * buildWorkerArgv, the session-dir slug (pinned against real-pi dirs),
 * and protocol.mergeStateFields.
 * Hermetic: VITRINE_TASKS_ROOT / sessions root / agents dir / fixture pi are
 * all tmp-dir or in-process. No real pi, no Hyprland, no LLM. Real timers
 * (fast ticks); the suite takes ~20 s wall clock.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as P from "./protocol";
import * as H from "../test/helpers";
import {
	buildWorkerArgv,
	buildWorkerEnv,
	completedCloseCountdownS,
	evaluateKeepAlive,
	evaluateWatchdogs,
	hasUserEntryBeyond,
	keepAliveCloseS,
	lastAssistantText,
	lastMessageKind,
	parseSessionEntries,
	readSessionHeader,
	readSessionName,
	runHeadlessWrapper,
	runWrapper,
	sessionDirFor,
	spawnWorkerHandle,
	tickMsFromEnv,
	totalCostUsd,
	VITRINE_CONTRACT,
	type HeadlessDeps,
	type KeepAliveFacts,
	type WrapperDeps,
	type WatchdogFacts,
} from "./vitrine-run";

const fixturePi = join(import.meta.dir, "..", "test", "fixtures", "fake-pi.ts");

let tb: H.TestBase;
let tasksRoot: string;
let sessionsRoot: string;
let agentsDir: string;
let cwdA: string;
let cwdB: string;
beforeAll(async () => {
	tb = await H.makeBase("u2");
	tasksRoot = tb.tasksRoot;
	sessionsRoot = join(tb.base, "sessions");
	agentsDir = join(tb.base, "agents");
	cwdA = join(tb.base, "work-a");
	cwdB = join(tb.base, "work-b");
	await mkdir(cwdA, { recursive: true });
	await mkdir(cwdB, { recursive: true });
	await mkdir(agentsDir, { recursive: true });
	await writeFile(join(agentsDir, "test-agent.md"), "---\nname: test-agent\ndescription: fixture agent\n---\n# Fixture agent\n\nYou are the fixture test agent.\n");
});
afterAll(async () => {
	await tb.close();
});
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// helpers

// The suite's task factory: the shared one (test/helpers.ts) with this
// suite's cwd (session discovery looks under cwdA's session dir).
const makeTask = (
	over: Partial<P.TaskSpec> = {},
	agent: Partial<P.TaskSpec["agent"]> = {},
): Promise<string> => H.makeTask(tasksRoot, over, agent, cwdA);

function depsFor(fixtureEnv: Record<string, string> = {}, over: Partial<WrapperDeps> = {}): WrapperDeps {
	const spawnFixture: NonNullable<WrapperDeps["spawnWorker"]> = async (argv, env, opts) =>
		spawnWorkerHandle("bun", [fixturePi, ...argv], { ...env, ...fixtureEnv, VITRINE_SESSIONS_DIR: sessionsRoot }, opts);
	return {
		footPid: process.ppid,
		sessionsRoot,
		agentsDir,
		tickMs: 100,
		focusPollMs: 100,
		ppidPollMs: 100,
		killGraceMs: 400,
		focusOnWorker: async () => false,
		writeTitle: () => {},
		log: () => {},
		// the in-process wrapper has no pty: present one to the tile-mode
		// isatty sanity check so these tests exercise the lifecycle,
		// not the spawn-shape guard.
		isTty: () => true,
		spawnWorker: spawnFixture,
		...over,
	};
}

const msleep = H.msleep;

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
	return H.withTimeout(p, ms, label);
}

async function eventsOf(dir: string): Promise<Array<Record<string, unknown>>> {
	return H.eventsOf(dir);
}

// ---------------------------------------------------------------------------
// pure cores

describe("session-dir slug (pinned against real-pi dirs)", () => {
	it("matches the observed ~/.pi/agent/sessions layout", () => {
		expect(sessionDirFor("/home/mikey/Work", "/sessions")).toBe("/sessions/--home-mikey-Work--");
		expect(sessionDirFor("/tmp/vitrine-u2", "/sessions")).toBe("/sessions/--tmp-vitrine-u2--");
	});
});

describe("tickMsFromEnv (the wrapper's VITRINE_TICK_MS override)", () => {
	it("absent or invalid → 1000 (fail to production, never to zero)", () => {
		expect(tickMsFromEnv({})).toBe(1000);
		expect(tickMsFromEnv({ VITRINE_TICK_MS: "" })).toBe(1000);
		expect(tickMsFromEnv({ VITRINE_TICK_MS: "abc" })).toBe(1000);
		expect(tickMsFromEnv({ VITRINE_TICK_MS: "0" })).toBe(1000);
		expect(tickMsFromEnv({ VITRINE_TICK_MS: "-5" })).toBe(1000);
	});
	it("a valid value → the value", () => {
		expect(tickMsFromEnv({ VITRINE_TICK_MS: "30" })).toBe(30);
	});
});

describe("session parsing & watchdog facts", () => {
	const msg = (role: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
		type: "message",
		id: "abc12345",
		parentId: null,
		timestamp: new Date().toISOString(),
		message: { role, ...extra },
	});

	it("lastMessageKind classifies the last message entry", () => {
		expect(lastMessageKind([])
		).toBeNull();
		expect(lastMessageKind([msg("user", { content: "hi" })
		])
		).toBe("other");
			expect(lastMessageKind([msg("assistant", { content: [{ type: "text", text: "done" }
			]
		})
		])
		).toBe("idle-assistant");
				expect( lastMessageKind([ msg("assistant", { content: [{ type: "toolCall", id: "c1", name: "bash", arguments: {}
			}
			]
		}),
		])
		, ).toBe("pending-tool");
				expect( lastMessageKind([ msg("assistant", { content: [{ type: "toolCall", id: "c1", name: "bash", arguments: {}
			}
			]
		}),
			msg("toolResult", { toolCallId: "c1", toolName: "bash", content: []
		, isError: false }),
		])
		, ).toBe("other");
		// a toolResult last is a mid-turn entry, not an idle assistant
				expect( lastMessageKind([ msg("assistant", { content: [{ type: "toolCall", id: "c1", name: "bash", arguments: {}
			}
			]
		}),
			msg("toolResult", { toolCallId: "c1", toolName: "bash", content: []
		, isError: false }),
			msg("assistant", { content: [{ type: "text", text: "final" }
			]
		}),
		])
		, ).toBe("idle-assistant");

		// an unmatched EARLIER toolCall in a later assistant entry is still pending
		expect(
			lastMessageKind([
				msg("assistant", { content: [{ type: "toolCall", id: "c1", name: "bash", arguments: {} }] }),
				msg("assistant", { content: [{ type: "toolCall", id: "c2", name: "bash", arguments: {} }] }),
			]),
		).toBe("pending-tool");
	});

	it("lastAssistantText / totalCostUsd harvest from the right entries", () => {
		const entries = [
			msg("user", { content: "go" }),
			msg("assistant", {
				content: [{ type: "text", text: "first" }],
				usage: { cost: { total: 0.5 } },
			}),
			msg("toolResult", { toolCallId: "c1", toolName: "bash", content: [], isError: false }),
			msg("assistant", {
				content: [{ type: "thinking", thinking: "..." }, { type: "text", text: "second" }, { type: "text", text: "third" }],
				usage: { cost: { total: 0.25 } },
			}),
		];
		expect(lastAssistantText(entries)).toBe("second\n\nthird");
		expect(totalCostUsd(entries)).toBeCloseTo(0.75);
		expect(lastAssistantText([msg("user", { content: "go" })])).toBeNull();
	});

	it("parseSessionEntries tolerates a torn last line", async () => {
		const f = join(tb.base, "torn.jsonl");
		await writeFile(f, '{"type":"session","version":3,"id":"x","timestamp":"t","cwd":"/w"}\n{"type":"message","partial":\n');
		const r = await parseSessionEntries(f);
		expect(r.entries.length).toBe(1);
		expect(r.skipped).toBe(1);
	});
});

	describe("buildWorkerArgv", () => {
const spec = (over: Partial<P.TaskSpec> = {}, agent: Partial<P.TaskSpec["agent"]> = {}): P.TaskSpec => ({
	task_id: "11111111-1111-4111-8111-111111111111",
	agent: { name: "test-agent", ...agent },
	dispatcher_session_id: "disp",
	cwd: cwdA,
	session_id: "vitrine.11111111-1111-4111-8111-111111111111",
	session_name: "test-agent · 11111111",
	mode: "tile",
	attended: false,
	workspace: 9,
	wall_timeout_s: 3600,
	inactivity_s: 3600,
	auto_settle_s: 3600,
	auto_settle_grace_s: 60,
	created_at: new Date().toISOString(),
	boot_id: "boot",
	...over,
});

		it("minimal: session-id, name, system-prompt path, @prompt", () => {
			const args = buildWorkerArgv(join(tasksRoot, "t"), spec(), null, join(tasksRoot, "t", "system-prompt.md"), "/sessions");
			expect(args[0])
			.toBe("--session-id");
			expect(args[1])
			.toBe("vitrine.11111111-1111-4111-8111-111111111111");
			const ni = args.indexOf("--name");
			expect(args[ni + 1])
			.toBe("test-agent · 11111111");
			// the system prompt is passed BY PATH (never inline: an inline value // that names an existing file would be read as a file by pi)
			const ai = args.indexOf("--append-system-prompt");
			expect(args[ai + 1])
			.toBe(join(tasksRoot, "t", "system-prompt.md"));
			const sd = args.indexOf("--session-dir");
			expect(args[sd + 1])
			.toBe("/sessions");
			expect(args.at(-2)).toBe("--");
			expect(args.at(-1)).toBe(`@${join(tasksRoot, "t", "prompt.md")}`);
			expect(args).not.toContain("--tools");
			expect(args).not.toContain("--model");
			expect(args).not.toContain("--fork");
			});
			it("full: model/thinking, the tools ceiling, and --fork first", () => {
				const args = buildWorkerArgv( join(tasksRoot, "t"), spec({}
					, { model: "ninfer/qwen3.8-27b", thinking: "high", tools: ["read", "grep"]
				}),
				"/sessions/from.jsonl", "/t/system-prompt.md", "/sessions", );
				expect(args.slice(0, 2)).toEqual(["--fork", "/sessions/from.jsonl"])
				;
				const mi = args.indexOf("--model");
				expect(args[mi + 1])
				.toBe("ninfer/qwen3.8-27b");
				const ti = args.indexOf("--thinking");
				expect(args[ti + 1])
				.toBe("high");
				// the tools ceiling: the agent's list, deduped, verbatim (no union —
				// the `vitrine_done` union is gone with the tool)
				const toi = args.indexOf("--tools");
				expect(args[toi + 1])
				.toBe("read,grep");
			});
			it("keeps an explicit tools list free of duplicates", () => {
				const args = buildWorkerArgv(join(tasksRoot, "t"), spec({}
					, { tools: ["read", "read", "grep"]
				}),
				null, "b", "/sessions");
				const toi = args.indexOf("--tools");
				expect(args[toi + 1])
				.toBe("read,grep");
			});
			it("empty or absent tools list ⇒ no --tools flag at all (the full default surface)", () => {

				// v1.21 re-derivation: the union with `vitrine_done` is gone, so an empty
				// list no longer needs to force a flag — an empty list means no flag (the
				// FULL default surface).
				const args = buildWorkerArgv(join(tasksRoot, "t"), spec({}
					, { tools: []
				}),
				null, "b", "/sessions");
				expect(args).not.toContain("--tools");
				// and an absent list likewise (the `noTools` encoding)
				const argsAbsent = buildWorkerArgv(join(tasksRoot, "t"), spec({}
					, {}),
				null, "b", "/sessions");
				expect(argsAbsent).not.toContain("--tools");
			});

		});
		describe("buildWorkerEnv (: the worker's env is what vitrine-run sets)", () => {
			it("carries VITRINE_TASK_DIR + the minimal set, and rides Hyprland vars along", () => {
				const env = buildWorkerEnv("/tmp/tasks/t", {
					PATH: "/usr/bin",
					HOME: "/home/mikey",
					TERM: "xterm-256color",
					HYPRLAND_INSTANCE_SIGNATURE: "abc123",
					WAYLAND_DISPLAY: "wayland-0",
					VITRINE_PI_BIN: "/should-not-ride",
				});
				expect(env.VITRINE_TASK_DIR).toBe("/tmp/tasks/t");
				expect(env.PATH).toBe("/usr/bin");
				expect(env.HOME).toBe("/home/mikey");
				expect(env.TERM).toBe("xterm-256color");
				expect(env.HYPRLAND_INSTANCE_SIGNATURE).toBe("abc123");
				expect(env.WAYLAND_DISPLAY).toBe("wayland-0");
				// the wrapper's spawn-shape test hook never rides along to the worker
				expect(env.VITRINE_PI_BIN).toBeUndefined();
			});

			it("propagates the wrapper's custom roots (the worker must resolve the same tasks + sessions roots)", () => {
				const env = buildWorkerEnv("/tmp/tasks/t", {
					VITRINE_TASKS_ROOT: "/custom/tasks",
					VITRINE_SESSIONS_DIR: "/custom/sessions",
				});
				// without these the worker would fall back to the defaults and the
				// wrapper would never find the worker's session file
				// (session.json discovery, watchdog inputs)
				expect(env.VITRINE_TASKS_ROOT).toBe("/custom/tasks");
				expect(env.VITRINE_SESSIONS_DIR).toBe("/custom/sessions");
			});

			it("fills sensible defaults when the parent env is bare", () => {
				const env = buildWorkerEnv("/tmp/tasks/t", {});
				expect(env.PATH).toBe("/usr/local/bin:/usr/bin:/bin");
				expect(env.TERM).toBe("xterm-256color");
				expect(env.VITRINE_TASK_DIR).toBe("/tmp/tasks/t");
			});
});

			describe("evaluateWatchdogs (pure)", () => {
const facts = (over: Partial<WatchdogFacts> = {}): WatchdogFacts => ({
	nowMs: 10_000,
	wallStartMs: 0,
	wallTimeoutS: 3600,
	sessionMtimeMs: 9_000,
	lastEntry: "idle-assistant",
	totalCostUsd: 0,
	maxCostUsd: null,
	inactivityS: 3600,
	attended: false,
	autoSettleS: 3600,
	autoSettleGraceS: 60,
	unfocusedMs: 0,
	markerPresent: false,
	markerSource: null,
	killRequested: false,
	...over,
});

				it("marker beats everything (order rule 1)", () => {
					expect(evaluateWatchdogs(facts({ markerPresent: true, markerSource: "stop" })))
					.toEqual({ kind: "completed", source: "stop", });
					expect( evaluateWatchdogs(facts({ markerPresent: true, markerSource: "auto_settle", killRequested: true, wallTimeoutS: 1 })),
					).toEqual({ kind: "completed", source: "auto_settle" });
				});
				it("kill intent beats the budgets", () => {
					expect(evaluateWatchdogs(facts({ killRequested: true, wallTimeoutS: 1 })))
					.toEqual({ kind: "kill" });
				});
				it("wall fires at the boundary", () => {
					// the pending-tool last entry isolates the wall (an idle-assistant
					// would stop-settle first)
					expect(evaluateWatchdogs(facts({ wallTimeoutS: 10, nowMs: 9_999, lastEntry: "pending-tool" })))
					.toEqual({ kind: "wait" });
					expect(evaluateWatchdogs(facts({ wallTimeoutS: 10, nowMs: 10_000, lastEntry: "pending-tool" })))
					.toEqual({ kind: "timeout", reason: "wall" });
				});
				it("inactivity: quiet ×1; ×3 while the last entry is a pending tool call", () => {
					// attended isolates the ×1 quiet path (an unattended settled turn
					// stop-settles first — inactivity is its last resort)
					expect(evaluateWatchdogs(facts({ attended: true, inactivityS: 1, sessionMtimeMs: 8_000 }))).toEqual({ kind: "timeout", reason: "inactivity" });
					expect(evaluateWatchdogs(facts({ attended: true, inactivityS: 1, sessionMtimeMs: 9_500 }))).toEqual({ kind: "wait" });
					// pending tool: 2 s quiet is still inside the 3 s window
					expect(evaluateWatchdogs(facts({ inactivityS: 1, sessionMtimeMs: 8_000, lastEntry: "pending-tool" }))).toEqual({
						kind: "wait",
					});
					expect(evaluateWatchdogs(facts({ inactivityS: 1, sessionMtimeMs: 7_000, lastEntry: "pending-tool" }))).toEqual({
						kind: "timeout",
						reason: "inactivity",
					});
					// no session file yet: inactivity is not measurable (the wall bounds it)
					expect(evaluateWatchdogs(facts({ inactivityS: 1, sessionMtimeMs: null, lastEntry: null }))).toEqual({ kind: "wait" });
				});

				it("cost fires at the budget (local models report 0 — budgets bite on cloud)", () => {
					// attended isolates the cost check (an unattended settled turn stop-settles first)
					expect(evaluateWatchdogs(facts({ attended: true, maxCostUsd: 1, totalCostUsd: 0.99 }))).toEqual({ kind: "wait" });
					expect(evaluateWatchdogs(facts({ attended: true, maxCostUsd: 1, totalCostUsd: 1 }))).toEqual({ kind: "timeout", reason: "cost" });
				});

				it("stop-settle (v1.21): unattended + idle-assistant, immediate — no quiet window, no unfocused grace; suppressed by attended/busy-kind", () => {
					const base2 = (over: Partial<WatchdogFacts> = {}): WatchdogFacts =>
						facts({ autoSettleS: 1, autoSettleGraceS: 1, sessionMtimeMs: 8_000, unfocusedMs: 1_000, ...over });
					// the old auto-settle facts (quiet + unfocused for the full windows) settle immediately now
					expect(evaluateWatchdogs(base2())).toEqual({ kind: "stop-settle" });
					expect(evaluateWatchdogs(base2({ attended: true }))).toEqual({ kind: "wait" });
					expect(evaluateWatchdogs(base2({ lastEntry: "pending-tool" }))).toEqual({ kind: "wait" });
					expect(evaluateWatchdogs(base2({ lastEntry: "other" }))).toEqual({ kind: "wait" });
					// the quiet window and the unfocused grace no longer gate it —
					// the keep-alive phase owns the viewing window after the settle
					expect(evaluateWatchdogs(base2({ unfocusedMs: 0 }))).toEqual({ kind: "stop-settle" });
					expect(evaluateWatchdogs(base2({ sessionMtimeMs: 9_999 }))).toEqual({ kind: "stop-settle" });
				});
});

				describe("evaluateKeepAlive (pure, v1.11)", () => {
					const ka = (over: Partial<KeepAliveFacts> = {})
							: KeepAliveFacts => ({ nowMs: 10_000, workerExited: false, closeIntent: false, attended: false, completedCloseS: 10,
						// the test clock runs in ms — a 10 s window fits it
						unfocusedSinceMs: null, lastEntry: "idle-assistant", ...over, });
						it("precedence: worker exit > close intent > countdown", () => {
							expect(evaluateKeepAlive(ka({ workerExited: true, closeIntent: true })))
							.toEqual({ kind: "close-worker-exit" });
							expect(evaluateKeepAlive(ka({ closeIntent: true })))
							.toEqual({ kind: "close-intent" });
							expect(evaluateKeepAlive(ka({ closeIntent: true, lastEntry: "pending-tool" })))
							.toEqual({ kind: "close-intent" });

						// intent beats a busy turn too (a human close is not the countdown)
						expect(evaluateKeepAlive(ka({ unfocusedSinceMs: 0 })))
						.toEqual({ kind: "close-countdown" });

						// the full window has elapsed (exactly at the boundary)
						expect(evaluateKeepAlive(ka({})))
						.toEqual({ kind: "wait" });
						});
						it("keepAliveCloseS: the spec field, with the 600 fallback for specs written by older dispatchers", () => {
							expect(keepAliveCloseS({}))
							.toBe(600);

						// the field is absent
						expect(keepAliveCloseS({ completed_close_s: 60 }))
						.toBe(60);
						expect(keepAliveCloseS({ completed_close_s: 0 }))
						.toBe(0);

						// 0 = never auto-close (carried through, not defaulted away)
						});
						it("the countdown: unattended + closeS > 0 + unfocused for the full window + idle (or no session)", () => {
							expect(evaluateKeepAlive(ka({ unfocusedSinceMs: 0 })))
							.toEqual({ kind: "close-countdown" });

						// exactly at the boundary
						expect(evaluateKeepAlive(ka({ unfocusedSinceMs: 1 })))
						.toEqual({ kind: "wait" });

						// 1 ms short
						expect(evaluateKeepAlive(ka({ unfocusedSinceMs: 0, attended: true })))
						.toEqual({ kind: "wait" });
						expect(evaluateKeepAlive(ka({ unfocusedSinceMs: 0, completedCloseS: 0 })))
						.toEqual({ kind: "wait" });

						// 0 = never
						expect(evaluateKeepAlive(ka({ unfocusedSinceMs: 0, lastEntry: "pending-tool" })))
						.toEqual({ kind: "wait" });
						expect(evaluateKeepAlive(ka({ unfocusedSinceMs: 0, lastEntry: "other" })))
						.toEqual({ kind: "wait" });
						expect(evaluateKeepAlive(ka({ unfocusedSinceMs: 0, lastEntry: null })))
						.toEqual({ kind: "close-countdown" });
						expect(evaluateKeepAlive(ka({ unfocusedSinceMs: 0, closeIntent: true })))
						.toEqual({ kind: "close-intent" });

						// intent beats the countdown
						});
						it("completedCloseCountdownS: the title countdown (null while focused/attended/0/busy)", () => {

						// nowMs 600_000, unfocused since 590_000: 10 s into a 600 s window ⇒ 590 s left
						expect( completedCloseCountdownS({ attended: false, completedCloseS: 600, unfocusedSinceMs: 590_000, nowMs: 600_000, lastEntry: "idle-assistant", }),
						).toBe(590);
						expect(completedCloseCountdownS({ attended: false, completedCloseS: 600, unfocusedSinceMs: 600_000, nowMs: 600_000, lastEntry: "idle-assistant" }))
						.toBe(600);
						expect(completedCloseCountdownS({ attended: true, completedCloseS: 600, unfocusedSinceMs: 0, nowMs: 600_000, lastEntry: "idle-assistant" }))
						.toBeNull();
						expect(completedCloseCountdownS({ attended: false, completedCloseS: 0, unfocusedSinceMs: 0, nowMs: 600_000, lastEntry: "idle-assistant" }))
						.toBeNull();
							expect(completedCloseCountdownS({ attended: false, completedCloseS: 600,
						unfocusedSinceMs: null, nowMs: 600_000, lastEntry: "idle-assistant" }))
						.toBeNull();
						expect(completedCloseCountdownS({ attended: false, completedCloseS: 600, unfocusedSinceMs: 0, nowMs: 600_000, lastEntry: "pending-tool" }))
						.toBeNull();
						});
							const msg = (role: string): Record<string, unknown> => ({ type: "message", id: `m-${role}-${Math.random()}`, parentId: null, timestamp: new Date().toISOString(), message: { role }
						, });
						it("hasUserEntryBeyond: only user entries at index >= the snapshot count", () => {
							expect(hasUserEntryBeyond([msg("assistant"), msg("assistant"), msg("assistant"), msg("assistant"), msg("user")]
							, 4)).toBe(true);
							expect(hasUserEntryBeyond([msg("assistant"), msg("assistant"), msg("assistant"), msg("user")]
							, 4)).toBe(false);

						// the user entry is AT the snapshot (initial prompt / copied)
						expect(hasUserEntryBeyond([msg("assistant"), msg("assistant")]
						, 2)).toBe(false);
						expect(hasUserEntryBeyond([msg("user")]
						, 0)).toBe(true); // a fork whose only pre-entry is a user entry: still at the snapshot
						expect(hasUserEntryBeyond([msg("user"), msg("user")], 1)).toBe(true); // and beyond it
					});
});

					describe("protocol.mergeStateFields", () => {
						it("merges pid fields while running and logs state-fields", async () => {
							const dir = await makeTask();
							await P.transitionState(dir, "queued", "running", { wrapper_pid: 4242 }
							, "spawn");
							const r = await P.mergeStateFields(dir, "running", { worker_pid: 1234, worker_pid_start: "1234567" }
							, "worker-spawned");
							expect(r).toEqual({ merged: true, state: "running" });
							const st = await P.readState(dir);
							expect(st.worker_pid).toBe(1234);
							expect(st.worker_pid_start).toBe("1234567");
							expect(st.wrapper_pid).toBe(4242);
							expect(st.state).toBe("running");
							const ev = await eventsOf(dir);
							expect(ev.some((e) => e.event === "state-fields" && e.note === "worker-spawned")).toBe(true);
						});
						it("bails when the state moved off the expected value (no clobber)", async () => {
							const dir = await makeTask();
							await P.transitionState(dir, "queued", "crashed", {}
							, "never-spawned");
							const r = await P.mergeStateFields(dir, "running", { worker_pid: 999 }
							, "worker-spawned");
							expect(r.merged).toBe(false);
							if (!r.merged) expect(r.current).toBe("crashed");
							const st = await P.readState(dir);
							expect(st.worker_pid).toBeUndefined();
							const ev = await eventsOf(dir);
							expect(ev.some((e) => e.event === "merge-rejected")).toBe(true);
						});
						it("bails from a terminal state", async () => {
							const dir = await makeTask();
							await P.transitionState(dir, "queued", "running", {}
							, "spawn");
							await P.transitionState(dir, "running", "killed", {}
							, "kill_requested");
							const r = await P.mergeStateFields(dir, "running", { worker_pid: 1 }
							, "late");
							expect(r.merged).toBe(false);
						});
					});
					// ---------------------------------------------------------------------------
					// E2E — the wrapper drives the fixture pi
					describe("stop (v1.21: completion on the tick)", () => {
						it("stop-settle: the worker's turn settled (unattended) ⇒ completed (stop), result.md harvested, keep-alive closes it", async () => {
							const dir = await makeTask({ completed_close_s: 1 });
							const titles: string[]
							= [];
							const out = await withTimeout( runWrapper(dir, depsFor({ VITRINE_FIXTURE_MODE: "hang" }
							, { writeTitle: (t) => titles.push(t) })),
							15_000, "stop-settle", );
							expect(out).toBe("completed");
							const st = await P.readState(dir);
							expect(st.state).toBe("completed");
							expect(st.reason).toBe("stop");
							expect(await readFile(join(dir, "result.md"), "utf8")).toContain("fixture finished the work");
							const marker = await P.readDoneMarker(dir);
							expect(marker?.source).toBe("stop");
							const sess = await P.readSession(dir);
							expect(await readSessionHeader(sess.session_file)).toEqual( expect.objectContaining({ id: `vitrine.${P.taskIdOf(dir)}` }),
							);
							const ev = await eventsOf(dir);
							expect(ev.some((e) => e.event === "session")).toBe(true);
							expect(ev.some((e) => e.event === "stop-settle")).toBe(true);
							expect(ev.some((e) => e.event === "done-marker" && e.source === "stop")).toBe(true);
							expect(ev.some((e) => e.event === "completed-close")).toBe(true);
							// the keep-alive close killed the resident worker
							expect(st.worker_pid !== undefined && P.pidInfo(st.worker_pid).alive).toBe(false);
							expect(titles.some((t) => t.includes("completed"))).toBe(true);
							expect(titles.some((t) => t.includes("completed ("))).toBe(true); // the close countdown title

					// the system prompt is a task-dir file (0600, wrapper-written before spawn)
					const sp = await readFile(join(dir, "system-prompt.md"), "utf8");
					expect(sp).toContain("You are the fixture test agent.");
					expect(sp).toContain(VITRINE_CONTRACT);
					const spStat = await stat(join(dir, "system-prompt.md"));
					expect((spStat.mode & 0o777).toString(8)).toBe("600");
					});
					it("worker contract carries the v1.21 completion doctrine: final message is the deliverable + audit manifest", () => {

					// pinned as literals: a future contract rewrite must not silently drop these
					// lines (the deliverable + the audit manifest).
					expect(VITRINE_CONTRACT).toContain("Your final message is the deliverable");
					expect(VITRINE_CONTRACT).toContain("OPENED FILES");
					});
					it("a transient session read failure around the settle cannot misfire resumed (the snapshot is the last GOOD count, never 0)", async () => {
						const dir = await makeTask({ completed_close_s: 1 });
						const titles: string[]
						= [];
						const p = runWrapper(dir, depsFor({ VITRINE_FIXTURE_MODE: "hang" }
						, { writeTitle: (t) => titles.push(t) }));
						// wait for the session attach (session.json written by the wrapper)
						await withTimeout( (async () => {
							while ((await P.readSession(dir).catch(() => null)) === null) await msleep(20);
						})
						(), 10_000, "session attach", );
						const { session_file } = await P.readSession(dir);
						// a transient read failure: hide the session file for a few ticks
						await rename(session_file, session_file + ".hidden");
						await msleep(500);
						await rename(session_file + ".hidden", session_file);
						const out = await withTimeout(p, 20_000, "snapshot-hollow");
						expect(out).toBe("completed");
						const st = await P.readState(dir);
						expect(st.state).toBe("completed");
						const ev = await eventsOf(dir);
						expect(ev.some((e) => e.event === "resumed")).toBe(false);

					// the initial prompt is not a resume (the snapshot is the last GOOD count, never 0)
					expect(ev.some((e) => e.event === "completed-close")).toBe(true);

					// the session was restored → the countdown still closes
					expect(ev.some((e) => e.event === "transition-rejected")).toBe(false);
					expect(titles.some((t) => t.includes("continued"))).toBe(false);
					});
					it("worker exits after completion: the wrapper closes the tile with it (event pinned, no settle)", async () => {
						const dir = await makeTask({ completed_close_s: 3600 });
						const p = runWrapper(dir, depsFor({ VITRINE_FIXTURE_MODE: "hang" }));
						await withTimeout( (async () => {
							while ((await P.readState(dir)).state !== "completed") await msleep(50);
						})
						(), 10_000, "wait for completed", );
						const st = await P.readState(dir);
						expect(st.reason).toBe("stop"); // the original settle's reason — untouched
						expect(st.worker_pid !== undefined && P.pidInfo(st.worker_pid).alive).toBe(true);
						// the resident worker self-exits after completion
						process.kill(st.worker_pid!, "SIGKILL");
						const out = await withTimeout(p, 15_000, "self-exit");
						expect(out).toBe("completed");
						expect((await P.readState(dir)).state).toBe("completed");
						const ev = await eventsOf(dir);
						expect(ev.some((e) => e.event === "worker-exit-after-completion")).toBe(true);
						expect(ev.some((e) => e.event === "transition-rejected")).toBe(false);
				});
});

				describe("watchdogs (fixture-driven)", () => {
					it("wall timeout kills the worker and records timeout (wall)", async () => {
						// pending-tool: the turn never settles, so the wall — not
						// the stop-settle — is what ends it
						const dir = await makeTask({ wall_timeout_s: 1 });
						const titles: string[]
						= [];
						const out = await withTimeout( runWrapper(dir, depsFor({ VITRINE_FIXTURE_MODE: "pending-tool" }
						, { writeTitle: (t) => titles.push(t) })),
						15_000, "wall", );
						expect(out).toBe("timeout");
						const st = await P.readState(dir);
						expect(st.state).toBe("timeout");
						expect(st.reason).toBe("wall");
						expect(st.worker_pid !== undefined && P.pidInfo(st.worker_pid).alive).toBe(false);
						expect(titles.some((t) => t.includes("timeout"))).toBe(true);
						const ev = await eventsOf(dir);
						expect(ev.some((e) => e.event === "timeout" && e.reason === "wall")).toBe(true);
					});
					it("inactivity fires after the quiet window (no pending tool)", async () => {
						// attended: the settled turn never stop-settles (the human's
						// workspace), so the inactivity quiet window is what fires
						const dir = await makeTask({ inactivity_s: 1, attended: true });
						const out = await withTimeout( runWrapper(dir, depsFor({ VITRINE_FIXTURE_MODE: "slow", VITRINE_FIXTURE_GAP_MS: "1500" })),
						15_000, "inactivity", );
						expect(out).toBe("timeout");
						const st = await P.readState(dir);
						expect(st.reason).toBe("inactivity");
					});
					it("a pending tool call triples the inactivity window", async () => {
						const dir = await makeTask({ inactivity_s: 1 });
						const p = runWrapper(dir, depsFor({ VITRINE_FIXTURE_MODE: "pending-tool", VITRINE_FIXTURE_GAP_MS: "4000" }));
						// 2 s in: 1× elapsed, 3× not — still running
						await msleep(2_000);
						expect((await P.readState(dir)).state).toBe("running");
						const out = await withTimeout(p, 15_000, "pending-tool inactivity");
						expect(out).toBe("timeout");
						expect((await P.readState(dir)).reason).toBe("inactivity");
					});

					it("cost budget expiry", async () => {
						// pending-tool: the turn never settles, so the cost budget —
						// not the stop-settle — is what ends it (the single toolCall
						// entry's cost reaches the budget at the first tick)
						const dir = await makeTask({ max_cost_usd: 0.8 });
						const out = await withTimeout(
							runWrapper(dir, depsFor({ VITRINE_FIXTURE_MODE: "pending-tool", VITRINE_FIXTURE_COST: "0.8" })),
							15_000,
							"cost",
						);
						expect(out).toBe("timeout");
						const st = await P.readState(dir);
						expect(st.reason).toBe("cost");
					});
});

					describe("stop-settle (v1.21: completion on the tick, unattended only)", () => {
						it("settles a stopped tile on the tick (no quiet window, no unfocused grace): marker stop, harvested result, keep-alive closes it", async () => {
							// auto_settle_s far in the future: if this settled, it was the
							// stop-settle (the immediate channel), not the auto-settle
							const dir = await makeTask({ auto_settle_s: 3600, auto_settle_grace_s: 60, completed_close_s: 1 });
							const titles: string[]
							= [];
							const out = await withTimeout( runWrapper(dir, depsFor({ VITRINE_FIXTURE_MODE: "hang" }
							, { writeTitle: (t) => titles.push(t) })),
							15_000, "stop-settle", );
							expect(out).toBe("completed");
							const st = await P.readState(dir);
							expect(st.state).toBe("completed");
							expect(st.reason).toBe("stop");
							expect(await P.readDoneMarker(dir)).toEqual(expect.objectContaining({ source: "stop" }));
							expect(await readFile(join(dir, "result.md"), "utf8")).toContain("fixture finished the work");
							expect(st.worker_pid !== undefined && P.pidInfo(st.worker_pid).alive).toBe(false);
							const ev = await eventsOf(dir);
							expect(ev.some((e) => e.event === "stop-settle")).toBe(true);
							expect(ev.some((e) => e.event === "completed-close")).toBe(true);
							// the keep-alive close
							});
							it("a focused tile is settled too (the keep-alive phase owns the viewing window)", async () => {
								let focused = true;
								const dir = await makeTask({ completed_close_s: 1 });
								const p = runWrapper(dir, depsFor({ VITRINE_FIXTURE_MODE: "hang" }
								, { focusOnWorker: async () => focused }));
								await msleep(2_000);

							// settled — focus no longer gates the settle (v1.21) — but the
							// human is watching, so the tile STAYS OPEN (keep-alive)
							const st = await P.readState(dir);
							expect(st.state).toBe("completed");
							expect(st.reason).toBe("stop");
							expect(st.worker_pid !== undefined && P.pidInfo(st.worker_pid).alive).toBe(true);
							focused = false;

							// the human looks away — the countdown closes
							const out = await withTimeout(p, 15_000, "close after focus drops");
							expect(out).toBe("completed");
							expect((await P.readState(dir)).reason).toBe("stop");
							});
							it("attended: settle is suppressed entirely (the human's workspace: only a kill or a close completes it)", async () => {
								const dir = await makeTask({ attended: true, auto_settle_s: 1, auto_settle_grace_s: 1 });
								const p = runWrapper(dir, depsFor({ VITRINE_FIXTURE_MODE: "hang" }));
								await msleep(2_500);
								expect((await P.readState(dir)).state).toBe("running");
								expect((await P.readDoneMarker(dir))).toBeNull();
								await P.requestKill(dir); // the only other completion: the human closes/kills
								const out = await withTimeout(p, 15_000, "attended kill");
								expect(out).toBe("killed");
						});

						it("an in-progress turn (pending tool) is not settled, however quiet", async () => {
							const dir = await makeTask({ auto_settle_s: 1, auto_settle_grace_s: 1, inactivity_s: 30 });
							const p = runWrapper(dir, depsFor({ VITRINE_FIXTURE_MODE: "pending-tool", VITRINE_FIXTURE_GAP_MS: "4000" }));
							await msleep(2_500);
							expect((await P.readState(dir)).state).toBe("running");
							expect((await P.readDoneMarker(dir))).toBeNull();
							await P.requestKill(dir);
							expect(await withTimeout(p, 15_000, "pending-tool settle guard")).toBe("killed");
						});
});

						describe("keep-alive (v1.11)", () => {
							async function waitCompleted(dir: string): Promise<void> {
								await withTimeout( (async () => {
									while ((await P.readState(dir)).state !== "completed") await msleep(50);
								})
								(), 10_000, "wait for completed", );
							}
							const sighupGuard = (): void => {
							};
							it("focused completed tile: the countdown never fires (the human is reading)", async () => {
								let focused = true;
								const dir = await makeTask({ completed_close_s: 1 });
								const p = runWrapper(dir, depsFor({ VITRINE_FIXTURE_MODE: "hang" }
								, { focusOnWorker: async () => focused }));
								await msleep(1_500);
								// well past the window — but focused the whole time
								const st = await P.readState(dir);
								expect(st.state).toBe("completed");
								expect(st.worker_pid !== undefined && P.pidInfo(st.worker_pid).alive).toBe(true);

								// tile still open
								focused = false;

								// the human looks away
								const out = await withTimeout(p, 15_000, "close after focus drops");
								expect(out).toBe("completed");
								expect((await P.readState(dir)).state).toBe("completed");
								expect(st.worker_pid !== undefined && P.pidInfo(st.worker_pid).alive).toBe(false);
								});
								it("attended: the completion channel is suppressed — the tile never settles, never auto-closes (a signal closes it as killed)", async () => {
									const dir = await makeTask({ attended: true, completed_close_s: 1 });
									process.on("SIGHUP", sighupGuard);
									try {
										const p = runWrapper(dir, depsFor({ VITRINE_FIXTURE_MODE: "hang" }));
										await msleep(1_500);

								const st = await P.readState(dir);
								expect(st.state).toBe("running"); // never settled (attended suppresses stop-settle)
								expect(st.worker_pid !== undefined && P.pidInfo(st.worker_pid).alive).toBe(true);

								// never auto-closes
								process.kill(process.pid, "SIGHUP");
								const out = await withTimeout(p, 15_000, "attended stop-settle SIGHUP");
								expect(out).toBe("killed");
								expect((await P.readState(dir)).state).toBe("killed"); // it was never settled

								// the close killed the worker
								expect(st.worker_pid !== undefined && P.pidInfo(st.worker_pid).alive).toBe(false);
								}
									finally { process.removeListener("SIGHUP", sighupGuard);
								}
								});
								it("completed_close_s: 0: a completed tile never auto-closes", async () => {
									const dir = await makeTask({ completed_close_s: 0 });
									const p = runWrapper(dir, depsFor({ VITRINE_FIXTURE_MODE: "hang" }));
									await msleep(1_500);

								// well past where a 1 s window would have closed
								const st = await P.readState(dir);
								expect(st.state).toBe("completed");
								expect(st.worker_pid !== undefined && P.pidInfo(st.worker_pid).alive).toBe(true);

								// 0 = never
								expect((await eventsOf(dir)).some((e) => e.event === "completed-close")).toBe(false);
								process.on("SIGHUP", sighupGuard);
								try {
									process.kill(process.pid, "SIGHUP");
									expect(await withTimeout(p, 15_000, "closeS 0 SIGHUP")).toBe("completed");
									expect((await P.readState(dir)).state).toBe("completed");
								}
									finally { process.removeListener("SIGHUP", sighupGuard);
								}
								});
								it("human resume: one resumed event, continued title, state untouched (a second turn adds nothing)", async () => {
									const dir = await makeTask({ completed_close_s: 3600 });
									const titles: string[]
									= [];
									const p = runWrapper(dir, depsFor({ VITRINE_FIXTURE_MODE: "hang" }
									, { writeTitle: (t) => titles.push(t) }));
									await waitCompleted(dir);
									const before = await P.readState(dir);
									const sess = await P.readSession(dir);
									let n = 0;
										const appendUser = (text: string): Promise<void> => appendFile( sess.session_file, `${JSON.stringify({ id: `user-resume-${n++}
									`, parentId: null, timestamp: new Date().toISOString(), type: "message", message: { role: "user", content: text, timestamp: Date.now() }, })}\n`, );
									await appendUser("what did you do?");
									await withTimeout( (async () => {
										while (!(await eventsOf(dir)).some((e) => e.event === "resumed")) await msleep(50);
									})
									(), 10_000, "wait for resumed", );
									await appendUser("and more?");
									await msleep(500);

								// several ticks — the latch holds
								const ev = await eventsOf(dir);
								const res = ev.filter((e) => e.event === "resumed");
								expect(res.length).toBe(1);
								expect(res[0]
								.source).toBe("human");
								expect(JSON.stringify(await P.readState(dir))).toBe(JSON.stringify(before));

								// state untouched
								expect(titles.some((t) => t.includes("continued (human)"))).toBe(true);
								process.on("SIGHUP", sighupGuard);
								try {
									process.kill(process.pid, "SIGHUP");
									expect(await withTimeout(p, 15_000, "resume SIGHUP")).toBe("completed");
									expect((await P.readState(dir)).state).toBe("completed");
									const ev2 = await eventsOf(dir);
									expect(ev2.filter((e) => e.event === "resumed").length).toBe(1);

								// the close wrote nothing new
								expect(ev2.some((e) => e.event === "transition-rejected")).toBe(false);
								}
									finally { process.removeListener("SIGHUP", sighupGuard);
								}
								});
								it("a busy resumed turn (pending tool call) is never killed by the countdown", async () => {
									const dir = await makeTask({ completed_close_s: 1 });
									const p = runWrapper(dir, depsFor({ VITRINE_FIXTURE_MODE: "hang" }));
									await waitCompleted(dir);
									// the worker resumes a turn: a pending toolCall as the last entry
									const sess = await P.readSession(dir);
									await appendFile(sess.session_file, `${JSON.stringify({ id: `busy-${Date.now()}`, parentId: null, timestamp: new Date().toISOString(), type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "call_busy_resume", name: "bash", arguments: { command: "long-running" } }], stopReason: "toolUse" }, })}\n`);
									await msleep(1_500);

								// well past the window — but the last entry is a pending tool call
								const st = await P.readState(dir);
								expect(st.state).toBe("completed");
								expect(st.worker_pid !== undefined && P.pidInfo(st.worker_pid).alive).toBe(true);
								process.on("SIGHUP", sighupGuard);
								try {
									process.kill(process.pid, "SIGHUP");
									expect(await withTimeout(p, 15_000, "busy SIGHUP")).toBe("completed");
									expect((await P.readState(dir)).state).toBe("completed");
								}
									finally { process.removeListener("SIGHUP", sighupGuard);
								}
								});
								it("a forked session's copied user entries do not fire resume (snapshot-based detection)", async () => {
									const rawFile = join(sessionsRoot, "raw-ka-source.jsonl");
									await writeFile( rawFile, `${JSON.stringify({ type: "session", version: 3, id: "ka-src", timestamp: new Date().toISOString(), cwd: cwdA })}\n${JSON.stringify({ type: "message", message: { role: "user", content: "source user entry" } })}\n`, );
									const dir = await makeTask({ cwd: cwdA, from_session_file: rawFile, completed_close_s: 3600 });
									const p = runWrapper(dir, depsFor({ VITRINE_FIXTURE_MODE: "hang" }));
									await waitCompleted(dir);
									await msleep(1_000);

								// several ticks of keep-alive on the forked (copied) session
								expect((await eventsOf(dir)).some((e) => e.event === "resumed")).toBe(false);

								// the copied user entry predates the snapshot
								process.on("SIGHUP", sighupGuard);
								try {
									process.kill(process.pid, "SIGHUP");
									expect(await withTimeout(p, 15_000, "fork SIGHUP")).toBe("completed");
								}
									finally { process.removeListener("SIGHUP", sighupGuard);
								}
								await rm(rawFile);
								});

							});
							describe("crash & window-close paths", () => {
								it("worker crash (exit 3, mid-turn): crashed + stderr tail + session-tail partial harvest", async () => {
									const dir = await makeTask();
									const out = await withTimeout(runWrapper(dir, depsFor({ VITRINE_FIXTURE_MODE: "crash" })),
									15_000, "crash");
									expect(out).toBe("crashed");
									const st = await P.readState(dir);
									expect(st.state).toBe("crashed");
									expect(st.reason).toBe("exit-3");
									expect(st.exit_code).toBe(3);
									const tail = await readFile(join(dir, "tail.log"), "utf8");
									expect(tail).toContain("fixture: about to crash");
									expect(tail).toContain("--- session tail ---");
									// the turn broke mid-tool (a pending toolCall last) — the
									// partial harvest has no assistant text
									expect(tail).toContain("(no assistant text)");
								});
								it("worker killed by a signal (SIGKILL): crashed, exit_code 137", async () => {
									const dir = await makeTask();
									const out = await withTimeout(runWrapper(dir, depsFor({ VITRINE_FIXTURE_MODE: "crash-sig" })),
									15_000, "crash-sig");
									expect(out).toBe("crashed");
									const st = await P.readState(dir);
									expect(st.reason).toBe("signal-SIGKILL");
									expect(st.exit_code).toBe(137);
								});
								it("SIGHUP (tile closed): SIGTERM the worker, record killed", async () => {
									const dir = await makeTask();
									const guard = (): void => {
									};
									// keep the test process alive if the signal lands pre-handler
									process.on("SIGHUP", guard);
									try {
										const p = runWrapper(dir, depsFor({ VITRINE_FIXTURE_MODE: "pending-tool" }));
										// pending-tool: the turn never settles, so the SIGHUP —
										// not the stop-settle — is what ends it
										await msleep(300);
										process.kill(process.pid, "SIGHUP");
										const out = await withTimeout(p, 15_000, "SIGHUP");
										expect(out).toBe("killed");
										const st = await P.readState(dir);
										expect(st.reason).toBe("signal-SIGHUP");
										expect(st.worker_pid !== undefined && P.pidInfo(st.worker_pid).alive).toBe(false);
									}
										finally { process.removeListener("SIGHUP", guard);
									}
									});
									it("/proc/<foot_pid> backstop: foot gone ⇒ window closed ⇒ killed", async () => {
										const dir = await makeTask();
										const foot = spawn("bun", ["-e", "setTimeout(() => {}, 400)"])
										;
										const out = await withTimeout(runWrapper(dir, depsFor({ VITRINE_FIXTURE_MODE: "pending-tool" }
										, { footPid: foot.pid! })),
										15_000, "ppid backstop");
										foot.kill("SIGKILL");
										expect(out).toBe("killed");
										const st = await P.readState(dir);
										expect(st.reason).toBe("window-closed");
										expect(st.worker_pid !== undefined && P.pidInfo(st.worker_pid).alive).toBe(false);
										const ev = await eventsOf(dir);
										expect(ev.some((e) => e.event === "window-closed")).toBe(true);
									});
									it("kill_requested file: the wrapper kills the worker and records killed", async () => {
										const dir = await makeTask();
										const p = runWrapper(dir, depsFor({ VITRINE_FIXTURE_MODE: "pending-tool" }));
										await msleep(300);
										await P.requestKill(dir);
										const out = await withTimeout(p, 15_000, "kill_requested");
										expect(out).toBe("killed");
										const st = await P.readState(dir);
										expect(st.reason).toBe("kill_requested");
										expect(st.worker_pid !== undefined && P.pidInfo(st.worker_pid).alive).toBe(false);
										const ev = await eventsOf(dir);
										expect(ev.some((e) => e.event === "kill")).toBe(true);
										// killed ⇒ partial harvest (the session tail in tail.log) — the
										// turn never produced text (a pending tool call last)
										const tail = await readFile(join(dir, "tail.log"), "utf8");
										expect(tail).toContain("--- session tail ---");
										expect(tail).toContain("(no assistant text)");
								});
});

								describe("queued edge cases", () => {
									it("stuck-queued: a non-queued task is never spawned", async () => {
										const dir = await makeTask();
										await P.transitionState(dir, "queued", "crashed", {}
										, "never-spawned");
										let spawned = false;
										const out = await withTimeout( runWrapper( dir, depsFor({}
											, { spawnWorker: async () => {
												spawned = true;
												throw new Error("must not spawn");
											}
										, }),
										), 10_000, "stuck-queued", );
										expect(out).toBe("not-queued");
										expect(spawned).toBe(false);
										expect((await P.readState(dir)).state).toBe("crashed");
									});
									it("spawn failure: state stays running with no worker_pid; the dead-wrapper reconcile settles it", async () => {
										const dir = await makeTask();
										const out = await withTimeout( runWrapper( dir, depsFor({}
											, { spawnWorker: async () => {
												throw new Error("pi not found");
											}
										, }),
										), 10_000, "spawn-failed", );
										expect(out).toBe("spawn-failed");
										const st = await P.readState(dir);
										expect(st.state).toBe("running");
										expect(st.worker_pid).toBeUndefined();
										expect(st.wrapper_pid).toBe(process.pid);
										const ev = await eventsOf(dir);
										expect(ev.some((e) => e.event === "spawn-failed")).toBe(true);
										// Simulate the wrapper's death (in the test it ran in-process, so the
										// recorded wrapper_pid is this still-alive test process): re-point it
										// at a reaped pid, then the dispatcher's reconcile (ordering rule 2) settles it.
										const reaper = spawn("bun", ["-e", "process.exit(0)"]);
										await new Promise<void>((r) => reaper.once("exit", () => r()));
										await P.mergeStateFields(dir, "running", { wrapper_pid: reaper.pid! }, "test: wrapper died");
										const rec = await P.reconcileDeadWrapper(dir);
										expect(rec.outcome).toBe("crashed");
										expect((await P.readState(dir)).state).toBe("crashed");
									});
});

									describe("session.json discovery", () => {
										it("concurrent spawns in the same cwd each find their own session file", async () => {
											const dirA = await makeTask({ cwd: cwdA });
											const dirB = await makeTask({ cwd: cwdA });
											const [outA, outB]
											= await withTimeout( Promise.all([ runWrapper(dirA, depsFor({ VITRINE_FIXTURE_MODE: "clean" })),
											runWrapper(dirB, depsFor({ VITRINE_FIXTURE_MODE: "clean" })),
											])
											, 15_000, "concurrent discovery", );
											// clean: a settled turn + exit 0 — the wrapper observes the STOP
											// (the exit mapping settles `stop`, not killed)
											expect(outA).toBe("completed");
											expect(outB).toBe("completed");
											const sA = await P.readSession(dirA);
											const sB = await P.readSession(dirB);
											expect(await readSessionHeader(sA.session_file)).toEqual( expect.objectContaining({ id: `vitrine.${P.taskIdOf(dirA)}`, cwd: cwdA }),
											);
											expect(await readSessionHeader(sB.session_file)).toEqual( expect.objectContaining({ id: `vitrine.${P.taskIdOf(dirB)}`, cwd: cwdA }),
											);
											expect(sA.session_file).not.toBe(sB.session_file);
											});
											it("a session file from another task (pre-existing in the dir) is not adopted", async () => {
												const dirA = await makeTask({ cwd: cwdB });
												const dirB = await makeTask({ cwd: cwdB });
												await runWrapper(dirA, depsFor({ VITRINE_FIXTURE_MODE: "clean" }));

											// creates A's file in cwdB's session dir
											const outB = await withTimeout(runWrapper(dirB, depsFor({ VITRINE_FIXTURE_MODE: "clean" })),
											15_000, "no misadoption");
											expect(outB).toBe("completed"); // the stop on exit
											const sB = await P.readSession(dirB);
											expect((await readSessionHeader(sB.session_file))?.id).toBe(`vitrine.${P.taskIdOf(dirB)}`);
											});
											it("pass-2 (name-based) discovery when the worker ignores --session-id", async () => {

											// The whole reason pass 2 exists: a future pi that ignores --session-id // on forks still lands a file with the right --name entry.
											const dir = await makeTask({ cwd: cwdA });
											const out = await withTimeout( runWrapper(dir, depsFor({ VITRINE_FIXTURE_MODE: "clean", VITRINE_FIXTURE_IGNORE_SESSION_ID: "1" })),
											15_000, "pass-2 discovery", );
											expect(out).toBe("completed"); // the stop on exit

											// clean exit after a settled turn
											const s = await P.readSession(dir);
											const hdr = await readSessionHeader(s.session_file);
											expect(hdr).not.toBeNull();
											expect(hdr?.id).not.toBe(`vitrine.${P.taskIdOf(dir)}`);

											// the worker used its own id
											});
											it("fork + ignored session id: discovery by the LATEST session_info name (latest-wins)", async () => {

											// A forked file carries the SOURCE's session_info entries first — a
											// first-match name lookup would read the stale source name and fail
											// discovery. This test pins latest-wins: the worker's own (latest)
											// name must match, not the source's.
											const fromDir = await makeTask({ cwd: cwdA });
											await withTimeout(runWrapper(fromDir, depsFor({ VITRINE_FIXTURE_MODE: "clean" })),
											15_000, "from task (latest-wins)");
											expect((await P.readState(fromDir)).state).toBe("completed");
											const toDir = await makeTask({ cwd: cwdA, from_task_id: P.taskIdOf(fromDir) });
											const out = await withTimeout( runWrapper(toDir, depsFor({ VITRINE_FIXTURE_MODE: "clean", VITRINE_FIXTURE_IGNORE_SESSION_ID: "1" })),
											15_000, "fork + name discovery", );
											expect(out).toBe("completed");
											const s = await P.readSession(toDir);
											const name = await readSessionName(s.session_file);
											expect(name).toBe(`test-agent · ${P.taskIdOf(toDir).slice(0, 8)}`);

											// the worker's own (latest)
											expect(name).not.toBe(`test-agent · ${P.taskIdOf(fromDir).slice(0, 8)}`); // not the stale source's
										});
});

										describe("zombie-tile guard", () => {
											it("a sibling-settled task: the wrapper kills its own worker before exiting", async () => {
												const dir = await makeTask();
												const p = runWrapper(dir, depsFor({ VITRINE_FIXTURE_MODE: "pending-tool" }));
												// pending-tool: the turn never settles (a settled turn would
												// stop-settle before the 600 ms mark), so at 600 ms the task is still running
												await msleep(600);
												// the worker is alive and its pid is recorded
												const mid = await P.readState(dir);
												expect(mid.worker_pid).toBeDefined();

												// the dispatcher's reconcile settles the task out from under the wrapper
											await P.transitionState(dir, "running", "completed", {}, "test-sibling");
											const out = await withTimeout(p, 15_000, "sibling settle");
											expect(out).toBe("completed"); // the wrapper returns the sibling's terminal
												const st = await P.readState(dir);
												expect(st.state).toBe("completed");
												expect(st.reason).toBe("test-sibling");
												// the wrapper never exits with its own worker alive in an open tile
											expect(st.worker_pid !== undefined && P.pidInfo(st.worker_pid).alive).toBe(false);
											});
});

											describe("from-task hand-off (fork)", () => {
												it("context task: forks the dispatcher's raw session file (from_session_file)", async () => {
													const rawFile = join(sessionsRoot, "raw-dispatcher-session.jsonl");
													await writeFile( rawFile, `${JSON.stringify({ type: "session", version: 3, id: "disp-live", timestamp: new Date().toISOString(), cwd: cwdA })}\n${JSON.stringify({ type: "message", message: { role: "user", content: "dispatcher context" } })}\n`, );
													const dir = await makeTask({ cwd: cwdA, from_session_file: rawFile });
														const argvBox: { v: string[]
													| null }
													= { v: null };
													const spawnCapture: NonNullable<WrapperDeps["spawnWorker"]
													> = async (argv, env, opts) => {
														argvBox.v = argv;
														return spawnWorkerHandle("bun", [fixturePi, ...argv]
														, { ...env, VITRINE_FIXTURE_MODE: "clean", VITRINE_SESSIONS_DIR: sessionsRoot }
														, opts);
													};
													const out = await withTimeout(runWrapper(dir, depsFor({}
													, { spawnWorker: spawnCapture })),
													15_000, "context fork");
													expect(out).toBe("completed");
													const fi = argvBox.v!.indexOf("--fork");
													expect(fi).toBeGreaterThan(-1);
													expect(argvBox.v![fi + 1])
													.toBe(rawFile);
													const hdr = await readSessionHeader((await P.readSession(dir)).session_file);
													expect(hdr).toEqual(expect.objectContaining({ parentSession: rawFile }));
													await rm(rawFile);
												});
												it("forks the source session: --fork argv, parentSession header, fresh discovery", async () => {
													const fromDir = await makeTask({ cwd: cwdA });
													await withTimeout(runWrapper(fromDir, depsFor({ VITRINE_FIXTURE_MODE: "clean" })),
													15_000, "from task");
													expect((await P.readState(fromDir)).state).toBe("completed");
													const fromSession = await P.readSession(fromDir);
													const toDir = await makeTask({ cwd: cwdA, from_task_id: P.taskIdOf(fromDir) });
														const argvBox: { v: string[]
													| null }
													= { v: null };
													const spawnCapture: NonNullable<WrapperDeps["spawnWorker"]
													> = async (argv, env, opts) => {
														argvBox.v = argv;
														return spawnWorkerHandle("bun", [fixturePi, ...argv]
														, { ...env, VITRINE_FIXTURE_MODE: "clean", VITRINE_SESSIONS_DIR: sessionsRoot }
														, opts);
													};
													const out = await withTimeout( runWrapper(toDir, depsFor({}
													, { spawnWorker: spawnCapture })),
													15_000, "fork hand-off", );
													expect(out).toBe("completed");
													expect(argvBox.v?.slice(0, 2)).toEqual(["--fork", fromSession.session_file])
													;
													const toSession = await P.readSession(toDir);
													expect(toSession.session_file).not.toBe(fromSession.session_file);
													const hdr = await readSessionHeader(toSession.session_file);
													expect(hdr).toEqual(expect.objectContaining({ id: `vitrine.${P.taskIdOf(toDir)}`, parentSession: fromSession.session_file }));
													// the fork copied the source's entries
												const { entries } = await parseSessionEntries(toSession.session_file);
												expect(entries.some((e) => e.type === "message" && (e.message as Record<string, unknown>).content !== undefined)).toBe(true);
												});
});

												// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// headless exit mapping (the `exit0-broken` fixture branch the
// README pins; these are the branches, in order)
// ---------------------------------------------------------------------------
function headlessDeps(fixtureEnv: Record<string, string> = {}, over: Partial<HeadlessDeps> = {}): HeadlessDeps {
	return {
		sessionsRoot,
		agentsDir,
		tickMs: 100,
		killGraceMs: 400,
		log: () => {},
		isTty: () => false,
		spawnWorker: async (argv, env, opts) =>
			spawnWorkerHandle("bun", [fixturePi, ...argv], { ...env, ...fixtureEnv, VITRINE_SESSIONS_DIR: sessionsRoot }, opts),
		...over,
	};
}

async function headlessTask(): Promise<string> {
	return makeTask({ mode: "headless", cwd: cwdA });
}


describe("headless exit mapping", () => {
	it("clean exit 0 + idle-assistant ⇒ completed via a headless-exit marker", async () => {
		const dir = await headlessTask();
		const out = await withTimeout(runHeadlessWrapper(dir, headlessDeps({ VITRINE_FIXTURE_MODE: "clean" })), 15_000, "headless clean");
		expect(out).toBe("completed");
		const st = await P.readState(dir);
		expect(st.state).toBe("completed");
		expect(st.reason).toBe("headless-exit");
		const marker = await P.readDoneMarker(dir);
		expect(marker?.source).toBe("headless-exit");
		// result.md was harvested (only-if-absent)
		const result = await readFile(join(dir, "result.md"), "utf8").catch(() => null);
		expect(result ?? "").toContain("fixture finished the work");
	});

	it("clean exit 0 with a pending toolCall last (exit0-broken) ⇒ crashed, NO marker", async () => {
		const dir = await headlessTask();
		const out = await withTimeout(runHeadlessWrapper(dir, headlessDeps({ VITRINE_FIXTURE_MODE: "exit0-broken" })), 15_000, "headless exit0-broken");
		expect(out).toBe("crashed");
		const st = await P.readState(dir);
		expect(st.state).toBe("crashed");
		expect(st.reason).toBe("headless-exit-empty-turn");
		// a broken turn is never a silent success — no marker
		expect(await P.readDoneMarker(dir)).toBeNull();
	});

	it("clean non-zero exit ⇒ failed (headless-only, D10)", async () => {
		const dir = await headlessTask();
		const out = await withTimeout(runHeadlessWrapper(dir, headlessDeps({ VITRINE_FIXTURE_MODE: "crash" })), 15_000, "headless crash");
		expect(out).toBe("failed");
		const st = await P.readState(dir);
		expect(st.state).toBe("failed");
		expect(st.reason).toBe("headless-exit 3");
		expect(st.exit_code).toBe(3);
		expect(await P.readDoneMarker(dir)).toBeNull();
	});

	it("signal-killed ⇒ crashed/signal-…", async () => {
		const dir = await headlessTask();
		const out = await withTimeout(runHeadlessWrapper(dir, headlessDeps({ VITRINE_FIXTURE_MODE: "crash-sig" })), 15_000, "headless crash-sig");
		expect(out).toBe("crashed");
		const st = await P.readState(dir);
		expect(st.state).toBe("crashed");
		expect(st.reason).toContain("signal-");
		expect(await P.readDoneMarker(dir)).toBeNull();
	});

	it("a pre-existing marker wins over the exit mapping (source preserved, rule 1)", async () => {
		const dir = await headlessTask();
		// a racing/sibling marker (or a historical `vitrine_done` one on an
		// old task): the marker's source is the settle's reason
		await P.writeDoneMarker(dir, "stop");
		const out = await withTimeout(runHeadlessWrapper(dir, headlessDeps({ VITRINE_FIXTURE_MODE: "clean" })), 15_000, "headless marker-wins");
		expect(out).toBe("completed");
		const st = await P.readState(dir);
		expect(st.state).toBe("completed");
		expect(st.reason).toBe("stop");
		const marker = await P.readDoneMarker(dir);
		expect(marker?.source).toBe("stop");
		const ev = await eventsOf(dir);
		expect(ev.some((e) => e.event === "marker-observed" && e.source === "stop")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// mode-asymmetry pins (the seven-point contract — the legs the post-landing
// audit (2026-09-17) found unpinned: Point 1 the headless mode guard, Point 2
// the isatty asymmetry, Point 3 the hand-off field recording)
// ---------------------------------------------------------------------------
describe("mode asymmetry (seven-point contract pins)", () => {
	it("Point 1: runHeadlessWrapper on a tile-mode spec ⇒ not-queued, mode-mismatch event, state untouched", async () => {
		const dir = await makeTask({ mode: "tile", cwd: cwdA });
		const out = await withTimeout(runHeadlessWrapper(dir, headlessDeps()), 10_000, "mode guard");
		expect(out).toBe("not-queued");
		const st = await P.readState(dir);
		expect(st.state).toBe("queued");
		const evs = await eventsOf(dir);
		expect(evs.some((e) => e.event === "mode-mismatch" && e.expected === "headless" && e.actual === "tile")).toBe(true);
	});

	it("Point 2: tile mode without a pty ⇒ spawn-failed event + crashed/failed-to-spawn settle", async () => {
		const dir = await makeTask({ mode: "tile", cwd: cwdA });
		const out = await withTimeout(runWrapper(dir, depsFor({}, { isTty: () => false })), 10_000, "tile no-pty");
		expect(out).toBe("spawn-failed");
		const st = await P.readState(dir);
		expect(st.state).toBe("crashed");
		expect(st.reason).toContain("failed-to-spawn");
		const evs = await eventsOf(dir);
		expect(evs.some((e) => e.event === "spawn-failed" && e.source === "wrapper")).toBe(true);
	});

	it("Point 2 (asymmetry): headless on a TTY ⇒ logged, not failed (the run still completes)", async () => {
		const dir = await headlessTask();
		const lines: string[] = [];
		const out = await withTimeout(
			runHeadlessWrapper(dir, headlessDeps({ VITRINE_FIXTURE_MODE: "clean" }, { isTty: () => true, log: (l) => lines.push(l) })),
			15_000,
			"headless tty",
		);
		expect(out).toBe("completed");
		expect(lines.some((l) => l.includes("sanity: headless wrapper on a TTY"))).toBe(true);
	});

	it("Point 3: the hand-off records wrapper_pid_start in both modes and foot_pid tile-only", async () => {
		const tDir = await makeTask({ mode: "tile", cwd: cwdA });
		await withTimeout(runWrapper(tDir, depsFor({ VITRINE_FIXTURE_MODE: "clean" })), 15_000, "tile hand-off fields");
		const tst = await P.readState(tDir);
		expect(tst.wrapper_pid).toBeTypeOf("number");
		expect(tst.wrapper_pid_start).toBeTypeOf("string");
		expect(tst.foot_pid).toBeTypeOf("number");
		const hDir = await headlessTask();
		await withTimeout(runHeadlessWrapper(hDir, headlessDeps({ VITRINE_FIXTURE_MODE: "clean" })), 15_000, "headless hand-off fields");
		const hst = await P.readState(hDir);
		expect(hst.wrapper_pid).toBeTypeOf("number");
		expect(hst.wrapper_pid_start).toBeTypeOf("string");
		expect(hst.foot_pid).toBeUndefined();
	});
});



