import { expect, test } from "vitest";
import { DEFAULT_CONFIG, renderEntry, renderEntryWhole, tokens, type EntryProfile, type ResultExtractor, type SourceEntry } from "../../../src/core/api/index.ts";
import { sourceSeededMemory } from "../../source-fixture.ts";

// Ticket 23 "One entry view, two budgets", in 23c's line format: Pi's own compaction shape
// (`core/compaction/utils.js`) with our addresses as the labels, byte for byte on synthetic entries.
// Core renders a host-neutral shape — tool name, status, arguments as a JSON object, result as text —
// so the extractor below stands in for a host's; the Pi one is pinned in tests/hosts/pi/entries.test.ts.
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

test("23c golden: a user message is its label, a colon and its text, with no native identity and no call id", () => {
  expect(view(entry("user", "看一下最新的导出。"))).toBe("[T7#user]: 看一下最新的导出。");
  // A user message without text (an image, say) still shows as a source with a marker.
  expect(view(entry("user", ""))).toBe("[T7#user]: [non-text content omitted]");
});

test("23c golden: an assistant message, and one with parallel calls as one line each, key=JSON in stored order", () => {
  expect(view(entry("assistant", "I read the export and found one swapped value.")))
    .toBe("[T7#assistant]: I read the export and found one swapped value.");
  expect(view(entry("assistant", "Two things at once.", [
    call(1, "read", { input: JSON.stringify({ file_path: "/tmp/notes.md", limit: 40 }) }),
    call(2, "bash", { input: JSON.stringify({ command: "grep -n TODO src/*.ts", timeout: 30 }) }),
  ]))).toBe([
    "[T7#assistant]: Two things at once.",
    `[T7#t1] read(file_path="/tmp/notes.md", limit=40)`,
    `[T7#t2] bash(command="grep -n TODO src/*.ts", timeout=30)`,
  ].join("\n"));
});

test("23c golden: a payload that is not a JSON object renders as name(raw)", () => {
  expect(view(entry("assistant", "", [call(1, "bash", { input: "not json at all, just text" })])))
    .toBe("[T7#t1] bash(not json at all, just text)");
  // An empty payload, and an object with nothing in it, are both a call with no arguments: the name
  // and its brackets, nothing omitted to mark. Only a payload that is not a JSON object shows raw.
  expect(view(entry("assistant", "", [call(1, "clear", { input: "" })]))).toBe("[T7#t1] clear()");
  expect(view(entry("assistant", "", [call(1, "clear", { input: "{}" })]))).toBe("[T7#t1] clear()");
  expect(view(entry("assistant", "", [call(1, "clear", { input: "[1,2]" })]))).toBe("[T7#t1] clear([1,2])");
});

test("23c golden: a tool result is label, status, colon and the host's text, non-text blocks marked", () => {
  expect(view(entry("toolResult", "", [call(1, "read", { status: "success", result: envelope("line one\n[image omitted]\nline three") })])))
    .toBe("[T7#t1] read success: line one\n[image omitted]\nline three");
});

test("23c golden: a result larger than its half of B keeps head and tail with an honest count", () => {
  const body = "HEAD " + "output ".repeat(400) + "TAIL";
  const rendered = view(entry("toolResult", "", [call(1, "bash", { status: "success", result: envelope(body) })]));
  expect(tokens(rendered)).toBe(150); // one half of B = 300, the result share
  expect(rendered.startsWith("[T7#t1] bash success: HEAD output output")).toBe(true);
  expect(rendered.endsWith("output output TAIL")).toBe(true);
  expect(rendered).toContain("\n[... 1903 characters truncated]\n");
  // Honest: the marker's count is exactly what the head and the tail leave out.
  const kept = rendered.slice("[T7#t1] bash success: ".length).split("\n[... 1903 characters truncated]\n");
  expect([...body].length - [...kept[0]!].length - [...kept[1]!].length).toBe(1903);
});

test("23c golden: an argument value over its share is cut inside its JSON string, the short sibling whole", () => {
  const rendered = view(entry("assistant", "", [call(1, "write", {
    input: JSON.stringify({ content: "章".repeat(400), file_path: "/tmp/target.md", mode: "overwrite" }) })]));
  expect(rendered).toBe(`[T7#t1] write(content="${"章".repeat(65)}"[... 271 characters truncated]"${"章".repeat(64)}"`
    + `, file_path="/tmp/target.md", mode="overwrite")`);
  expect(tokens(rendered)).toBeLessThanOrEqual(Math.floor(tier1.toolCallTokens / 2));
});

test("23c golden: a sealed call keeps its name, its brackets and one marker for the whole part", () => {
  const source = entry("assistant", "Two calls.", [
    call(1, "bash", { input: JSON.stringify({ command: "echo one" }) }),
    call(2, "read", { input: JSON.stringify({ file_path: "/tmp/x.md" }) })]);
  const rendered = renderEntry(source, tier1, extract, (address) => address.endsWith("#t2") ? "floor" : "render");
  expect(rendered.content).toBe([
    "[T7#assistant]: Two calls.",
    `[T7#t1] bash(command="echo one")`,
    "[T7#t2] read(...)",
    "[... 9 characters truncated]"].join("\n"));
  expect(rendered.omitted).toEqual([2]);
});

test("23c golden: structured data the host drops is marked by size, and stands in for an empty result text", () => {
  expect(view(entry("toolResult", "", [call(1, "edit", { status: "success", result: envelope("Edited /tmp/x.ts", { diff: "-old\n+new" }) })])))
    .toBe("[T7#t1] edit success: Edited /tmp/x.ts\n[... 21 characters of details truncated]");
  // Empty text with structured data: the head of its compact JSON on the label line, never a blank.
  expect(view(entry("toolResult", "", [call(1, "edit", { status: "success", result: envelope("", { diff: "-old\n+new", path: "/tmp/x.ts" }) })])))
    .toBe("[T7#t1] edit success: {\"diff\":\"-old\\n+new\",\"path\":\"/tmp/x.ts\"}");
});

test("23c golden: an entry over E with tool parts shrinks the tool parts, not the text", () => {
  expect(view(entry("assistant", "Short note. " + "word ".repeat(30), [
    call(1, "bash", { input: JSON.stringify({ command: "echo " + "a".repeat(300) }) }),
    call(2, "bash", { input: JSON.stringify({ command: "echo " + "b".repeat(300) }) }),
  ]), { toolCallTokens: 300, entryTokens: 90 })).toBe([
    "[T7#assistant]: Short note. " + "word ".repeat(30),
    `[T7#t1] bash(command="echo ${"a".repeat(10)}"[... 276 characters truncated]"${"a".repeat(14)}")`,
    `[T7#t2] bash(command="echo ${"b".repeat(10)}"[... 276 characters truncated]"${"b".repeat(14)}")`,
  ].join("\n"));
});

test("23c golden: an entry over E without tool parts is the text cut head and tail", () => {
  expect(view(entry("user", "PREFIX " + "字".repeat(200) + " SUFFIX"), { toolCallTokens: 300, entryTokens: 60 })).toBe([
    "[T7#user]: PREFIX " + "字".repeat(25),
    "[... 150 characters truncated]",
    "字".repeat(25) + " SUFFIX",
  ].join("\n"));
});

test("23: the two stages in order — text yields only after every tool part is at its minimum", () => {
  const source = entry("assistant", "A long reply. " + "word ".repeat(300),
    [call(1, "bash", { input: JSON.stringify({ command: "make build" }) })]);
  const tight: EntryProfile = { toolCallTokens: 100, entryTokens: 150 }; // tighter than the shipped tier 2, to force the second stage
  const rendered = view(source, tight);
  expect(tokens(rendered)).toBeLessThanOrEqual(tight.entryTokens);
  // The tool part is at its whole-part floor, and only then is the text cut.
  expect(rendered).toContain("[T7#t1] bash(...)\n[... 10 characters truncated]");
  expect(rendered).toMatch(/\n\[\.\.\. \d+ characters truncated\]\n/);
  // With room for both, neither yields: the same entry under tier 1 keeps text and arguments whole.
  expect(view(source, tier1)).toBe(`[T7#assistant]: A long reply. ${"word ".repeat(300)}\n[T7#t1] bash(command="make build")`);
});

test("23c: the half split — a call's arguments and its result each get floor(B / 2)", () => {
  const long = (character: string) => JSON.stringify({ command: "echo " + character.repeat(5_000) });
  for (const toolCallTokens of [60, 100, 300, 301, 1_000]) {
    const profile = { toolCallTokens, entryTokens: 100_000 };
    const half = Math.floor(toolCallTokens / 2);
    const args = tokens(view(entry("assistant", "", [call(1, "bash", { input: long("a") })]), profile));
    const result = tokens(view(entry("toolResult", "", [call(1, "bash", { status: "success", result: envelope("b".repeat(5_000)) })]), profile));
    // Both fill their own half, within one cut unit of it, and neither takes the other's.
    for (const [what, size] of [["arguments", args], ["result", result]] as const) {
      expect([toolCallTokens, what, size <= half && size > half - 5]).toEqual([toolCallTokens, what, true]);
    }
    // Not the quarter and three quarters 23a shipped: arguments hold more than a quarter of `B` and
    // the result less than three quarters of it.
    expect([toolCallTokens, args > Math.floor(toolCallTokens / 4)]).toEqual([toolCallTokens, true]);
    expect([toolCallTokens, result < Math.floor(toolCallTokens * 3 / 4)]).toEqual([toolCallTokens, true]);
  }
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
      const share = Math.floor(toolCallTokens / 2); // 23c: one half for arguments, one half for the result
      for (const [index, part] of parts.entries()) {
        expect(part.length, where).toBeGreaterThan(0);
        const label = index === 0 && (source.text || source.role === "user") ? "[T7#" : "[T7#t";
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

// ---- 23c ruling 2, GPT review 2026-09-09: the JSON boundaries a cut may never fall inside ----

/** A head must not end, and a tail must not begin, inside an escape sequence or a surrogate pair. */
const edgesSafe = (head: string, tail: string) => {
  const trailingBackslashes = /\\*$/.exec(head)![0]!.length;
  const partialEscape = /\\(u[0-9A-Fa-f]{0,3})?$/.test(head) && trailingBackslashes % 2 === 1;
  const orphanHigh = head.length > 0 && (head.codePointAt(head.length - 1)! & 0xFC00) === 0xD800;
  const orphanLow = tail.length > 0 && (tail.codePointAt(0)! & 0xFC00) === 0xDC00;
  const brokenTail = /^u?[0-9A-Fa-f]{0,3}[^\\]*/.test(tail) && /\\u[0-9A-Fa-f]{0,3}$/.test(head);
  return !partialEscape && !orphanHigh && !orphanLow && !brokenTail;
};
const cuts = (input: string, key: string) => {
  const seen: { head: string; tail: string }[] = [];
  // A dense scan of budgets, one token apart: every kept length these budgets can produce, and the
  // count is asserted by each case below so the scan cannot silently degenerate to one cut position.
  for (let toolCallTokens = 40; toolCallTokens <= 800; toolCallTokens++) {
    const rendered = view(entry("assistant", "", [call(1, "x", { input })]), { toolCallTokens, entryTokens: 100_000 });
    const cut = new RegExp(`^\\[T7#t1\\] x\\(${key}=(.*)\\[\\.\\.\\. (\\d+) characters truncated\\](.*)\\)$`, "s").exec(rendered);
    if (cut) seen.push({ head: cut[1]!, tail: cut[3]! });
  }
  return [...new Map(seen.map((cut) => [`${cut.head}|${cut.tail}`, cut])).values()];
};

test("23c JSON boundaries: a cut string value stays two valid JSON strings around the marker", () => {
  // A value whose JSON text is mostly escapes: newlines, quotes, backslashes, control escapes, an
  // astral pair. Each half is JSON-encoded on its own, so no escape sequence can ever be split.
  const value = "a\nb\"c\\de😀f".repeat(40);
  const observed = cuts(JSON.stringify({ v: value }), "v");
  expect(observed.length).toBeGreaterThan(40); // a dense scan of budgets, not one cut position
  for (const { head, tail } of observed) {
    // Both halves parse on their own, which is only true if no escape sequence was split, and each is
    // really the head or the tail of the stored value. A tail of nothing kept is written as nothing.
    expect(() => JSON.parse(head) as string).not.toThrow();
    expect([head, value.startsWith(JSON.parse(head) as string)]).toEqual([head, true]);
    if (tail !== "") {
      expect(() => JSON.parse(tail) as string).not.toThrow();
      expect([tail, value.endsWith(JSON.parse(tail) as string)]).toEqual([tail, true]);
    }
  }
  expect(observed.some(({ tail }) => tail !== "")).toBe(true); // the marker really does stand between two halves
});

test("23c JSON boundaries: a long array and a long nested object are cut on their compact text, edges outside every escape", () => {
  const array = Array.from({ length: 120 }, (_, i) => `\\"q${i}\\😀 line\nbreak`);
  const nested = { deep: Object.fromEntries(array.map((text, i) => [`k${i}`, text])), n: 42 };
  for (const [key, value] of [["items", array], ["tree", nested]] as const) {
    const observed = cuts(JSON.stringify({ [key]: value }), key);
    expect([key, observed.length > 20]).toEqual([key, true]);
    for (const { head, tail } of observed) {
      expect([key, head, tail, edgesSafe(head, tail)]).toEqual([key, head, tail, true]);
      // The cut text is the head and the tail of the value's own compact JSON.
      expect(JSON.stringify(value).startsWith(head)).toBe(true);
      expect(JSON.stringify(value).endsWith(tail)).toBe(true);
    }
  }
});

test("23c JSON boundaries: a key that is not a plain identifier renders JSON-quoted, as one argument", () => {
  const rendered = view(entry("assistant", "", [call(1, "x", { input: JSON.stringify({ "a=\"x\", b": 1, plain$_1: "y" }) })]));
  expect(rendered).toBe(`[T7#t1] x("a=\\"x\\", b"=1, plain$_1="y")`);
  // One argument, not two: the key's own `=` and `, ` are inside its quotes.
  expect(rendered.slice(rendered.indexOf("(")).split("=").length - 1).toBe(3); // the key's escaped `=`, and one per argument
});

test("23c (GPT review 2026-09-09): a null argument value renders as null, never as an empty string", () => {
  // Under 23c's rule every non-string value is its compact JSON, so `null` (clear/unset) and `""`
  // (an empty string) are different evidence again; the shared absent-field helper is not used here.
  expect(view(entry("assistant", "", [call(1, "tool", { input: JSON.stringify({ value: null }) })]))).toBe("[T7#t1] tool(value=null)");
  expect(view(entry("assistant", "", [call(1, "tool", { input: JSON.stringify({ value: "" }) })]))).toBe(`[T7#t1] tool(value="")`);
  expect(view(entry("assistant", "", [call(1, "tool", { input: JSON.stringify({ a: false, b: 0, c: [], d: {} }) })])))
    .toBe("[T7#t1] tool(a=false, b=0, c=[], d={})");
});

test("23 fidelity: a target path after a long argument value still appears, without any tool knowledge", () => {
  const rendered = view(entry("assistant", "", [call(1, "write", {
    input: JSON.stringify({ content: "章".repeat(4000), file_path: "/tmp/target.md", mode: "overwrite" }) })]));
  expect(rendered).toContain(`file_path="/tmp/target.md"`);
  expect(rendered).toContain(`mode="overwrite"`);
  expect(rendered).toMatch(/content="章+"\[\.\.\. \d+ characters truncated\]"章+"/);
});

test("23 fidelity: an omitted middle states an honest count and its address fetches the original", () => {
  const memory = sourceSeededMemory(":memory:", async () => ({ outcome: "success", output: "", request: {} }));
  try {
    const project = memory.store.createProject({ name: "p", declaredBy: "mark" });
    const session = memory.store.createSession({ enrollmentChoice: true, host: "fake", startedAt: "t", firstReplyAt: "t", projectId: project.id });
    const turn = memory.store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "run it", assistantText: "done", startedAt: "t" });
    const result = ["head line", ...Array.from({ length: 400 }, (_, i) => `key${i}: value${i}`), "tail line"].join("\n");
    memory.store.appendToolCall({ turnId: turn.id, name: "bash", input: JSON.stringify({ command: "dump" }), result, status: "success" });
    const source = memory.store.listSourceEntries(session.id).find((e) => e.role === "toolResult")!;
    const rendered = renderEntry(source, memory.config.render, memory.resultText).content;
    const marker = /\[\.\.\. (\d+) characters truncated\]/.exec(rendered)!;
    expect(rendered).not.toContain("key200: value200");
    const [head, tail] = rendered.split(marker[0]!);
    const label = "[T1#t1] bash success: ";
    expect([...result].length - [...head!.slice(label.length)].length - [...tail!].length + 2).toBe(Number(marker[1]));
    // The address the label carries fetches the original through the unbounded `full` path.
    expect(memory.trace(`T${turn.id}#t1`, { full: true })).toContain("key200: value200");
  } finally { memory.close(); }
});

test("23: the profiles are the two shipped ones, and B is rejected above its ceiling", () => {
  expect([tier1.toolCallTokens, tier1.entryTokens]).toEqual([300, 10_000]);
  expect([tier2.toolCallTokens, tier2.entryTokens]).toEqual([100, 1000]);
  const open = (render: Record<string, number>) => sourceSeededMemory(":memory:", async () => ({ outcome: "success", output: "", request: {} }), { render });
  expect(() => open({ toolCallTokens: 1_001 })).toThrow("Invalid render.toolCallTokens: at most 1000");
  expect(() => open({ secondaryToolCallTokens: 1_001 })).toThrow("Invalid render.secondaryToolCallTokens: at most 1000");
  const ceiling = open({ toolCallTokens: 1_000 });
  try { expect(ceiling.config.render.toolCallTokens).toBe(1_000); } finally { ceiling.close(); }
  for (const value of [0, -1, 1.5, NaN, Infinity]) for (const key of ["toolCallTokens", "entryTokens", "secondaryToolCallTokens", "secondaryEntryTokens"]) {
    expect(() => open({ [key]: value })).toThrow("Invalid render.");
  }
});

// ---- 23c ruling 4: `full` is the same renderer with no budget ----

/** The one guard that demonstrably fires (ticket 23c, `full` cost): the token estimator is the only
 * caller of `String.prototype.split` in this module — a prototype method, unlike `tokens` itself,
 * which is module-internal and invisible to a spy on the export. Counting split calls around a render
 * therefore counts token measurement. It must be shown to fire on the budgeted path before its silence
 * on the unbounded one means anything, which is exactly what this test asserts, in that order. */
const splitCalls = (run: () => void): number => {
  const original = String.prototype.split;
  let count = 0;
  String.prototype.split = function (this: string, ...args: unknown[]) { count++; return original.apply(this, args as never); } as never;
  try { run(); } finally { String.prototype.split = original; }
  return count;
};

test("23c full cost: the unbounded path measures no tokens, while the budgeted path does", () => {
  const source = entry("assistant", "a reply", [call(1, "bash", { input: JSON.stringify({ command: "echo " + "x".repeat(200_000) }) })]);
  expect(splitCalls(() => renderEntry(source, tier1, extract))).toBeGreaterThan(0); // the guard fires
  expect(splitCalls(() => renderEntryWhole(source, extract))).toBe(0); // and is silent here
});

test("23c full cost: the unbounded path copies a 2 MB result as its label plus the stored bytes", () => {
  const stored = "z".repeat(2_000_000);
  const source = entry("toolResult", "", [call(1, "bash", { status: "success", result: stored })]);
  const started = process.hrtime.bigint();
  const rendered = renderEntryWhole(source).content; // the default extractor: the stored string as is
  expect(rendered).toBe(`[T7#t1] bash success: ${stored}`);
  expect(Number(process.hrtime.bigint() - started) / 1e6).toBeLessThan(2_000); // no bisection over 2 MB
});

test("23c: `full` and the budgeted path agree on the bytes when nothing has to yield", () => {
  const roomy = { toolCallTokens: 100_000, entryTokens: 1_000_000 };
  for (const source of [scanned[0]!, scanned[2]!, scanned[3]!,
    entry("toolResult", "", [call(1, "edit", { status: "success", result: envelope("Edited /tmp/x.ts", { diff: "-old\n+new" }) })])]) {
    expect(renderEntryWhole(source, extract).content).toBe(view(source, roomy));
    // And a sealed part is the same floor on both paths, though only one of them measures anything.
    const sealed = (address: string) => address.endsWith("#t2") ? "floor" as const : "render" as const;
    expect(renderEntryWhole(source, extract, sealed).content).toBe(renderEntry(source, roomy, extract, sealed).content);
  }
});
