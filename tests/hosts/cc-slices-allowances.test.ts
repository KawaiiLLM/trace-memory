import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { decodeCcInjection, encodeCcInjection, type CcVisibleBinding } from "../../src/hosts/cc/injection.ts";
import { sliceCcInjection } from "../../src/hosts/cc/slices.ts";
import type { TransportItem } from "../../src/core/render/material.ts";

// 182: CC preserves two independent caps, the base and the one shared temporary pool; t/u record their charges.

const binding: CcVisibleBinding = { db: "unit-db", nativeSession: "native-144", coreSession: 1 };
type K = Extract<TransportItem, { kind: "knowledge" }>;
const knowledge = (commitId: number, rank: number, allowance: "base" | "temporary", size = 200, over: Partial<K> = {}): K => ({ kind: "knowledge", commitId,
  text: `[K${commitId}@${commitId}] ${"word ".repeat(Math.ceil(size / 5))}`, category: "constraint", scope: "project", address: `K${commitId}@${commitId}`, form: "body", allowance, rank, ...over });
const decoded = (slices: ReturnType<typeof sliceCcInjection>) => slices.flatMap(slice => {
  const text = slice?.hookSpecificOutput.additionalContext;
  return text ? [decodeCcInjection(text, binding)!] : [];
});
const sum = (slices: ReturnType<typeof sliceCcInjection>, key: "knowledgeTokens" | "temporaryTokens") =>
  decoded(slices).reduce((total, header) => total + (header[key] ?? 0), 0);
const commits = (slices: ReturnType<typeof sliceCcInjection>) => decoded(slices).flatMap(header => header.commits).sort((a, b) => a - b);

test("a high-score old item outranks a low-score new one when the base cap trims", () => {
  const items = [knowledge(1, 0, "base", 800), knowledge(9, 1, "base", 800), knowledge(10, 2, "base", 800)]; // commit 1 has the best rank; 10 is newest
  const two = sum(sliceCcInjection(binding, items.slice(0, 2)), "knowledgeTokens"); // room for the two best ranks
  const cap = two + 100; // and the receipt that names what the capacity left out
  const trimmed = sliceCcInjection(binding, items, undefined, cap, Infinity);
  expect(commits(trimmed)).toEqual([1, 9]);
  const old = sliceCcInjection(binding, items.map(item => ({ ...item, rank: undefined })), undefined, cap, Infinity); // no rank: newest commit first, as before 144
  expect(commits(old)).toEqual([9, 10]);
});

test("base full with temporary room: temporary items are delivered and both caps hold", () => {
  const items = [knowledge(1, 0, "base"), knowledge(2, 1, "temporary"), knowledge(3, 2, "temporary", 200, { form: "title", text: "[K3@3] [constraint/project] (title only) T" })];
  const baseOnly = sum(sliceCcInjection(binding, [items[0]!]), "knowledgeTokens");
  const slices = sliceCcInjection(binding, items, undefined, baseOnly, 400);
  expect(commits(slices)).toEqual([1, 2]);
  expect(decoded(slices).flatMap(header => header.titles)).toEqual([3]);
  expect(sum(slices, "knowledgeTokens")).toBeLessThanOrEqual(baseOnly);
  expect(sum(slices, "temporaryTokens")).toBeGreaterThan(0);
  expect(sum(slices, "temporaryTokens")).toBeLessThanOrEqual(400);
});

test("a slice with only temporary items charges its framing to u, and t is zero", () => {
  const slices = sliceCcInjection(binding, [knowledge(2, 0, "temporary")]);
  expect(sum(slices, "knowledgeTokens")).toBe(0);
  expect(sum(slices, "temporaryTokens")).toBeGreaterThan(tokens("[K2@2]"));
});

test("framing repeated across slices with base items removes the lowest-ranked base items, never a temporary one", () => {
  // Big items force several slices, each repeating the block framing.
  const base = Array.from({ length: 6 }, (_, i) => knowledge(i + 1, i, "base", 4_000));
  const temporary = [knowledge(20, 6, "temporary", 4_000)];
  const items = [...base, ...temporary];
  const all = sliceCcInjection(binding, items);
  const whole = sum(all, "knowledgeTokens");
  const trimmed = sliceCcInjection(binding, items, undefined, Math.floor(whole * 0.6), Infinity);
  expect(sum(trimmed, "knowledgeTokens")).toBeLessThanOrEqual(Math.floor(whole * 0.6));
  expect(commits(trimmed)).toContain(20); // the temporary item was not evicted for the base cap
  expect(commits(trimmed)).toContain(1); // the highest rank stays
  expect(commits(trimmed)).not.toContain(6);
});

test("the receipt for a temporary item the slice cannot carry is charged to the temporary allowance, not the base", () => {
  const items = [knowledge(2, 0, "temporary"), knowledge(3, 1, "temporary", 200_000)]; // the second fits no slice
  const slices = sliceCcInjection(binding, items, undefined, 0, 1_000); // Knowledge base 0, temporary room
  expect(commits(slices)).toEqual([2]); // the base check did not evict the temporary item
  const text = slices.map(slice => slice?.hookSpecificOutput.additionalContext ?? "").join("");
  expect(text).toContain("trace://K3@3"); // the omission is named
  expect(sum(slices, "knowledgeTokens")).toBe(0);
  expect(sum(slices, "temporaryTokens")).toBeLessThanOrEqual(1_000);
});

test("an oversized overflow body's receipt uses the shared pool and preserves base knowledge", () => {
  const base = knowledge(1, 0, "base");
  const slices = sliceCcInjection(binding, [base, knowledge(2, 1, "temporary", 12_000)], undefined, 20_000, 10_000);
  expect(commits(slices)).toEqual([1]);
  expect(slices.map(slice => slice?.hookSpecificOutput.additionalContext ?? "").join("")).toContain("trace://K2@2");
  expect(sum(slices, "knowledgeTokens")).toBe(sum(sliceCcInjection(binding, [base]), "knowledgeTokens"));
  expect(sum(slices, "temporaryTokens")).toBeGreaterThan(0);
});

test("a base item omitted for capacity charges its receipt to the base, and the resulting overrun evicts base items, never the temporary one", () => {
  const a = knowledge(1, 0, "base"), t = knowledge(2, 1, "temporary"), huge = knowledge(3, 2, "base", 200_000); // the huge one fits no slice
  const baseOnly = sum(sliceCcInjection(binding, [a]), "knowledgeTokens"); // A fills the base to the token
  const slices = sliceCcInjection(binding, [a, t, huge], undefined, baseOnly, Infinity);
  expect(commits(slices)).toContain(2); // T was not evicted for the base cap
  expect(sum(slices, "knowledgeTokens")).toBeLessThanOrEqual(baseOnly);
  expect(slices.map(slice => slice?.hookSpecificOutput.additionalContext ?? "").join("")).toContain("trace://K3@3"); // the omission is named
});

test("Raw omitted for capacity lowers u", () => {
  const raw = (entryId: number, size: number): TransportItem => ({ kind: "raw", text: `[T1#E${entryId}] ${"r".repeat(size)}`, entryId, address: `T1#E${entryId}`, pending: true, allowance: "temporary", charge: 100 });
  const kept = sum(sliceCcInjection(binding, [raw(1, 200)]), "temporaryTokens");
  expect(kept).toBe(100);
  const huge = sliceCcInjection(binding, [raw(1, 200), raw(2, 200_000)]); // the second cannot fit any slice
  expect(sum(huge, "temporaryTokens")).toBe(100);
});

test("the wire digest protects the pool charge and still accepts old carriers, including a pointer charge they carry", () => {
  const text = encodeCcInjection(binding, { text: "body", knowledgeCommitIds: [1], knowledgeTitleCommitIds: [2, 3], knowledgeTokens: 11, temporaryTokens: 7 });
  const header = decodeCcInjection(text, binding)!;
  expect(header).toMatchObject({ commits: [1], titles: [2, 3], knowledgeTokens: 11, temporaryTokens: 7 });
  const plain = decodeCcInjection(encodeCcInjection(binding, { text: "body", knowledgeCommitIds: [1], knowledgeTokens: 11 }), binding)!;
  expect(plain.titles).toEqual([]);
  expect(plain.temporaryTokens).toBeUndefined();
  expect(decodeCcInjection(text.replace('"u":7', '"u":8'), binding)).toBeNull(); // the digest covers the accounting
  expect(text).not.toContain('"v":'); // 182: no writer emits a pointer charge
  // A carrier written before 182 names its pointer charge in `v`, covered by the same digest.
  const lines = text.split("\n"), at = lines.findIndex(line => line.includes('"h":"'));
  const wire = JSON.parse(lines[at]!.slice(lines[at]!.indexOf("{")));
  const legacy = (pointer: number, claimed = pointer) => {
    const sealed = { ...wire, v: claimed, h: createHash("sha256").update(JSON.stringify([11, 7, [2, 3], "body", pointer]), "utf8").digest("hex") };
    return [...lines.slice(0, at), lines[at]!.slice(0, lines[at]!.indexOf("{")) + JSON.stringify(sealed), ...lines.slice(at + 1)].join("\n");
  };
  expect(decodeCcInjection(legacy(9), binding)).toMatchObject({ temporaryTokens: 7, pointerTokens: 9 });
  expect(decodeCcInjection(legacy(9, 10), binding)).toBeNull();
});

test("182: shared-pool trimming drops the title before the body that ranks ahead of it", () => {
  const body = knowledge(1, 0, "temporary", 400);
  const title = knowledge(2, 1, "temporary", 200, { form: "title", text: "[K2@2] [constraint/project] (title only) Title" });
  const both = sum(sliceCcInjection(binding, [body, title]), "temporaryTokens");
  const bodyOnly = sum(sliceCcInjection(binding, [body]), "temporaryTokens");
  expect(bodyOnly).toBeLessThan(both);
  const roomy = sliceCcInjection(binding, [body, title], undefined, Infinity, both);
  expect(commits(roomy)).toEqual([1]);
  expect(decoded(roomy).flatMap(header => header.titles)).toEqual([2]);
  const tight = sliceCcInjection(binding, [body, title], undefined, Infinity, both - 1);
  expect(commits(tight)).toEqual([1]); // the body kept
  expect(decoded(tight).flatMap(header => header.titles)).toEqual([]); // the lowest-ranked item, the title, went
  expect(sum(tight, "temporaryTokens")).toBeLessThanOrEqual(both - 1);
  const none = sliceCcInjection(binding, [body, title], undefined, Infinity, 1);
  expect(commits(none)).toEqual([]);
});

const tokens = (text: string): number => text.length;
