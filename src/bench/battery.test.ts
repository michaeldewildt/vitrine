/**
 * battery.test.ts — the outcome oracles against fabricated task dirs /
 * scratch cwds (pass, exact-mismatch fail, missing-file fail, malformed
 * result.json fail-without-throw), and the battery definitions
 * (well-formed: agents, unique ids, schemas compile where declared, the
 * oracles' expectations agree with the battery's own content).
 */
import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Compile } from "typebox/compile";
import { BATTERY, BOUNDED_WRITE_CONTENT, READ_GROUND_CONTENT, runOracle } from "./battery";

async function mkDirs(): Promise<{ taskDir: string; scratch: string; base: string }> {
	const base = await mkdtemp(join(tmpdir(), "vitrine-battery-"));
	const taskDir = join(base, "task");
	const scratch = join(base, "scratch");
	await mkdir(taskDir, { recursive: true });
	await mkdir(scratch, { recursive: true });
	return { taskDir, scratch, base };
}

describe("runOracle — data-match", () => {
	it("passes on an exact content match in result.json", async () => {
		const { taskDir, scratch, base } = await mkDirs();
		await writeFile(join(taskDir, "result.json"), JSON.stringify({ content: "alpha\nbeta\n" }));
		const v = await runOracle({ kind: "data-match", expected: "alpha\nbeta\n" }, taskDir, scratch);
		expect(v.pass).toBe(true);
		await rm(base, { recursive: true, force: true });
	});

	it("fails on an exact mismatch (a trailing newline difference)", async () => {
		const { taskDir, scratch, base } = await mkDirs();
		await writeFile(join(taskDir, "result.json"), JSON.stringify({ content: "alpha\nbeta" }));
		const v = await runOracle({ kind: "data-match", expected: "alpha\nbeta\n" }, taskDir, scratch);
		expect(v.pass).toBe(false);
		expect(v.detail).toContain("differs");
		await rm(base, { recursive: true, force: true });
	});

	it("fails on a missing result.json", async () => {
		const { taskDir, scratch, base } = await mkDirs();
		const v = await runOracle({ kind: "data-match", expected: "x" }, taskDir, scratch);
		expect(v.pass).toBe(false);
		expect(v.detail).toContain("result.json missing");
		await rm(base, { recursive: true, force: true });
	});

	it("fails without throwing on a malformed result.json", async () => {
		const { taskDir, scratch, base } = await mkDirs();
		await writeFile(join(taskDir, "result.json"), "{not json");
		const v = await runOracle({ kind: "data-match", expected: "x" }, taskDir, scratch);
		expect(v.pass).toBe(false);
		expect(v.detail).toContain("malformed");
		await rm(base, { recursive: true, force: true });
	});

	it("fails when data.content is missing or not a string", async () => {
		const { taskDir, scratch, base } = await mkDirs();
		await writeFile(join(taskDir, "result.json"), JSON.stringify({ content: 42 }));
		expect((await runOracle({ kind: "data-match", expected: "42" }, taskDir, scratch)).pass).toBe(false);
		await writeFile(join(taskDir, "result.json"), JSON.stringify({ other: "x" }));
		expect((await runOracle({ kind: "data-match", expected: "x" }, taskDir, scratch)).pass).toBe(false);
		await rm(base, { recursive: true, force: true });
	});
});

describe("runOracle — file-content", () => {
	it("passes on a byte-exact file", async () => {
		const { taskDir, scratch, base } = await mkDirs();
		await writeFile(join(scratch, "out.txt"), "line one\nline two\n");
		const v = await runOracle({ kind: "file-content", file: "out.txt", expected: "line one\nline two\n" }, taskDir, scratch);
		expect(v.pass).toBe(true);
		await rm(base, { recursive: true, force: true });
	});

	it("fails on a content difference and on a missing file", async () => {
		const { taskDir, scratch, base } = await mkDirs();
		await writeFile(join(scratch, "out.txt"), "line one\nline two");
		expect((await runOracle({ kind: "file-content", file: "out.txt", expected: "line one\nline two\n" }, taskDir, scratch)).pass).toBe(false);
		const missing = await runOracle({ kind: "file-content", file: "absent.txt", expected: "x" }, taskDir, scratch);
		expect(missing.pass).toBe(false);
		expect(missing.detail).toContain("missing");
		await rm(base, { recursive: true, force: true });
	});
});

describe("runOracle — line-count", () => {
	it("passes on exactly N lines (trailing newline not double-counted)", async () => {
		const { taskDir, scratch, base } = await mkDirs();
		await writeFile(join(scratch, "lines.txt"), Array.from({ length: 100 }, (_, i) => String(i + 1)).join("\n") + "\n");
		const v = await runOracle({ kind: "line-count", file: "lines.txt", expected: 100 }, taskDir, scratch);
		expect(v.pass).toBe(true);
		await rm(base, { recursive: true, force: true });
	});

	it("fails on a different count and on a missing file", async () => {
		const { taskDir, scratch, base } = await mkDirs();
		await writeFile(join(scratch, "lines.txt"), "1\n2\n");
		const v = await runOracle({ kind: "line-count", file: "lines.txt", expected: 100 }, taskDir, scratch);
		expect(v.pass).toBe(false);
		expect(v.detail).toContain("2 lines");
		expect((await runOracle({ kind: "line-count", file: "absent.txt", expected: 1 }, taskDir, scratch)).pass).toBe(false);
		await rm(base, { recursive: true, force: true });
	});
});

describe("runOracle — result-text", () => {
	it("passes when the task settled completed and the harvest contains the text", async () => {
		const { taskDir, scratch, base } = await mkDirs();
		await writeFile(join(taskDir, "state.json"), JSON.stringify({ state: "completed" }));
		await writeFile(join(taskDir, "result.md"), "fixture result\n");
		const v = await runOracle({ kind: "result-text", contains: "fixture" }, taskDir, scratch);
		expect(v.pass).toBe(true);
		await rm(base, { recursive: true, force: true });
	});

	it("fails on a non-completed state and on missing expected text", async () => {
		const { taskDir, scratch, base } = await mkDirs();
		await writeFile(join(taskDir, "state.json"), JSON.stringify({ state: "crashed", reason: "failed-to-spawn" }));
		await writeFile(join(taskDir, "result.md"), "fixture result\n");
		const v = await runOracle({ kind: "result-text", contains: "fixture" }, taskDir, scratch);
		expect(v.pass).toBe(false);
		expect(v.detail).toContain("crashed");
		await writeFile(join(taskDir, "state.json"), JSON.stringify({ state: "completed" }));
		const v2 = await runOracle({ kind: "result-text", contains: "not there" }, taskDir, scratch);
		expect(v2.pass).toBe(false);
		await rm(base, { recursive: true, force: true });
	});
});

describe("the battery definitions", () => {
	it("has three entries with unique ids and the settled seat assignments", () => {
		expect(BATTERY).toHaveLength(3);
		const ids = BATTERY.map((b) => b.id);
		expect(new Set(ids).size).toBe(3);
		expect(ids).toEqual(["read-ground", "bounded-write", "decode-proxy"]);
		// local seats only (the design's settled decision)
		expect(BATTERY.map((b) => b.agent)).toEqual(["explore", "execute", "execute"]);
	});

	it("every entry is well-formed: non-empty task, a valid oracle, safe cwd file names", () => {
		for (const entry of BATTERY) {
			expect(entry.task.length > 0).toBe(true);
			expect(["data-match", "file-content", "line-count", "result-text"]).toContain(entry.oracle.kind);
			for (const f of entry.cwdFiles ?? []) {
				// a cwd file name is a bare file in the scratch cwd (no path escape)
				expect(f.name.includes("/")).toBe(false);
				expect(f.name.length > 0).toBe(true);
			}
		}
	});

	it("the declared schemas compile (where declared)", () => {
		for (const entry of BATTERY) {
			if (entry.schema === undefined) continue;
			// Compile throws on a schema that does not compile — the battery must compile clean
			const v = Compile(entry.schema);
			expect(v.Check({ content: "x" })).toBe(true);
			expect(v.Check({ content: 42 })).toBe(false);
		}
		// exactly one entry carries a schema (the typed-harvest contract)
		expect(BATTERY.filter((b) => b.schema !== undefined)).toHaveLength(1);
	});

	it("the oracle expectations agree with the battery's own content", () => {
		const readGround = BATTERY.find((b) => b.id === "read-ground")!;
		expect(readGround.cwdFiles).toHaveLength(1);
		expect(readGround.cwdFiles![0].content).toBe(READ_GROUND_CONTENT);
		expect(readGround.oracle).toEqual({ kind: "data-match", expected: READ_GROUND_CONTENT });
		// the fixture file is a ~15-line list
		expect(READ_GROUND_CONTENT.split("\n").length - 1).toBeGreaterThanOrEqual(14);

		const boundedWrite = BATTERY.find((b) => b.id === "bounded-write")!;
		expect(boundedWrite.oracle).toEqual({ kind: "file-content", file: "out.txt", expected: BOUNDED_WRITE_CONTENT });
		expect(BOUNDED_WRITE_CONTENT.split("\n").length - 1).toBe(10);
		// the task text names the file and every expected line
		expect(boundedWrite.task).toContain("out.txt");
		for (const line of BOUNDED_WRITE_CONTENT.trim().split("\n")) expect(boundedWrite.task).toContain(line);

		const decodeProxy = BATTERY.find((b) => b.id === "decode-proxy")!;
		expect(decodeProxy.oracle).toEqual({ kind: "line-count", file: "lines.txt", expected: 100 });
		expect(decodeProxy.task).toContain("lines.txt");
	});
});
