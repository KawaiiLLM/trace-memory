// 22c: an explicit read does the work the caller asked for. A full tool trace obtains the target
// Turn's native occurrences once and reuses them across its tool ordinals; a knowledge search applies
// the page cap before it formats a hit and resolves the commit graph once per query, so a later page
// still carries the labels that query established. Nothing here changes what the reads print.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as render from "../../../src/core/render/index.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sourceSeededMemory } from "../../source-fixture.ts";
import { suppliedHandles } from "../../dreaming-skips.ts";
import { countSourceReads, countGraphResolutions } from "../../perf/fixture.ts";
import { AdmittedDreamerScenarios, createDreamerTrigger } from "../../admitted-dreamer-scenario.ts";

const time = "2026-09-09T00:00:00Z";

function fullRead(tool: { execute(input: unknown): string }, address: string) {
  let page = tool.execute({ address, full: true, itemBudget: null });
  for (let cursor = /cursor=(\S+)/.exec(page)?.[1]; cursor; cursor = /cursor=(\S+)/.exec(page)?.[1])
    page = tool.execute({ address: `cursor=${cursor}`, itemBudget: null });
}
let dir: string, dbPath: string, memory: ReturnType<typeof sourceSeededMemory>, scenarios: AdmittedDreamerScenarios;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "trace-memory-22c-"));
  dbPath = join(dir, "trace.db");
  scenarios = new AdmittedDreamerScenarios(async () => { throw new Error("these cases call no model"); });
  memory = sourceSeededMemory(dbPath, scenarios.agent);
});
afterEach(() => { memory.close(); rmSync(dir, { recursive: true, force: true }); });

/** Count actual preview rendering, not immutable identity capture for later pages. */
function countFormattedHits() {
  const preview = vi.spyOn(render, "renderKnowledgePreview");
  return { hits: () => preview.mock.calls.length, reset: () => preview.mockClear(), restore: () => preview.mockRestore() };
}

/** A session of `turns` Turns; the middle one carries `calls` tool calls and a second native result
 * occurrence of its first call — the shape a full trace must render as two entries (23c: the
 * `multiple results` merge is gone; each native occurrence is its own entry, as the assembled read
 * already showed it). */
function conversation(turns: number, calls: number) {
  const store = memory.store;
  const projectId = store.createProject({ name: `p${turns}x${calls}`, declaredBy: "marker" }).id;
  const session = store.createSession({ enrollmentChoice: true, host: "fake", startedAt: time, firstReplyAt: time, projectId });
  let parent: number | null = null, heavy = 0;
  for (let i = 0; i < turns; i++) {
    const turn = store.appendTurn({ sessionId: session.id, parentTurnId: parent, kind: "turn", userPrompt: `prompt ${i}`, startedAt: time });
    const many = i === Math.floor(turns / 2);
    for (let n = 0; n < (many ? calls : 1); n++) {
      store.appendToolCall({ turnId: turn.id, name: "read", input: `{"n":${n}}`, result: `result ${i}.${n}`, status: "success" });
    }
    store.updateTurn(turn.id, { assistantText: `answer ${i}`, endedAt: time });
    if (many) {
      heavy = turn.id;
      const first = store.listToolCalls(turn.id)[0]!;
      const calls = [{ ordinal: first.ordinal, name: first.name, callId: `call-${first.id}`, result: "the second occurrence", status: "success" }];
      memory.appendEntry({ sessionId: session.id, nativeLineage: "fixture", nativeId: `retry-${turn.id}`, turnId: turn.id,
        role: "toolResult", text: "", raw: JSON.stringify({ role: "toolResult", text: "", calls }), calls });
    }
    parent = turn.id;
  }
  return { sessionId: session.id, heavy, headTurnId: parent! };
}

test("22c: a full trace obtains the Turn's occurrences once, whatever the session's length", () => {
  const short = conversation(6, 12), long = conversation(24, 12);
  const counter = countSourceReads();
  const reads = (session: typeof short) => {
    counter.reset();
    const text = memory.trace(`T${session.heavy}`, { full: true });
    return { reads: counter.reads(), text };
  };
  try {
    const a = reads(short), b = reads(long);
    // The Turn's own entries decide the cost: four times the session is the same read count.
    expect(b.reads).toBe(a.reads);
    const entries = memory.store.listSourceEntries(long.sessionId).filter(e => e.turnId === long.heavy).length;
    expect(a.reads).toBeLessThanOrEqual(entries);
    // Ordinal 1 has two native result occurrences; the selected call renders both, in entry order.
    expect(b.text).toContain(`[T${long.heavy}#E3@observation] read success: result 12.0`);
    expect(b.text.indexOf("result 12.0")).toBeGreaterThan(-1);
    expect(b.text.indexOf("the second occurrence")).toBeGreaterThan(b.text.indexOf("result 12.0"));
    // Whole-entry full includes every call and result; no call is selected or silently sealed.
    for (let ordinal = 2; ordinal <= 12; ordinal++) expect(b.text).toContain(`#E${ordinal * 2}@assistant`);
    expect(b.text).toContain("result 12.11");
    // 23b assembles the read without `full` from the same Turn-scoped occurrences, at the same cost,
    // and shows each of them in entry order instead of merging them into one call's evidence.
    counter.reset();
    const assembled = memory.trace(`T${long.heavy}`);
    expect(counter.reads()).toBe(a.reads);
    expect(assembled.indexOf("result 12.0")).toBeGreaterThan(-1);
    expect(assembled.indexOf("the second occurrence")).toBeGreaterThan(assembled.indexOf("result 12.0"));
    // Each call is readable by its own entry, without a call selector or sibling result.
    for (let ordinal = 1; ordinal <= 12; ordinal++) {
      counter.reset();
      expect(memory.trace(`T${long.heavy}#E${ordinal * 2}`, { full: true })).toContain(`#E${ordinal * 2}@assistant] read(`);
      expect(counter.reads()).toBeLessThanOrEqual(a.reads);
    }
  } finally { counter.restore(); }
});

/** `knowledge` commits, each with `revisions` commits on this path: one create and its updates, so
 * every commit but the last of a chain is historical. All of them match one literal query. */
async function knowledgeCorpus(knowledge: number, revisions: number) {
  const store = memory.store, { sessionId, headTurnId } = conversation(3, 1);
  const path = { sessionId, branch: "main", headTurnId };
  store.selectSourcePath(sessionId, "main", store.listSourceEntries(sessionId).map(e => e.id));
  const entries = store.listSourceEntries(sessionId);
  const cited = store.hydrateSourceEntries(entries.map(e => e.id)).find(e => e.turnId === headTurnId && e.role === "user")!;
  const noted = store.commitNotingRun({ run: { kind: "noting", sessionId, branch: "main", createdAt: time },
    facts: [{ turnId: headTurnId, category: "observation", actor: "user", text: "evidence", source: [`T${headTurnId}#user`], entryIds: [cited.id], createdAt: time }],
    entryIds: entries.map(e => e.id) });
  if (!noted.ok) throw new Error(noted.problems.join("; "));
  const supports = [noted.facts[0]!.id];
  const tips: { knowledgeId: number; commit: number }[] = [];
  for (let i = 0; i < knowledge; i++) {
    const run = { kind: "manual" as const, sessionId, branch: "main", createdAt: time };
    const created = store.commitConsolidationRun({ path, run, operations: [{ op: "create", handle: `h${i}`, author: "fake",
      text: `SEARCHNEEDLE conclusion ${i}`, category: "understanding", scope: "session", supports, reason: "corpus", topics: [], createdAt: time }] });
    if (!created.ok) throw new Error(created.problems.join("; "));
    tips.push({ knowledgeId: created.committed[0]!.knowledgeId, commit: created.committed[0]!.commit });
  }
  const trigger = createDreamerTrigger(memory, path, supports[0]!, knowledge + revisions, "session");
  const dreamed = await scenarios.run(memory, path, input => {
    const request = { fixture: "paged read corpus" }; input.reportRequest(request);
    const trace = input.tools.find(tool => tool.name === "trace")!, write = input.tools.find(tool => tool.name === "memory")!;
    const consumed = new Set<string>();
    for (let i = 0; i < tips.length; i++) for (let j = 1; j < revisions; j++) {
      const tip = tips[i]!, address = `K${tip.knowledgeId}#${store.versionTag(tip.knowledgeId, tip.commit)}`;
      consumed.add(`K${tip.knowledgeId}@v${j}`);
      fullRead(trace, address);
      const updated = JSON.parse(write.execute({ operations: [{ op: "update", id: address,
        text: `SEARCHNEEDLE conclusion ${i} revision ${j}`, category: "understanding", scope: "session", supports: supports.map(id => `F${id}`), reason: "corpus", topics: [] }], skipped: [] }));
      expect(updated.committed[0]!.version).toBe(`K${tip.knowledgeId}@v${j + 1}`);
      tip.commit = store.resolveVersionOrdinal(tip.knowledgeId, j + 1);
    }
    const triggerAddress = `K${trigger.knowledgeId}#${store.versionTag(trigger.knowledgeId, trigger.commit)}`;
    const supplied = new Set(suppliedHandles(input.material.changed)); supplied.delete(`K${trigger.knowledgeId}@v1`); for (const address of consumed) supplied.delete(address);
    write.execute({ operations: [{ op: "archive", kind: "budget", id: triggerAddress, supports: supports.map(id => `F${id}`), reason: "Retire the explicit paged-read trigger." }],
      skipped: [...supplied].map(knowledge => ({ knowledge, because: "No further corpus maintenance is needed." })) });
    expect(input.tools.find(tool => tool.name === "check")!.execute({})).toContain("Blockers: none");
    return { outcome: "success", output: "corpus revisions complete", request };
  });
  if (dreamed.outcome !== "success") throw new Error(JSON.stringify(dreamed));
  return { sessionId, headTurnId, path, supports, tips, query: "SEARCHNEEDLE" };
}

test("22c: a search page formats its own hits and resolves the commit graph once for the query", async () => {
  const small = await knowledgeCorpus(3, 3), large = await knowledgeCorpus(9, 3);
  const options = { sessionId: large.sessionId, headTurnId: large.headTurnId, versions: "all" as const };
  const graph = countGraphResolutions(), format = countFormattedHits();
  try {
    graph.reset();
    const page = memory.search(large.query, "knowledge", { ...options, cap: 1 });
    // One resolution for the query, not one (or two) per hit. Only this page renders.
    expect(graph.resolutions()).toBe(1);
    expect(format.hits()).toBe(1);
    expect(page.split("\n").filter(l => l.startsWith("[K"))).toHaveLength(1);
    const cursor = /cursor=(\S+)/.exec(page)![1]!;
    graph.reset(); format.reset();
    memory.search("", "knowledge", { ...options, cursor });
    expect(format.hits()).toBe(1);
    expect(graph.resolutions()).toBe(0); // the next page reuses the frozen selection
    graph.reset(); format.reset();
    memory.search(small.query, "knowledge", { sessionId: small.sessionId, headTurnId: small.headTurnId, cap: 1 });
    expect(graph.resolutions()).toBe(1); // a third of the hits: the same resolution count
    expect(format.hits()).toBe(1);
    graph.reset(); format.reset();
    memory.search(large.query, "knowledge", { ...options, cap: 2 });
    expect(graph.resolutions()).toBe(1);
    expect(format.hits()).toBe(2);
    graph.reset();
    const whole = memory.search(large.query, "knowledge", options);
    expect(graph.resolutions()).toBe(1);
    expect(whole.split("\n").filter(l => l.startsWith("[K")).length).toBeGreaterThan(1);
  } finally { graph.restore(); format.restore(); }
});

test("22c: continuation is complete and stable, and a commit between pages moves no label", async () => {
  const corpus = await knowledgeCorpus(4, 3);
  const options = { sessionId: corpus.sessionId, headTurnId: corpus.headTurnId, versions: "all" as const, category: "understanding" as const, fields: ["text", "status"] as const };
  const addresses = (text: string) => text.split("\n").filter(l => l.startsWith("[K")).map(l => l.slice(1, l.indexOf("]")));
  const whole = memory.search("", "knowledge", options);
  const expected = addresses(whole);
  expect(expected).toHaveLength(4);
  // The last knowledge's tip is a current hit: the label a later page must keep.
  const last = corpus.tips.at(-1)!;
  expect(whole.split("\n").find(l => l.startsWith(`[K${last.knowledgeId}@${last.commit}]`))).toContain("current on this path");

  let page = memory.search("", "knowledge", { ...options, cap: 1 });
  const seen = [...addresses(page)], lines = [page.split("\n\nReceipts:")[0]!];
  let written = false;
  for (let cursor = /cursor=(\S+)/.exec(page)?.[1]; cursor; cursor = /cursor=(\S+)/.exec(page)?.[1]) {
    if (!written) {
      // No transaction may be open while the caller decides to ask for another page: a second
      // connection commits a superseding revision of the last knowledge between the pages.
      expect(memory.store.db.isTransaction).toBe(false);
      const otherScenarios = new AdmittedDreamerScenarios(async () => { throw new Error("unexpected second-connection phase"); });
      const other = sourceSeededMemory(dbPath, otherScenarios.agent);
      const trigger = createDreamerTrigger(other, corpus.path, corpus.supports[0]!, 99, "session");
      const changed = await otherScenarios.run(other, corpus.path, input => {
        const request = { fixture: "between paged reads" }; input.reportRequest(request);
        const trace = input.tools.find(tool => tool.name === "trace")!;
        const base = `K${last.knowledgeId}#${other.store.versionTag(last.knowledgeId, last.commit)}`;
        fullRead(trace, base);
        input.tools.find(tool => tool.name === "memory")!.execute({ operations: [
          { op: "update", id: base, text: "SEARCHNEEDLE later conclusion",
            category: "understanding", scope: "session", supports: corpus.supports.map(id => `F${id}`), reason: "between pages", topics: [] },
          { op: "archive", kind: "budget", id: `K${trigger.knowledgeId}#${other.store.versionTag(trigger.knowledgeId, trigger.commit)}`, supports: corpus.supports.map(id => `F${id}`), reason: "Retire the explicit between-pages trigger." },
        ], skipped: [] });
        expect(input.tools.find(tool => tool.name === "check")!.execute({})).toContain("Blockers: none");
        return { outcome: "success", output: "between-pages revision complete", request };
      });
      other.close();
      expect(changed.outcome).toBe("success");
      written = true;
    }
    page = memory.search("", "knowledge", { ...options, cursor });
    seen.push(...addresses(page));
    lines.push(page.split("\n\nReceipts:")[0]!);
  }
  expect(written).toBe(true);
  // Complete, duplicate-free, in the query's order — and the commit written between pages is absent.
  expect(seen).toEqual(expected);
  expect(new Set(seen).size).toBe(seen.length);
  expect(lines.join("\n")).toBe(whole.split("\n\nReceipts:")[0]);
  // A fresh query sees the new commit and moves the label; the paged query does not.
  const after = memory.search("", "knowledge", options);
  expect(after).not.toContain(`[K${last.knowledgeId}@${last.commit}]`);
  expect(after).toContain("SEARCHNEEDLE later conclusion");
  expect(addresses(after)).toHaveLength(4);
});

test("a continuation nobody comes back for is dropped: sixteen are outstanding at once, the oldest expires", async () => {
  const corpus = await knowledgeCorpus(4, 3);
  const options = { sessionId: corpus.sessionId, headTurnId: corpus.headTurnId, versions: "all" as const };
  const cursorOf = (page: string) => /cursor=(\S+)/.exec(page)![1]!;
  // Asking for page one and never asking for page two is ordinary use, so a remainder is a cache
  // entry with a bound, not an obligation held for the process's lifetime.
  const abandoned = cursorOf(memory.search(corpus.query, "knowledge", { ...options, cap: 1 }));
  let newest = abandoned;
  for (let i = 0; i < 16; i++) newest = cursorOf(memory.search(corpus.query, "knowledge", { ...options, cap: 1 }));
  // The sixteen newest remainders are all still answerable; the seventeenth-oldest is gone, and it
  // is gone through the failure contract an unknown cursor already had.
  expect(memory.search("", "knowledge", { ...options, cursor: newest })).toContain("[K");
  expect(() => memory.search("", "knowledge", { ...options, cursor: abandoned })).toThrow("unknown or expired cursor");
});
