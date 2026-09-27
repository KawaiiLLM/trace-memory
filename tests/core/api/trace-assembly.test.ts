// 23b: an explicit `trace` of a Turn without `full` is that Turn's selected source entries, in path
// order, each rendered by the entry renderer under the tier-1 profile. The per-tool branches of the
// old Turn preview — a read or search as its path, a bash command with its stdout and stderr, a report
// head and tail — and the tool-name regex that chose between them are gone, and so are the three
// budgets that shaped them. 23c makes `full` the same assembly through the renderer's unbounded path
// and the raw extractor: the same labels, nothing cut, every native occurrence its own entry, and
// `renderTurn` with its `tool=`/`omitted=` vocabulary deleted.
import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sourceSeededMemory, renderEntry, renderEntryWhole, type ConfigOverride , hydrate } from "../../source-fixture.ts";
import { wholeTrace } from "../../trace-pages.ts";

const time = "2026-09-09T00:00:00Z";
let directory: string, memory: ReturnType<typeof sourceSeededMemory>, sessionId: number;
const open = (config: ConfigOverride = {}) =>
  sourceSeededMemory(join(directory, "trace.db"), async () => { throw new Error("these cases call no model"); }, config);
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "trace-memory-23b-"));
  memory = open();
  const projectId = memory.store.createProject({ name: "assembly", declaredBy: "mark" }).id;
  sessionId = memory.store.createSession({ enrollmentChoice: true, host: "fake", startedAt: time, firstReplyAt: time, projectId }).id;
});
afterEach(() => { memory.close(); rmSync(directory, { recursive: true, force: true }); });

const header = (turnId: number) => `[S${sessionId}/T${turnId}] ${time} [turn]`;
const turn = (userPrompt: string, assistantText: string | null = null, parentTurnId: number | null = null) =>
  memory.store.appendTurn({ sessionId, parentTurnId, kind: "turn", userPrompt, assistantText, startedAt: time });
/** A native occurrence the fixture host records on its own, beside the ones the Turn shape mirrors. */
const occurrence = (turnId: number, nativeId: string, entry: Partial<Parameters<typeof memory.appendEntry>[0]>) =>
  memory.appendEntry({ sessionId, nativeLineage: "fixture", nativeId, turnId, role: "assistant", text: "", raw: "{}", calls: [], ...entry });

test("23b golden: a Turn with several assistant messages shows each one, in path order", () => {
  const t = turn("what changed?", "first reply");
  occurrence(t.id, "second-reply", { text: "second reply" });
  expect(memory.trace(`T${t.id}`)).toBe([header(t.id),
    `[T${t.id}#E1@user] user: what changed?`,
    `[T${t.id}#E2@assistant] assistant: first reply`,
    `[T${t.id}#E3@assistant] assistant: second reply`, `Raw: T${t.id}#E1..E3`].join("\n"));
});

test("23b golden: a call with several native result occurrences shows each occurrence", () => {
  const t = turn("run it");
  memory.store.appendToolCall({ turnId: t.id, name: "bash", input: JSON.stringify({ command: "echo hi" }), result: "first result", status: "success" });
  occurrence(t.id, "retry", { role: "toolResult", calls: [{ ordinal: 1, name: "bash", callId: "call-1", result: "second result", status: "failure" }] });
  const expected = [header(t.id),
    `[T${t.id}#E1@user] user: run it`,
    `[T${t.id}#E2@assistant] bash(command="echo hi")`,
    `[T${t.id}#E3@observation] bash success: first result`,
    `[T${t.id}#E4@observation] bash failure: second result`, `Raw: T${t.id}#E1..E4`].join("\n");
  // Results share a call ID, never an entry identity; full changes only compression.
  expect(memory.trace(`T${t.id}`)).toBe(expected);
  expect(memory.trace(`T${t.id}`, { full: true })).toBe(expected);
});

test("23b golden: a sibling branch's entries never appear in this branch's trace", () => {
  const t = turn("shared question", "shared reply");
  const shared = hydrate(memory.store.listSourceEntries(sessionId, t.id), memory.store).map(e => e.id);
  const sibling = occurrence(t.id, "sibling-reply", { text: "abandoned reply" });
  memory.selectEntries(sessionId, "main", shared);
  memory.selectEntries(sessionId, "fork", [...shared, sibling.id]);
  const bound = { sessionId, headTurnId: t.id, branch: "main" };
  expect(memory.trace(`T${t.id}`, bound)).toBe([header(t.id),
    `[T${t.id}#E1@user] user: shared question`,
    `[T${t.id}#E2@assistant] assistant: shared reply`, `Raw: T${t.id}#E1..E2`].join("\n"));
  expect(memory.trace(`T${t.id}`, { ...bound, branch: "fork" })).toContain("abandoned reply");
  // An unbound read names no branch and stays unrestricted, as 17a ruled for shared-call fork results.
  expect(memory.trace(`T${t.id}`)).toContain("abandoned reply");
});

test("93: whole-entry calls retain contents, and independent budgets emit honest expansion receipts", () => {
  const t = turn("two calls");
  memory.store.appendToolCall({ turnId: t.id, name: "bash", input: JSON.stringify({ command: "echo one" }), result: "output one", status: "success" });
  memory.store.appendToolCall({ turnId: t.id, name: "read", input: JSON.stringify({ file_path: "/tmp/x.md", content: "z".repeat(4000) }), result: "y".repeat(4000), status: "success" });
  const ordinary = memory.trace(`T${t.id}`);
  expect(ordinary).toContain(`file_path="/tmp/x.md"`);
  expect(ordinary).toContain("output one");
  const compressed = memory.trace(`T${t.id}`, { toolCallBudget: 24, toolResultBudget: 24 });
  expect(compressed).toContain(`T${t.id}: 2 omitted calls`);
  expect(compressed).toContain(`"address":"T${t.id}#E4"`);
  expect(compressed).toContain(`"address":"T${t.id}#E5"`);
  expect(memory.trace(`T${t.id}#E4`, { itemBudget: null, toolCallBudget: null, toolResultBudget: null })).toContain('/tmp/x.md');
});

test("23c golden: full is the same renderer with no budget — the same labels, the stored bytes uncut", () => {
  const t = turn("keep the evidence");
  const command = "echo " + "x".repeat(4_000);
  const input = JSON.stringify({ command, timeout: 30 });
  const result = JSON.stringify({ stdout: "z".repeat(4_000), exitCode: 0 });
  memory.store.appendToolCall({ turnId: t.id, name: "bash", input, result, status: "success" });
  // The arguments under the entry view's own labels, whole; the result text is the raw extractor's,
  // the stored string as it is, so a Pi envelope's `details` (an edit diff) appears here too.
  expect(memory.trace(`T${t.id}#E2,T${t.id}#E3`, { full: true }))
    .toBe(`[T${t.id}#E2@assistant] bash(command=${JSON.stringify(command)}, timeout=30)\n[T${t.id}#E3@observation] bash success: ${result}`);
  expect(memory.trace(`T${t.id}#E2,T${t.id}#E3`)).not.toContain(command); // without full, the same evidence under B
  // Each of the Turn's native entries, in entry order, is the unbounded path's rendering of it.
  const entries = hydrate(memory.store.listSourceEntries(sessionId, t.id), memory.store);
  expect(memory.trace(`T${t.id}`, { full: true }))
    .toBe([header(t.id), ...entries.map(e => renderEntryWhole(e).content), `Raw: T${t.id}#E1..E3`].join("\n"));
});

test("33: full is a compression alias and cannot change a bound read's selected branch",  () => {
  const t = turn("shared question", "shared reply");
  memory.store.appendToolCall({ turnId: t.id, name: "bash", input: JSON.stringify({ command: "echo main" }), result: "main result", status: "success" });
  const shared = hydrate(memory.store.listSourceEntries(sessionId, t.id), memory.store).map(e => e.id);
  const sibling = occurrence(t.id, "fork-result", { role: "toolResult",
    calls: [{ ordinal: 1, name: "bash", callId: "call-1", result: "fork result", status: "failure" }] });
  memory.selectEntries(sessionId, "main", shared);
  memory.selectEntries(sessionId, "fork", [...shared, sibling.id]);
  // The registered tool always passes the session's branch, so this is the bound reader's own read.
  const tool = memory.tools({ kind: "manual", sessionId, branch: "main", currentTurnId: t.id }).find(t => t.name === "trace")!;
  expect(tool.execute({ address: `T${t.id}`, full: true })).not.toContain("fork result");
  expect(memory.trace(`T${t.id}`, { full: true })).toContain("fork result"); // unbound reads remain unrestricted
  expect(tool.execute({ address: `T${t.id}` })).not.toContain("fork result");
  expect(tool.execute({ address: `T${t.id}` })).toContain("main result");
});

test("23c (GPT review 2026-09-09): a displayed non-text user address is readable on its own", () => {
  const t = turn("", "reply");
  memory.appendEntry({ sessionId, nativeLineage: "fixture", nativeId: "image", turnId: t.id, role: "user", text: "",
    raw: JSON.stringify({ role: "user", content: [{ type: "image", mimeType: "image/png", data: "synthetic" }] }), calls: [] });
  // The assembled read shows the address with the placeholder, so the explicit read of that one part
  // must agree — the existence check follows the displayed parts, not what a fact may cite.
  expect(memory.trace(`T${t.id}`)).toContain(`[T${t.id}#E2@user] user: [non-text content omitted]`);
  expect(memory.trace(`T${t.id}#E2@user`)).toBe(`[T${t.id}#E2@user] user: [non-text content omitted]`);
  // An assistant entry with no text of its own — only tool calls — displays no text part, and its
  // `#assistant` address stays unreadable: the placeholder is the user message's, not thinking's.
  const quiet = turn("q");
  memory.store.appendToolCall({ turnId: quiet.id, name: "bash", input: JSON.stringify({ command: "echo" }), result: "out", status: "success" });
  expect(memory.trace(`T${quiet.id}#E2@assistant`)).toContain(`bash(command="echo")`);
  expect(() => memory.trace(`T${quiet.id}#assistant`)).toThrow(/invalid public trace address/);
});

test("23b: a read of a tool result without full is the entry renderer's tier-1 rendering of that entry", () => {
  const t = turn("render me");
  memory.store.appendToolCall({ turnId: t.id, name: "bash", input: JSON.stringify({ command: "echo hi" }), result: "r".repeat(4_000), status: "success" });
  const entries = hydrate(memory.store.listSourceEntries(sessionId, t.id), memory.store);
  const views = entries.map(e => renderEntry(e, memory.config.render, memory.resultText).content);
  expect(memory.trace(`T${t.id}`)).toBe([header(t.id), ...views].join("\n") +
    `\n\nReceipts:\nT${t.id}: 1 omitted calls (including partial calls)\nexpand: trace({"address":"T${t.id}#E3","itemBudget":null,"toolCallBudget":null,"toolResultBudget":null})` + `\nRaw: T${t.id}#E1..E3`);
  const result = entries.find(e => e.role === "toolResult")!;
  expect(memory.trace(`T${t.id}#E3`)).toContain(renderEntry(result, memory.config.render, memory.resultText).content);
});

test("23b: the per-tool branches of the Turn preview, the tool-name regex and the stdout/stderr constants are gone from src", () => {
  const source = readFileSync(new URL("../../../src/core/render/index.ts", import.meta.url), "utf8");
  const code = source.split("\n").filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line)).join("\n");
  for (const gone of ["STDOUT_HEAD_TOKENS", "STDOUT_TAIL_TOKENS", "STDERR_TAIL_TOKENS",
    "read_file", "memoryWrite", "stdout", "stderr", "report", "commandTokens", "reportHeadTokens", "reportTailTokens"]) {
    expect([gone, code.includes(gone)]).toEqual([gone, false]);
  }
});

/** Count the paginator's prefix probes through the estimator's split calls, beside the fixed
 * address/line parsing calls. Entry-renderer tests separately pin full rendering's no-tokenizer path. */
const splitCalls = (run: () => void): number => {
  const original = String.prototype.split;
  let count = 0;
  String.prototype.split = function (this: string, ...args: unknown[]) { count++; return original.apply(this, args as never); } as never;
  try { run(); } finally { String.prototype.split = original; }
  return count;
};

test("full trace prices bounded page prefixes, not the entire pending single-line suffix", () => {
  const read = (characters: number, calls: number, options: Parameters<typeof memory.trace>[1]) => {
    const t = turn(`read ${characters}x${calls}`);
    for (let n = 0; n < calls; n++) {
      memory.store.appendToolCall({ turnId: t.id, name: "bash", input: JSON.stringify({ command: "echo" }),
        result: "y".repeat(characters), status: "success" });
    }
    return splitCalls(() => memory.trace(`T${t.id}`, options));
  };
  // The renderer still copies uncompressed strings; the outer paginator now estimates tokens.
  // Increasing an oversized single line by 100x does not increase the number of prefix probes.
  const small = read(50_000, 1, { full: true });
  // Draining a 2 MB stored result recovers its label plus every stored byte.
  const huge = turn("two megabytes");
  const stored = "z".repeat(2_000_000);
  memory.store.appendToolCall({ turnId: huge.id, name: "bash", input: "{}", result: stored, status: "success" });
  expect(wholeTrace(memory, `T${huge.id}#E2,T${huge.id}#E3`, { full: true })).toBe(`[T${huge.id}#E2@assistant] bash()\n[T${huge.id}#E3@observation] bash success: ${stored}`);
  expect(read(5_000_000, 1, { full: true })).toBe(small);
  expect(read(5_000, 20, {})).toBeGreaterThan(small);
});

/** Every `.ts` under `src/`, comment lines removed — the device `boundary.test.ts` uses for host
 * imports, widened from one file because 23c deletes vocabulary from three. */
const sourceCode = (): string => {
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
    .flatMap(e => e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []);
  return walk("src").map(file => readFileSync(file, "utf8").split("\n")
    .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line)).join("\n")).join("\n");
};

test("23c: renderTurn, the tool= / omitted= labels, the input:/result: blocks and the multiple-results merge are gone from src", () => {
  const code = sourceCode();
  for (const gone of ["renderTurn", "omitted=", "multiple results", '["input", call.input', "characters of input/result"]) {
    expect([gone, code.includes(gone)]).toEqual([gone, false]);
  }
});

test("23c: one marker family — no `[omitted ` and no `details omitted` is left in src", () => {
  const code = sourceCode();
  for (const gone of ["[omitted ", "details omitted", "middle not inspected"]) {
    expect([gone, code.includes(gone)]).toEqual([gone, false]);
  }
  expect(code).toContain("characters truncated]"); // and Pi's family is what replaced them
});

test("30: the B split and the second rendering tier are gone from src, and one marker family is left", () => {
  const code = sourceCode();
  // The shared call budget and its halves, the tier-2 profile and its block title, and the never-built
  // short-marker alternatives (a names-only view, a result-hiding switch, a low-budget `...` mode).
  // The three retired keys survive as removed settings and nowhere else, so what is closed here is
  // every read of them, the tier-2 title and the profile behind it.
  for (const gone of ["ARGUMENTS_SHARE", "config.render.toolCallTokens", "config.render.secondaryToolCallTokens",
    "config.render.secondaryEntryTokens", "secondaryRawTitle", "tier-2 entry views", "namesOnly", "hideResults"]) {
    expect([gone, code.includes(gone)]).toEqual([gone, false]);
  }
  expect(code).toContain("toolInputTokens");
  expect(code).toContain("toolResultTokens");
  // One omission marker family, computed while fitting, with a real character count.
  expect([...code.matchAll(/const truncated = [^\n]*/g)].map(m => m[0]))
    .toEqual(["const truncated = (characters: number) => `[... ${characters} characters truncated]`;"]);
});

test("23b 2026-09-09: the three explicit-preview budgets are rejected at load, by name, with the replacement named", () => {
  for (const key of ["commandTokens", "reportHeadTokens", "reportTailTokens"]) {
    expect(() => open({ render: { [key]: 2 } as never }))
      .toThrow(`Removed setting render.${key}: use render.toolInputTokens (the whole rendered call part) and render.toolResultTokens (the whole rendered result part)`);
  }
});
