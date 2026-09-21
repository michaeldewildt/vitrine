/**
 * main-guard — the jiti-safe main-module check for the bin entry points.
 *
 * Why not `import.meta.main`: jiti (pi's extension loader) transpiles to
 * CJS and rewrites only `import.meta.url`; any other raw `import.meta`
 * survives, forcing jiti's data-URL import fallback — which pi (a Bun
 * binary) rejects with `NameTooLong` for a large module, killing the
 * extension load (verified 2026-09-16, v0.1 bring-up).
 *
 * Portable equivalent: compare the process entry (`argv[1]`) with the
 * module's own path, both through realpath. False on import and false-safe
 * on any error, so a main block can never run twice.
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function isMainModule(moduleUrl: string): boolean {
	const entry = process.argv[1];
	if (!entry) return false;
	try {
		return realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl));
	} catch {
		return false;
	}
}
