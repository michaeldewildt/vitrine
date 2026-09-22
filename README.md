# Vitrine

[![ci](https://github.com/michaeldewildt/vitrine/actions/workflows/ci.yml/badge.svg)](https://github.com/michaeldewildt/vitrine/actions/workflows/ci.yml)

Vitrine is a pi extension that turns every delegated agent task into a first-class OS citizen — a visible, persisted, disk-tracked worker window spawned by the compositor, so it survives the dispatcher. Named for the glass case the work happens in: visible, isolated, undisturbed until you open it.

Built on pi, Hyprland, and foot. No daemon, no socket, no multiplexer: the state is task directories on disk (`0700` dirs, `0600` files), and the work is visible — a window you can focus, type into, and close.

Design record: this README — the repo stands on its own.

## What this is

One package, two roles, switched by environment:

- **In your main session**, the extension registers `vitrine_dispatch` and `vitrine_collect`. You (or your agent) hand the dispatch one or more tasks, each naming a specialist agent — a pi agent file from `~/.pi/agent/agents/`, or a project's `.pi/agents/` (only when pi has marked the project trusted; a copyable template lives in `docs/example-agent.md`) — plus a brief. Per task the tool creates a `0700` task dir under `~/.vitrine/tasks/<id>/` — the single source of truth for the task (`0600` files: `spec.json`, `prompt.md`, a monotonic `state.json`, an `events.jsonl` audit log) — then asks the compositor to spawn a foot tile running the `vitrine-run` wrapper, which spawns the worker's own named, persisted `pi` session. A foot tile when the compositor is reachable; a detached headless worker when it is not — a fallback, not a second design (same protocol, no window). **The dispatch returns immediately after the spawn/admission pass** — per task: short id, agent, state — and the harvest of every task lands in your context **as a delivery on settlement** (see *Async dispatch: delivery and collect* below); the old in-call blocking wait-and-report loop is removed — non-blocking is the only mode, a pre-`0.1.0` behaviour change, stated plainly. `vitrine_collect` is the on-demand pull floor over the same disk state (harvests on demand, status lines for running tasks, never blocks on a worker).
- **In a worker session** (detected by `VITRINE_TASK_DIR` in the environment), the extension registers exactly one tool, `vitrine_done` — the completion signal. It writes `result.md` + `done.marker` (never `state.json`), and its answer renders as markdown in the worker's own tile. Completed tiles stay open — unattended ones auto-close after `completed_close_s` (default 600 s; `0` = never) — so you can read the answer or type a follow-up (a human-typed entry resumes the session).

The model calls it with one or more tasks — `vitrine_dispatch({ tasks: [{ agent: "explore", task: "ground the claim in the code" }] })` — and the ids + states return in the tool result; the harvest follows as a delivery on settlement.

Because Hyprland — not your session — is the spawner, workers survive your dispatcher aborting or crashing. A machine reboot kills them with the compositor — but the record does not die: stale `running` tasks settle to `crashed` with a partial harvest at the next reconcile (a dispatch pass or the session's watcher tick), and nothing is lost because state and transcripts live on disk. Worker tiles land in one Hyprland **window group anchored by your own panel** — your agent's tab plus one tab per worker — so a batch is a single visible, navigable unit. The tool description is self-describing: the roster of global agents is composed into it at session start from the same dir the resolver reads, so it cannot drift from what dispatch accepts there (project agents are dispatchable too; an unknown-agent error lists the full live roster). New agents appear at the next session start.

The repo also ships the pieces that are not pi code: the `vitrine-run` wrapper (watchdogs, keep-alive, exit mapping), the `vitrine` CLI (`list`/`show`/`kill`/`gc` over the task dirs), and the worker agent files (`agents/`; the copyable template is `docs/example-agent.md`). The `agents/` files are a starting set of seats — copy them into `~/.pi/agent/agents/` and tune the model pins to your machine.

It is deliberately not a fork, shim, or drop-in of the old subagent tooling (`@mjakl/pi-subagent`): the contrast is visibility, not return — work is no longer an invisible subprocess piped into the parent's context; it is a place you can go, and its answer still lands in your context — on settlement, as a delivery.

## Typed harvest

A dispatch can declare a typed contract: an `output_schema` (a JSON Schema) on the task. The schema rides `spec.json`, and the worker's `vitrine_done` gains an optional `data` parameter (arbitrary JSON) written to `result.json` (0600, alongside `result.md` — the prose answer and the typed contract stay orthogonal). When a schema was declared, `data` is required, and the schema is checked fail-closed at authoring — the dispatch edge rejects a schema that does not `Compile` (typebox) or that carries an unknown `type` keyword with a named error (typebox silently accepts an unrecognised `type` name and its check never rejects on it — a typo'd LLM-authored schema would be silently vacuous, the harvest reporting unvalidated data as validated). The payload is validated at the `vitrine_done` call (the second line): a missing payload or a violating one errors with the offending fields named, so the worker retries with a fixed payload, and a schema that fails to compile there fails closed. On harvest, the report renders the data as compact JSON after the answer block, capped at 8 KB with the full data preserved in a 0600 overflow file the capped text names (the same treatment as the text harvest); the per-task result carries the parsed data uncapped.

## Async dispatch: delivery and collect

**The behaviour change, up front:** `vitrine_dispatch` is non-blocking, full stop — the tool returns after the spawn/admission pass (per task: short id, agent, state `running`/`queued`, one line stating the harvest will be reported on settlement) and carries **no harvest**. The old in-call blocking wait-and-report loop is removed, not bypassed — non-blocking is the only mode. This is a behaviour change for the pre-`0.1.0` era (the version stays `0.0.0`; the task-dir protocol may still change before `0.1.0`), stated plainly. The harvest of every task still lands in the dispatcher's context — on settlement, as a delivery, not in the tool result. A crashed or killed worker is a result too: every terminal state (`completed`, `failed`, `killed`, `timeout`, `crashed`) delivers the same wrapper shape, with the body per state (full harvest on `completed`, a partial harvest where the session has one on `failed`/`crashed`/`timeout`, header-only on `killed` — the killer already knows).

**The two tools and their contract.**

- **`vitrine_dispatch`** returns ids + state + the settlement line. It never blocks; from the pass onward the **queue is owned by the session's watcher** — a session-scoped poller in the extension that admits queued tasks as slots free, spawns them, refreshes their owner lease each tick (the queue is live under the lease, not a dead dispatcher's residue), and delivers. It closes on `session_shutdown` and re-arms on the next dispatch.
- **The delivery** arrives on settlement as one coalesced `pi.sendMessage` per settled set — **edge-triggered** (each poll tick, every task that settled since the last delivery goes out as ONE message, so a batch that settles together gets one wake and a lone fast worker gets its message promptly), `customType: "vitrine-harvest"`, `display: true`, `deliverAs: "followUp"` (a harvest never interrupts a live conversation — it waits for the conversation to end, then triggers the integration turn) + `triggerTurn: true` (an idle session is woken immediately). The message is a **fixed wrapper framing the worker output as untrusted data, never instructions** (a delivery now autonomously triggers a main-model turn — the wrapper is the bounding invariant, not a footnote): a header line, then per task the short id, agent, state + reason, elapsed, and the harvested answer quoted verbatim and INDENTED under its label — the body's lines cannot forge the wrapper's structure (a `[N] agent · …` section header, the `replay:` line, or the cap's `full text: …` line are unindented wrapper grammar), with the cap/overflow treatment identical to the old report (50 KB / 2000 lines; the 0600 overflow file's path named in the message — the sanctioned response to a truncated body is to read it) and the typed `data` render when a schema was declared.
- **`vitrine_collect`** is the on-demand pull floor (main-session only; a worker never sees it). It answers **immediately from disk and never blocks on a worker**: terminal tasks → the full harvest in the same fixed wrapper (cap/overflow identical) + delivery status; running/queued tasks → a status line (state, elapsed, workspace) with no body; a terminal task a human resumed in its tile → the session's latest output as an **advisory note** (the resume commit: never a state change, never a re-delivery). **No ids = all tasks of this session plus its fork ancestry** — the extension records the pre-fork dispatcher's session ids from `session_start { reason: "fork", previousSessionFile }` (the previous session file resolves to its header id, chained back through the header's `parentSession` field) so a fork's no-id collect still finds the pre-fork tasks; **explicit ids (full or the short 8-char prefix) cross any session**. **Write semantics:** a collect that harvests a terminal task **writes the `harvest-delivered` marker** (a fresh collect-scoped batch id) — the collect is a delivery to this session's context, so replay and gc treat the task as delivered (and can retire it). Undelivered **attended** tasks are headlined without a body (attended workspaces are the human's — attended tasks are never pushed, ever; pulling their harvest is an explicit id).

The doctrine rides the tool descriptions (both tools point at each other): *dispatch returns immediately — results arrive as a delivery; never act on a worker's result in the same turn you dispatched; collect is the on-demand pull for a result you want now — never busy-poll collect inside a turn.*

**Protocol additions** (additive; pre-`0.1.0`):

- `spec.json`: `async?: boolean` — the **delivery-eligibility marker**, written `true` on every task from this change onward. Absent on historical (blocking-era) task dirs, which are excluded from delivery, replay, and the gc-skip by its absence — the clean upgrade boundary (the marker is the boundary, not a runtime flag).
- `events.jsonl`: `harvest-delivered { id }` — one per delivered task; `id` is the **delivery-batch id shared by every task in one message**, so a message's membership is reconstructable from disk. Written after a successful send — or by `vitrine_collect` (above). Absence = undelivered: the replay and gc predicates key on it. The marker is write-once; the only double-delivery window is a crash between send and write (at-least-once, bounded to that gap).
- The **`spawn-issued` in-flight guard**: a spawn is recorded BEFORE it is issued; a wait loop that attaches inside the issue window (the state still `queued`, the tile join still running) sees the fresh event and does not double-spawn — the loop re-evaluates the guard per tick (every non-terminal queued task is re-admitted to the spawn decision fresh each pass, and the dispatch's spawn pass consults the same guards before it issues), so a fresh event pins only the boot window: an event older than the stuck window is a dead spawner (the wrapper booted nowhere), and the live loop (re-)spawns on its next tick — the recovery is the loop's own per-tick re-evaluation, not a stale lease or the stuck-queued settle; a torn events read fails conservative (treated as in flight, no spawn); and a failed issue settles `failed-to-spawn`, leaving the (now stale) event inert.
- The **stuck-queued predicate keys on lease freshness, not creation age** — a queue longer than the 15 s window is now normal; only a task whose owner lease went stale settles `never-spawned` at the next reconcile.

**Restart semantics.** At session start the watcher re-attaches over the global task dirs: non-terminal `async` tasks of a dead predecessor are adopted (their queue settles into this session) — the adoption is gated on the owner lease: only a STALE or absent lease is adopted (a live owner refreshes the lease every tick, so a live session's tasks are never co-adopted across a concurrent re-arm), and terminal `async` undelivered **non-attended** tasks are **replayed as one coalesced message with a `replay:` header** — late rather than lost, with the original settlement time as provenance. The replay set is sent as its own message immediately at arm — a fresh settlement landing in the first tick gets its own message without the header (the `replay:` provenance is the message's, never mislabelled). Across a fresh session or a crash-restart the old context is gone, so a replayed delivery is usually the *first* the model sees — correct behaviour, not a duplicate. A fork or resume *inherits* context, so a re-shown harvest can be a genuine visible duplicate there; what makes it legible as a re-show rather than a new result is the fixed wrapper shape (plus the overflow-file action), not session memory. **Attended tasks are never pushed, not even by replay** (the replay predicate excludes them; the live watcher skips them) — pull only, by construction.

**The gc boundary.** `vitrine gc` **skips** task dirs with spec `async` and no `harvest-delivered` event (noted in its output) — the slow retirement path cannot retire an undelivered async task; retiring one is an explicit operator act (deliver it — e.g. `vitrine_collect` with the task's id — and the plain retention rule applies again). Historical dirs (no `async` marker) are never skipped: they remain gc-eligible under the plain retention rule.

**The pi floor.** The delivery primitive is `pi.sendMessage(message, { deliverAs, triggerTurn })` — verified present (docs and binary) on pi 0.85.1, the declared floor: **no bump** (the target range stays 0.85–0.86; the ambient type stubs in `src/types/` carry the declaration).

## Pi's principles

pi ships none of the usual machinery — no sub-agents, no plan mode, no built-in to-dos, no background bash — and its answer to each is *build it yourself*, usually with tmux (https://pi.dev/). Vitrine is that escape hatch executed with the OS instead of tmux:

| principle | them | us |
| --- | --- | --- |
| **No sub-agents** | spawn pi instances via tmux, or build your own with extensions, or install a package that does it your way | automatically spawn pi instances in a Hyprland window group — full control and observability |
| **No plan mode** | write plans to files, or build it with extensions, or install a package | we agree! |
| **No built-in to-dos** | use a TODO.md file, or build your own with extensions | we agree! |
| **No background bash** | use tmux — full observability, direct interaction | your tiling window manager and terminal — Hyprland and foot on this box |

Vitrine adds two primitives to your main session — `vitrine_dispatch` (the push: spawn, then the harvest arrives as a delivery on settlement) and `vitrine_collect` (the pull floor: harvests and status on demand) — and leaves the rest of the model's environment as pi left it.

## Why Hyprland, why foot

**Hyprland** is the load-bearing dependency, and it earns the place with three gifts: it can **spawn** (workers are descendants of the compositor — the survival property), it can **group** (a batch is one window group anchored by the dispatcher's panel), and it can be **queried** (`hyprctl` — the focus juggle, the liveness checks, the window enumeration).

**foot** is the verified terminal, not an architectural commitment. The requirement is topology, not brand: one process per window (the window owns the pty — closing the tile SIGHUPs the wrapper, and the window's pid is the task's distinct, stable identity) and a per-launch app-id (`--app-id vitrine-worker`) so the static window rule matches workers and never your manual terminals. foot is pinned today; the swap seam is one spawn argv, and a config key is the planned path if a different terminal is wanted.

## Status

The public API is the four surfaces — `vitrine_dispatch`, `vitrine_collect`, `vitrine_done`, and the `vitrine` CLI — and has stayed stable across every internal restructure (the async change added `vitrine_collect` and removed the dispatch's in-call wait; the tool names and the task-dir protocol are the contract). Gates: `bun test` (hermetic) + strict `tsc --noEmit`.

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
  core.ts (surface + dispatchTasks + the R1 report) · spawn.ts (tile argv + juggle + bun) ·
  loop.ts (the reusable wait loop — the watcher's mechanism: spawn/admit/poll + the spawn-issued guard) ·
  harvest.ts (result harvest + the shared cap mechanism + deferred registry) ·
  admit.ts (slot count + reconciliation) · panel.ts (the dispatcher window/panel facts)
src/watcher.ts                        the session-scoped watcher — queue duties (admit/spawn/
  lease refresh, the lease-keyed stuck-queued predicate) + the coalesced delivery + the
  restart attach/replay scan (the fixed harvest wrapper lives here)
src/collect.ts                        the vitrine_collect core — the pull floor: the session +
  fork-ancestry scope, the harvest (fixed wrapper reuse), the harvest-delivered write,
  the status lines, the resumed-session advisory, the attended headlines
src/vitrine.ts                        the pi extension: vitrine_dispatch + vitrine_collect + vitrine_done
src/cli.ts                            the `vitrine` CLI — bin entry (shebang)
src/bench/                            the perf-eval core — the pure collector
  (one task dir → one metrics row) · report.ts (rows → table/JSON, no IO) ·
  history.ts (state/bench/history.jsonl, gitignored) · hermetic.ts (the
  headless driver behind `vitrine bench hermetic`) · battery.ts (the
  versioned live battery + the pure outcome oracles) · live.ts (the live
  driver behind `vitrine bench live` — the real model, the local seats)
  the conformance canary (conformance.test.ts) pins the fixture against
  test/fixtures/pi-session-sample.jsonl — regenerate that sample on a pi upgrade that changes the session shape
test/helpers.ts, test/fixtures/fake-pi.ts    shared test base + the fixture pi binary
agents/                                       the shipped worker agent files
docs/example-agent.md                         the copyable agent template
```

Data flow, one way around: `vitrine_dispatch` (the model's tool) → `dispatchTasks` reconciles, admits against the liveness-qualified slot cap, creates the task dir (`spec.json` + `prompt.md`, `0700`/`0600`, the `async` delivery-eligibility marker), spawns the admitted tasks (tile: hyprctl argv → a foot tile running `vitrine-run`; headless: a detached `vitrine-run` — the `spawn-issued` event guards the in-flight window), and **returns the per-task report (ids + state + the settlement line — no harvest)**. From the pass onward the session's watcher (`src/watcher.ts`) owns the queue (admission, spawn, lease refresh) and the delivery (settlement → one coalesced `pi.sendMessage` with the fixed wrapper → the `harvest-delivered` marker; restart → the attach/replay scan). `vitrine_collect` (`src/collect.ts`) is the on-demand pull floor over the same disk state — the same harvest machinery, the same marker. The wrapper (`vitrine-run` → `runWrapper`/`runHeadlessWrapper`) does the `queued→running` CAS, spawns the worker `pi` session, and runs the watchdog loop until `done.marker` / kill / timeout — `state.json` is the status record of record (monotonic, single-writer per regime), `events.jsonl` the audit log. The worker's `vitrine_done` tool writes `result.md` + `done.marker` and never `state.json`. The `vitrine` CLI reads the same task dirs (list/show/kill/gc — gc skips undelivered async dirs, noted) and runs the perf-eval suite over them (`bench hermetic` — the hermetic driver in `src/bench/`; `bench live` — the versioned battery in `src/bench/battery.ts` against real pi, success rate first via the outcome oracles, latency medians second). No daemon, no socket — `spec.json` is the only parent→worker transport.

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

- **pi** — the extension targets pi 0.85–0.86 (the ambient type stubs in `src/types/` mirror the extension API; keep them in sync with the installed pi when you extend the surface). The delivery primitive — `pi.sendMessage` with `deliverAs: "followUp"` + `triggerTurn: true` — is verified present on 0.85.1 (docs and binary): no floor bump.
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

- **No OS-level worker signal**: a finished or stuck *worker* shows in its tile (title, countdown) — nothing else notifies the worker side; watch the window group or poll `vitrine list`. Settlement additionally delivers the harvest to the main session (the delivery is the model's signal, not the operator's); an OS-level worker signal (tile title changes, a desktop notification) is the right home for that, not this feature.
- **Lazy reconciliation**: stale tasks settle on the next `vitrine_dispatch` or the session's watcher tick (the dispatcher's reconciliation), not on a timer — the owner-lease window (30 s) is the only clock.
- **Default delivery rendering**: the harvest message (`customType: "vitrine-harvest"`) renders with pi's default custom-message rendering in v1 — a `registerEntryRenderer` (a collapsed-by-default row with the per-task states) is a follow-up.
- **No bench delivery surface yet**: the CLI bench drives the dispatch core, not the extension — the delivery segment is measured hermetically in the E2E, not in the bench battery; a bench surface is a follow-up.
- **No delivery tuning surface**: the coalescing window *is* the poll tick (1000 ms); there is nothing to configure in v1. A tuning surface (coalescing window, wake suppression, per-state policy) is a follow-up only if the risks prove wrong in use.
- **Pre-release**: `0.0.0` — the first public release is `0.1.0`, and the task-dir protocol may still change before it (the async change — non-blocking only — is itself a pre-`0.1.0` behaviour change).

## License

MIT — see `LICENSE`.
