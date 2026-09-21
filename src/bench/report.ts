/**
 * report.ts — the bench report (pure): rows → table text (and JSON dump).
 * No IO — the sinks are strings; the driver and the CLI decide where they go.
 */
import type { BenchRow, Medians, MedianKey } from "./collector";

/** Format a millisecond duration for a table cell. */
export function fmtMs(v: number | null): string {
	if (v === null) return "-";
	if (Math.abs(v) < 1000) return `${Math.round(v)}ms`;
	return `${(v / 1000).toFixed(2)}s`;
}

type Col = [string, (r: BenchRow) => string];

const COLS: Col[] = [
	["task", (r) => r.task_id.slice(0, 8)],
	["agent", (r) => r.agent ?? "-"],
	["state", (r) => r.state ?? "-"],
	["queue", (r) => fmtMs(r.queue_ms)],
	["boot", (r) => fmtMs(r.boot_ms)],
	["work", (r) => fmtMs(r.work_ms)],
	["poll", (r) => fmtMs(r.poll_ms)],
	["settle", (r) => fmtMs(r.settle_ms)],
	["e2e", (r) => fmtMs(r.e2e_ms)],
	["harness", (r) => (r.harness_ratio === null ? "-" : `${Math.round(r.harness_ratio * 100)}%`)],
	["tok/s", (r) => (r.tokens_per_s === null ? "-" : r.tokens_per_s.toFixed(1))],
	["cost$", (r) => (r.cost_usd === null ? "-" : `$${r.cost_usd.toFixed(4)}`)],
];

/** Rows → a fixed-width table (header + one line per row). */
export function renderTable(rows: BenchRow[]): string[] {
	const cells = rows.map((r) => COLS.map(([, f]) => f(r)));
	const widths = COLS.map(([h], i) => Math.max(h.length, ...cells.map((c) => c[i].length)));
	const line = (vals: string[]): string => vals.map((v, i) => v.padEnd(widths[i])).join("  ").trimEnd();
	const out = [line(COLS.map(([h]) => h))];
	for (let i = 0; i < rows.length; i++) out.push(line(cells[i]));
	return out;
}

const MEDIAN_ORDER: Array<{ key: MedianKey; label: string; fmt: (v: number) => string }> = [
	{ key: "queue_ms", label: "queue", fmt: fmtMs },
	{ key: "boot_ms", label: "boot", fmt: fmtMs },
	{ key: "work_ms", label: "work", fmt: fmtMs },
	{ key: "poll_ms", label: "poll", fmt: fmtMs },
	{ key: "settle_ms", label: "settle", fmt: fmtMs },
	{ key: "e2e_ms", label: "e2e", fmt: fmtMs },
	{ key: "harness_ratio", label: "harness", fmt: (v) => `${Math.round(v * 100)}%` },
	{ key: "tokens_per_s", label: "tok/s", fmt: (v) => v.toFixed(1) },
	{ key: "cost_usd", label: "cost", fmt: (v) => `$${v.toFixed(4)}` },
];

/** Medians → one compact line: `queue 5ms · boot 1.20s · …`. */
export function renderMedians(medians: Medians): string {
	return MEDIAN_ORDER.map(({ key, label, fmt }) => {
		const v = medians[key];
		return `${label} ${v === null ? "-" : fmt(v)}`;
	}).join(" · ");
}

/** Rows → a pretty JSON dump (the `--json` payload is the full record). */
export function toJson(rows: BenchRow[]): string {
	return JSON.stringify(rows, null, 2);
}
