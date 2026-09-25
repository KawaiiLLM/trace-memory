import { expect, test } from "vitest";
import { decodeCcInjection, type CcVisibleBinding } from "../../src/hosts/cc/injection.ts";
import { sliceCcInjection, CC_SLICE_COUNT, CC_SLICE_LIMIT } from "../../src/hosts/cc/slices.ts";
import type { TransportItem } from "../../src/core/render/material.ts";

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
  expect(slices[0]?.systemMessage).toContain("1 pending Raw entry");
  expect(slices.filter(item => item?.systemMessage)).toHaveLength(1);
  expect(slices.filter(Boolean).flatMap(item => decodeCcInjection(item!.hookSpecificOutput.additionalContext, binding)?.entryIds ?? [])).toEqual([]);
  expect(slices.filter(Boolean).map(item => item!.hookSpecificOutput.additionalContext).join(" ")).toContain("expand: T9#E1");
});

test("66 oversized whole item is not split or counted delivered", () => {
  const slices = sliceCcInjection(binding, [{ kind: "knowledge", category: "constraint", commitId: 50, address: "K50@50",
    text: `[K50@50] ${"x".repeat(12_000)}` }]);
  const decoded = slices.filter(Boolean).map(value => decodeCcInjection(value!.hookSpecificOutput.additionalContext, binding)!);
  expect(decoded.flatMap(value => value.commits)).toEqual([]);
  expect(slices.filter(Boolean).map(value => value!.hookSpecificOutput.additionalContext).join(" ")).toContain("omitted 1 whole items");
});
