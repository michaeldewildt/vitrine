/**
 * headless.ts — the headless-mode wrapper specifics: the
 * 5-branch worker-exit mapping (branches pinned by test, in
 * order). Headless has no focus poll, no title, no ppid backstop, no
 * auto-settle (its completion path is the process exit), and no keep-alive
 * (a headless tile never exists).
 */
import { stat } from "node:fs/promises";
import { join } from "node:path";
import * as P from "../protocol";
import { lastAssistantText, lastMessageKind, parseSessionEntries } from "../session";
import type { ExitCtx, WrapperOutcome } from "./lifecycle";

/**
 * The headless exit mapping (branches pinned by test, in order):
 * 1. marker present ⇒ `completed` with the marker's source (rule 1 —
 *    including a worker that called `vitrine_done` under `--print` before
 *    exiting; a racing marker at the exit is caught here);
 * 2. `kill_requested` / signal intent ⇒ `killed`;
 * 3. clean exit 0 + last session entry an idle-assistant ⇒ harvest
 *    (result.md ONLY IF ABSENT — a racing `vitrine_done` result wins) ⇒
 *    `done.marker` (source `headless-exit`) ⇒ `completed`;
 * 4. clean exit 0 with no/other last entry ⇒ `crashed`/`headless-exit-
 *    empty-turn`, NO marker, partial harvest (a broken turn is never a
 *    silent success);
 * 5. clean non-zero ⇒ `failed`/`headless-exit <code>` (headless-only);
 *    signal-killed ⇒ `crashed`/`signal-…`.
 */
export async function headlessWorkerExit(c: ExitCtx): Promise<WrapperOutcome> {
	const exit = c.getExit()!;
	// Re-check the marker at the exit: a racing `vitrine_done` can land
	// between the tick's read and the exit (rule 1 wins).
	const markerAtExit = await P.readDoneMarker(c.d).catch(() => null);
	if (markerAtExit !== null) {
		await c.appendEvent({ event: "worker-exit", code: exit.code, signal: exit.signal, error: exit.error });
		await c.appendEvent({ event: "marker-observed", source: markerAtExit.source });
		await c.settle("completed", markerAtExit.source, exit);
		await c.killWorkerGraceful(); // hang-after-done ⇒ SIGTERM
		return "completed";
	}
	const wasKilled = (await P.killRequested(c.d).catch(() => false)) || c.signalIntent() !== null;
	if (wasKilled) {
		await c.appendEvent({ event: "worker-exit", code: exit.code, signal: exit.signal, error: exit.error });
		await c.partialHarvest();
		await c.settle("killed", c.signalIntent() !== null ? `signal-${c.signalIntent()}` : "kill_requested", exit);
		return "killed";
	}
	if (exit.code === 0) {
		// Content gate: a headless success requires the last session
		// entry to be an idle-assistant (the turn actually ended — a mid-turn
		// error that still exits 0 is a crash, never a silent success).
		const sFile = c.sessionFile();
		const parsed = sFile !== null ? await parseSessionEntries(sFile).catch(() => null) : null;
		const idle = parsed !== null && lastMessageKind(parsed.entries) === "idle-assistant";
		if (idle) {
			const harvested = lastAssistantText(parsed!.entries) ?? "(no assistant text harvested)";
			// result.md only if absent: a racing vitrine_done's result wins
			// (it wrote it before its marker — which the marker re-check
			// above would have caught).
			const rs = await stat(join(c.d, "result.md")).catch(() => null);
			if (rs === null) await P.writeResult(c.d, harvested);
			let source: P.DoneMarker["source"] = "headless-exit";
			try {
				await P.writeDoneMarker(c.d, "headless-exit");
			} catch (e) {
				if (!(e instanceof P.ProtocolError && e.code === "marker-exists")) throw e;
				const existing = await P.readDoneMarker(c.d);
				source = existing !== null ? existing.source : "headless-exit";
				await c.appendEvent({ event: "marker-observed", source });
			}
			await c.appendEvent({ event: "worker-exit", code: exit.code, signal: exit.signal, error: exit.error });
			await c.settle("completed", source, exit);
			return "completed";
		}
		// Clean exit 0 with no/other last entry — broken turn.
		await c.appendEvent({
			event: "worker-exit",
			code: exit.code,
			signal: exit.signal,
			error: exit.error,
			note: "headless-exit-empty-turn",
		});
		await c.partialHarvest();
		await c.settle("crashed", "headless-exit-empty-turn", exit);
		return "crashed";
	}
	if (exit.signal !== null) {
		// Signal-killed ⇒ crashed (the worker did not finish its turn).
		await c.appendEvent({ event: "worker-exit", code: exit.code, signal: exit.signal, error: exit.error });
		await c.partialHarvest();
		await c.settle("crashed", `signal-${exit.signal}`, exit);
		return "crashed";
	}
	// Clean non-zero ⇒ failed (headless-only): the worker ran, its
	// model/turn pipeline errored, and the exit code says so.
	await c.appendEvent({ event: "worker-exit", code: exit.code, signal: exit.signal, error: exit.error });
	await c.partialHarvest();
	await c.settle("failed", `headless-exit ${exit.code}`, exit);
	return "failed";
}
