/** * dispatch.ts — the `vitrine_dispatch` surface, stable public path: * `core.ts` (the tool-call surface + the dispatch core + the R1 report), * `spawn.ts` (the tile argv + the join juggle + `issueSpawn` + the headless bun resolution * + the formatting pieces), `loop.ts` (the reusable wait loop — the * watcher's and the bench drivers' mechanism, R2/R10), `harvest.ts` (the result harvest + the * deferred-harvest registry), `admit.ts` (the liveness-qualified slot count * + reconciliation). Re-exported so `import ... from "./dispatch"` keeps * working (the barrel is re-exports only, like protocol/). */
export * from "./dispatch/core";
export * from "./dispatch/spawn";
export * from "./dispatch/loop";
export * from "./dispatch/harvest";
export * from "./dispatch/admit";
export { findDispatcherWindow, findPanelInWindows, readPpid, type PanelDeps, type PanelWindow,
} from "./dispatch/panel";
export { focusWindowByPid, listAllWindows, listWorkerWindows, probeCompositor, readActiveWindow, toggleGroup, WORKER_APP_ID, defaultHyprctl, type AnyWindow, type HyprctlResult, type WorkerWindow,
} from "./hyprctl";
