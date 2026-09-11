import { expect, test } from "vitest";
import { formatSkillsForPrompt, SessionManager, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { tokens } from "../../../src/core/api/index.ts";
import { compactText, measuredMemory } from "../../../src/core/render/material.ts";
import { contextComposition, type ContextComposition } from "../../../src/hosts/pi/context-composition.ts";
import { allocateCells, compositionMap, statusBody } from "../../../src/hosts/pi/session-status.ts";
import { host } from "./test-host.ts";

const skills = [{ name: "test", description: "Load test instructions", filePath: "/virtual/test/SKILL.md", baseDir: "/virtual/test", source: "test", disableModelInvocation: false,
  sourceInfo: { path: "/virtual/test", source: "test", scope: "temporary" as const, origin: "top-level" as const } }];
function fixture() {
  const sm = SessionManager.inMemory("/tmp/trace-composition-tests");
  const ctx = { model: { contextWindow: 500000 }, sessionManager: sm, getContextUsage: () => undefined,
    getSystemPrompt: () => "System instructions", getSystemPromptOptions: () => ({ skills }) } as unknown as ExtensionCommandContext;
  const pi = { getActiveTools: () => [], getAllTools: () => [] };
  return { sm, ctx, read: () => contextComposition(ctx, pi) };
}
const material = { knowledge: [{ category: "constraint", text: "[K1@1] Keep the retained knowledge" }],
  facts: ["[F1] A retained fact"], entries: [{ id: 1, view: "[T1#user]: Raw text" }], receipts: ["omitted older history"] };
const measured = measuredMemory(compactText(material), material);
const details = { traceMemory: { composition: measured.composition, supplied: { knowledgeCommitIds: [1] } } };

test("catalog requires one exact actual-system occurrence; hidden/modified/duplicate catalogs stay System", () => {
  const f = fixture(), catalog = formatSkillsForPrompt(skills);
  for (const system of ["prefix" + catalog + "suffix", "prefix", catalog.replace("instructions", "changed"), catalog + catalog]) {
    f.ctx.getSystemPrompt = () => system;
    const result = f.read();
    const matched = system === "prefix" + catalog + "suffix";
    expect(result.amounts.Skills).toBe(matched ? tokens(catalog) : 0);
    expect(result.amounts.System + result.amounts.Skills).toBe(tokens(system));
  }
  f.ctx.getSystemPromptOptions = () => { throw Error("unavailable options"); };
  expect(f.read().complete).toBe(true);
  expect(f.read().amounts.Skills).toBe(0);
});

test("retained occurrences count repeatedly, independent of carrier IDs, database, project or enrollment", () => {
  const f = fixture();
  f.sm.appendCustomMessageEntry("trace-memory", measured.text, false, details);
  const first = f.read();
  f.sm.appendCustomMessageEntry("trace-memory", measured.text, false, details);
  const second = f.read();
  expect(second.amounts.Memory).toBe(first.amounts.Memory * 2);
  for (const key of Object.keys(first.memory) as (keyof typeof first.memory)[])
    expect(second.memory[key]).toBe(first.memory[key] * 2);
  expect(first.memory.Unclassified).toBeGreaterThan(0); // titles/receipts are not forced into Raw
  expect(Object.values(second.memory).reduce((sum, n) => sum + n, 0)).toBe(second.amounts.Memory);
});

test("old and invalid carriers are wholly Unclassified, never parsed from headings or identity arrays", () => {
  for (const metadata of [undefined, { traceMemory: { supplied: details.traceMemory.supplied } }, details,
    { traceMemory: { composition: { ...measured.composition, raw: -1 } } },
    { traceMemory: { composition: { ...measured.composition, facts: Infinity } } },
    { traceMemory: { composition: { ...measured.composition, knowledge: 99999999 } } }]) {
    const f = fixture();
    f.sm.appendCustomMessageEntry("trace-memory", measured.text + (metadata === details ? " changed body" : ""), false, metadata);
    const value = f.read();
    expect(value.memory.Unclassified).toBe(value.amounts.Memory);
    expect(value.memory.Knowledge + value.memory.Facts + value.memory.Raw).toBe(0);
  }
});

test("actual retained compact/tree ancestry drives capacity; native summary is Conversation", () => {
  const f = fixture();
  const discarded = f.sm.appendMessage({ role: "user", content: "discarded".repeat(100), timestamp: 1 });
  const kept = f.sm.appendMessage({ role: "user", content: "kept", timestamp: 2 });
  const before = f.read();
  const compact = f.sm.appendCompaction(measured.text, kept, 10000, details, true);
  expect(f.read().amounts.Conversation).toBe(tokens("kept"));
  expect(f.read().memory.Knowledge).toBe(measured.composition.knowledge);
  f.sm.appendCompaction("native", "", 10000);
  expect(f.read().amounts.Memory).toBe(0);
  expect(f.read().amounts.Conversation).toBeGreaterThan(tokens("native"));
  f.sm.branch(compact);
  expect(f.read().memory.Knowledge).toBe(measured.composition.knowledge);
  f.sm.branch(discarded);
  expect(f.read().amounts.Memory).toBe(0);
  expect(f.read().amounts.Conversation).toBe(before.amounts.Conversation - tokens("kept"));
});

test("loaded SKILL.md/reference content and pasted tags stay Conversation; excluded bash is absent", () => {
  const f = fixture();
  f.sm.appendMessage({ role: "toolResult", toolCallId: "read", toolName: "read", content: [{ type: "text", text: "SKILL.md body <knowledge>fake</knowledge>" }], isError: false, timestamp: 1 });
  f.sm.appendMessage({ role: "user", content: '<skill name="test">reference</skill>', timestamp: 2 });
  const before = f.read();
  f.sm.appendMessage({ role: "bashExecution", command: "private", output: "secret", cancelled: false, truncated: false, exitCode: 0, excludeFromContext: true, timestamp: 3 });
  expect(f.read()).toEqual(before);
  expect(before.amounts.Memory + before.amounts.Skills).toBe(0);
  expect(before.amounts.Conversation).toBeGreaterThan(0);
});

test("reported totals never rescale measured categories; unknown gap, missing APIs and non-text remain honest", () => {
  const f = fixture(), baseline = f.read();
  f.ctx.getContextUsage = () => ({ tokens: 10000, contextWindow: 500000, percent: 2 });
  expect(f.read().amounts.System).toBe(baseline.amounts.System);
  expect(f.read().amounts.Unknown).toBe(10000 - baseline.total);
  f.ctx.getContextUsage = () => ({ tokens: 0, contextWindow: 500000, percent: 0 });
  expect(f.read().total).toBe(baseline.total);
  f.ctx.getSystemPrompt = () => { throw Error("unavailable"); };
  expect(f.read().complete).toBe(false);
  expect(compositionMap(f.read(), "test", 80).join("\n")).toContain("free unknown");
  expect(compositionMap(f.read(), "test", 80).join("\n")).not.toContain("Free ~");
});

test("only active tool schemas count; image capacity is not fabricated from base64", () => {
  const f = fixture();
  const tool = { name: "read", description: "Read", parameters: { type: "object", properties: {} },
    sourceInfo: skills[0]!.sourceInfo };
  const measured = contextComposition(f.ctx, { getActiveTools: () => ["read"], getAllTools: () => [tool, { ...tool, name: "inactive" }] });
  expect(measured.amounts.Tools).toBe(tokens(JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters })));
  f.sm.appendMessage({ role: "user", content: [{ type: "image", data: "a".repeat(1000), mimeType: "image/png" }], timestamp: 1 });
  expect(f.read().complete).toBe(false);
  expect(f.read().amounts.Conversation).toBe(0);
});

test("sub-percent legends never round a nonzero item to zero or up to one percent", () => {
  const f = fixture(), value = f.read();
  value.amounts.System = 4900; value.amounts.Memory = 100000;
  value.memory = { Knowledge: 99999, Facts: 1, Raw: 0, Unclassified: 0 };
  value.total = 104900;
  const lines = compositionMap(value, "test", 80).join("\n");
  expect(lines).toContain("System ~4.9k (<1%)");
  expect(lines).toContain("Facts 1 (<0.1%)");
});

test("shared rounding gives 100 cells without tiny-category minimums; zero and overcapacity are safe", () => {
  expect(allocateCells([800, 300, 498900], 100)).toEqual([0, 0, 100]);
  expect(allocateCells([0, 0, 0], 100)).toEqual([0, 0, 0]);
  expect(allocateCells([12, 6, 6], 40)).toEqual([20, 10, 10]);
  for (let count = 1; count < 100; count++) {
    const values = Array.from({ length: count }, (_, i) => i * 0.7 + 0.1);
    expect(allocateCells(values, 100).reduce((sum, n) => sum + n, 0)).toBe(100);
  }
  const f = fixture(); f.ctx.getSystemPrompt = () => "";
  expect(compositionMap(f.read(), "test", 40).slice(0, 5).join("")).toBe("⛶".repeat(100));
  f.sm.appendCustomMessageEntry("trace-memory", "raw ".repeat(100), false);
  f.ctx.model!.contextWindow = 1;
  const lines = compositionMap(f.read(), "test", 40);
  expect(lines.slice(0, 5).join("")).toBe("⛁".repeat(100));
  expect(lines.join("\n")).not.toContain("Free ~");
});

test.each([1, 20, 40, 80, 100])("composition and single continuous Memory bar fit %i columns", width => {
  const value: ContextComposition = { amounts: { System: 800, Skills: 300, Tools: 0, Memory: 24000, Conversation: 0, Other: 0, Unknown: 0 },
    memory: { Knowledge: 12000, Facts: 6000, Raw: 6000, Unclassified: 0 }, window: 500000, total: 25100, complete: true };
  const paint = (color: string, text: string) => `\x1b[${color === "syntaxKeyword" ? 31 : color === "syntaxString" ? 32 : 33}m${text}\x1b[39m`;
  const lines = compositionMap(value, "fake/test", width, paint);
  const rendered = statusBody(lines, width);
  expect(rendered.split("\n").every(line => visibleWidth(line) <= width)).toBe(true);
  expect(lines.join("\n")).toContain("System ~800 (0.2%)");
  expect(lines.join("\n")).toContain("Skill catalog ~300 (<0.1%)");
  const title = lines.findIndex(line => line === "Memory ~24k");
  expect(stripTerminalSequences(lines[title + 1]!)).toBe("█".repeat(Math.min(60, width)));
  expect(stripTerminalSequences(lines[title + 2]!)).toBe("⛁ Knowledge 12k  ⛁ Facts 6k  ⛁ Raw 6k");
  if (width >= 40) expect(rendered).toMatchSnapshot();
});

test("initial and on/project supplement carriers share assembly measurement; retained old project stays Memory", async () => {
  const h = host({ "noting.triggerTokens": 999999, "consolidation.triggerTokens": 999999 });
  try {
    await h.turn();
    const store = h.memory.store;
    const noted = store.commitNotingRun({ run: { kind: "manual", sessionId: 1, createdAt: "test" }, facts: [
      { turnId: 1, category: "decision", actor: "user", text: "Rule", source: ["T1#user"], createdAt: "test" },
    ] });
    if (!noted.ok) throw Error(noted.problems.join());
    const messages: any[] = [];
    for (const [i, command] of ["", "on", "project changed-project"].entries()) {
      const result = store.commitConsolidationRun({ run: { kind: "manual", sessionId: 1, createdAt: "test" }, operations: [
        { op: "create", handle: "$1", author: "test", text: `Rule ${i}`, category: "constraint", scope: i ? "global" : "project",
          supports: [noted.facts[0]!.id], topics: [], reason: "new rule", createdAt: "test" },
      ] });
      expect(result.ok).toBe(true);
      if (command) await h.commands.get("trace").handler(command, h.ctx);
      const supplied = (await h.prompt("next"))!.message;
      const composition = supplied.details.traceMemory.composition;
      expect(composition.knowledge).toBeGreaterThan(0);
      expect(composition.facts + composition.raw).toBe(0);
      expect(Object.keys(composition).sort()).toEqual(["bodyHash", "facts", "knowledge", "raw"]);
      messages.push(supplied);
      await h.answer();
    }
    const value = contextComposition(h.ctx, { getActiveTools: () => [], getAllTools: () => [] });
    expect(value.amounts.Memory).toBe(messages.reduce((sum, m) => sum + tokens(m.content), 0));
    expect(value.memory.Knowledge).toBe(messages.reduce((sum, m) => sum + m.details.traceMemory.composition.knowledge, 0));
    const compact = (await h.emit("session_before_compact", { preparation: { tokensBefore: 10000 } }))!.compaction;
    expect(compact.details.traceMemory.composition.bodyHash).toHaveLength(64);
    expect(compact.details.traceMemory.composition.knowledge).toBeGreaterThan(0);
    expect(compact.details.traceMemory.composition.raw).toBeGreaterThan(0);
    expect(h.requests).toEqual([]);
  } finally { await h.dispose(); }
});
