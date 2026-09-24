import { expect, test } from "vitest";
import { DEFAULT_CONFIG, JoinedTokens, renderEntry, tokens, type EntryProfile, type ResultExtractor, type SourceEntry } from "../../../src/core/api/index.ts";

// Ticket 80 item 1, 22b's rule: "the estimate is still of one joined string, exactly as before —
// independently estimated views are never summed". `JoinedTokens`/`tokensJoined` are not a naive sum:
// this property test pins that they reproduce `tokens(parts.join(separator))` exactly, including at
// adversarial boundaries (trailing/leading whitespace and punctuation runs that could merge across a
// join) as well as on real `renderEntry` output.
const extract: ResultExtractor = (raw) => {
  const value = JSON.parse(raw) as { text: string; details?: unknown };
  return { text: value.text, ...(value.details === undefined ? {} : { details: JSON.stringify(value.details) }) };
};
const entry = (id: number, role: SourceEntry["role"], text: string, calls: SourceEntry["calls"] = []): SourceEntry =>
  ({ id, entryOrdinal: id, sessionId: 1, nativeLineage: "lineage", nativeId: `native-${id}`, turnId: 7, role, text, raw: "", calls, blocks: [
    ...(text ? [{ kind: "text" as const, text }] : role === "user" ? [{ kind: "marker" as const, text: "[non-text content omitted]" }] : []),
    ...calls.map(call => ({ kind: role === "toolResult" ? "result" as const : "call" as const, call })),
  ] });
const call = (ordinal: number, name: string, rest: Partial<SourceEntry["calls"][number]>) =>
  ({ ordinal, name, callId: `native-${ordinal}`, status: "attempted" as const, ...rest });
const envelope = (text: string, details?: unknown) => JSON.stringify({ text, ...(details === undefined ? {} : { details }) });
const view = (source: SourceEntry, profile: EntryProfile = DEFAULT_CONFIG.render) => renderEntry(source, profile, extract).content;

const check = (parts: readonly string[], separator = "\n\n") => {
  const counter = new JoinedTokens();
  parts.forEach((part, index) => { if (index) counter.add(separator); counter.add(part); });
  expect(counter.count).toBe(tokens(parts.join(separator)));
};

test("real renderEntry views of every kind, joined pairwise and as a growing batch", () => {
  const entries = [
    entry(1, "user", "看一下最新的导出。"),
    entry(2, "assistant", "sure, checking now."),
    entry(3, "assistant", "", [call(1, "search", { input: envelope("query terms") })]),
    entry(4, "toolResult", "", [call(1, "search", { result: envelope("result text here"), status: "ok" })]),
    entry(5, "user", "a message with trailing punctuation!!!"),
    entry(6, "assistant", "混合 mixed 内容 with CJK and ascii, plus 123456 digits."),
  ].map(source => view(source));
  for (let i = 0; i < entries.length; i++) for (let j = i; j < entries.length; j++) check(entries.slice(i, j + 1));
  check(entries);
});

test("adversarial boundaries: trailing/leading whitespace and punctuation runs at a join", () => {
  const cases: (readonly string[])[] = [
    ["hello\n\n\n", "world"], // trailing newlines meeting the "\n\n" separator
    ["hello   ", "world"], // trailing horizontal whitespace
    ["hello.", ".world"], // punctuation meeting punctuation across the separator
    ["a", "b", "c", "d"], // several short pieces
    ["", "hello"], // an empty first part
    ["hello", ""], // an empty last part
    ["", ""], // both empty
    ["   "], // a single whitespace-only part (the `alone` edge case)
    ["a".repeat(2000) + "\n".repeat(20), "\n".repeat(5) + "b".repeat(2000)], // long merges on both sides
  ];
  for (const parts of cases) check(parts);
});

test("removing rendered-view prefixes stays exact across punctuation and whitespace boundaries", () => {
  const views = [
    entry(1, "user", "one!!!  "), entry(2, "assistant", "  二\n\n"),
    entry(3, "assistant", "three..."), entry(4, "user", "  four\t"),
    entry(5, "user", "五??"),
  ].map(source => view(source));
  const samples = [...views, "", "\n\n", "hello!!!  ", " \t..\n", "\n".repeat(18)];
  let seed = 923, parts: string[] = [];
  const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0);
  const counter = new JoinedTokens();
  for (let i = 0; i < 500; i++) {
    if (parts.length && random() % 3 === 0) {
      const count = 1 + random() % parts.length;
      const removed = parts.slice(0, count);
      const characters = removed.reduce((sum, part) => sum + part.length, 0)
        + Math.min(count, parts.length - 1) * 2;
      // Each removed part owns its following separator, except the last part of an empty suffix.
      counter.removePrefix(characters);
      parts = parts.slice(count);
    } else {
      const part = samples[random() % samples.length]!;
      if (parts.length) counter.add("\n\n");
      counter.add(part);
      parts.push(part);
    }
    expect(counter.count, `step ${i}; parts: ${JSON.stringify(parts)}`).toBe(tokens(parts.join("\n\n")));
  }
});

test("nonempty rendered views have boundary-exact terminal/followed weights", () => {
  const views = [
    entry(1, "user", "one!!!  "), entry(2, "assistant", "two\n\n"),
    entry(3, "assistant", "three..."), entry(4, "user", "  four\t"),
    entry(5, "user", "五??"),
  ].map(source => view(source));
  const suffixes = ["", " ", "\t", "\n", "\n".repeat(30), "!  ", "  !\t\n"];
  const samples = views.flatMap(text => suffixes.map(suffix => text + suffix));
  for (let start = 0; start < samples.length; start++) {
    for (let length = 1; length <= 6; length++) {
      const parts = Array.from({ length }, (_, i) => samples[(start + i * 7) % samples.length]!);
      const expected = tokens(parts.join("\n\n"));
      const terminal = tokens(parts.at(-1)!);
      const followed = parts.slice(0, -1).reduce((sum, part) => sum + tokens(part + "\n\n[") - tokens("["), 0);
      expect(followed + terminal, JSON.stringify(parts)).toBe(expected);
    }
  }
  // An empty assistant message has no source parts: it is a real rendered view but breaks
  // the fixed-sentinel assumption by coalescing multiple adjacent newline separators.
  expect(view(entry(99, "assistant", ""))).toBe("");
});

test("a direct append matches string concatenation for a running total", () => {
  const counter = new JoinedTokens();
  const pieces = ["[T1#E1@text] user: first", "\n\n", "[T1#E2@text] assistant: second\n", "\n\n", "[T1#E3@text] user: third"];
  let joined = "";
  for (const piece of pieces) { counter.add(piece); joined += piece; expect(counter.count).toBe(tokens(joined)); }
});
