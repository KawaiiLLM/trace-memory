import { expect, test } from "vitest";
import { formatSkillsForPrompt, SessionManager, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { memoryBodyHash, tokens } from "../../../src/core/api/index.ts";
import { tracePage } from "../../trace-pages.ts";
import { compactText, measuredMemory } from "../../../src/core/render/material.ts";
import { contextComposition, type ContextComposition } from "../../../src/hosts/pi/context-composition.ts";
import { allocateCells, compositionMap, percent, statusBody } from "../../../src/hosts/pi/session-status.ts";
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
function numericComposition(sdkTokens: number, window: number | undefined, system = 0): ContextComposition {
  return { amounts: { System: system, Tools: 0, Skills: 0, Memory: 0, Conversation: 0, Other: 0 },
    memory: { Knowledge: 0, Facts: 0, Raw: 0, Unclassified: 0 }, total: system, sdkTokens,
    sdkDifference: sdkTokens - system, window, complete: true };
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

test("rendering preserves Memory metadata and keeps nonzero parts inline in fixed uncolored order", () => {
  const f = fixture();
  f.sm.appendCustomMessageEntry("trace-memory", measured.text, false, details);
  const value = f.read(), before = structuredClone(value);
  const paint = (color: string, text: string) => `\x1b[${color === "accent" ? 34 : color === "syntaxKeyword" ? 31 : color === "syntaxString" ? 33 : color === "syntaxNumber" ? 35 : 90}m${text}\x1b[39m`;
  const rendered = compositionMap(value, "test", 160, paint as any).join("\n");
  expect(value).toEqual(before);
  const plain = stripTerminalSequences(rendered).replace(/\s+/g, " ");
  const parts = (["Knowledge", "Facts", "Raw", "Unclassified"] as const).filter(part => value.memory[part] > 0);
  expect(parts.map(part => plain.indexOf(`${part} `))).toEqual([...parts.map(part => plain.indexOf(`${part} `))].sort((a, b) => a - b));
  for (const part of parts) expect(plain.match(new RegExp(`${part} `, "g"))).toHaveLength(1);
  expect(rendered).toMatch(/\x1b\[34m⛁ Memory[^\n]*\x1b\[39m — Knowledge/);
  expect(rendered).not.toMatch(/\x1b\[(?:31|33|35)m(?:Knowledge|Facts|Raw|Unclassified)/);
  expect(plain).not.toMatch(/Memory bar|No retained memory/);
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

test("incomplete reader census keeps a coherent colored partition without inventing image usage", () => {
  const f = fixture(), baseline = f.read();
  f.ctx.getContextUsage = () => ({ tokens: 10000, contextWindow: 500000, percent: 2 });
  let value = f.read();
  expect(value.amounts.System).toBe(baseline.amounts.System);
  expect(value.total).toBe(baseline.total);
  expect(value.sdkDifference).toBe(10000 - baseline.total);

  f.ctx.getSystemPrompt = () => "x".repeat(407_300);
  f.sm.appendMessage({ role: "user", content: [
    { type: "text", text: "measured text remains classified" },
    { type: "image", data: "a".repeat(1000), mimeType: "image/png" },
  ], timestamp: 1 });
  f.ctx.getContextUsage = () => ({ tokens: 60237, contextWindow: 512000, percent: 0 });
  value = f.read();
  const codes = { syntaxKeyword: 31, Conversation: 35, muted: 37, dim: 90 };
  const paint = (color: string, text: string) => `\x1b[${color === "syntaxKeyword" ? codes.syntaxKeyword : color === "syntaxNumber" ? codes.Conversation : color === "muted" ? codes.muted : codes.dim}m${text}\x1b[39m`;
  const rendered = compositionMap(value, "test", 80, paint as any);
  const text = stripTerminalSequences(rendered.join("\n"));
  expect(value.complete).toBe(false);
  expect(value.total).toBeGreaterThan(58_100);
  expect(value.total).toBeLessThan(58_300);
  expect(value.total).toBeLessThan(value.sdkTokens!);
  expect(text).toContain("~60.2k / 512k tokens (11.8%)");
  expect(text).toContain("Estimated usage by category (partial)");
  expect(text).toContain("Difference ~2k (0.4%)");
  expect(text).toContain("Free ~451.8k (88.2%)");
  expect(rendered.slice(0, 10).join("")).toMatch(/\x1b\[31m⛁.*\x1b\[35m⛁.*\x1b\[37m⛁.*\x1b\[90m⛶/s);
  expect(text).not.toMatch(/image|non-text|unclassified numerical gap|Local census incomplete|\?{20}/);
});

test.each([1, 102, 150, null, undefined, -1, NaN, Infinity])("SDK total %s selects the raw-value state without changing local categories", reported => {
  const f = fixture();
  f.ctx.getSystemPrompt = () => "x".repeat(714); // exactly 102 rebuilt tokens
  f.ctx.getContextUsage = () => ({ tokens: reported, contextWindow: 1000, percent: 99 }) as any;
  const value = f.read(), text = stripTerminalSequences(compositionMap(value, "test", 40).join("\n")).replace(/\s+/g, " ");
  const validSdk = typeof reported === "number" && Number.isFinite(reported) && reported >= 0;
  expect(value.amounts.System).toBe(102);
  expect(value.total).toBe(102);
  expect(value.sdkDifference).toBe(validSdk ? reported - 102 : undefined);
  expect(text).toContain("System ~102 (10.2%)");
  expect(text).not.toMatch(/Local rebuilt|Occupied estimate|Estimated remaining|\?{20}/);
  if (!validSdk) {
    expect(text).toContain("Context window ~1k tokens SDK usage unavailable.");
    expect(text).not.toContain("Free");
  } else if (reported < 102) {
    expect(text).toContain("Local text exceeds SDK total; grid uses SDK.");
    expect(text).not.toContain("Difference");
  } else {
    expect(text).not.toContain("Local text exceeds SDK total");
    expect(text.includes("Difference")).toBe(reported > 102);
  }
});

test("unavailable, fractional, boundary and huge over-window values remain honest", () => {
  const f = fixture();
  f.ctx.getContextUsage = () => { throw Error("usage unavailable"); };
  let text = compositionMap(f.read(), "test", 40).join("\n");
  expect(text).toContain("SDK usage unavailable.");
  expect(text).toContain("Context window ~500k tokens");
  expect(text).not.toContain("Free");
  f.ctx.getSystemPrompt = () => "x".repeat(714);
  for (const window of [undefined, 0, -1, NaN, Infinity]) {
    f.ctx.model!.contextWindow = window as number;
    f.ctx.getContextUsage = () => ({ tokens: 102, contextWindow: window, percent: null }) as any;
    const value = f.read(); text = compositionMap(value, "test", 40).join("\n");
    expect(value.window).toBeUndefined();
    expect(text.replace(/\s+/g, " ")).toContain("~102 tokens Context window unavailable.");
    expect(text).not.toContain("Free");
  }
  f.ctx.model = undefined;
  f.ctx.getContextUsage = () => undefined;
  text = compositionMap(f.read(), "test", 40).join("\n");
  expect(text.replace(/\s+/g, " ")).toContain("SDK usage and context window unavailable.");
  expect(text).not.toContain("Free");

  f.ctx.model = { contextWindow: 100 } as any;
  for (const sdkTokens of [99.999, 100, 100.001, 102.5, 1e30]) {
    f.ctx.getContextUsage = () => ({ tokens: sdkTokens, contextWindow: 100, percent: 0 });
    const value = f.read(); text = compositionMap(value, "test", 40).join("\n");
    expect(value.sdkTokens).toBe(sdkTokens);
    expect(text).toContain(`(${percent(sdkTokens / 100)})`);
    const grid = stripTerminalSequences(compositionMap(value, "test", 40).slice(0, 10).join(""));
    if (sdkTokens > 100) {
      expect(grid).toBe("⛁".repeat(200));
      expect(text).toContain("Context exceeds window by ~");
      expect(text).toContain("grid capped.");
      expect(text).toContain("Free ~0 (0.0%)");
      expect(text).not.toContain("Difference");
    } else expect(text).not.toContain("Context exceeds window");
  }
  const overWithLargerLocal: ContextComposition = { amounts: { System: 200, Tools: 0, Skills: 0, Memory: 0, Conversation: 0, Other: 0 },
    memory: { Knowledge: 0, Facts: 0, Raw: 0, Unclassified: 0 }, total: 200, sdkTokens: 101, sdkDifference: -99, window: 100, complete: true };
  text = compositionMap(overWithLargerLocal, "test", 40).join("\n");
  expect(text.replace(/\s+/g, " ")).toContain("Context exceeds window by ~1 tokens; grid capped.");
  expect(text).not.toContain("Local text exceeds SDK total");
});

test("positive sub-milltoken overflow remains visible without changing the over-window state", () => {
  const value = numericComposition(100.0001, 100, 100);
  const lines = compositionMap(value, "test", 40);
  const text = lines.join("\n"), compact = text.replace(/\s+/g, " ");
  expect(lines.slice(0, 10).join("")).toBe("⛁".repeat(200));
  expect(text).toContain("~100 / 100 tokens (>100%)");
  expect(compact).toContain("Context exceeds window by <0.001 tokens; grid capped.");
  expect(text).not.toContain("exceeds window by ~0 tokens");
  expect(text).not.toContain("Difference");
});

test("positive sub-milltoken Difference and Free remain distinct from exact zero", () => {
  let text = compositionMap(numericComposition(100.0001, 101, 100), "test", 40).join("\n");
  expect(text).toContain("Difference <0.001 (<0.1%)");
  expect(text).not.toContain("Difference ~0 ");

  text = compositionMap(numericComposition(99.9999, 100), "test", 40).join("\n");
  expect(text).toContain("Free <0.001 (<0.1%)");
  expect(text).not.toContain("Free ~0 ");

  text = compositionMap(numericComposition(100, 100, 100), "test", 40).join("\n");
  expect(text).toContain("Free ~0 (0.0%)");
  expect(text).not.toContain("Difference");
});

test("tiny positive SDK usage remains visible with and without a valid window", () => {
  let text = compositionMap(numericComposition(0.0001, 100), "test", 40).join("\n");
  expect(text).toContain("<0.001 / 100 tokens (<0.1%)");
  expect(text).toContain("Difference <0.001 (<0.1%)");
  expect(text).not.toContain("~0 / 100 tokens");

  text = compositionMap(numericComposition(Number.MIN_VALUE, undefined), "test", 40).join("\n");
  expect(text.replace(/\s+/g, " ")).toContain("<0.001 tokens Context window unavailable.");
  expect(text).not.toContain("~0 tokens");
  expect(text).not.toContain("Difference");

  text = compositionMap(numericComposition(0, 100), "test", 40).join("\n");
  expect(text).toContain("~0 / 100 tokens (0.0%)");
  expect(text).not.toContain("<0.001 / 100 tokens");
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

test("sub-percent categories stay visible while Memory parts have no second percentages", () => {
  const f = fixture(), value = f.read();
  value.amounts.System = 4900; value.amounts.Memory = 100000;
  value.memory = { Knowledge: 99999, Facts: 1, Raw: 0, Unclassified: 0 };
  value.total = 104900;
  const text = stripTerminalSequences(compositionMap(value, "test", 80).join("\n")).replace(/\s+/g, " ");
  expect(text).toContain("System ~4.9k (<1%)");
  expect(text).toContain("Memory ~100k (20.0%) — Knowledge 100k, Facts 1");
  expect(text).not.toMatch(/Facts 1 \(/);
});

test("coherent composition allocates 200 colored cells and keeps one compact legend", () => {
  const value: ContextComposition = {
    amounts: { System: 1900, Tools: 3800, Skills: 1200, Memory: 30300, Conversation: 143500, Other: 12800 },
    memory: { Knowledge: 10500, Facts: 9900, Raw: 9621, Unclassified: 279 },
    window: 512000, total: 193500, sdkTokens: 207000, sdkDifference: 13500, complete: true,
  };
  const codes: Record<string, number> = { syntaxKeyword: 31, syntaxFunction: 32, syntaxString: 33,
    accent: 34, syntaxNumber: 35, syntaxType: 36, muted: 37, dim: 90 };
  const paint = (color: string, text: string) => `\x1b[${codes[color]}m${text}\x1b[39m`;
  const lines = compositionMap(value, "fake/test", 40, paint as any);
  const grid = lines.slice(0, 10).join("");
  const count = (code: number, glyph: string) => grid.split(`\x1b[${code}m${glyph}`).length - 1;
  expect([count(31, "⛁"), count(32, "⛁"), count(33, "⛁"), count(34, "⛁"),
    count(35, "⛁"), count(36, "⛁"), count(37, "⛁"), count(90, "⛶")])
    .toEqual([1, 2, 0, 12, 56, 5, 5, 119]);
  const text = stripTerminalSequences(lines.join("\n")), compact = text.replace(/\s+/g, " ");
  expect(text.match(/~207k \/ 512k tokens \(40\.4%\)/g)).toHaveLength(1);
  expect(text).toContain("Estimated usage by category");
  expect(text).toContain("Skill catalog ~1.2k (0.2%)");
  expect(compact).toContain("Memory ~30.3k (5.9%) — Knowledge 10.5k, Facts 9.9k, Raw 9.6k, Unclassified 279");
  expect(text).not.toMatch(/Local rebuilt|Occupied estimate|Memory\n|Pi rebuilt|not provider wire|guaranteed free/);
  for (const [code, label] of [[31, "System"], [32, "Tools"], [33, "Skill catalog"], [34, "Memory"],
    [35, "Conversation"], [36, "Other"], [37, "Difference"]] as const)
    expect(lines.join("\n")).toContain(`\x1b[${code}m⛁ ${label}`);
  expect(lines.join("\n")).toMatch(/\x1b\[34m⛁ Memory[^\n]*\x1b\[39m — Knowledge/);
  expect(lines.join("\n")).not.toMatch(/\x1b\[(?:31|33|35)m(?:Knowledge|Facts|Raw|Unclassified)/);
});

test("largest remainders are stable across ties and tiny categories without minimum cells", () => {
  expect(allocateCells([1, 1, 1], 2)).toEqual([1, 1, 0]);
  expect(allocateCells([3, 997], 200)).toEqual([1, 199]);
  expect(allocateCells([1, 1, 1, 1, 1, 995], 200)).toEqual([1, 0, 0, 0, 0, 199]);
  expect(allocateCells([0, 0, 0], 200)).toEqual([0, 0, 0]);
  for (let count = 1; count < 100; count++) {
    const values = Array.from({ length: count }, (_, i) => i * 0.7 + 0.1);
    const allocated = allocateCells(values, 200);
    expect(allocated.reduce((sum, n) => sum + n, 0)).toBe(200);
    expect(allocated.every(n => n >= 0)).toBe(true);
  }
});

test("coherent zero/equal/full states and fallback partial cells use distinct rules", () => {
  const f = fixture(); f.ctx.getSystemPrompt = () => "";
  f.ctx.getContextUsage = () => ({ tokens: 0, contextWindow: 1000, percent: 0 });
  let lines = compositionMap(f.read(), "test", 40), text = lines.join("\n");
  expect(lines.slice(0, 10).join("")).toBe("⛶".repeat(200));
  expect(text).not.toContain("Difference");
  expect(text).toContain("Free ~1k (100.0%)");

  f.ctx.getContextUsage = () => ({ tokens: 1, contextWindow: 1000, percent: 0.1 });
  lines = compositionMap(f.read(), "test", 40); text = lines.join("\n");
  expect(lines.slice(0, 10).join("")).toBe("⛶".repeat(200)); // 0.2-cell Difference loses the shared remainder.
  expect(text).toContain("Difference ~1 (0.1%)");

  f.ctx.getSystemPrompt = () => "x".repeat(714); // L=102
  f.ctx.getContextUsage = () => ({ tokens: 1, contextWindow: 1000, percent: 0.1 });
  lines = compositionMap(f.read(), "test", 40); text = lines.join("\n");
  expect(lines.slice(0, 10).join("")).toBe("⛀" + "⛶".repeat(199));
  expect(text.replace(/\s+/g, " ")).toContain("Local text exceeds SDK total; grid uses SDK.");
  expect(text).not.toContain("Difference");

  f.ctx.getContextUsage = () => ({ tokens: 102, contextWindow: 102, percent: 100 });
  lines = compositionMap(f.read(), "test", 40); text = lines.join("\n");
  expect(lines.slice(0, 10).join("")).toBe("⛁".repeat(200));
  expect(text).not.toContain("Difference");
  expect(text).toContain("Free ~0 (0.0%)");
});

test.each([20, 40, 79, 80, 100, 160])("composition wraps complete legend and inline Memory at %i columns", width => {
  const value: ContextComposition = { amounts: { System: 800, Skills: 300, Tools: 1, Memory: 24000, Conversation: 2, Other: 3 },
    memory: { Knowledge: 12000, Facts: 6000, Raw: 5999, Unclassified: 1 }, window: 500000, total: 25106, sdkTokens: 25106, sdkDifference: 0, complete: false };
  const paint = (color: string, text: string) => `\x1b[${color === "syntaxKeyword" ? 31 : color === "syntaxString" ? 32 : color === "accent" ? 34 : 33}m${text}\x1b[39m`;
  const lines = compositionMap(value, "fake/模型-with-a-very-long-name", width, paint as any);
  const rendered = statusBody(lines, width);
  expect(rendered.split("\n").every(line => visibleWidth(line) <= width)).toBe(true);
  const text = stripTerminalSequences(rendered).replace(/\s+/g, " ");
  expect(text.replaceAll(" ", "")).toContain("fake/模型-with-a-very-long-name".replaceAll(" ", ""));
  for (const phrase of ["Estimated usage by category (partial)", "System ~800 (0.2%)", "Skill catalog ~300 (<0.1%)",
    "Memory ~24k (4.8%)", "Knowledge 12k", "Facts 6k", "Raw 6k", "Unclassified 1", "Free ~474.9k (95.0%)"])
    expect(text).toContain(phrase);
  expect(["Knowledge 12k", "Facts 6k", "Raw 6k", "Unclassified 1"].map(part => text.indexOf(part)))
    .toEqual([...(["Knowledge 12k", "Facts 6k", "Raw 6k", "Unclassified 1"].map(part => text.indexOf(part)))].sort((a, b) => a - b));
  const grid = lines.slice(0, 10).map(line => stripTerminalSequences(line).split("   ")[0]!.replaceAll(" ", "")).join("");
  expect(grid).toHaveLength(200);
  expect(text).not.toMatch(/No retained memory|Memory bar|Pi rebuilt|not provider wire/);
});

test("below the 20-column floor keeps safe text without a one-cell-per-row grid", () => {
  const value: ContextComposition = { amounts: { System: 1, Skills: 0, Tools: 0, Memory: 0, Conversation: 0, Other: 0 },
    memory: { Knowledge: 0, Facts: 0, Raw: 0, Unclassified: 0 }, window: 100, total: 1, sdkTokens: 1, sdkDifference: 0, complete: true };
  const lines = compositionMap(value, "test", 1);
  expect(lines.join("").match(/⛁/g) ?? []).toHaveLength(1); // Legend glyph only; no 200-cell grid.
  expect(lines.length).toBeLessThan(100);
  expect(statusBody(lines, 1).split("\n").every(line => visibleWidth(line) <= 1)).toBe(true);
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
