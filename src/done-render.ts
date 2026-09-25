/**
 * done-render.ts — the `vitrine_done` TUI renderers (v1.14).
 *
 * The worker's final output is shown nicely formatted IN THE WORKER: the
 * completed tile is kept open so the human can read it, and the
 * default rendering would bury the answer in the escaped-JSON tool argument.
 * These renderers turn the tool row into a clean call header + the recorded
 * answer as markdown (pi-tui `Markdown`, syntax highlighted).
 *
 * Master-side surfaces are deliberately untouched: the dispatcher never
 * registers `vitrine_done` (worker mode only), and the harvest reads
 * result.md / the session, never the TUI.
 *
 * Pure by construction: the pi-tui component factories and the markdown
 * theme provider are INJECTED (vitrine.ts wires the real ones). That keeps
 * this module free of pi-package imports — the specifiers resolve only
 * under pi's extension loader (jiti), and the tests drive the renderer with
 * stub components (bun 1.4.2 mock.module covers the wiring in
 * vitrine.test.ts; nothing here needs mocking).
 */
import type { RenderTheme, ToolRenderOptions, TuiComponent } from "@earendil-works/pi-coding-agent";

/** The `details` payload `vitrine_done` attaches to its tool result — persisted
 * in the session record, so the row re-renders from it on resume/re-render. */
export interface DoneToolDetails {
	/** The recorded answer — the exact text written to result.md. */
	answer: string;
	/** True when the typed data payload was recorded to result.json (the typed harvest). */
	dataRecorded?: boolean;
}

/** The component factories the renderer needs (vitrine.ts wires pi-tui +
 * `getMarkdownTheme()`; tests wire stubs). */
export interface DoneRenderDeps {
	/** A plain-text component (pi-tui `Text`). */
	text(content: string, padX: number, padY: number): TuiComponent;
	/** A vertical group (pi-tui `Container`). */
	container(children: TuiComponent[]): TuiComponent;
	/** A markdown component (pi-tui `Markdown`; theme from `markdownTheme()`). */
	markdown(text: string, padX: number, padY: number, theme: unknown): TuiComponent;
	/** The active markdown theme (pi-coding-agent `getMarkdownTheme()`). */
	markdownTheme(): unknown;
}

const PAD = 0;

/** The recorded answer from a tool result's `details`, or null when absent/blank. */
function answerOf(details: unknown): string | null {
	if (typeof details !== "object" || details === null) return null;
	const a = (details as { answer?: unknown }).answer;
	return typeof a === "string" && a.trim() !== "" ? a : null;
}

/** Whether the result's `details` mark the typed data payload as recorded. */
function dataRecordedOf(details: unknown): boolean {
	if (typeof details !== "object" || details === null) return false;
	return (details as { dataRecorded?: unknown }).dataRecorded === true;
}

/** The `vitrine_done` renderCall/renderResult pair (v1.14). */
export function makeDoneRenderers(deps: DoneRenderDeps) {
	/**
	 * Call slot: a one-line header. The default rendering would show the
	 * escaped-JSON `answer` argument (potentially large) — the result slot
	 * carries the answer as markdown, so the call slot stays compact.
	 */
	function renderCall(args: Record<string, unknown>, theme: RenderTheme): TuiComponent {
		const answer = typeof args.answer === "string" ? args.answer : "";
		const label = answer.length > 0 ? `final answer (${answer.length} chars)` : "final answer";
		return deps.text(theme.fg("toolTitle", theme.bold("vitrine_done ")) + theme.fg("dim", label), PAD, PAD);
	}

	/**
	 * Result slot: the recorded answer, SHOWN as markdown.
	 *
	 * `expanded` is deliberately IGNORED: the answer is the worker's
	 * deliverable and the tile is kept open so the human can read it — it is shown, not a log dump behind a toggle.
	 */
	function renderResult(
		result: { content?: unknown[]; details?: unknown; isError?: boolean },
		{ isPartial }: ToolRenderOptions,
		theme: RenderTheme,
	): TuiComponent {
		if (isPartial) return deps.text(theme.fg("warning", "recording answer…"), PAD, PAD);
		const detailsIsError =
			typeof result.details === "object" && result.details !== null && "error" in (result.details as object);
		if (result.isError === true || detailsIsError) {
			return deps.text(theme.fg("error", "the answer was not recorded — see the error"), PAD, PAD);
		}
		const answer = answerOf(result.details);
		if (answer === null) return deps.text(theme.fg("warning", "no answer recorded (empty)"), PAD, PAD);
		const header = deps.text(theme.fg("success", `✓ answer recorded (${answer.length} chars)`), PAD, PAD);
		// the typed-harvest note — one line, only when data was recorded
		const dataNote = dataRecordedOf(result.details) ? deps.text(theme.fg("success", "✓ data recorded (result.json)"), PAD, PAD) : null;
		const body = deps.markdown(answer, PAD, PAD, deps.markdownTheme());
		return deps.container(dataNote === null ? [header, body] : [header, dataNote, body]);
	}

	return { renderCall, renderResult };
}
