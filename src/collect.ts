/**
 * collect.ts — the `vitrine_collect` core (R6): the pull floor.
 *
 * The dispatch's push (the watcher's delivery, src/watcher.ts) covers the
 * hands-off flow; collect covers push's edges — an explicit status check, a
 * re-harvest after a human resumed a worker's session, and the diagnosis
 * path if delivery semantics ever misbehave. It answers immediately from
 * disk and NEVER blocks on a worker: a running task gets a status line
 * (state, elapsed, workspace), not a wait.
 *
 * Scope (D6 — global replay, session-scoped collect):
 * - No ids: every task of the calling session PLUS its fork ancestry — the
 *   `session_start { reason: "fork", previousSessionFile }` record (the
 *   pre-fork dispatcher's session ids, resolved by the extension) makes a
 *   fork's no-id collect still find the pre-fork tasks.
 * - Explicit ids: full task ids or the short (8-char) prefix the dispatch
 *   return carries — they cross ANY session boundary.
 *
 * Per task (the fixed wrapper is REUSED, not re-invented — the terminal
 * output is `buildHarvestMessage` over `harvestTask` output, the same
 * cap/overflow as the delivery):
 * - TERMINAL → the full harvest (capped — the 0600 overflow file's path is
 *   named in the body; the sanctioned response to a truncated body is to
 *   read it) + delivery status. A collect that harvests a terminal task
 *   WRITES `harvest-delivered` (a fresh collect-scoped batch id) — the
 *   collect is a delivery to this session's context, so replay and gc treat
 *   the task as delivered (and can retire it).
 * - RUNNING/QUEUED → a status line — no body.
 * - TERMINAL + resumed (the `resumed` event — a human resumed the session
 *   after settlement) → the session's latest output as an advisory note (the
 *   resume commit, R5: never a state change, never a re-delivery).
 *
 * Attended tasks are pull-only (invariant): a no-id collect HEADLINES an
 * in-scope undelivered attended task (the `isUndeliveredAttended` seam —
 * headline, not body) and does not harvest it into the wrapper or mark it
 * delivered — pulling an attended task's harvest is an explicit act (an id).
 * Explicit ids harvest any task, attended or not.
 */
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as P from "./protocol";
import { formatElapsed, shortId } from "./dispatch/spawn";
import { CAP_BYTES_DEFAULT, CAP_LINES_DEFAULT, capToText, harvestTask } from "./dispatch/harvest";
import { lastAssistantText, parseSessionEntries } from "./session";
import { buildHarvestMessage, elapsedOf, isUndeliveredAttended, scanTaskFacts, type DeliveryTask, type HarvestMessage, type TaskFacts } from "./watcher";

// ---------------------------------------------------------------------------
// the surface

export interface CollectOptions {
	/** The calling dispatcher's session id — the session-scoped set key (`spec.dispatcher_session_id`). */
	sessionId: string;
	/** The fork-ancestry session ids (the pre-fork dispatchers, from `session_start { reason: "fork" }`) — a no-id collect still finds their tasks. */
	ancestryIds?: string[];
	/** Explicit task ids (full ids or the short prefix) — they cross any session boundary. */
	ids?: string[];
	/** The injectable clock (default `Date.now`). */
	now?: () => number;
	/** The overflow tmp dir for the caps (default `os.tmpdir()`). */
	tmpDir?: string;
}

/** One collected task (the machine-readable twin of its output section). */
export interface CollectRow {
	id: string;
	agent: string;
	state: P.TaskState;
	reason?: string;
	/** The elapsed segment: settlement duration (terminal) or live age (non-terminal). */
	elapsed?: string;
	/** The task's workspace (the status line). */
	workspace?: number;
	/** The delivery-batch id marking the task delivered — `null` = undelivered. */
	delivered: string | null;
	/** The collect's own batch id, set when THIS collect wrote the marker (a fresh collect-scoped batch id, R6). */
	markedNow?: string;
	/** True when a human resumed the session after settlement (the `resumed` event) — the advisory note rides the wrapper. */
	resumed?: boolean;
}

/** A headlined undelivered attended task (headline, not body). */
export interface CollectHeadline {
	id: string;
	agent: string;
	state: P.TaskState;
}

export interface CollectResult {
	/** One row per task in the considered set (harvested, status-lined, and headlined alike). */
	rows: CollectRow[];
	/** The fixed wrapper over the terminal tasks this collect harvested (null when it harvested none). */
	message: HarvestMessage | null;
	/** The collect's delivery-batch id (the marker's `id` when this collect wrote it; the message's batch id) — anchored to the FIRST existing marker id in the harvested batch when every task was already delivered (a message's membership is reconstructable from disk — details.batch is a batch id some marker carries, never an orphan UUID), and a fresh collect-scoped id when nothing was marked. Null when nothing was harvested. */
	batch: string | null;
	/** The headlined undelivered attended tasks (the no-id scope only — headline, not body). */
	headlined: CollectHeadline[];
	/** The notes: unresolved / ambiguous explicit ids. */
	notes: string[];
	/** The model-facing tool-result text (the pinned shape). */
	text: string;
}

// ---------------------------------------------------------------------------
// the collect

/**
 * Collect vitrine tasks from disk, immediately — never blocking on a worker.
 * See the module header for the scope, the per-task shapes, the
 * harvest-delivered write semantics, and the attended headline rule.
 */
export async function collectTasks(opts: CollectOptions): Promise<CollectResult> {
	const now = opts.now ?? Date.now;
	const tmpDir = opts.tmpDir ?? tmpdir();
	const facts = await scanTaskFacts();
	const ancestry = new Set(opts.ancestryIds ?? []);
	const inScope = (f: TaskFacts): boolean => f.spec.dispatcher_session_id === opts.sessionId || ancestry.has(f.spec.dispatcher_session_id);

	const notes: string[] = [];
	let scope: TaskFacts[];
	const headlineMode: boolean = !(Array.isArray(opts.ids) && opts.ids.length > 0); // no ids → the undelivered attended set is headlined, not harvested
	if (!headlineMode) {
		scope = [];
		const seen = new Set<string>();
		for (const want of opts.ids as string[]) {
			if (typeof want !== "string" || want.trim() === "") continue;
			const exact = facts.find((f) => f.id === want);
			if (exact !== undefined) {
				if (!seen.has(exact.id)) scope.push(exact);
				continue;
			}
			const prefix = facts.filter((f) => f.id.startsWith(want));
			if (prefix.length === 0) notes.push(`${want}: no such task`);
			else if (prefix.length > 1) notes.push(`${want}: ambiguous (${prefix.length} tasks match)`);
			else if (!seen.has(prefix[0].id)) scope.push(prefix[0]);
		}
	} else {
		scope = facts.filter(inScope);
	}

	// The undelivered attended set (headline, not body — the isUndeliveredAttended seam).
	const headlined: CollectHeadline[] = [];
	if (headlineMode) {
		for (const f of scope) {
			if (isUndeliveredAttended(f)) headlined.push({ id: f.id, agent: f.spec.agent.name, state: f.state });
		}
	}
	const headlinedSet = new Set(headlined.map((h) => h.id));

	// The terminal set: harvested into the fixed wrapper. The headlined
	// attended set is excluded (a no-id collect does not pull an attended
	// task's harvest into the context — an explicit id does).
	const terminalSet = scope.filter((f) => P.isTerminal(f.state) && !headlinedSet.has(f.id));
	// The non-terminal set: status lines (never waited on).
	const runningSet = scope.filter((f) => !P.isTerminal(f.state));

	const rows: CollectRow[] = [];
	const bodies: DeliveryTask[] = [];
	// The batch id (R6's write semantics + the reconstructability invariant):
	// the collect's message is ONE delivery batch — every task it marks gets
	// the SAME id. When the batch re-shows already-delivered tasks, the id
	// anchors to the FIRST existing marker in the batch (scan order): a
	// message's membership is reconstructable from disk, and an orphan UUID
	// no marker carries would break it. A fresh UUID is minted only when
	// nothing was marked yet.
	let batch: string | null = terminalSet.map((f) => f.delivered).find((d): d is string => d !== null) ?? null;

	for (const f of terminalSet) {
		const state = await P.readState(f.dir).catch(() => null);
		const el = state !== null ? elapsedOf(state, f.spec) : undefined;
		const h = await harvestTask(f.dir, f.state, { tmpDir });
		// The write semantics (R6): a collect that harvests a terminal task
		// writes `harvest-delivered` — under the batch id anchored above (a
		// fresh collect-scoped id when nothing was marked; the marker is
		// write-once, so a concurrent delivery winning the race between the
		// scan and the write is reported with the winner's id).
		let delivered = f.delivered;
		let markedNow: string | undefined;
		if (delivered === null) {
			batch = batch ?? randomUUID();
			const wrote = await P.writeHarvestDelivered(f.dir, batch);
			if (wrote) {
				markedNow = batch;
				delivered = batch;
			} else {
				delivered = (await P.harvestDeliveredId(f.dir).catch(() => null)) ?? batch;
			}
		}
		// The resume commit (R5): a terminal task a human resumed — the
		// session's latest output rides as an advisory note (never a state
		// change, never a re-delivery — the marker write above is the one
		// collect-scoped delivery, and it is write-once).
		const events = await P.readEvents(f.dir).catch(() => [] as Array<Record<string, unknown>>);
		const resumed = events.some((e) => e.event === "resumed");
		const body: DeliveryTask = {
			id: f.id,
			agent: f.spec.agent.name,
			state: f.state,
			replay: false,
			...(f.reason !== undefined && f.reason !== "" ? { reason: f.reason } : {}),
			...(el !== undefined ? { elapsed: el } : {}),
			...(state !== null && state.finished_at !== undefined ? { settledAt: state.finished_at } : {}),
		};
		if (f.state !== "killed") {
			body.text = h.text;
			if (h.dataText !== undefined) body.dataText = h.dataText;
			if (resumed) body.advisory = await latestSessionOutput(f.dir, f.id, tmpDir);
		}
		bodies.push(body);
		rows.push({
			id: f.id,
			agent: f.spec.agent.name,
			state: f.state,
			...(f.reason !== undefined && f.reason !== "" ? { reason: f.reason } : {}),
			...(el !== undefined ? { elapsed: el } : {}),
			workspace: f.spec.workspace,
			delivered,
			...(markedNow !== undefined ? { markedNow } : {}),
			...(resumed ? { resumed: true } : {}),
		});
	}

	const runningLines: string[] = [];
	let num = bodies.length;
	for (const f of runningSet) {
		num += 1;
		const st = await P.readState(f.dir).catch(() => null);
		const el = liveElapsedOf(st, f.spec, now());
		// The status line: state, elapsed, workspace — NO body, and no wait
		// (the worker's liveness is the wrapper's concern, not the pull's).
		runningLines.push(
			`[${num}] ${f.spec.agent.name} · ${shortId(f.id)} — ${f.state}${f.reason !== undefined && f.reason !== "" ? ` (${f.reason})` : ""}${el !== undefined ? ` · ${el}` : ""} · workspace ${f.spec.workspace}`,
		);
		rows.push({
			id: f.id,
			agent: f.spec.agent.name,
			state: f.state,
			...(f.reason !== undefined && f.reason !== "" ? { reason: f.reason } : {}),
			...(el !== undefined ? { elapsed: el } : {}),
			workspace: f.spec.workspace,
			delivered: f.delivered,
		});
	}
	for (const h of headlined) {
		rows.push({ id: h.id, agent: h.agent, state: h.state, delivered: null });
	}

	const batchId = bodies.length > 0 ? batch ?? randomUUID() : null;
	const message = batchId !== null ? buildHarvestMessage(batchId, bodies) : null;

	// ---- the model-facing text (the pinned shape) --------------------------------
	const scopeLabel = headlineMode ? (ancestry.size > 0 ? `this session + ${ancestry.size} fork ancestor(s)` : "this session") : "explicit ids";
	const lines: string[] = [
		`vitrine collect — ${bodies.length} terminal, ${runningSet.length} running` + (headlined.length > 0 ? `, ${headlined.length} undelivered attended` : "") + ` (scope: ${scopeLabel})`,
	];
	if (message !== null) lines.push(message.content);
	lines.push(...runningLines);
	// The delivery status: one entry per harvested task (marked now, or
	// already delivered — the batch id rides so the membership is
	// reconstructable from disk).
	const deliveryEntries: string[] = [];
	for (const r of rows) {
		if (!P.isTerminal(r.state) || r.delivered === null) continue;
		if (r.markedNow !== undefined) deliveryEntries.push(`${shortId(r.id)} marked (batch ${shortId(r.markedNow)})`);
		else deliveryEntries.push(`${shortId(r.id)} already delivered (batch ${shortId(r.delivered)})`);
	}
	if (deliveryEntries.length > 0) lines.push(`delivery: ${deliveryEntries.join(" · ")}`);
	if (headlined.length > 0) {
		lines.push("", "undelivered attended (pull-only — never pushed, never replayed):");
		for (const h of headlined) {
			lines.push(`- ${shortId(h.id)} ${h.agent} — ${h.state} (pull by id to harvest: vitrine_collect with ids: ["${shortId(h.id)}"])`);
		}
	}
	if (notes.length > 0) {
		lines.push("", "notes:");
		for (const n of notes) lines.push(`- ${n}`);
	}

	return { rows, message, batch: batchId, headlined, notes, text: lines.join("\n") };
}

// ---------------------------------------------------------------------------
// the helpers

/** The live age of a non-terminal task: `now` − `started_at` (or − the spec's `created_at` for a task that never ran). */
function liveElapsedOf(st: P.TaskStateRecord | null, spec: P.TaskSpec, now: number): string | undefined {
	const start = Date.parse(st?.started_at ?? spec.created_at);
	if (!Number.isFinite(start)) return undefined;
	return formatElapsed(Math.max(0, now - start));
}

/**
 * The session's latest output (the resumed-terminal advisory, R5): the last
 * assistant text of the task's session file (the shared lenient parse — a
 * torn last line on a live file is normal), capped with the shared mechanism
 * (the 0600 overflow file's path named in the note). Best-effort: an
 * unreadable session yields the honest note, never a failure.
 */
async function latestSessionOutput(dir: string, id: string, tmpDir: string): Promise<string> {
	const sess = await P.readSession(dir).catch(() => null);
	if (sess === null) return "(no session record — no latest output)";
	// the shared lenient parse (it takes the PATH and reads it itself — a torn
	// last line on a live file is normal and skipped)
	const facts = await parseSessionEntries(sess.session_file).catch(() => null);
	if (facts === null) return `(the session file is not readable: ${sess.session_file})`;
	const last = lastAssistantText(facts.entries);
	if (last === null) return "(the session has no assistant output)";
	return capToText(last, { maxBytes: CAP_BYTES_DEFAULT, maxLines: CAP_LINES_DEFAULT, tmpDir, id, label: "advisory" }).text;
}
