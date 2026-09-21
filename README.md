# Vitrine

[![ci](https://github.com/michaeldewildt/vitrine/actions/workflows/ci.yml/badge.svg)](https://github.com/michaeldewildt/vitrine/actions/workflows/ci.yml)

Vitrine is a pi extension that turns every delegated agent task into a first-class OS citizen — a visible, persisted, disk-tracked worker window spawned by the compositor, so it survives the dispatcher. Named for the glass case the work happens in: visible, isolated, undisturbed until you open it.

Built on pi, Hyprland, and foot. No daemon, no socket, no multiplexer: the state is task directories on disk (`0700` dirs, `0600` files), and the work is visible — a window you can focus, type into, and close.

Design record: this README — the repo stands on its own.

## What this is

One package, two roles, switched by environment:

- **In your main session**, the extension registers `vitrine_dispatch`. You (or your agent) hand it one or more tasks, each naming a specialist agent — a pi agent file from `~/.pi/agent/agents/`, or a project's `.pi/agents/` (only when pi has marked the project trusted; a copyable template lives in `docs/example-agent.md`) — plus a brief. Per task the tool creates a `0700` task dir under `~/.vitrine/tasks/<id>/` — the single source of truth for the task (`0600` files: `spec.json`, `prompt.txt`, a monotonic `state.json`, an `events.jsonl` audit log) — then asks the compositor to spawn a foot tile running the `vitrine-run` wrapper, which spawns the worker's own named, persisted `pi` session. A foot tile when the compositor is reachable; a detached headless worker when it is not — a fallback, not a second design (same protocol, no window). The tool blocks until the batch settles (or your turn aborts — the workers keep running), then harvests each worker's answer back into the tool result.
- **In a worker session** (detected by `VITRINE_TASK_DIR` in the environment), the extension registers exactly one tool, `vitrine_done` — the completion signal. It writes `result.md` + `done.marker` (never `state.json`), and its answer renders as markdown in the worker's own tile. Completed tiles stay open — unattended ones auto-close after `completed_close_s` (default 600 s; `0` = never) — so you can read the answer or type a follow-up (a human-typed entry resumes the session).

The model calls it with one or more tasks — `vitrine_dispatch({ tasks: [{ agent: "explore", task: "ground the claim in the code" }] })` — and the report returns in the tool result.

Because Hyprland — not your session — is the spawner, workers survive your dispatcher aborting or crashing. A machine reboot kills them with the compositor — but the record does not die: stale `running` tasks settle to `crashed` with a partial harvest at the next dispatch, and nothing is lost because state and transcripts live on disk. Worker tiles land in one Hyprland **window group anchored by your own panel** — your agent's tab plus one tab per worker — so a batch is a single visible, navigable unit. The tool description is self-describing: the roster of global agents is composed into it at session start from the same dir the resolver reads, so it cannot drift from what dispatch accepts there (project agents are dispatchable too; an unknown-agent error lists the full live roster). New agents appear at the next session start.

The repo also ships the pieces that are not pi code: the `vitrine-run` wrapper (watchdogs, keep-alive, exit mapping), the `vitrine` CLI (`list`/`show`/`kill`/`gc` over the task dirs), and the worker agent files (`agents/`; the copyable template is `docs/example-agent.md`). The `agents/` files are a starting set of seats — copy them into `~/.pi/agent/agents/` and tune the model pins to your machine.

It is deliberately not a fork, shim, or drop-in of the old subagent tooling (`@mjakl/pi-subagent`): the contrast is visibility, not return — work is no longer an invisible subprocess piped into the parent's context; it is a place you can go, and its answer still lands in the tool result.

## Typed harvest

A dispatch can declare a typed contract: an `output_schema` (a JSON Schema) on the task. The schema rides `spec.json`, and the worker's `vitrine_done` gains an optional `data` parameter (arbitrary JSON) written to `result.json` (0600, alongside `result.md` — the prose answer and the typed contract stay orthogonal). When a schema was declared, `data` is required and validated at the `vitrine_done` call — fail-fast: a missing payload or a violating one errors with the offending fields named, so the worker retries with a fixed payload, and a schema that fails to compile fails closed. On harvest, the report renders the data as compact JSON after the answer block, capped at 8 KB with the full data preserved in a 0600 overflow file the capped text names (the same treatment as the text harvest); the per-task result carries the parsed data uncapped.

## Pi's principles

pi ships none of the usual machinery — no sub-agents, no plan mode, no built-in to-dos, no background bash — and its answer to each is *build it yourself*, usually with tmux (https://pi.dev/). Vitrine is that escape hatch executed with the OS instead of tmux:

| principle | them | us |
| --- | --- | --- |
| **No sub-agents** | spawn pi instances via tmux, or build your own with extensions, or install a package that does it your way | automatically spawn pi instances in a Hyprland window group — full control and observability |
| **No plan mode** | write plans to files, or build it with extensions, or install a package | we agree! |
| **No built-in to-dos** | use a TODO.md file, or build your own with extensions | we agree! |
| **No background bash** | use tmux — full observability, direct interaction | your tiling window manager and terminal — Hyprland and foot on this box |

Vitrine adds one primitive to your main session — dispatch — and leaves the rest of the model's environment as pi left it.

## Why Hyprland, why foot

**Hyprland** is the load-bearing dependency, and it earns the place with three gifts: it can **spawn** (workers are descendants of the compositor — the survival property), it can **group** (a batch is one window group anchored by the dispatcher's panel), and it can be **queried** (`hyprctl` — the focus juggle, the liveness checks, the window enumeration).

**foot** is the verified terminal, not an architectural commitment. The requirement is topology, not brand: one process per window (the window owns the pty — closing the tile SIGHUPs the wrapper, and the window's pid is the task's distinct, stable identity) and a per-launch app-id (`--app-id vitrine-worker`) so the static window rule matches workers and never your manual terminals. foot is pinned today; the swap seam is one spawn argv, and a config key is the planned path if a different terminal is wanted.

## Status

The public API is the three surfaces — `vitrine_dispatch`, `vitrine_done`, and the `vitrine` CLI — and has stayed stable across every internal restructure. Gates: `bun test` (hermetic) + strict `tsc --noEmit`.

## Layout

The tree is layered (acyclic at runtime; the two `wrapper/lifecycle` ↔ `wrapper/{tile,headless}` edges are type-only imports, erased at compile):

```
src/types/pi-coding-agent.d.ts        ambient stubs (no project imports)
src/protocol/                         the task-dir protocol — re-export-only barrel
  errors → fs → spec → state → files → env → reconcile   (each imports only the ones before it)
src/session.ts                        session storage + JSONL facts — leaf
src/hyprctl.ts                        the single Hyprland runner — leaf
src/config.ts, src/agents.ts          config + agent resolution → protocol
src/main-guard.ts                     the jiti-safe main check → nothing
src/wrapper/                          the wrapper → protocol, session, hyprctl, agents
  worker.ts (spawn/argv/env/exit) · watchdogs.ts (pure evaluators) ·
  tile.ts (titles, fail-safe focus, exit mapping, keep-alive) · headless.ts (the 5-branch mapping) ·
  lifecycle.ts (ONE loop for both modes — the seven-point mode contract)
src/vitrine-run.ts                    the wrapper bin entry (shebang) + stable re-exports
src/dispatch/                         the dispatch core — re-exported via src/dispatch.ts
  core.ts (surface + dispatchTasks + the report) · spawn.ts (tile argv + juggle + bun) ·
  harvest.ts (result harvest + deferred registry) · admit.ts (slot count + reconciliation)
src/vitrine.ts                        the pi extension: vitrine_dispatch + vitrine_done
src/cli.ts                            the `vitrine` CLI — bin entry (shebang)
src/bench/                            the perf-eval core — the pure collector
  (one task dir → one metrics row) · report.ts (rows → table/JSON, no IO) ·
  history.ts (state/bench/history.jsonl, gitignored) · hermetic.ts (the
  headless driver behind `vitrine bench hermetic`) · battery.ts (the
  versioned live battery + the pure outcome oracles) · live.ts (the live
  driver behind `vitrine bench live` — the real model, the local seats)
test/helpers.ts, test/fixtures/fake-pi.ts    shared test base + the fixture pi binary
agents/                                       the shipped worker agent files
docs/example-agent.md                         the copyable agent template
```

Data flow, one way around: `vitrine_dispatch` (the model's tool) → `dispatchTasks` reconciles, admits against the liveness-qualified slot cap, creates the task dir (`spec.json` + `prompt.txt`, `0700`/`0600`), spawns (tile: hyprctl argv → a foot tile running `vitrine-run`; headless: a detached `vitrine-run`), polls, harvests, reports. The wrapper (`vitrine-run` → `runWrapper`/`runHeadlessWrapper`) does the `queued→running` CAS, spawns the worker `pi` session, and runs the watchdog loop until `done.marker` / kill / timeout — `state.json` is the status record of record (monotonic, single-writer per regime), `events.jsonl` the audit log. The worker's `vitrine_done` tool writes `result.md` + `done.marker` and never `state.json`. The `vitrine` CLI reads the same task dirs (list/show/kill/gc) and runs the perf-eval suite over them (`bench hermetic` — the hermetic driver in `src/bench/`; `bench live` — the versioned battery in `src/bench/battery.ts` against real pi, success rate first via the outcome oracles, latency medians second). No daemon, no socket — `spec.json` is the only parent→worker transport.

## Quickstart

```sh
mise install      # pins bun per .tool-versions
bun install       # typebox (a pi-provided peer dep; installed for test/typecheck)
bun test          # the full suite (hermetic)
bun run typecheck # strict tsc over the whole repo
```

## Install

From a clone (the full path — the extension plus the `~/.local/bin` exec-wrappers):

```sh
git clone git@github.com:michaeldewildt/vitrine
cd vitrine && ./install.sh   # idempotent: pi install <repo> + exec-wrappers (absolute bun pinned)
```

Extension only (the package itself — the `vitrine`/`vitrine-run` bins still need the exec-wrappers above):

```sh
pi install git:github.com/michaeldewildt/vitrine
```

- the pi extension package registers **in place** (the repo tree is used directly — a git pull updates the live extension)
- `~/.local/bin/vitrine-run` + `~/.local/bin/vitrine`: `#!/bin/sh` exec-wrappers with the **absolute bun path pinned at install time** (the compositor's `sh -c` layer is not a login shell — a mise bun shim won't resolve there). Re-run after a bun upgrade.
- config at `~/.vitrine/config.json` (`0600`, auto-created on first read; `VITRINE_CONFIG` overrides the path)
- one Hyprland window rule keyed on app-id `vitrine-worker` (omarchy convention, added with sign-off — the tile opens on the current workspace as a group the concurrent workers join): `o.window("vitrine-worker", { no_initial_focus = true, group = "set" })`

## Requirements

- **pi** — the extension targets pi 0.85–0.86 (the ambient type stubs in `src/types/` mirror the extension API; keep them in sync with the installed pi when you extend the surface).
- **Hyprland + foot** for tile mode (compositor-spawned windows — the survival property; the omarchy window rule above). When the compositor is unreachable, dispatch falls back to **headless** automatically — same protocol, same state, no window: the extension works on any machine, the tile is the upgrade.
- **bun** (pinned per `.tool-versions`) for the wrapper and the CLI.
- **Linux** — the anti-recycling liveness reads `/proc/<pid>` and `/proc/sys/kernel/random/boot_id`.

## Security

- **No daemon, no socket, no telemetry, no network calls** — the wrapper is a short-lived per-task process; its I/O is its task dir and the compositor's IPC. Model traffic goes to the model provider, as with any pi session.
- **File permissions**: task dirs `0700`, files `0600`; every write is atomic (unique tmp + fsync + rename) — a partial `state.json` is never visible.
- **Scoped process control**: the wrapper only signals its own child; the reconcilers only signal a recorded `worker_pid` after a **start-time match** (plus the `boot_id` check) — a recycled pid of an unrelated process cannot read as live and cannot be signalled.
- **The bun pin is validated**: `install.sh` proves the pinned path runs as bun (`bun -e` output check) before writing the exec-wrappers and refuses anything else (the mise shim dispatches per calling directory; the mise CLI would treat the script path as a subcommand).
- A pi package runs with the host's pi permissions — as with any pi package, review the source before installing.

## Known limitations

- **No human-facing signal**: a finished or stuck worker shows in its tile (title, countdown) — nothing else notifies; watch the window group or poll `vitrine list`.
- **Lazy reconciliation**: stale tasks settle on the next `vitrine_dispatch` or `vitrine kill` (the dispatcher's reconciliation), not on a timer — the owner-lease window (30 s) is the only clock.
- **Pre-release**: `0.0.0` — the first public release is `0.1.0`, and the task-dir protocol may still change before it.

## License

MIT — see `LICENSE`.
