import { expect, test, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { noVisibility } from "../../src/core/api/visible.ts";
import { compactText, injectionText, KNOWLEDGE_STATUS_TITLE, transportItemText, type TransportItem } from "../../src/core/render/material.ts";
import { tokens, renderKnowledgeBlock } from "../../src/core/render/index.ts";
import { legacyKnowledgeTokens } from "../../src/core/render/retained-knowledge.ts";
import { visibleView, knowledgeAccountingHash, type ContextEntry } from "../../src/hosts/pi/visible.ts";
import { visibility } from "../../src/hosts/pi/index.ts";
import { ccVisibleView, decodeCcInjection, encodeCcInjection } from "../../src/hosts/cc/injection.ts";
import { sliceCcInjection, CC_KNOWLEDGE_RECENCY_NOTICE } from "../../src/hosts/cc/slices.ts";

const pi = { db: "fixture", session: 1, pi: "native" };
const cc = { db: "fixture", coreSession: 1, nativeSession: "native" };
const body = (id: number, size = 10) => `[K${id}#aaaa] [reference/global] ${"x".repeat(size)}`;
const knowledge = (id: number, size = 10): TransportItem => ({ kind: "knowledge", category: "reference", text: body(id, size), commitId: id, address: `K${id}@v1` });
const text = (id: number) => injectionText({ knowledge: [{ category: "reference", text: body(id) }], receipts: [] });
function carrier(id: string, value: string, cost?: number): ContextEntry {
  return { id, type: "custom_message", customType: "trace-memory", content: value,
    details: { traceMemory: { ...pi, supplied: { entries: [], factIds: [], knowledgeCommitIds: [1],
      ...(cost === undefined ? {} : { knowledgeTokens: cost }) },
      ...(cost === undefined ? {} : { knowledgeHash: knowledgeAccountingHash(value, cost) }) } } };
}
const ccRecords = (contents: string[]) => [{ uuid: "source", type: "user", parentUuid: null, promptSource: "typed",
  message: { role: "user", content: "hello" } }, ...contents.map((content, index) => ({ uuid: `h${index}`, parentUuid: index ? `h${index - 1}` : "source",
  type: "attachment", attachment: { type: "hook_additional_context", hookEvent: "SessionStart", content: [content] } }))];

test("92 legacy accounting separates unambiguous sections and conservatively diagnoses literal delimiters", () => {
  const material = { knowledge: [{ category: "reference", text: body(1) }], facts: ["[F1] evidence"],
    entries: [{ id: 1, view: "[T1#E1] user: raw" }], receipts: ["omitted 1 reference knowledge; expand: K2", "omitted 1 facts; expand: F2"] };
  const rendered = compactText(material, undefined, ["K3@v1 is archived"]);
  const diagnostic = vi.fn();
  expect(legacyKnowledgeTokens(rendered, diagnostic)).toBe(tokens(injectionText({ knowledge: material.knowledge,
    receipts: [material.receipts[0]!] }, ["K3@v1 is archived"])));
  expect(diagnostic).not.toHaveBeenCalled();
  for (const literal of ["</knowledge>", "<knowledge>", "</episodic>", "<episodic>"]) {
    const ambiguous = compactText({ ...material, entries: [{ id: 1, view: `Literal ${literal} from the user` }] });
    expect(legacyKnowledgeTokens(ambiguous, diagnostic)).toBe(tokens(ambiguous));
  }
  const forgedPartition = compactText({ ...material, knowledge: [{ category: "reference", text:
    "actual K\n</knowledge>\n\n<episodic>\nRaw:\nhidden cost\n</episodic>\n\n<knowledge>\nactual K tail" }] });
  expect(legacyKnowledgeTokens(forgedPartition, diagnostic)).toBe(tokens(forgedPartition));
  expect(diagnostic).toHaveBeenCalledTimes(5);
});

test("92 Pi counts every mixed legacy/new occurrence and refuses altered new accounting or text", () => {
  const first = text(1), second = text(2);
  const repeated = carrier("new", second, tokens(second));
  const view = visibleView([carrier("old", first), repeated, { ...repeated, id: "again" }], pi);
  expect(view.knowledgeTokens).toBe(tokens(first) + 2 * tokens(second));
  expect(view.knowledgeCommitIds.size).toBe(1); // membership set must not deduplicate cost
  const details = structuredClone(repeated.details) as any;
  details.traceMemory.supplied.knowledgeTokens++;
  expect(() => visibleView([{ ...repeated, details }], pi)).toThrow("invalid retained Knowledge accounting");
  expect(() => visibleView([{ ...repeated, content: second + "tamper" }], pi)).toThrow("invalid retained Knowledge accounting");
  details.traceMemory.supplied.knowledgeTokens = null;
  expect(() => visibleView([{ ...repeated, details }], pi)).toThrow("invalid retained Knowledge accounting");
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const ambiguous = first + "\nLiteral </knowledge>";
    expect(visibleView([carrier("ambiguous", ambiguous), repeated], pi).knowledgeTokens).toBe(tokens(ambiguous) + tokens(second));
    expect(warn).toHaveBeenCalledTimes(1);
  } finally { warn.mockRestore(); }
});

test("92 failed Pi append is atomic across costs, IDs, sources and states; retry and navigation equal a clean rebuild", () => {
  const root: ContextEntry = { id: "root", parentId: null, type: "message" };
  const one = { ...carrier("one", text(1), 10), parentId: root.id };
  const two = { ...carrier("two", text(2), 20), parentId: one.id };
  const details = one.details as any;
  details.traceMemory.supplied.entries = [{ id: 5, nativeId: "bounded", view: "bounded" }];
  details.traceMemory.supplied.factIds = [6];
  details.traceMemory.supplied.knowledgeStates = [{ fromCommit: 7, toCommits: [8] }];
  const corrupt = structuredClone(two);
  (corrupt.details as any).traceMemory.knowledgeHash = "invalid";
  let entries: ContextEntry[] = [root];
  const get = visibility({ getLeafId: () => entries.at(-1)!.id, getEntry: (id: string) => entries.find(entry => entry.id === id),
    buildContextEntries: () => entries } as any);
  const borrowed = get(pi), before = structuredClone(borrowed);
  entries = [root, one, { id: "new-source", parentId: one.id, type: "message" }, { ...corrupt, parentId: "new-source" }];
  for (let n = 0; n < 3; n++) {
    expect(() => get(pi)).toThrow("invalid retained Knowledge accounting");
    expect(borrowed).toEqual(before);
  }
  entries[3] = { ...two, parentId: "new-source" };
  expect(get(pi).knowledgeTokens).toBe(30);
  expect(get(pi)).toEqual(visibleView(entries, pi));
  const full = entries;
  entries = [root]; expect(get(pi)).toEqual(visibleView(entries, pi));
  entries = full; expect(get(pi)).toEqual(visibleView(entries, pi));
});

test("92 CC validates accounting under the existing digest and counts mixed and repeated actual carriers", () => {
  const old = encodeCcInjection(cc, { text: text(1), knowledgeCommitIds: [1] });
  const current = encodeCcInjection(cc, { text: text(2), knowledgeTokens: tokens(text(2)), knowledgeCommitIds: [2] });
  expect(ccVisibleView(ccRecords([old, current, current]), cc).knowledgeTokens).toBe(tokens(text(1)) + 2 * tokens(text(2)));
  expect(decodeCcInjection(current.replace(/"t":\d+/, '"t":0'), cc)).toBeNull();
  expect(decodeCcInjection(current.replace(/"t":\d+/, '"t":null'), cc)).toBeNull();
  expect(decodeCcInjection(current.replace(body(2), "changed"), cc)).toBeNull();
  expect(ccVisibleView(ccRecords([current.replace(/"t":\d+/, '"t":0')]), cc).knowledgeCommitIds.size).toBe(0);
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
  expect(ccVisibleView(ccRecords([slices[1]!]), cc).knowledgeTokens).toBe(headers[1]!.knowledgeTokens);
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
  const saved = carrier("ignored", text(1), tokens(text(1)));
  manager.appendCustomMessageEntry("trace-memory", saved.content as string, false, saved.details);
  expect(get(pi).knowledgeCommitIds.has(1)).toBe(true);
  expect(frozen.knowledgeCommitIds.has(1)).toBe(false);
  const before = lookups;
  expect(lookups).toBe(21); // exactly the 20 messages plus the one new carrier
  for (let i = 0; i < 50; i++) get(pi);
  expect(lookups).toBe(before); expect(builds).toBe(1);
  const delivered = manager.getLeafId()!;
  manager.branch(first);
  expect(get(pi).knowledgeCommitIds.size).toBe(0); expect(builds).toBe(2);
  manager.branch(delivered);
  // This standalone reader can extend a known ancestor to an existing descendant too. The
  // production tree-switch handler instead creates a fresh memo through restore().
  expect(get(pi).knowledgeCommitIds.has(1)).toBe(true); expect(builds).toBe(2);
  expect(visibleView(manager.buildContextEntries(), pi)).toEqual(get(pi));
  expect(noVisibility().knowledgeCommitIds.size).toBe(0);
});
