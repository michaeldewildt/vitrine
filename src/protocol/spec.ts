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
	from_task_id?: string;
	/** Raw session file to fork — `context` tasks fork the dispatcher's own live session file, which lives in no task dir. Mutually exclusive with `from_task_id`. */
	from_session_file?: string;
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
	{ key: "from_task_id", msg: "from_task_id must be a lowercase uuidv4", pred: uuid, optional: true },
	{ key: "from_session_file", msg: "from_session_file must be a non-empty string", pred: nonEmpty, optional: true },
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
