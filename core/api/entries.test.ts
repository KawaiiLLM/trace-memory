import { expect, test } from "vitest";
import { TraceMemory, renderEntry, tokens, DEFAULT_CONFIG, type SourceEntry } from "./index.ts";

const source = (text: string, calls: SourceEntry["calls"] = []): SourceEntry => ({ id: 1, sessionId: 1, nativeLineage: "lineage", nativeId: "native", turnId: 1, role: "assistant", text, raw: text, calls });
const call = (ordinal: number, input: string) => ({ ordinal, name: "bash", callId: `native-call-${ordinal}`, status: "attempted", input });

test.each([
  ["ordinary text", "Start. A short ordinary entry. End.", []],
  ["CJK", "首部" + "文字".repeat(25000) + "尾部", []],
  ["one huge line", "HEAD" + "z".repeat(100000) + "TAIL", []],
  ["huge JSON argument", "A call", [call(1, JSON.stringify({ command: "HEAD" + "z".repeat(100000) + "TAIL", timeout: 42 }))]],
  ["many calls without natural text", "", Array.from({ length: 30 }, (_, i) => call(i + 1, "HEAD" + "z".repeat(10000) + "TAIL"))],
  ["several calls", "HEAD " + "word ".repeat(15000) + " TAIL", Array.from({ length: 7 }, (_, i) => call(i + 1, JSON.stringify({ command: "HEAD" + "z".repeat(10000) + "TAIL" })))],
] as const)("17a 2026-09-08: shared view bounds %s including source labels and omission markers", (_name, text, calls) => {
  const entry = source(text, [...calls]);
  const view = renderEntry(entry, DEFAULT_CONFIG.render).content;
  expect(tokens(view)).toBeLessThanOrEqual(10000);
  expect(view.startsWith('[S1/T1] [entry ["lineage","native"]]\n')).toBe(true);
  if (text) expect(view).toContain("[Source entry id: T1#assistant]");
  if (text.length > 10000) {
    const natural = view.split("[T1#t")[0]!;
    expect(natural).toContain(text.slice(0, 4)); expect(natural).toContain(text.slice(-4));
    expect(natural).toMatch(/\[omitted [1-9]\d* characters; middle not inspected\]/);
  } else expect(view).toContain(text);
  for (const c of calls) {
    const fragment = view.slice(view.indexOf(`[T1#t${c.ordinal}]`)).split(/\n(?=\[T1#t)/)[0]!;
    expect(tokens(fragment)).toBeLessThanOrEqual(499);
    expect(fragment).toContain(`tool=bash call=${c.callId} status=attempted arguments:`);
    expect(fragment).toMatch(/HEAD[\s\S]*\[omitted \d+ characters; middle not inspected\][\s\S]*TAIL/);
  }
});

test("17a 2026-09-08: fixed call portions bound arguments plus late result without changing the earlier view", () => {
  const argumentsEntry = source("assistant", [call(1, "HEAD" + "字".repeat(20000) + "TAIL")]);
  const resultEntry: SourceEntry = { ...argumentsEntry, id: 2, nativeId: "result", text: "", role: "toolResult", calls: [{ ordinal: 1, name: "bash", callId: "native-call-1", status: "failure", result: "HEAD" + "字".repeat(30000) + "TAIL" }] };
  const before = renderEntry(argumentsEntry, DEFAULT_CONFIG.render).content;
  const result = renderEntry(resultEntry, DEFAULT_CONFIG.render).content;
  expect(tokens(before.slice(before.indexOf("[T1#t1]")) + "\n" + result.slice(result.indexOf("[T1#t1]")))).toBeLessThanOrEqual(1000);
  expect(result).toContain("status=failure result:");
  expect(renderEntry(argumentsEntry, DEFAULT_CONFIG.render).content).toBe(before);
});

test("17a 2026-09-08: view configuration validates decimal limits and impossible metadata reports capacity", () => {
  expect([DEFAULT_CONFIG.render.toolCallTokens, DEFAULT_CONFIG.render.entryTokens]).toEqual([1000, 10000]);
  for (const value of [0, -1, 1.5, NaN, Infinity]) for (const key of ["toolCallTokens", "entryTokens"]) {
    expect(() => TraceMemory(":memory:", async () => ({ outcome: "success", output: "", request: {} }), { render: { [key]: value } })).toThrow("Invalid render.");
  }
  expect(() => renderEntry(source("large"), { ...DEFAULT_CONFIG.render, entryTokens: 1 })).toThrow("capacity");
});
