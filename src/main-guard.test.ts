/**
 * main-guard.test.ts — the jiti-safe main-module guard (v0.1 bring-up,
 * extension-load fix).
 * The guard replaces `import.meta.main` in the bin entry points: raw
 * `import.meta` survives jiti's CJS transpile and kills pi's extension load
 * (see src/main-guard.ts). These tests pin the predicate's semantics; the
 * entry wiring (the main block runs on direct exec and never on import) is
 * covered by the suite importing the entry modules plus the bring-up smoke
 * (`bun src/vitrine-run.ts` prints usage; importing it prints nothing).
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isMainModule } from "./main-guard";
const savedArgv = process.argv.slice();
describe("isMainModule (the jiti-safe main-module guard)", () => {
	let tmp: string;
	let modulePath: string;
	// the file the predicate is asked about
	let otherPath: string;

	// a different existing file
	let moduleUrl: string;
	beforeAll(() => {
		tmp = mkdtempSync(join(tmpdir(), "vitrine-main-guard-"));
		modulePath = join(tmp, "entry.ts");
		otherPath = join(tmp, "other.ts");
		writeFileSync(modulePath, "export const x = 1;\n");
		writeFileSync(otherPath, "export const y = 2;\n");
		moduleUrl = pathToFileURL(modulePath).href;
	});
	afterAll(() => {
		process.argv.length = 0;
		process.argv.push(...savedArgv);
		rmSync(tmp, { recursive: true, force: true });
	});
	it("is true when argv[1] is the module's own file", () => {
		process.argv[1]
		= modulePath;
		expect(isMainModule(moduleUrl)).toBe(true);
	});
	it("is true for a relative argv[1] that resolves to the same file (no chdir: bun test runs from the repo root)", () => {
		const rel = join(".", "src", "main-guard.ts");
		process.argv[1]
		= rel;
		expect(isMainModule(pathToFileURL(join(process.cwd(), "src", "main-guard.ts")).href)).toBe(true);
	});
	it("is false for a different existing file", () => {
		process.argv[1]
		= otherPath;
		expect(isMainModule(moduleUrl)).toBe(false);
	});
	it("is false when argv[1] is missing (bun -e)", () => {
		process.argv.splice(1, 1);
		expect(isMainModule(moduleUrl)).toBe(false);
	});
	it("is false when argv[1] does not exist (fail-safe, never run main twice)", () => {
		process.argv[1]
		= join(tmp, "nope.ts");
		expect(isMainModule(moduleUrl)).toBe(false);
	});
	it("is true through a symlinked entry (realpath normalises both sides)", () => {
		const link = join(tmp, "linked-entry.ts");
		symlinkSync(modulePath, link);
		process.argv[1]
		= link;
		expect(isMainModule(moduleUrl)).toBe(true);
		rmSync(link);
	});

});

