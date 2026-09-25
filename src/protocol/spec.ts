/**
 * spec.ts — `spec.json`: the dispatch tool's written-once task payload.
 * `validateSpec` is the single chokepoint for the
 * shape (the name is embedded verbatim into the tile-spawn dispatch string
 * and a file path, so `AGENT_NAME_RE` is a security boundary, not style);
 * `createTask` is the dispatch-regime creation (dir `0700`, spec + prompt +
 * `queued` state + the `created` event).
 */
import { mkdir, realpath, rm, stat } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import type { TSchema } from "typebox";
import { Compile } from "typebox/compile";
import { ProtocolError } from "./errors";
import { appendEvent, assertTaskDir, atomicWriteFile, readTaskFile, tasksRoot, UUID_RE } from "./fs";

/**
 * Agent names are embedded verbatim into the tile-spawn dispatch string
 * (the `foot -T` title inside `hl.dsp.exec_cmd`), into the session display
 * name, and into a file path (`readAgentBody` joins `name + ".md"`) — the
 * name is validated at the single chokepoint here: a hand-edited spec with
 * `../../…` would otherwise read an arbitrary `.md` into the worker's system
 * prompt, which then lands in an indexed session.
 */
export const AGENT_NAME_RE = /^[A-Za-z0-9_-]+$/;

export interface TaskSpec {
	task_id: string;
	agent: {
		name: string;
		/** The resolved agent-file body — the dispatch tool resolves and carries it (spec.json is the only parent→worker transport; the wrapper's `readAgentBody` path lookup is the dev/fixture fallback). */
		body?: string;
		model?: string;
		thinking?: string;
		tools?: string[];
		inactivityTimeout?: number;
	};
	dispatcher_session_id: string;
	cwd: string;
	session_id: string;
	session_name: string;
	mode: "tile" | "headless";
	attended: boolean;
	workspace: number;
	wall_timeout_s: number;
	inactivity_s: number;
	auto_settle_s: number;
	auto_settle_grace_s: number;
	/** Auto-close for completed tiles, seconds (default 600). 0 = never; optional — the wrapper falls back to 600 when absent. */
	completed_close_s?: number;
	max_cost_usd?: number;
	/** The typed-harvest contract — a JSON Schema (plain object) the worker's `vitrine_done` `data` payload must satisfy. Rides spec.json; the worker validates the payload at the call and records it to `result.json` (the prose answer in `result.md` and the typed data stay orthogonal). */
	output_schema?: Record<string, unknown>;
	from_task_id?: string;
	/** Raw session file to fork — `context` tasks fork the dispatcher's own live session file, which lives in no task dir. Mutually exclusive with `from_task_id`. */
	from_session_file?: string;
	/**
	 * The delivery-eligibility marker (the upgrade boundary): written `true`
	 * on every task created from the async-dispatch change onward. Absent on
	 * historical (blocking-era) task dirs — their absence is the clean upgrade
	 * boundary: historical tasks are excluded from delivery, replay, and the
	 * gc-skip by the absence of this field.
	 */
	async?: boolean;
	created_at: string;
	boot_id: string;
}

// ---------------------------------------------------------------------------
// validateSpec — the field table

type Pred = (v: unknown) => boolean;
interface FieldDef {
	key: string;
	/** The `bad-spec` message — for a required field, also the absent message. */
	msg: string;
	pred: Pred;
	optional?: boolean;
}

const nonEmpty = (v: unknown): boolean => typeof v === "string" && v !== "";
const absPath: Pred = (v) => typeof v === "string" && isAbsolute(v);
const uuid: Pred = (v) => typeof v === "string" && UUID_RE.test(v);
const posNum: Pred = (v) => typeof v === "number" && v > 0;
const plainObject: Pred = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const posInt: Pred = (v) => typeof v === "number" && Number.isInteger(v) && v > 0;
const nonNegInt: Pred = (v) => typeof v === "number" && Number.isInteger(v) && v >= 0;
const isoTs: Pred = (v) => typeof v === "string" && !Number.isNaN(Date.parse(v));

const SPEC_FIELDS: FieldDef[] = [
	{ key: "task_id", msg: "task_id must be a lowercase uuidv4", pred: uuid },
	{ key: "dispatcher_session_id", msg: "dispatcher_session_id is required", pred: nonEmpty },
	{ key: "cwd", msg: "cwd must be an absolute path", pred: absPath },
	{ key: "session_id", msg: "session_id is required", pred: nonEmpty },
	{ key: "session_name", msg: "session_name is required", pred: nonEmpty },
	{ key: "mode", msg: 'mode must be "tile" or "headless"', pred: (v) => v === "tile" || v === "headless" },
	{ key: "attended", msg: "attended must be a boolean", pred: (v) => typeof v === "boolean" },
	{ key: "workspace", msg: "workspace must be a positive integer", pred: posInt },
	{ key: "wall_timeout_s", msg: "wall_timeout_s must be a positive number", pred: posNum },
	{ key: "inactivity_s", msg: "inactivity_s must be a positive number", pred: posNum },
	{ key: "auto_settle_s", msg: "auto_settle_s must be a positive number", pred: posNum },
	{ key: "auto_settle_grace_s", msg: "auto_settle_grace_s must be a positive number", pred: posNum },
	{ key: "completed_close_s", msg: "completed_close_s must be a non-negative integer (0 = never auto-close)", pred: nonNegInt, optional: true },
	{ key: "max_cost_usd", msg: "max_cost_usd must be a positive number", pred: posNum, optional: true },
	{ key: "output_schema", msg: "output_schema must be a plain object (a JSON Schema)", pred: plainObject, optional: true },
	{ key: "from_task_id", msg: "from_task_id must be a lowercase uuidv4", pred: uuid, optional: true },
	{ key: "from_session_file", msg: "from_session_file must be a non-empty string", pred: nonEmpty, optional: true },
	{ key: "async", msg: "async must be a boolean (the delivery-eligibility marker)", pred: (v) => typeof v === "boolean", optional: true },
	{ key: "created_at", msg: "created_at must be an ISO timestamp", pred: isoTs },
	{ key: "boot_id", msg: "boot_id is required", pred: nonEmpty },
];

const AGENT_FIELDS: FieldDef[] = [
	{ key: "body", msg: "agent.body must be a string", pred: (v) => typeof v === "string", optional: true },
	{ key: "model", msg: "agent.model must be a string", pred: (v) => typeof v === "string", optional: true },
	{ key: "thinking", msg: "agent.thinking must be a string", pred: (v) => typeof v === "string", optional: true },
	{ key: "tools", msg: "agent.tools must be a string array", pred: (v) => Array.isArray(v) && v.every((t) => typeof t === "string" && t !== ""), optional: true },
	{ key: "inactivityTimeout", msg: "agent.inactivityTimeout must be a positive number", pred: posNum, optional: true },
];

const fail = (msg: string): never => {
	throw new ProtocolError("bad-spec", msg);
};

// ---------------------------------------------------------------------------
// output_schema — the fail-closed authoring-time check (the dispatch edge)

/**
 * The JSON type vocabulary the installed typebox's `Compile` honours —
 * the seven JSON types (typebox 1.3.32 exports no type-name constant;
 * verified: every one of these is discriminated by the compiler's
 * `Check`, and every other name is silently ignored — `Compile` does
 * not throw on an unrecognised `type`, and its `Check` never rejects on
 * it. A typo'd LLM-authored `output_schema` would otherwise be silently
 * vacuous: the harvest would report unvalidated data as validated.)
 */
export const KNOWN_JSON_TYPES: readonly string[] = ["object", "array", "string", "number", "integer", "boolean", "null"];

/**
 * The schema's `type` / `anyOf` / `oneOf` / `properties` surface, walked
 * for unknown `type` keywords (a `type` may be a single name or an array
 * of names — JSON Schema). Returns the offending `type` values with their
 * location (empty = clean). Non-object nodes are skipped (the compile
 * check is what catches the shape).
 */
export interface UnknownTypeKeyword {
	/** The location: `(root)`, `properties.<name>`, `anyOf[<i>]`, ... (a JSON-pointer-ish path). */
	path: string;
	/** The offending `type` value, as it appears in the schema. */
	type: string;
}

export function unknownTypeKeywords(schema: unknown): UnknownTypeKeyword[] {
	const bad: UnknownTypeKeyword[] = [];
	const walk = (node: unknown, path: string): void => {
		if (typeof node !== "object" || node === null) return;
		const o = node as Record<string, unknown>;
		if (o.type !== undefined) {
			const types = Array.isArray(o.type) ? o.type : [o.type];
			for (const t of types) {
				if (!KNOWN_JSON_TYPES.includes(String(t))) bad.push({ path: path === "" ? "(root)" : path, type: String(t) });
			}
		}
		if (o.properties !== undefined && typeof o.properties === "object" && o.properties !== null && !Array.isArray(o.properties)) {
			for (const [k, v] of Object.entries(o.properties as Record<string, unknown>)) {
				walk(v, path === "" ? `properties.${k}` : `${path}.properties.${k}`);
			}
		}
		for (const key of ["anyOf", "oneOf"] as const) {
			const arr = o[key];
			if (Array.isArray(arr)) arr.forEach((v, i) => walk(v, path === "" ? `${key}[${i}]` : `${path}.${key}[${i}]`));
		}
	};
	walk(schema, "");
	return bad;
}

/**
 * The fail-closed authoring-time check for a task's `output_schema` — the
 * dispatch edge rejects on a non-empty result (the `vitrine_done`-time
 * validation stays the second line):
 * 1. the schema must `Compile` (typebox) — a schema that does not compile
 *    is unverifiable at the call;
 * 2. every `type` keyword on the schema's `type`/`anyOf`/`oneOf`/
 *    `properties` surface must be a known JSON type (see
 *    `unknownTypeKeywords` — the compiler's silent-ignore is the fail-open
 *    this walk closes).
 */
export function outputSchemaErrors(schema: Record<string, unknown>): string[] {
	const errors: string[] = [];
	try {
		Compile(schema as TSchema);
	} catch (e: unknown) {
		errors.push(`output_schema failed to compile: ${e instanceof Error ? e.message : String(e)}`);
	}
	for (const { path, type } of unknownTypeKeywords(schema)) {
		errors.push(`output_schema has an unknown type keyword '${type}' at ${path} (known types: ${KNOWN_JSON_TYPES.join(", ")})`);
	}
	return errors;
}

function checkField(o: Record<string, unknown>, f: FieldDef, prefix: string): void {
	const v = o[f.key];
	if (v === undefined) {
		if (!f.optional) fail(f.msg);
		return;
	}
	if (!f.pred(v)) fail(`${prefix}${f.msg}`);
}

/** Validate an unknown value against the `spec.json` shape. */
export function validateSpec(s: unknown): TaskSpec {
	if (typeof s !== "object" || s === null) fail("spec must be an object");
	const o = s as Record<string, unknown>;
	const agent = o.agent;
	if (typeof agent !== "object" || agent === null || typeof (agent as Record<string, unknown>).name !== "string" || (agent as Record<string, unknown>).name === "") {
		fail("agent.name is required (non-empty string)");
	}
	const a = agent as Record<string, unknown>;
	if (typeof a.name !== "string" || !AGENT_NAME_RE.test(a.name)) {
		fail(`agent.name must match ${AGENT_NAME_RE} (embedded verbatim in the tile-spawn dispatch string and a file path)`);
	}
	for (const f of AGENT_FIELDS) checkField(a, f, "");
	for (const f of SPEC_FIELDS) checkField(o, f, "");
	if (o.from_task_id !== undefined && o.from_session_file !== undefined) {
		fail("from_task_id and from_session_file are mutually exclusive");
	}
	return s as TaskSpec;
}

export async function readSpec(dir: string): Promise<TaskSpec> {
	const d = await assertTaskDir(dir);
	return validateSpec(await readTaskFile(d, "spec.json", "no-spec"));
}

// ---------------------------------------------------------------------------
// Task creation (dispatch-tool regime)

/**
 * Create a task dir: mkdir `0700`, then `spec.json` + `prompt.md` +
 * `state.json` (`queued`) + the `created` event. Fails if the dir exists.
 */
export async function createTask(dir: string, spec: TaskSpec, promptText: string): Promise<void> {
	const d = await assertTaskDir(dir);
	validateSpec(spec);
	// The dir name is the task id everywhere downstream (kill, show, harvest,
	// recall) — a mismatched spec.task_id would make the task unkillable and
	// unrecallable while looking healthy.
	if (spec.task_id !== basename(d)) throw new ProtocolError("bad-spec", `spec.task_id "${spec.task_id}" does not match the task dir "${d}"`);
	// a raw fork source must exist at task-creation time (a context task forks
	// the dispatcher's live session file — a stale ref is a dispatch-time error)
	if (spec.from_session_file !== undefined) {
		let fileOk = false;
		try {
			fileOk = (await stat(spec.from_session_file)).isFile();
		} catch {
			fileOk = false;
		}
		if (!fileOk) throw new ProtocolError("bad-spec", `from_session_file does not exist or is not a file: ${spec.from_session_file}`);
	}
	const root = tasksRoot();
	await mkdir(root, { recursive: true, mode: 0o700 });
	try {
		await mkdir(d, { recursive: false, mode: 0o700 });
	} catch (e: unknown) {
		if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new ProtocolError("exists", `task dir already exists: ${d}`);
		throw e;
	}
	// Post-creation containment re-check, the symlink-aware way: the root itself
	// may contain symlink components (a symlinked $HOME, a test root behind a
	// symlink), so compare against the resolved root — not the lexical path.
	const realRoot = await realpath(root).catch(() => root);
	if ((await realpath(d)) !== join(realRoot, spec.task_id)) {
		await rm(d, { recursive: true, force: true }); // no orphan dir on a failed re-check
		throw new ProtocolError("bad-path", `task dir escaped the tasks root: ${d}`);
	}
	await atomicWriteFile(join(d, "spec.json"), `${JSON.stringify(spec, null, 2)}\n`);
	await atomicWriteFile(join(d, "prompt.md"), promptText);
	// The initial `queued` record goes through the same unique-tmp discipline
	// (a hand-off CAS racing the create must not clobber its tmp).
	await atomicWriteFile(join(d, "state.json"), `${JSON.stringify({ state: "queued" }, null, 2)}\n`);
	await appendEvent(d, { event: "created", agent: spec.agent.name, mode: spec.mode, session_name: spec.session_name });
}
