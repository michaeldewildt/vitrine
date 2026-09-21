/**
 * agents.ts — agent file resolution.
 *
 * The dispatch tool resolves the agent file at dispatch time and carries
 * the body in the spec (`agent.body`): `spec.json` is the only parent→
 * worker transport, and the worker's cwd is the task's, not the dispatcher's
 * — the wrapper can only use its own lookup as the dev/fixture fallback.
 *
 * Lookup (first hit wins — the closer scope overrides, the same layering as
 * pi's AGENTS.md files):
 * 1. project-local: `<cwd>/.pi/agents/<name>.md` — ONLY when the calling
 *    pi session is project-trusted (pi's project-trust gate; the extension
 *    checks `ctx.isProjectTrusted` before allowing project lookup, mirroring
 *    how pi itself loads project-local agents).
 * 2. global: `~/.pi/agent/agents/<name>.md`
 *
 * The name is validated against `P.AGENT_NAME_RE` (`validateSpec` is
 * the single chokepoint; this is defense-in-depth for the direct callers
 * — the CLI and tests). The name is embedded verbatim into
 * the tile-spawn dispatch string and a file path, so the regex is a
 * security boundary, not a style rule.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as P from "./protocol";

/** Global agent dir (pi's own, `~/.pi/agent/agents`) — call-time, and
 * `process.env.HOME` read directly (Bun snapshots `os.homedir()` at startup;
 * tests override `$HOME` per-file). */
export function globalAgentsDir(): string {
	return join(process.env.HOME ?? homedir(), ".pi", "agent", "agents");
}

export interface ResolvedAgent {
	name: string;
	/** The file body with the YAML frontmatter stripped — the system-prompt payload. */
	body: string;
	source: "global" | "project";
	path: string;
	/** The parsed frontmatter (`name, description, model, thinking,
	 * inactivityTimeout, tools, noTools`; unknown fields ignored). */
	frontmatter: AgentFrontmatter;
}

/**
 * The frontmatter fields Vitrine acts on. Unknown fields (the
 * advisory `sessionPreference`/`sessionHint` lines included) are ignored.
 */
export interface AgentFrontmatter {
	name?: string;
	description?: string;
	model?: string;
	thinking?: string;
	inactivityTimeout?: number;
	/** The `--tools` allowlist (comma-separated in the file). */
	tools?: string[];
	/** `noTools` ⇒ the empty allowlist (`--tools vitrine_done` after the union). */
	noTools?: boolean;
}

/**
 * Parse the leading YAML frontmatter block into the fields Vitrine acts on.
 * Plain `key: value` pairs only (the agent files are flat);
 * `tools` is comma-split; `noTools` is any truthy scalar. Returns `{}` when
 * there is no block. Tolerance for the live agent files is a named
 * test (plan: the parser must not choke on real files).
 */
export function parseFrontmatter(text: string): AgentFrontmatter {
	const out: AgentFrontmatter = {};
	const lines = text.split("\n");
	if (lines[0]?.trim() !== "---") return out;
	for (let i = 1; i < lines.length; i++) {
		const line = lines[i];
		if (line.trim() === "---") break;
		const m = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
		if (m === null) continue; // indented/continuation lines: ignored (flat files)
		const key = m[1];
		const value = m[2].trim().replace(/^["']|["']$/g, "");
		switch (key) {
			case "name":
				if (value !== "") out.name = value;
				break;
			case "description":
				if (value !== "") out.description = value;
				break;
			case "model":
				if (value !== "") out.model = value;
				break;
			case "thinking":
				if (value !== "") out.thinking = value;
				break;
			case "inactivityTimeout":
				if (/^\d+$/.test(value)) out.inactivityTimeout = Number(value);
				break;
			case "tools":
				out.tools = value === "" ? [] : value.split(",").map((s) => s.trim()).filter((s) => s !== "");
				break;
			case "noTools":
				out.noTools = value !== "" && value !== "false" && value !== "0";
				break;
			default:
				break; // unknown fields are ignored
		}
	}
	return out;
}

/**
 * Strip a leading YAML frontmatter block (the first `---` line closed by a
 * later `---` line) — pi's agent files carry model/tools metadata there;
 * the worker model should see the prose only. An absent or unterminated
 * frontmatter block returns the (trimmed) text unchanged.
 *
 * The single frontmatter stripper: `resolveAgent` (dispatch) and
 * `readAgentBody` (the wrapper's fallback) both go through it.
 */
export function stripFrontmatter(text: string): string {
	const lines = text.split("\n");
	if (lines[0]?.trim() !== "---") return text.trim();
	for (let i = 1; i < lines.length; i++) {
		if (lines[i].trim() === "---") {
			return lines.slice(i + 1).join("\n").trim();
		}
	}
	return text.trim();
}

/**
 * Resolve `name` to an agent file and return its body.
 * `projectAllowed` gates the project-local lookup (trust).
 * `cwd` is the DISPATCHER's cwd (where the user invoked the tool).
 */
export async function resolveAgent(name: string, opts: { projectAllowed?: boolean; cwd?: string } = {}): Promise<ResolvedAgent> {
	if (typeof name !== "string" || !P.AGENT_NAME_RE.test(name)) {
		throw new P.ProtocolError("bad-agent", `agent name must match ${P.AGENT_NAME_RE} (got ${JSON.stringify(name)})`);
	}
	const candidates: Array<{ path: string; source: "global" | "project" }> = [];
	if (opts.projectAllowed === true && typeof opts.cwd === "string" && opts.cwd !== "") {
		candidates.push({ path: join(opts.cwd, ".pi", "agents", `${name}.md`), source: "project" });
	}
	candidates.push({ path: join(globalAgentsDir(), `${name}.md`), source: "global" });
	for (const c of candidates) {
		if (!existsSync(c.path)) continue;
		const raw = await readFile(c.path, "utf8");
		return { name, body: stripFrontmatter(raw), source: c.source, path: c.path, frontmatter: parseFrontmatter(raw) };
	}
	throw new P.ProtocolError("bad-agent", `no agent file for '${name}' (looked in: ${candidates.map((c) => c.path).join(", ")})`);
}

/**
 * The wrapper's dev/fixture agent-dir default: the repo's `agents/` (the
 * wrapper's own lookup — distinct from the dispatcher's global
 * `~/.pi/agent/agents`, which `resolveAgent` uses). Call-time (tests
 * change HOME and the module may load under a different cwd).
 */
export const wrapperAgentsDir = (): string => join(dirname(fileURLToPath(import.meta.url)), "..", "agents");

/**
 * Read an agent file's body (frontmatter stripped) from an explicit dir —
 * the wrapper's dev/fixture fallback (specs without a resolved `agent.body`:
 * hand-built dirs, old tests). The dispatcher's path is `resolveAgent`.
 */
export async function readAgentBody(agentName: string, agentsDir: string): Promise<string> {
	const p = join(agentsDir, `${agentName}.md`);
	const text = await readFile(p, "utf8").catch((e: NodeJS.ErrnoException) => {
		throw new P.ProtocolError("bad-spec", `agent file missing: ${p} (${e.code ?? e})`);
	});
	return stripFrontmatter(text);
}

/**
 * The available agent names (global + project-local when trusted) — for
 * the unknown-agent error that lists what the dispatcher could have meant
 * ("Unknown-agent errors list the available names").
 */
export function listAgentNames(opts: { projectAllowed?: boolean; cwd?: string } = {}): string[] {
	const dirs: string[] = [];
	if (opts.projectAllowed === true && typeof opts.cwd === "string" && opts.cwd !== "") {
		dirs.push(join(opts.cwd, ".pi", "agents"));
	}
	dirs.push(globalAgentsDir());
	const names = new Set<string>();
	for (const d of dirs) {
		try {
			for (const f of readdirSync(d)) {
				if (f.endsWith(".md") && P.AGENT_NAME_RE.test(f.slice(0, -3))) names.add(f.slice(0, -3));
			}
		} catch {
			// a missing dir is just "no agents there"
		}
	}
	return [...names].sort();
}

/** The cap on a roster line — a label for the model to pick with, not the
 * description itself; an over-long first sentence is truncated to this
 * many chars with an ellipsis. */
const SUMMARY_LINE_CAP = 160;

/** The FIRST SENTENCE of a frontmatter `description` — the text up to and
 * including the first period, or the whole description when it has none —
 * capped at SUMMARY_LINE_CAP chars (ellipsis on truncation). */
function firstSentenceLine(description: string): string {
	const i = description.indexOf(".");
	const sentence = i === -1 ? description : description.slice(0, i + 1);
	return sentence.length <= SUMMARY_LINE_CAP ? sentence : `${sentence.slice(0, SUMMARY_LINE_CAP - 1)}…`;
}

/** One roster entry: the agent name plus its one-line summary. */
export interface AgentSummary {
	name: string;
	/** The first sentence of the description (capped), or the name alone
	 * when the file has no description. */
	line: string;
}

/**
 * The available agents with a one-line summary each — the roster the
 * `vitrine_dispatch` description (composed at registration time) and the
 * unknown-agent error (composed at call time) are built from. Same dir scan
 * as `listAgentNames` (project dir first when trusted, then global), and
 * project entries shadow global entries of the same name — `resolveAgent`'s
 * candidate order, so the roster cannot list an agent under a description
 * dispatch would not use. Sorted by name.
 */
export function listAgentSummaries(opts: { projectAllowed?: boolean; cwd?: string } = {}): AgentSummary[] {
	const dirs: string[] = [];
	if (opts.projectAllowed === true && typeof opts.cwd === "string" && opts.cwd !== "") {
		dirs.push(join(opts.cwd, ".pi", "agents"));
	}
	dirs.push(globalAgentsDir());
	const byName = new Map<string, AgentSummary>();
	for (const d of dirs) {
		let files: string[];
		try {
			files = readdirSync(d);
		} catch {
			continue; // a missing dir is just "no agents there"
		}
		for (const f of files) {
			if (!f.endsWith(".md") || !P.AGENT_NAME_RE.test(f.slice(0, -3))) continue;
			const name = f.slice(0, -3);
			if (byName.has(name)) continue; // project-first precedence: the closer scope shadows
			let line = name; // no description (or an unreadable file) ⇒ the name alone
			try {
				const fm = parseFrontmatter(readFileSync(join(d, f), "utf8"));
				if (fm.description !== undefined && fm.description !== "") line = firstSentenceLine(fm.description);
			} catch {
				// the file still names a resolvable agent — list it without a summary
			}
			byName.set(name, { name, line });
		}
	}
	return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
