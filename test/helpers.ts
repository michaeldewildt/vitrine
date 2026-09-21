/**
 * helpers.ts — the shared test scaffolding: the tmp base + tasks root,
 * the fixture spec/task factory, the timeout-bounded promise, and the
 * events reader.
 *
 * Env is read at CALL time, never at import time: the suites mutate
 * `process.env` per file (HOME / VITRINE_*) and run in one bun process — a
 * helper that snapshotted env at import would see the first suite's values
 * for every later suite.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as P from "../src/protocol";

/** A tmp base dir + the tasks root under it (sets VITRINE_TASKS_ROOT). */
export interface TestBase {
	base: string;
	tasksRoot: string;
	/** afterAll: clears VITRINE_TASKS_ROOT and removes the base. */
	close: () => Promise<void>;
}

export async function makeBase(tag: string): Promise<TestBase> {
	const base = await mkdtemp(join(tmpdir(), `vitrine-${tag}-`));
	const tasksRoot = join(base, "tasks");
	process.env.VITRINE_TASKS_ROOT = tasksRoot;
	return {
		base,
		tasksRoot,
		close: async () => {
			delete process.env.VITRINE_TASKS_ROOT;
			await rm(base, { recursive: true, force: true });
		},
	};
}

/**
 * The standard fixture spec (tile, unattended, generous budgets) + task dir.
 * `cwd` defaults to the tasks root; pass the suite's work dir for
 * session-discovery tests.
 */
export async function makeTask(
	tasksRoot: string,
	over: Partial<P.TaskSpec> = {},
	agent: Partial<P.TaskSpec["agent"]> = {},
	cwd?: string,
): Promise<string> {
	const task_id = P.newTaskId();
	const spec: P.TaskSpec = {
		task_id,
		agent: { name: "test-agent", ...agent },
		dispatcher_session_id: "disp-1",
		cwd: cwd ?? tasksRoot,
		session_id: `vitrine.${task_id}`,
		session_name: `test-agent · ${task_id.slice(0, 8)}`,
		mode: "tile",
		attended: false,
		workspace: 9,
		wall_timeout_s: 3600,
		inactivity_s: 3600,
		auto_settle_s: 3600,
		auto_settle_grace_s: 60,
		created_at: new Date().toISOString(),
		boot_id: "test-boot",
		...over,
	} as P.TaskSpec;
	const dir = join(tasksRoot, task_id);
	await P.createTask(dir, spec, "fixture prompt\n");
	return dir;
}

export const msleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A promise that rejects after `ms` (the suite's hang guard). */
export async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
	return Promise.race([
		p,
		new Promise<never>((_, rej) => {
			const t = setTimeout(() => rej(new Error(`${label} timed out`)), ms);
			t.unref?.();
		}),
	]);
}

export async function eventsOf(dir: string): Promise<Array<Record<string, unknown>>> {
	return (await P.readEvents(dir)) as Array<Record<string, unknown>>;
}
