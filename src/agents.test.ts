/**
 * agents.test.ts — agent file resolution
 * (global first, project-local only when trusted), frontmatter stripping,
 * name validation, missing-agent errors.
 *
 * Hermetic: HOME points at a tmp dir so `~/.pi/agent/agents` is test-owned.
 */
import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProtocolError } from "./protocol";
import { listAgentNames, listAgentSummaries, parseFrontmatter, resolveAgent, stripFrontmatter } from "./agents";

let base: string;
const realHome = process.env.HOME;

beforeAll(async () => {
	base = await mkdtemp(join(tmpdir(), "vitrine-agents-"));
	process.env.HOME = base;
});

afterAll(async () => {
	process.env.HOME = realHome;
	await rm(base, { recursive: true, force: true });
});

// `base` is only known after beforeAll (the module body runs at collection
// time) — compute lazily.
const globalDir = () => join(base, ".pi", "agent", "agents");

/** Assert the rejection carries the given protocol code. */
async function rejectsCode(code: string, fn: () => Promise<unknown>): Promise<void> {
	try {
		await fn();
	} catch (e) {
		if (e instanceof ProtocolError && e.code === code) return;
		throw new Error(`expected protocol code '${code}', got: ${String(e)}`);
	}
	throw new Error(`expected rejection with code '${code}', resolved instead`);
}

const WITH_FM = `---\nname: refiner\ndescription: stress-tests a brief\n---\n# Refiner\n\nBe adversarial.\n`;

describe("stripFrontmatter", () => {
	it("strips a leading frontmatter block", () => {
		expect(stripFrontmatter(WITH_FM)).toBe("# Refiner\n\nBe adversarial.");
	});
	it("leaves frontmatter-free text (trimmed)", () => {
		expect(stripFrontmatter("  # Plain\n\nBody.\n\n")).toBe("# Plain\n\nBody.");
	});
	it("an unterminated frontmatter block returns the text unchanged", () => {
		expect(stripFrontmatter("---\nname: x\nbody text")).toBe("---\nname: x\nbody text".trim());
	});
	it("a later `---` line in the body is content, not a closer", () => {
		expect(stripFrontmatter("---\n---\n# T\n---\nmore")).toBe("# T\n---\nmore");
	});
});

describe("parseFrontmatter", () => {
	it("parses the fields (tools comma-split, noTools truthy)", () => {
		const fm = parseFrontmatter(
			"---\nname: refiner\ndescription: stress-tests a brief\nmodel: ninfer/qwen3.8-27b\nthinking: high\ninactivityTimeout: 600\ntools: read, grep, find\n---\nbody",
		);
		expect(fm).toEqual({
			name: "refiner",
			description: "stress-tests a brief",
			model: "ninfer/qwen3.8-27b",
			thinking: "high",
			inactivityTimeout: 600,
			tools: ["read", "grep", "find"],
		});
	});

	it("noTools is an empty allowlist, unknown fields are ignored", () => {
		const fm = parseFrontmatter("---\nnoTools: true\nsessionPreference: ephemeral\nsessionHint: whatever\n---\nbody");
		expect(fm).toEqual({ noTools: true });
	});

	it("an empty tools value is the empty allowlist", () => {
		expect(parseFrontmatter("---\ntools:\n---\nbody").tools).toEqual([]);
	});

	it("no frontmatter is an empty object", () => {
		expect(parseFrontmatter("# Plain\nbody")).toEqual({});
	});

	it("tolerates the six live agent files (named test — they keep working unmodified)", async () => {
		// the shipped agent files (the repo's agents/ dir, plain files) — this
		// test's whole point is that the files that ship keep working, and the
		// repo path keeps the test hermetic (any machine, not just this box)
		const liveDir = fileURLToPath(new URL("../agents", import.meta.url));
		const live = ["challenge", "design", "execute", "explore", "plan", "review"].map((n) => join(liveDir, `${n}.md`));
		const present = live.filter((p) => existsSync(p));
		// the repo ships the six seats; if one is missing the tolerance
		// claim is untestable, and the test says so rather than passing silently
		expect(present.length).toBe(live.length);
		for (const p of present) {
			const raw = await readFile(p, "utf8");
			const fm = parseFrontmatter(raw);
			expect(fm.name).toBe(p.split("/").pop()!.replace(".md", ""));
			// the body must survive (the system-prompt payload is non-empty)
			expect(stripFrontmatter(raw).length).toBeGreaterThan(0);
		}
	});
});

describe("listAgentNames", () => {
	it("unions global + project-local (when trusted) and sorts", async () => {
		await mkdir(globalDir(), { recursive: true });
		await writeFile(join(globalDir(), "b.md"), "b");
		await writeFile(join(globalDir(), "a.md"), "a");
		const cwd = join(base, "proj-l");
		await mkdir(join(cwd, ".pi", "agents"), { recursive: true });
		await writeFile(join(cwd, ".pi", "agents", "c.md"), "c");
		expect(listAgentNames({ projectAllowed: true, cwd })).toEqual(["a", "b", "c"]);
		expect(listAgentNames({ projectAllowed: false, cwd })).toEqual(["a", "b"]);
	});
});

describe("listAgentSummaries (the roster: name + first description sentence)", () => {
	// the file's earlier describes leave files in the shared global dir —
	// assert per-name, never on the whole array
	it("project entries shadow same-name global entries (resolveAgent's candidate order)", async () => {
		await mkdir(globalDir(), { recursive: true });
		await writeFile(join(globalDir(), "shadowed.md"), "---\nname: shadowed\ndescription: the global line. never shown trusted\n---\nbody");
		const cwd = join(base, "proj-sum");
		await mkdir(join(cwd, ".pi", "agents"), { recursive: true });
		await writeFile(join(cwd, ".pi", "agents", "shadowed.md"), "---\nname: shadowed\ndescription: the project line. never shown untrusted\n---\nbody");
		await writeFile(join(cwd, ".pi", "agents", "proj-only.md"), "---\nname: proj-only\ndescription: lives in the project.\n---\nbody");
		const trusted = listAgentSummaries({ projectAllowed: true, cwd });
		expect(trusted.find((s) => s.name === "shadowed")?.line).toBe("the project line.");
		expect(trusted.find((s) => s.name === "proj-only")?.line).toBe("lives in the project.");
		const untrusted = listAgentSummaries({ projectAllowed: false, cwd });
		expect(untrusted.find((s) => s.name === "shadowed")?.line).toBe("the global line.");
		expect(untrusted.find((s) => s.name === "proj-only")).toBeUndefined();
	});

	it("line = the first sentence (through the first period), or the whole description; no description ⇒ the name alone", async () => {
		await mkdir(globalDir(), { recursive: true });
		await writeFile(join(globalDir(), "sentences.md"), "---\ndescription: First one. Second one. Third.\n---\nbody");
		await writeFile(join(globalDir(), "no-period.md"), "---\ndescription: no period anywhere\n---\nbody");
		await writeFile(join(globalDir(), "bare.md"), "no frontmatter at all");
		const s = listAgentSummaries();
		expect(s.find((x) => x.name === "sentences")?.line).toBe("First one.");
		expect(s.find((x) => x.name === "no-period")?.line).toBe("no period anywhere");
		expect(s.find((x) => x.name === "bare")?.line).toBe("bare");
	});

	it("caps the line at 160 chars with an ellipsis on truncation", async () => {
		await mkdir(globalDir(), { recursive: true });
		// a first sentence of 301 chars ⇒ 159 chars + the ellipsis = 160
		await writeFile(join(globalDir(), "capped.md"), `---\ndescription: ${"x".repeat(300)}. tail\n---\nbody`);
		// a first sentence of exactly 160 chars ⇒ untouched
		await writeFile(join(globalDir(), "exact.md"), `---\ndescription: ${"y".repeat(159)}. more\n---\nbody`);
		const s = listAgentSummaries();
		const capped = s.find((x) => x.name === "capped")!.line;
		expect(capped).toBe(`${"x".repeat(159)}…`);
		expect(capped.length).toBeLessThanOrEqual(160);
		const exact = s.find((x) => x.name === "exact")!.line;
		expect(exact).toBe(`${"y".repeat(159)}.`);
		expect(exact.length).toBe(160);
		expect(exact.endsWith("…")).toBe(false);
	});

	it("sorts by name", async () => {
		await mkdir(globalDir(), { recursive: true });
		await writeFile(join(globalDir(), "zz.md"), "---\ndescription: zz\n---\nbody");
		await writeFile(join(globalDir(), "mm.md"), "---\ndescription: mm\n---\nbody");
		const names = listAgentSummaries().map((s) => s.name);
		expect(names).toEqual([...names].sort());
		expect(names).toContain("mm");
		expect(names).toContain("zz");
	});
});

describe("resolveAgent", () => {
	it("resolves a global agent with the frontmatter stripped", async () => {
		await mkdir(globalDir(), { recursive: true });
		await writeFile(join(globalDir(), "refiner.md"), WITH_FM);
		const a = await resolveAgent("refiner");
		expect(a).toEqual({
			name: "refiner",
			body: "# Refiner\n\nBe adversarial.",
			source: "global",
			path: join(globalDir(), "refiner.md"),
			frontmatter: { name: "refiner", description: "stress-tests a brief" },
		});
	});

	it("project-local wins only when trusted", async () => {
		await mkdir(globalDir(), { recursive: true });
		await writeFile(join(globalDir(), "executor.md"), "# Global executor\n");
		const cwd = join(base, "proj");
		await mkdir(join(cwd, ".pi", "agents"), { recursive: true });
		await writeFile(join(cwd, ".pi", "agents", "executor.md"), "# Project executor\n");
		// untrusted: global wins
		expect((await resolveAgent("executor", { projectAllowed: false, cwd })).source).toBe("global");
		// trusted: project wins
		const a = await resolveAgent("executor", { projectAllowed: true, cwd });
		expect(a.source).toBe("project");
		expect(a.body).toBe("# Project executor");
	});

	it("a project-only agent is invisible to an untrusted session", async () => {
		const cwd = join(base, "proj2");
		await mkdir(join(cwd, ".pi", "agents"), { recursive: true });
		await writeFile(join(cwd, ".pi", "agents", "solo.md"), "# Solo\n");
		await rejectsCode("bad-agent", () => resolveAgent("solo", { projectAllowed: false, cwd }));
	});

	it("rejects traversal and control names (bad-agent)", async () => {
		for (const name of ["../../etc/passwd", "a;b", "a b", "a/b", "a\nb", ""]) {
			await rejectsCode("bad-agent", () => resolveAgent(name));
		}
	});

	it("a missing agent is a bad-agent naming the looked-in paths", async () => {
		await rejectsCode("bad-agent", () => resolveAgent("ghost"));
		await expect(resolveAgent("ghost")).rejects.toThrow(/no agent file for 'ghost'/);
	});
});
