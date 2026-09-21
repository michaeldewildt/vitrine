/**
 * done-render.test.ts — the `vitrine_done` TUI renderers (, v1.14).
 * Hermetic: stub component factories (no pi, no TUI, no mocking) — the
 * renderer is pure by construction (see src/done-render.ts). The stub theme
 * returns plain text, so assertions are on the exact rendered strings.
 */
import { describe, expect, it } from "bun:test";
import { makeDoneRenderers, type DoneRenderDeps } from "./done-render";
import type { RenderTheme, ToolRenderOptions } from "@earendil-works/pi-coding-agent";
	interface StubComponent { kind: "text" | "container" | "markdown";
	text?: string;
	children?: StubComponent[];
	render(width: number): string[];
}
	interface StubLog { texts: string[];
	markdowns: string[];
	themeCalls: number;
}
	function makeStubs(): { deps: DoneRenderDeps;
log: StubLog }
		{ const log: StubLog = { texts: []
		, markdowns: []
	, themeCalls: 0 };
		const deps: DoneRenderDeps = { text: (content) => {
			log.texts.push(content);
				return { kind: "text", text: content, render: () => [content]
			};
		}
		, container: (children) => {
			const kids = children as StubComponent[];
			return { kind: "container", children: kids, render: () => kids.flatMap((c) => c.render(80)) };
		}
		, markdown: (text) => {
			log.markdowns.push(text);
				return { kind: "markdown", text, render: () => [`md:${text}`]
			};
		}
		, markdownTheme: () => {
			log.themeCalls += 1;
			return { stub: "markdown-theme" };
		}
	, };
	return { deps, log };
}
/** A stub pi theme: plain text, no ANSI. */
const theme: RenderTheme = { fg: (_color, text) => text, bold: (text) => text,
};
const NOT_EXPANDED: ToolRenderOptions = { expanded: false, isPartial: false };
const EXPANDED: ToolRenderOptions = { expanded: true, isPartial: false };
describe("renderCall (the call slot is a one-line header)", () => {
	it("shows the tool name + the answer length", () => {
		const { deps }
		= makeStubs();
		const { renderCall }
		= makeDoneRenderers(deps);
		const comp = renderCall({ answer: "abc" }
		, theme) as StubComponent;
		expect(comp.kind).toBe("text");
		expect(comp.text).toBe("vitrine_done final answer (3 chars)");
	});
	it("a missing/blank argument: header without a count", () => {
		const { deps }
		= makeStubs();
		const { renderCall }
		= makeDoneRenderers(deps);
		expect((renderCall({}
		, theme) as StubComponent).text).toBe("vitrine_done final answer");
		expect((renderCall({ answer: 42 }
		, theme) as StubComponent).text).toBe("vitrine_done final answer");
	});
});
describe("renderResult (the result slot shows the answer as markdown)", () => {
	it("isPartial: a recording indicator, nothing else", () => {
		const { deps, log }
		= makeStubs();
		const { renderResult }
		= makeDoneRenderers(deps);
			const comp = renderResult( { content: []
			, details: { answer: "x" }
		}
		, { expanded: false, isPartial: true }
		, theme, ) as StubComponent;
		expect(comp.kind).toBe("text");
		expect(comp.text).toBe("recording answer…");
		expect(log.markdowns).toHaveLength(0);
	});
	it("an error result: an error line, no markdown", () => {
		const { deps, log }
		= makeStubs();
		const { renderResult }
		= makeDoneRenderers(deps);
			const comp = renderResult({ content: []
		, details: undefined, isError: true }
		, NOT_EXPANDED, theme) as StubComponent;
		expect(comp.kind).toBe("text");
		expect(comp.text).toContain("not recorded");
		expect(log.markdowns).toHaveLength(0);
	});
	it("details.error (pi's wrapped throw): an error line", () => {
		const { deps }
		= makeStubs();
		const { renderResult }
		= makeDoneRenderers(deps);
			const comp = renderResult( { content: []
			, details: { error: "ENOENT" }
		, isError: false }
		, NOT_EXPANDED, theme, ) as StubComponent;
		expect(comp.kind).toBe("text");
		expect(comp.text).toContain("not recorded");
	});
	it("no/empty answer: a warning line, no markdown", () => {
		const { deps, log }
		= makeStubs();
		const { renderResult }
		= makeDoneRenderers(deps);
		for (const details of [undefined, null, {}
		, { answer: "" }
		, { answer: " " }
		, { answer: 42 }
		])
		{
				const comp = renderResult({ content: []
			, details }
			, NOT_EXPANDED, theme) as StubComponent;
			expect(comp.kind).toBe("text");
			expect(comp.text).toBe("no answer recorded (empty)");
		}
		expect(log.markdowns).toHaveLength(0);
	});
	it("the recorded answer is shown as markdown, verbatim, with a header", () => {
		const answer = "# Report\n\n- one\n- **two**\n";
		const { deps, log }
		= makeStubs();
		const { renderResult }
		= makeDoneRenderers(deps);
			const comp = renderResult({ content: [{ type: "text", text: "Done." }
			]
			, details: { answer }
		}
		, NOT_EXPANDED, theme) as StubComponent;
		expect(comp.kind).toBe("container");
		expect(comp.children).toHaveLength(2);
		expect(comp.children![0]
		.kind).toBe("text");
		expect(comp.children![0]
		.text).toBe(`✓ answer recorded (${answer.length} chars)`);
		expect(comp.children![1]
		.kind).toBe("markdown");
		expect(comp.children![1]
		.text).toBe(answer);
		// verbatim — the recorded text, not a reformulation
		expect(log.markdowns).toEqual([answer])
		;
		expect(log.themeCalls).toBe(1);

		// the full body renders in the row
		expect(comp.render(80).join("\n")).toContain(`md:${answer}`.split("\n")[0])
		;
		});
		it("`expanded` is ignored — the answer is shown either way (v1.14 decision)", () => {
			const { deps }
			= makeStubs();
			const { renderResult }
			= makeDoneRenderers(deps);
			const details = { answer: "the answer" };
				const collapsed = renderResult({ content: []
			, details }
			, NOT_EXPANDED, theme);
				const expanded = renderResult({ content: []
			, details }
			, EXPANDED, theme);
			expect((collapsed as StubComponent).render(80)).toEqual((expanded as StubComponent).render(80));
		});
		it("dataRecorded: a one-line note between the header and the answer (no note when unset)", () => {
			const { deps }
			= makeStubs();
			const { renderResult }
			= makeDoneRenderers(deps);
			const withData = renderResult({ content: []
			, details: { answer: "the answer", dataRecorded: true } }
			, NOT_EXPANDED, theme) as StubComponent;
			expect(withData.kind).toBe("container");
			expect(withData.children).toHaveLength(3);
			expect(withData.children![1]
			.kind).toBe("text");
			expect(withData.children![1]
			.text).toBe("✓ data recorded (result.json)");
			expect(withData.children![2]
			.kind).toBe("markdown");
			// unset: the note is absent — the no-data shape is unchanged
			const without = renderResult({ content: []
			, details: { answer: "the answer" } }
			, NOT_EXPANDED, theme) as StubComponent;
			expect(without.children).toHaveLength(2);
		});

	});

