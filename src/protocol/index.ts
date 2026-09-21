/**
 * protocol/ — the task-dir protocol core ("The task dir — single
 * source of truth").
 *
 * Everything Vitrine knows about a task is a file under
 * `~/.vitrine/tasks/<uuid>/`: `spec.json` (written once, dispatch-tool-owned,
 * read-only afterwards), `prompt.md`, `state.json` (the status record),
 * `session.json` (wrapper-owned, written once after spawn), `result.md` +
 * `done.marker` (`vitrine_done`), `events.jsonl` (append-only audit),
 * `kill_requested` (presence-only), `tail.log`.
 *
 * This module enforces mechanically: path containment (`<tasksRoot>/<uuid>/`,
 * no symlink escape); modes (dirs `0700`, files `0600`); atomic writes
 * (unique tmp + fsync + rename — no partial `state.json`, ever); the
 * monotonic state machine (terminal states never rewritten, only
 * `LEGAL_TRANSITIONS`); ordering rule 1 (a terminal transition attempted
 * while `done.marker` exists records `completed`); ordering rule 2
 * (`reconcileDeadWrapper`); the hand-off CAS of ordering rule 3 (re-read
 * immediately before the rename; bail if the state moved — the residual
 * window is accepted by the spec, monotonicity + marker-wins make either
 * outcome safe).
 *
 * What this module does NOT enforce: the single-writer *regime* rule
 * (dispatch tool while `queued`, wrapper from `running` onward) is
 * architectural — the processes calling this module own that discipline;
 * the monotonic + CAS + marker-wins rules make every interleaving they
 * might produce safe. `session.json`/`done.marker` "written once" is
 * stat-then-write (mechanical best-effort).
 *
 * Modules: `errors` (typed failures) · `fs` (paths, atomic I/O, events,
 * tail) · `spec` (spec.json shape + creation) · `state` (the state machine)
 * · `files` (session/system-prompt/result/marker/kill files) · `env` (POSIX
 * facts + anti-recycling liveness) · `reconcile` (ordering rules 2/3 + kill).
 *
 * This barrel is jiti-loaded with the extension (one name, one owner): keep it
 * a re-export-only module.
 */
export * from "./errors";
export * from "./fs";
export * from "./spec";
export * from "./state";
export * from "./files";
export * from "./env";
export * from "./reconcile";
