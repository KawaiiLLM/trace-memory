import { expect, test } from "vitest";
import { DEFAULT_CONFIG, renderEntry, tokens, type EntryProfile, type ResultExtractor, type SourceEntry } from "../../../src/core/api/index.ts";
import { TraceMemory } from "../../source-fixture.ts";

// Ticket 23 "One entry view, two budgets": the whole rule on synthetic entries, byte for byte. Core
// renders a host-neutral shape — tool name, status, arguments as a JSON object, result as text — so
// the extractor below stands in for a host's; the Pi one is pinned in tests/hosts/pi/entries.test.ts.
const extract: ResultExtractor = (raw) => {
  const value = JSON.parse(raw) as { text: string; details?: unknown };
  return { text: value.text, ...(value.details === undefined ? {} : { details: JSON.stringify(value.details) }) };
};
const entry = (role: SourceEntry["role"], text: string, calls: SourceEntry["calls"] = []): SourceEntry =>
  ({ id: 1, sessionId: 1, nativeLineage: "lineage", nativeId: "native", turnId: 7, role, text, raw: "", calls });
const call = (ordinal: number, name: string, rest: Partial<SourceEntry["calls"][number]>) =>
  ({ ordinal, name, callId: `native-${ordinal}`, status: "attempted", ...rest });
const envelope = (text: string, details?: unknown) => JSON.stringify({ text, ...(details === undefined ? {} : { details }) });
const view = (source: SourceEntry, profile: EntryProfile = DEFAULT_CONFIG.render) => renderEntry(source, profile, extract).content;

const tier1 = DEFAULT_CONFIG.render;
const tier2: EntryProfile = { toolCallTokens: DEFAULT_CONFIG.render.secondaryToolCallTokens, entryTokens: DEFAULT_CONFIG.render.secondaryEntryTokens };

test("23 golden: a user message is its label and its text, with no native identity and no call id", () => {
  expect(view(entry("user", "看一下最新的导出。"))).toBe("[Source entry id: T7#user]\n看一下最新的导出。");
  // A user message without text (an image, say) still shows as a source with a marker.
  expect(view(entry("user", ""))).toBe("[Source entry id: T7#user]\n[non-text content omitted]");
});

test("23 golden: an assistant message, and one with parallel calls as label plus one key: value line each", () => {
  expect(view(entry("assistant", "I read the export and found one swapped value.")))
    .toBe("[Source entry id: T7#assistant]\nI read the export and found one swapped value.");
  expect(view(entry("assistant", "Two things at once.", [
    call(1, "read", { input: JSON.stringify({ file_path: "/tmp/notes.md", limit: 40 }) }),
    call(2, "bash", { input: JSON.stringify({ command: "grep -n TODO src/*.ts", timeout: 30 }) }),
  ]))).toBe([
    "[Source entry id: T7#assistant]",
    "Two things at once.",
    "[T7#t1] read",
    "file_path: /tmp/notes.md",
    "limit: 40",
    "[T7#t2] bash",
    "command: grep -n TODO src/*.ts",
    "timeout: 30",
  ].join("\n"));
});

test("23 golden: a tool result is label plus status plus the host's text, non-text blocks marked", () => {
  expect(view(entry("toolResult", "", [call(1, "read", { status: "success", result: envelope("line one\n[image omitted]\nline three") })])))
    .toBe("[T7#t1] read success\nline one\n[image omitted]\nline three");
});

test("23 golden: a result larger than B keeps head and tail with an honest count, inside its share of B", () => {
  const body = "HEAD " + "output ".repeat(400) + "TAIL";
  const rendered = view(entry("toolResult", "", [call(1, "bash", { status: "success", result: envelope(body) })]));
  expect(tokens(rendered)).toBe(225); // three quarters of B = 300, the result share
  expect(rendered.startsWith("[T7#t1] bash success\nHEAD output output")).toBe(true);
  expect(rendered.endsWith("output output TAIL")).toBe(true);
  expect(rendered).toContain("\n[omitted 1400 characters; middle not inspected]\n");
  // Honest: the marker's count is exactly what the head and the tail leave out.
  const kept = rendered.slice("[T7#t1] bash success\n".length).split("\n[omitted 1400 characters; middle not inspected]\n");
  expect([...body].length - [...kept[0]!].length - [...kept[1]!].length).toBe(1400);
});

test("23 golden: structured data the host drops is marked by size, and stands in for an empty result text", () => {
  expect(view(entry("toolResult", "", [call(1, "edit", { status: "success", result: envelope("Edited /tmp/x.ts", { diff: "-old\n+new" }) })])))
    .toBe("[T7#t1] edit success\nEdited /tmp/x.ts\n[details omitted: 21 characters]");
  // Empty text with structured data: the head of its compact JSON, never a blank part.
  expect(view(entry("toolResult", "", [call(1, "edit", { status: "success", result: envelope("", { diff: "-old\n+new", path: "/tmp/x.ts" }) })])))
    .toBe("[T7#t1] edit success\n{\"diff\":\"-old\\n+new\",\"path\":\"/tmp/x.ts\"}");
});

test("23 golden: an entry over E with tool parts shrinks the tool parts, not the text", () => {
  expect(view(entry("assistant", "Short note. " + "word ".repeat(30), [
    call(1, "bash", { input: JSON.stringify({ command: "echo " + "a".repeat(300) }) }),
    call(2, "bash", { input: JSON.stringify({ command: "echo " + "b".repeat(300) }) }),
  ]), { toolCallTokens: 300, entryTokens: 90 })).toBe([
    "[Source entry id: T7#assistant]",
    "Short note. " + "word ".repeat(30),
    "[T7#t1] bash",
    "command: echo " + "a".repeat(28) + "[omitted 272 characters]",
    "[T7#t2] bash",
    "command: echo " + "b".repeat(28) + "[omitted 272 characters]",
  ].join("\n"));
});

test("23 golden: an entry over E without tool parts is the text cut head and tail", () => {
  expect(view(entry("user", "PREFIX " + "字".repeat(200) + " SUFFIX"), { toolCallTokens: 300, entryTokens: 60 })).toBe([
    "[Source entry id: T7#user]",
    "PREFIX " + "字".repeat(20),
    "[omitted 160 characters; middle not inspected]",
    "字".repeat(20) + " SUFFIX",
  ].join("\n"));
});

test("23: the two stages in order — text yields only after every tool part is at its minimum", () => {
  const source = entry("assistant", "A long reply. " + "word ".repeat(300),
    [call(1, "bash", { input: JSON.stringify({ command: "make build" }) })]);
  const tight: EntryProfile = { toolCallTokens: 100, entryTokens: 150 }; // tighter than the shipped tier 2, to force the second stage
  const rendered = view(source, tight);
  expect(tokens(rendered)).toBeLessThanOrEqual(tight.entryTokens);
  // The tool part is at its label-plus-marker minimum, and only then is the text cut.
  expect(rendered).toContain("[T7#t1] bash\n[omitted 10 characters]");
  expect(rendered).toContain("[omitted ");
  expect(rendered).toContain("; middle not inspected]");
  // With room for both, neither yields: the same entry under tier 1 keeps text and arguments whole.
  expect(view(source, tier1)).toBe(`[Source entry id: T7#assistant]\nA long reply. ${"word ".repeat(300)}\n[T7#t1] bash\ncommand: make build`);
});

// The fixed entry set of the budget-contract scan: text, parallel calls, results with and without
// structured data, and a tool-heavy entry.
const scanned: SourceEntry[] = [
  entry("user", "短问题：这次导出对不对？"),
  entry("assistant", "A reply that runs on. " + "word ".repeat(200)),
  entry("assistant", "Calling three tools.", [
    call(1, "read", { input: JSON.stringify({ file_path: "/tmp/a.md" }) }),
    call(2, "bash", { input: JSON.stringify({ command: "echo " + "z".repeat(2000), timeout: 30 }) }),
    call(3, "grep", { input: JSON.stringify({ pattern: "TODO", path: "src" }) }),
  ]),
  entry("toolResult", "", [call(1, "bash", { status: "success", result: envelope("out ".repeat(1000), { exitCode: 0 }) })]),
  entry("toolResult", "", [call(1, "edit", { status: "failure", result: envelope("", { diff: "-a\n+b".repeat(50) }) })]),
  entry("assistant", "", Array.from({ length: 12 }, (_, i) => call(i + 1, "bash", { input: JSON.stringify({ command: "run " + "x".repeat(500) }) }))),
];

test("23 budget contract: over a range of B and E every part is within its allocation and no part is empty", () => {
  for (const toolCallTokens of [60, 100, 300, 1_000]) for (const entryTokens of [40, 150, 1_000, 10_000]) {
    const profile = { toolCallTokens, entryTokens };
    for (const source of scanned) {
      let rendered: string;
      try { rendered = view(source, profile); }
      catch (error) { expect(String(error)).toMatch(/capacity/); continue; }
      const where = `B=${toolCallTokens} E=${entryTokens} ${source.role}`;
      expect(tokens(rendered), where).toBeLessThanOrEqual(entryTokens);
      const parts = rendered.split(/\n(?=\[T7#t\d+\] )/);
      const share = Math.floor(toolCallTokens * (source.role === "toolResult" ? 0.75 : 0.25));
      for (const [index, part] of parts.entries()) {
        expect(part.length, where).toBeGreaterThan(0);
        const label = index === 0 && (source.text || source.role === "user") ? `[Source entry id: T7#` : "[T7#t";
        expect(part.startsWith(label), `${where}: ${part.slice(0, 40)}`).toBe(true);
        if (part.startsWith("[T7#t")) {
          expect(tokens(part), where).toBeLessThanOrEqual(share);
          // Never shorter than its minimum: the label line survives, and so does one marker whenever
          // the part had anything to omit.
          expect(part.split("\n")[0]!.length, where).toBeGreaterThan("[T7#t1] x".length - 1);
        }
      }
    }
  }
});

test("23 budget contract: an E below the minima of an entry's parts raises the capacity error", () => {
  const source = scanned[2]!;
  expect(() => view(source, { toolCallTokens: 300, entryTokens: 20 })).toThrow(/capacity/);
  // So does a B whose share cannot hold one part's label and marker, whatever E allows.
  expect(() => view(source, { toolCallTokens: 20, entryTokens: 10_000 })).toThrow(/capacity/);
});

test("23 budget contract: no cut falls inside a surrogate pair", () => {
  for (const entryTokens of [40, 80, 160, 320]) {
    const rendered = view(entry("user", "😀🧠".repeat(300)), { toolCallTokens: 300, entryTokens });
    expect([...rendered].every((character) => {
      const code = character.codePointAt(0)!;
      return code < 0xD800 || code > 0xDFFF;
    }), `E=${entryTokens}`).toBe(true);
  }
});

test("23 fidelity: a target path after a long argument value still appears, without any tool knowledge", () => {
  const rendered = view(entry("assistant", "", [call(1, "write", {
    input: JSON.stringify({ content: "章".repeat(4000), file_path: "/tmp/target.md", mode: "overwrite" }) })]));
  expect(rendered).toContain("file_path: /tmp/target.md");
  expect(rendered).toContain("mode: overwrite");
  expect(rendered).toMatch(/content: 章+\[omitted \d+ characters\]/);
});

test("23 fidelity: an omitted middle states an honest count and its address fetches the original", () => {
  const memory = TraceMemory(":memory:", async () => ({ outcome: "success", output: "", request: {} }));
  try {
    const project = memory.store.createProject({ name: "p", declaredBy: "mark" });
    const session = memory.store.createSession({ enrollmentChoice: true, host: "fake", startedAt: "t", firstReplyAt: "t", projectId: project.id });
    const turn = memory.store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "run it", assistantText: "done", startedAt: "t" });
    const result = ["head line", ...Array.from({ length: 400 }, (_, i) => `key${i}: value${i}`), "tail line"].join("\n");
    memory.store.appendToolCall({ turnId: turn.id, name: "bash", input: JSON.stringify({ command: "dump" }), result, status: "success" });
    const source = memory.store.listSourceEntries(session.id).find((e) => e.role === "toolResult")!;
    const rendered = renderEntry(source, memory.config.render, memory.resultText).content;
    const marker = /\[omitted (\d+) characters; middle not inspected\]/.exec(rendered)!;
    expect(rendered).not.toContain("key200: value200");
    const [head, tail] = rendered.split(marker[0]!);
    expect([...result].length - [...head!.slice(head!.indexOf("\n") + 1)].length - [...tail!].length + 2).toBe(Number(marker[1]));
    // The address the label carries fetches the original through the unchanged `full` path.
    expect(memory.trace(`T${turn.id}#t1`, { full: true })).toContain("key200: value200");
  } finally { memory.close(); }
});

test("23: the profiles are the two shipped ones, and B is rejected above its ceiling", () => {
  expect([tier1.toolCallTokens, tier1.entryTokens]).toEqual([300, 10_000]);
  expect([tier2.toolCallTokens, tier2.entryTokens]).toEqual([100, 1000]);
  const open = (render: Record<string, number>) => TraceMemory(":memory:", async () => ({ outcome: "success", output: "", request: {} }), { render });
  expect(() => open({ toolCallTokens: 1_001 })).toThrow("Invalid render.toolCallTokens: at most 1000");
  expect(() => open({ secondaryToolCallTokens: 1_001 })).toThrow("Invalid render.secondaryToolCallTokens: at most 1000");
  const ceiling = open({ toolCallTokens: 1_000 });
  try { expect(ceiling.config.render.toolCallTokens).toBe(1_000); } finally { ceiling.close(); }
  for (const value of [0, -1, 1.5, NaN, Infinity]) for (const key of ["toolCallTokens", "entryTokens", "secondaryToolCallTokens", "secondaryEntryTokens"]) {
    expect(() => open({ [key]: value })).toThrow("Invalid render.");
  }
});
