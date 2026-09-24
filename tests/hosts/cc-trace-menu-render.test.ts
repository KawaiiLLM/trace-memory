import { describe, expect, it } from "vitest";
import { TRACE_MENU_FIXTURE } from "../../src/hosts/trace-menu.ts";
import { buildCcContextSection, renderTraceMenu, renderTraceMenuText, type CcContextBreakdown } from "../../src/hosts/cc/trace-menu-render.ts";

const breakdown: CcContextBreakdown = {
  model: "claude-sonnet-5", totalTokens: 2500, maxTokens: 10000, percentage: 25,
  terminalWidth: 60, categories: [
    { name: "System prompt", tokens: 500, color: "inactive", kind: "used" },
    { name: "Messages", tokens: 2000, color: "purple_FOR_SUBAGENTS_ONLY", kind: "used" },
    { name: "Free space", tokens: 7500, color: "promptBorder", kind: "free" },
  ],
};

describe("Claude Code local menu rendering", () => {
  it("splits confirmed retained carriers from SDK Messages and keeps the total", () => {
    const section = buildCcContextSection(breakdown, { knowledge: 200, facts: 100, raw: 50, unclassified: 0 }, 1000)!;
    expect(section.legend.find(row => row.label === "Knowledge")?.tokens).toBe(400);
    expect(section.legend.find(row => row.label === "Facts")?.tokens).toBe(200);
    expect(section.legend.find(row => row.label === "Raw")?.tokens).toBe(100);
    expect(section.legend.find(row => row.label === "Messages")?.tokens).toBe(1300);
    expect(section.legend.filter(row => row.label === "Memory, unclassified")).toHaveLength(0);
    expect(section.gridRows.every(row => row.length === 5)).toBe(true);
  });
  it("never invents a split without a Messages denominator or exact presence", () => {
    const noMessages = { ...breakdown, categories: breakdown.categories.filter(row => row.name !== "Messages") };
    expect(buildCcContextSection(noMessages, { knowledge: 1, facts: 0, raw: 0, unclassified: 0 }, 1)?.memoryUnavailable).toContain("unavailable");
    const section = buildCcContextSection(breakdown, undefined, undefined)!;
    expect(section.legend.find(row => row.label === "Messages")?.tokens).toBe(2000);
    expect(section.memoryUnavailable).toContain("unavailable");
  });
  it("returns checkable headless text even without context usage", () => {
    const text = renderTraceMenuText(renderTraceMenu(TRACE_MENU_FIXTURE, {}));
    expect(text).toContain("Trace Memory · S3");
    expect(text).toContain("unavailable — see the built-in /context");
    expect(text).toContain("Pending / trigger");
    expect(text).toContain("Catch up");
  });
});
