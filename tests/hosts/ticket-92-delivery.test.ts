import { expect, test } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { noVisibility } from "../../src/core/api/visible.ts";
import { injectionText, KNOWLEDGE_STATUS_TITLE, type TransportItem } from "../../src/core/render/material.ts";
import { tokens, renderKnowledgeBlock } from "../../src/core/render/index.ts";
import { visibleView } from "../../src/hosts/pi/visible.ts";
import { visibility } from "../../src/hosts/pi/index.ts";
import { decodeCcInjection, encodeCcInjection } from "../../src/hosts/cc/injection.ts";
import { sliceCcInjection, CC_KNOWLEDGE_RECENCY_NOTICE } from "../../src/hosts/cc/slices.ts";

const pi = { db: "fixture", session: 1, pi: "native" };
const cc = { db: "fixture", coreSession: 1, nativeSession: "native" };
const body = (id: number, size = 10) => `[K${id}#aaaa] [reference/global] ${"x".repeat(size)}`;
const knowledge = (id: number, size = 10): TransportItem => ({ kind: "knowledge", category: "reference", text: body(id, size), commitId: id, address: `K${id}@v1` });
const text = (id: number) => injectionText({ knowledge: [{ category: "reference", text: body(id) }], receipts: [] });

test("92 CC envelope digest binds its Knowledge accounting and body", () => {
  const current = encodeCcInjection(cc, { text: text(2), knowledgeTokens: tokens(text(2)), knowledgeCommitIds: [2] });
  expect(decodeCcInjection(current, cc)).toMatchObject({ commits: [2], knowledgeTokens: tokens(text(2)) });
  expect(decodeCcInjection(current.replace(/"t":\d+/, '"t":0'), cc)).toBeNull();
  expect(decodeCcInjection(current.replace(/"t":\d+/, '"t":null'), cc)).toBeNull();
  expect(decodeCcInjection(current.replace(body(2), "changed"), cc)).toBeNull();
});

test("92 each final CC slice charges its K framing and notices, not facts, Raw or other slices", () => {
  const state: TransportItem = { kind: "state", text: "K9@v1 is archived", address: "K9", receipt: { fromCommit: 9, toCommits: [10] } };
  const values: TransportItem[] = [state, knowledge(1, 6000), knowledge(2, 5000),
    { kind: "receipt", text: "omitted 1 reference knowledge; expand: K3", knowledge: true },
    { kind: "fact", factId: 20, pending: false, text: "[F20] " + "f".repeat(700) },
    { kind: "raw", entryId: 30, address: "T3#E1", pending: false, text: "[T3#E1] user: " + "r".repeat(700) }];
  const slices = sliceCcInjection(cc, values).filter(Boolean).map(slice => slice!.hookSpecificOutput.additionalContext);
  const headers = slices.map(slice => decodeCcInjection(slice, cc)!);
  expect(headers).toHaveLength(2);
  for (const header of headers) {
    const parts = [
      ...(header.states.length ? [`${KNOWLEDGE_STATUS_TITLE}\n${state.text}`] : []),
      renderKnowledgeBlock(values.filter(value => value.kind === "knowledge" && header.commits.includes(value.commitId))
        .map(value => ({ category: "reference", text: value.text })), CC_KNOWLEDGE_RECENCY_NOTICE),
      ...(header.slice![0] === 0 ? ["Receipts:\nomitted 1 reference knowledge; expand: K3"] : []),
    ].filter(Boolean);
    expect(header.knowledgeTokens).toBe(tokens(parts.join("\n\n")));
  }
});

test("92 one-block exact fit does not permit repeated K segment framing to exceed the remaining allowance", () => {
  const values = Array.from({ length: 24 }, (_, i) => knowledge(i + 1, 6000));
  const cap = tokens(renderKnowledgeBlock(values.map(value => ({ category: "reference", text: value.text }))));
  const unrestricted = sliceCcInjection(cc, values).filter(Boolean).map(slice => decodeCcInjection(slice!.hookSpecificOutput.additionalContext, cc)!);
  expect(unrestricted.reduce((sum, header) => sum + header.knowledgeTokens!, 0)).toBeGreaterThan(cap);
  for (const allowance of [cap, cap - 1000, 0]) {
    const outputs = sliceCcInjection(cc, values, undefined, allowance).filter(Boolean);
    const headers = outputs.map(slice => decodeCcInjection(slice!.hookSpecificOutput.additionalContext, cc)!);
    expect(headers.reduce((sum, header) => sum + header.knowledgeTokens!, 0)).toBeLessThanOrEqual(allowance);
    const ids = headers.flatMap(header => header.commits);
    expect(ids.length).toBeLessThan(24);
    expect(ids).toEqual(Array.from({ length: ids.length }, (_, i) => 25 - ids.length + i));
    for (const output of outputs) {
      expect(output!.hookSpecificOutput.additionalContext.length).toBeLessThanOrEqual(10000);
      const header = decodeCcInjection(output!.hookSpecificOutput.additionalContext, cc)!;
      expect([...output!.hookSpecificOutput.additionalContext.matchAll(/\[K(\d+)#aaaa\]/g)].map(match => Number(match[1]))).toEqual(header.commits);
    }
  }
});

test("92 Pi memo appends incrementally, navigation rebuilds, and a frozen admission survives later appends", () => {
  const manager = SessionManager.inMemory();
  manager.appendMessage({ role: "user", content: "start", timestamp: 0 });
  const first = manager.getLeafId()!;
  let builds = 0, lookups = 0;
  const get = visibility({ getLeafId: () => manager.getLeafId(), getEntry: id => { lookups++; return manager.getEntry(id); },
    buildContextEntries: () => { builds++; return manager.buildContextEntries(); } });
  get(pi);
  for (let i = 0; i < 20; i++) {
    manager.appendMessage({ role: "user", content: String(i), timestamp: i });
    get(pi);
  }
  const frozen = structuredClone(get(pi));
  manager.appendCustomMessageEntry("trace-memory", text(1), false,
    { traceMemory: { ...pi, supplied: { entries: [], factIds: [1], knowledgeCommitIds: [] } } });
  expect(get(pi).factIds.has(1)).toBe(true);
  expect(frozen.factIds.has(1)).toBe(false);
  const before = lookups;
  expect(lookups).toBe(21); // exactly the 20 messages plus the one new carrier
  for (let i = 0; i < 50; i++) get(pi);
  expect(lookups).toBe(before); expect(builds).toBe(1);
  const delivered = manager.getLeafId()!;
  manager.branch(first);
  expect(get(pi).factIds.size).toBe(0); expect(builds).toBe(2);
  manager.branch(delivered);
  // This standalone reader can extend a known ancestor to an existing descendant too. The
  // production tree-switch handler instead creates a fresh memo through restore().
  expect(get(pi).factIds.has(1)).toBe(true); expect(builds).toBe(2);
  expect(visibleView(manager.buildContextEntries(), pi)).toEqual(get(pi));
  expect(noVisibility().knowledgeCommitIds.size).toBe(0);
});
