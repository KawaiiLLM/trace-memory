import { expect, test } from "vitest";
import { formatSkillsForPrompt, SessionManager, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { memoryBodyHash, tokens } from "../../../src/core/api/index.ts";
import { tracePage } from "../../trace-pages.ts";
import { compactText, measuredMemory } from "../../../src/core/render/material.ts";
import { contextComposition, type ContextComposition } from "../../../src/hosts/pi/context-composition.ts";
import { allocateCells, compositionMap, statusBody } from "../../../src/hosts/pi/session-status.ts";
import { host } from "./test-host.ts";

// Exercise the installed native builder as an oracle; production uses only public APIs.
const { buildSystemPrompt } = await import(new URL("core/system-prompt.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);

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

test.each([undefined, ["read"], ["bash"], ["bash", "read"], [], ["edit"], ["powershell"]].map(selectedTools => ({ selectedTools })))("catalog follows Pi selectedTools $selectedTools", ({ selectedTools }) => {
  const f = fixture();
  const options = { cwd: "/virtual", skills, selectedTools };
  f.ctx.getSystemPromptOptions = () => options;
  const system = buildSystemPrompt(options);
  f.ctx.getSystemPrompt = () => system;
  const expected = selectedTools === undefined || selectedTools.includes("read") ? formatSkillsForPrompt(skills, "read")
    : selectedTools.includes("bash") ? formatSkillsForPrompt(skills, "bash") : "";
  expect(f.read().amounts.Skills).toBe(tokens(expected));
  expect(f.read().amounts.System + f.read().amounts.Skills).toBe(tokens(system));
  // A stale or edited prompt must not be deducted using the other reader's wording.
  if (expected) {
    f.ctx.getSystemPrompt = () => formatSkillsForPrompt(skills, expected.includes("Use bash") ? "read" : "bash");
    expect(f.read().amounts.Skills).toBe(0);
  }
});

test.each([0.5, -1, Number.MAX_SAFE_INTEGER + 1, undefined, NaN, Infinity, -Infinity, "1", null])("malformed composition value %s rejects the entire carrier", invalid => {
  for (const key of ["knowledge", "facts", "raw"]) {
    const f = fixture();
    f.sm.appendCustomMessageEntry("trace-memory", measured.text, false, {
      traceMemory: { composition: { ...measured.composition, [key]: invalid } },
    });
    const value = f.read();
    expect(value.memory).toEqual({ Knowledge: 0, Facts: 0, Raw: 0, Unclassified: value.amounts.Memory });
  }
});

test("zero composition parts are valid; their sum cannot exceed the body", () => {
  const f = fixture();
  f.sm.appendCustomMessageEntry("trace-memory", measured.text, false, {
    traceMemory: { composition: { ...measured.composition, facts: 0, raw: 0 } },
  });
  expect(f.read().memory.Knowledge).toBe(measured.composition.knowledge);
  const g = fixture();
  g.sm.appendCustomMessageEntry("trace-memory", measured.text, false, {
    traceMemory: { composition: { ...measured.composition, knowledge: tokens(measured.text), facts: 1, raw: 0 } },
  });
  expect(g.read().memory.Unclassified).toBe(g.read().amounts.Memory);
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

test("SDK occupancy remains separate from measured text and an incomplete local census", () => {
  const f = fixture(), baseline = f.read();
  f.ctx.getContextUsage = () => ({ tokens: 10000, contextWindow: 500000, percent: 2 });
  let value = f.read();
  expect(value.amounts.System).toBe(baseline.amounts.System);
  expect(value.total).toBe(baseline.total);
  expect(value.sdkDifference).toBe(10000 - baseline.total);

  f.ctx.getSystemPrompt = () => "x".repeat(407_300); // about 58.2k local text, matching the report shape
  f.sm.appendMessage({ role: "user", content: [
    { type: "text", text: "measured text remains classified" },
    { type: "image", data: "a".repeat(1000), mimeType: "image/png" },
  ], timestamp: 1 });
  f.ctx.getContextUsage = () => ({ tokens: 60237, contextWindow: 512000, percent: 0 });
  value = f.read();
  const text = compositionMap(value, "test", 80).join("\n");
  expect(value.complete).toBe(false);
  expect(value.total).toBeGreaterThan(58_100);
  expect(value.total).toBeLessThan(58_300);
  expect(value.total).toBeLessThan(value.sdkTokens!);
  expect(text).toContain("SDK occupancy estimate ~60.2k / 512k");
  expect(text).toContain("Estimated remaining ~451.8k");
  expect(text).toContain("unclassified numerical gap");
  expect(text).toContain("non-text content is unmeasured");
  expect(text).not.toContain("?".repeat(20));
});

test.each([1, 102, 150, null, undefined, -1, NaN, Infinity])("SDK total %s is disclosed without rescaling local categories", reported => {
  const f = fixture();
  f.ctx.getSystemPrompt = () => "x".repeat(714); // exactly 102 rebuilt tokens
  f.ctx.getContextUsage = () => ({ tokens: reported, contextWindow: 1000, percent: 99 }) as any;
  const value = f.read(), lines = compositionMap(value, "test", 40), text = lines.join("\n");
  const valid = typeof reported === "number" && Number.isFinite(reported) && reported >= 0;
  expect(value.amounts.System).toBe(102);
  expect(value.total).toBe(102);
  expect(value.sdkDifference).toBe(valid ? reported - 102 : undefined);
  expect(text).toContain(valid ? "SDK occupancy estimate" : "Capacity estimate unavailable: SDK usage unavailable");
  expect(text).toContain("Local rebuilt text ~102");
  expect(text.includes("Estimated remaining")).toBe(valid);
  expect(text).not.toContain("?".repeat(20));
  if (valid && reported < 102) {
    expect(text).toContain("below local rebuilt text estimate");
    expect(text).toContain("local categories are not reduced");
  }
});

test("usage exceptions, unavailable windows, fractional SDK estimates and overcapacity stay honest", () => {
  const f = fixture();
  f.ctx.getContextUsage = () => { throw Error("usage unavailable"); };
  let lines = compositionMap(f.read(), "test", 40);
  expect(lines.join("\n")).toContain("Capacity estimate unavailable: SDK usage unavailable");
  expect(lines.join("\n")).not.toContain("?".repeat(20));
  f.ctx.getSystemPrompt = () => "x".repeat(714);
  for (const window of [undefined, 0, -1, NaN, Infinity]) {
    f.ctx.model!.contextWindow = window as number;
    f.ctx.getContextUsage = () => ({ tokens: 102, contextWindow: window, percent: null }) as any;
    const value = f.read(), text = compositionMap(value, "test", 40).join("\n");
    expect(value.window).toBeUndefined();
    expect(text).toContain("Capacity estimate unavailable: context window unavailable");
    expect(text).toContain("SDK occupancy estimate ~102");
    expect(text).not.toContain("?".repeat(20));
  }
  f.ctx.getContextUsage = () => ({ tokens: 102.5, contextWindow: 100, percent: 102.5 });
  const value = f.read(), text = compositionMap(value, "test", 40).join("\n");
  expect(value.sdkTokens).toBe(102.5); // SDK estimates are not persisted composition integers.
  expect(value.sdkDifference).toBe(0.5);
  expect(text).toContain("unclassified numerical gap");
  expect(text).toContain("102.5%");
  expect(text).not.toContain("Estimated remaining ~-");
  expect(compositionMap(value, "test", 40).slice(0, 5).join("")).toBe("⛁".repeat(100));
  f.ctx.getContextUsage = () => ({ tokens: 1e30, contextWindow: 1000, percent: 0 });
  expect(compositionMap(f.read(), "test", 40).join("\n")).toContain("above local rebuilt text estimate"); // No cancellation from subtracting a huge SDK gap.
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
  f.ctx.getContextUsage = () => ({ tokens: 0, contextWindow: 500000, percent: 0 });
  expect(compositionMap(f.read(), "test", 40).slice(0, 5).join("")).toBe("⛶".repeat(100));
  f.ctx.getContextUsage = () => ({ tokens: 1, contextWindow: 1000, percent: 0.1 });
  expect(compositionMap(f.read(), "test", 40).slice(0, 5).join("")).toBe("⛀" + "⛶".repeat(99));
  f.sm.appendCustomMessageEntry("trace-memory", "raw ".repeat(100), false);
  f.ctx.model!.contextWindow = 1;
  f.ctx.getContextUsage = () => ({ tokens: 100, contextWindow: 1, percent: 10000 });
  const lines = compositionMap(f.read(), "test", 40);
  expect(lines.slice(0, 5).join("")).toBe("⛁".repeat(100));
  expect(lines.join("\n")).toContain("Estimated remaining ~0 (0.0%)");
});

test.each([1, 20, 40, 80, 100])("composition and single continuous Memory bar fit %i columns", width => {
  const value: ContextComposition = { amounts: { System: 800, Skills: 300, Tools: 0, Memory: 24000, Conversation: 0, Other: 0 },
    memory: { Knowledge: 12000, Facts: 6000, Raw: 6000, Unclassified: 0 }, window: 500000, total: 25100, sdkTokens: 25100, sdkDifference: 0, complete: true };
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
    // Integration: persist the actual core/host replacement, not a hand-built material fixture.
    expect(compact.details.traceMemory.composition.bodyHash).toBe(memoryBodyHash(compact.summary));
    const retained = fixture();
    retained.sm.appendCompaction(compact.summary, "", 10000, compact.details, true);
    const before = retained.read();
    expect(before.memory.Knowledge).toBe(compact.details.traceMemory.composition.knowledge);
    expect(before.memory.Facts).toBe(compact.details.traceMemory.composition.facts);
    expect(before.memory.Raw).toBe(compact.details.traceMemory.composition.raw);
    const saved = JSON.stringify(retained.sm.getEntries());
    const tools = h.memory.tools({ kind: "manual", sessionId: 1, currentTurnId: 1, branch: "main" });
    const trace = tools.find(t => t.name === "trace")!, write = tools.find(t => t.name === "memory")!;
    const edit = () => JSON.parse(write.execute({ operations: [{ op: "update", id: "K2@2", text: "Rule updated",
      category: "constraint", scope: "global", supports: ["F1"], topics: [], reason: "integration" }], skipped: [] }));
    // A retained carrier and raw trace supply no named-K write handle.
    expect(edit().results[0]).toContain("knowledge was not read");
    for (const address of ["T1", "K2@2"]) {
      let page = trace.execute({ address, cap: 1 }), pages = 0;
      for (;;) {
        expect(page).not.toContain("rejected:");
        expect(tokens(page)).toBeLessThanOrEqual(2000);
        expect(retained.read()).toEqual(before);
        expect(JSON.stringify(retained.sm.getEntries())).toBe(saved);
        const cursor = tracePage(page).cursor;
        if (!cursor) break;
        expect(edit().results[0]).toContain("knowledge was not read");
        page = trace.execute({ address: `cursor=${cursor}` });
        expect(++pages).toBeLessThan(100);
      }
      expect(pages).toBeGreaterThan(0);
      if (address === "T1") expect(edit().results[0]).toContain("knowledge was not read");
    }
    expect(edit().committed[0]).toMatchObject({ knowledgeId: 2 });
    expect(retained.read()).toEqual(before); // Live DB changes never remeasure a saved carrier.
    expect(h.requests).toEqual([]);
  } finally { await h.dispose(); }
});
