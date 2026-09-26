import { expect, test } from "vitest";
import { ccInjectionLength, decodeCcInjection, encodeCcInjection, type CcVisibleBinding } from "../../src/hosts/cc/injection.ts";
import { transportItemText } from "../../src/core/render/material.ts";
import { sliceCcInjection, CC_SLICE_COUNT, CC_SLICE_LIMIT, CC_KNOWLEDGE_RECENCY_NOTICE } from "../../src/hosts/cc/slices.ts";
import type { TransportItem } from "../../src/core/render/material.ts";
import { renderKnowledgeBlock, tokens } from "../../src/core/render/index.ts";

const binding: CcVisibleBinding = { db: "unit-db", nativeSession: "native-66", coreSession: 1 };
const items: TransportItem[] = [
  ...Array.from({ length: 45 }, (_, i) => ({ kind: "knowledge" as const, text: `[K1@${i + 1}] ${"a".repeat(800)}`,
    category: "constraint", commitId: i + 1, address: `K1@${i + 1}` })),
  { kind: "fact", text: `[T1] selected facts\n[F2] ${"b".repeat(500)}`, factId: 2, pending: true },
  { kind: "raw", text: `[T1#E1@text] user: ${"c".repeat(500)}`, entryId: 3, address: "T1#E1", pending: true },
];

test("66 complete slices carry exact membership and single slot-one warning independently of completion order", () => {
  const slices = sliceCcInjection(binding, items, "pending Raw warning");
  expect(slices).toHaveLength(CC_SLICE_COUNT);
  expect(slices.filter(item => item?.systemMessage)).toHaveLength(1);
  expect(slices[0]?.systemMessage).toBe("pending Raw warning");
  const received = [...slices].reverse().filter(Boolean);
  const commits = new Set<number>(), facts = new Set<number>(), entries = new Set<number>();
  for (const slice of received) {
    const text = slice!.hookSpecificOutput.additionalContext;
    if (!text) continue;
    expect(text.length).toBeLessThanOrEqual(CC_SLICE_LIMIT);
    const decoded = decodeCcInjection(text, binding)!;
    expect(decoded).not.toBeNull();
    decoded.commits.forEach(id => commits.add(id)); decoded.factIds.forEach(id => facts.add(id));
    decoded.entryIds.forEach(id => entries.add(id));
  }
  expect([...commits].sort((a, b) => a - b)).toEqual(Array.from({ length: 45 }, (_, i) => i + 1));
  expect([...facts]).toEqual([2]); expect([...entries]).toEqual([3]);
  expect(sliceCcInjection(binding, items, "pending Raw warning")).toEqual(slices);
});

test("66 warning-only clear still emits one foreground notice, without pretending to deliver material", () => {
  const slices = sliceCcInjection(binding, [], "pending Facts warning");
  expect(slices[0]).toEqual({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "" },
    systemMessage: "pending Facts warning" });
  expect(slices.slice(1).every(item => item === null)).toBe(true);
});

test("66 omitted pending Raw is not delivered and warns in slot one", () => {
  const slices = sliceCcInjection(binding, [{ kind: "raw", entryId: 90, address: "T9#E1", pending: true,
    text: `[T9#E1@text] user: ${"y".repeat(12_000)}` }]);
  expect(slices[0]?.systemMessage).toBe("Trace Memory: inline transport omitted 1 pending Raw entry; omitted Raw remains pending for Noting.");
  expect(slices.filter(item => item?.systemMessage)).toHaveLength(1);
  expect(slices.filter(Boolean).flatMap(item => decodeCcInjection(item!.hookSpecificOutput.additionalContext, binding)?.entryIds ?? [])).toEqual([]);
  expect(slices.filter(Boolean).map(item => item!.hookSpecificOutput.additionalContext).join(" ")).toContain("expand: T9#E1");
});

test("92 fact-only transport omission preserves its count without promising extraction", () => {
  const text = `[F90] ${"y".repeat(12_000)}`;
  const slices = sliceCcInjection(binding, [{ kind: "fact", factId: 90, pending: true, text }]);
  expect(slices[0]?.systemMessage).toBe(`Trace Memory: inline transport omitted 1 fact (${tokens(text)} tokens).`);
  expect(slices.filter(item => item?.systemMessage)).toHaveLength(1);
  expect(slices.filter(Boolean).flatMap(item => decodeCcInjection(item!.hookSpecificOutput.additionalContext, binding)?.factIds ?? [])).toEqual([]);
});

test("66 legacy oversized omission receipt keeps its actual bounded expansion", () => {
  const receipt: TransportItem = { kind: "receipt", text: `omitted 120 older facts; expand: ${Array.from({ length: 120 }, (_, i) => `F${i + 1}`).join(", ")}${" ".repeat(12_000)}` };
  const slices = sliceCcInjection(binding, [receipt]);
  const contexts = slices.filter(Boolean).map(item => item!.hookSpecificOutput.additionalContext);
  expect(contexts.every(text => text.length <= CC_SLICE_LIMIT)).toBe(true);
  expect(contexts.join(" ")).toContain("omitted 120 items; expand: F1");
  expect(contexts.join(" ")).toContain("F120");
});

test("66 slice marker fits its extended host framing bound without changing the 10k UTF-16 cap", () => {
  const native: CcVisibleBinding = { db: "123456789:123456789", nativeSession: "12345678-1234-1234-1234-123456789012", coreSession: 123 };
  const base: TransportItem = { kind: "knowledge", category: "constraint", commitId: 1, address: "K1@1", text: "" };
  const frame = encodeCcInjection(native, { text: transportItemText(base, CC_KNOWLEDGE_RECENCY_NOTICE), knowledgeCommitIds: [1],
    factIds: [], entryIds: [], slice: [23, 24] });
  const oldFraming = frame.length - transportItemText(base, CC_KNOWLEDGE_RECENCY_NOTICE).length;
  expect(oldFraming).toBeGreaterThan(300 + 12);
  const short: CcVisibleBinding = { ...native, db: "1:2" };
  const shortFrame = encodeCcInjection(short, { text: transportItemText(base, CC_KNOWLEDGE_RECENCY_NOTICE), knowledgeCommitIds: [1],
    factIds: [], entryIds: [], slice: [0, 24] });
  for (const target of [9999, 10000, 10001]) {
    const item: TransportItem = { ...base, text: `${"x".repeat(target - shortFrame.length - 30)}😀` };
    const encode = () => { const text = transportItemText(item, CC_KNOWLEDGE_RECENCY_NOTICE);
      return encodeCcInjection(short, { text, knowledgeTokens: tokens(text), knowledgeCommitIds: [1],
        factIds: [], entryIds: [], slice: [0, 24] }); };
    while (encode().length < target) item.text = "x" + item.text;
    const exact = encode();
    expect(exact.length).toBe(target);
    const slices = sliceCcInjection(short, [item]);
    const contexts = slices.filter(Boolean).map(value => value!.hookSpecificOutput.additionalContext);
    expect(contexts.every(text => text.length <= 10000)).toBe(true);
    expect(contexts.flatMap(text => decodeCcInjection(text, short)?.commits ?? [])).toEqual(target <= 10000 ? [1] : []);
  }
});

test("92 CC placement prices the final single knowledge list, including exact UTF-16 boundaries", () => {
  const first: TransportItem = { kind: "knowledge", category: "reference", commitId: 1, address: "K1@v1", text: `[K1#aaaa] ${"a".repeat(3_000)}` };
  const emptySecond: TransportItem = { kind: "knowledge", category: "reference", commitId: 2, address: "K2@v1", text: "[K2#bbbb] " };
  const membership = { knowledgeCommitIds: [1, 2], factIds: [], entryIds: [], slice: [0, 24] as [number, number] };
  const body = (second: TransportItem) => renderKnowledgeBlock([first, second].map(item => ({ category: "items", text: item.text })), CC_KNOWLEDGE_RECENCY_NOTICE);
  const initial = encodeCcInjection(binding, { ...membership, text: body(emptySecond) }).length;
  for (const target of [9999, 10000, 10001]) {
    const second = { ...emptySecond, text: emptySecond.text + "x".repeat(target - initial - 30) + "😀" };
    const encode = () => encodeCcInjection(binding, { ...membership, text: body(second), knowledgeTokens: tokens(body(second)) });
    while (encode().length < target) second.text = "x" + second.text;
    const text = body(second);
    expect(ccInjectionLength(binding, { ...membership, knowledgeTokens: tokens(text) }, text.length)).toBe(target);
    expect(encode().length).toBe(target);
    const outputs = sliceCcInjection(binding, [first, second]);
    const actual = outputs.filter(Boolean).map(value => decodeCcInjection(value!.hookSpecificOutput.additionalContext, binding)!);
    expect(actual.flatMap(header => header.commits)).toEqual([1, 2]);
    expect(actual[0]!.commits).toEqual(target <= 10000 ? [1, 2] : [1]);
    expect(outputs.filter(Boolean).every(value => value!.hookSpecificOutput.additionalContext.length <= 10000)).toBe(true);
  }
});

test("92 CC knowledge is next-fit oldest-first by segment, while Raw and facts fill earlier gaps", () => {
  const knowledge = (id: number, size: number): TransportItem => ({ kind: "knowledge", category: "constraint", commitId: id,
    address: `K${id}@v1`, text: `[K${id}#aaaa] [constraint/project] ${"x".repeat(size)}` });
  const values: TransportItem[] = [knowledge(1, 6_000), knowledge(2, 5_000), knowledge(3, 500),
    { kind: "raw", address: "T8#E1", entryId: 8, pending: true, text: `[T8#E1@text] user: ${"r".repeat(500)}` },
    { kind: "fact", factId: 9, pending: true, text: `[F9] ${"f".repeat(500)}` }];
  const outputs = sliceCcInjection(binding, values);
  expect(outputs).toHaveLength(24);
  const received = [...outputs].reverse().filter(Boolean).map(output => {
    const text = output!.hookSpecificOutput.additionalContext;
    expect(text.length).toBeLessThanOrEqual(CC_SLICE_LIMIT);
    expect(text).not.toMatch(/K\d+@\d+/);
    const header = decodeCcInjection(text, binding)!;
    const bodies = [...text.matchAll(/\[K(\d+)#aaaa\]/g)].map(match => Number(match[1]));
    expect(bodies).toEqual(header.commits);
    if (bodies.length) {
      expect(text.split(CC_KNOWLEDGE_RECENCY_NOTICE)).toHaveLength(2);
      expect(text).toContain("Arrival order is not recency");
    }
    return { text, header };
  });
  const ordered = received.sort((a, b) => a.header.slice![0] - b.header.slice![0]);
  expect(ordered.flatMap(value => value.header.commits)).toEqual([1, 2, 3]);
  expect(ordered[0]!.header.commits).toEqual([1]);
  expect(ordered[1]!.header.commits).toEqual([2, 3]); // small K3 must not fill segment zero
  expect(ordered[0]!.header.factIds).toEqual([9]);
  expect(ordered[0]!.header.entryIds).toEqual([8]);
  expect(sliceCcInjection(binding, values)).toEqual(outputs);
});

test("92 CC sequential overflow retains newest whole knowledge and accounts only actual carriers", () => {
  const values: TransportItem[] = Array.from({ length: 80 }, (_, i) => ({ kind: "knowledge", category: "reference", commitId: i + 1,
    address: `K${i + 1}@v1`, text: `[K${i + 1}#aaaa] ${"x".repeat(4_500)}` }));
  values.push({ kind: "knowledge", category: "reference", commitId: 81, address: "K81@v1", text: `[K81#aaaa] ${"x".repeat(20_000)}` });
  const outputs = sliceCcInjection(binding, values);
  expect(outputs).toHaveLength(24);
  // A deterministic permutation of all 24 arrivals, not just the first two populated segments.
  const arrivals = Array.from({ length: 24 }, (_, i) => outputs[(i * 7) % 24]!);
  const decoded = arrivals.filter(Boolean).map(value => {
    const text = value!.hookSpecificOutput.additionalContext;
    expect(text.length).toBeLessThanOrEqual(CC_SLICE_LIMIT);
    expect(text).not.toMatch(/K\d+@\d+/);
    const header = decodeCcInjection(text, binding)!;
    expect([...text.matchAll(/\[K(\d+)#aaaa\]/g)].map(match => Number(match[1]))).toEqual(header.commits);
    return header;
  }).sort((a, b) => a.slice![0] - b.slice![0]);
  const retained = decoded.flatMap(value => value.commits);
  expect(retained.length).toBeGreaterThan(0);
  expect(retained.length).toBeLessThan(80);
  expect(retained).toEqual([...retained].sort((a, b) => a - b));
  expect(retained.at(-1)).toBe(80);
  expect(retained).toEqual(Array.from({ length: retained.length }, (_, i) => 81 - retained.length + i));
  const text = outputs.filter(Boolean).map(value => value!.hookSpecificOutput.additionalContext).join("\n");
  expect(text).toContain("omitted");
  expect(text).not.toContain("[K81#aaaa]");
  expect(new Set(retained).size).toBe(retained.length);
});

test("66 oversized whole item is not split or counted delivered", () => {
  const slices = sliceCcInjection(binding, [{ kind: "knowledge", category: "constraint", commitId: 50, address: "K50@50",
    text: `[K50@50] ${"x".repeat(12_000)}` }]);
  const decoded = slices.filter(Boolean).map(value => decodeCcInjection(value!.hookSpecificOutput.additionalContext, binding)!);
  expect(decoded.flatMap(value => value.commits)).toEqual([]);
  expect(slices.filter(Boolean).map(value => value!.hookSpecificOutput.additionalContext).join(" ")).toContain("omitted 1 whole items");
});
