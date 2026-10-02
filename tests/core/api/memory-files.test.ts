// The /tm namespace returns complete virtual files; pagination belongs to each host.
import { afterEach, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryFiles, memoryGlob, memoryPath, recorded, sourceSeededMemory } from "../../source-fixture.ts";
import { entry, fact, knowledge, session } from "../../support/seed.ts";
import { readingGuide } from "../../../src/core/render/reading-guide.ts";
import { tokens } from "../../../src/core/render/tokens.ts";
import { canonicalToolNames } from "../../../src/core/prompts/tool-names.ts";
import { ccPluginToolNames, ccWorkerToolNames } from "../../../src/hosts/cc/tool-names.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "tm-memory-files-")); dirs.push(dir);
  const memory = sourceSeededMemory(join(dir, "memory.sqlite"), async () => { throw new Error("no model work"); });
  const store = memory.store;
  const project = store.createProject({ name: "alpha", declaredBy: "mark" });
  const owner = session(store, project.id, "pi:reader");
  const turn = store.appendTurn({ sessionId: owner.id, kind: "turn", startedAt: "2026-09-21T00:00:00.000Z" });
  const ask = entry(store, owner.id, turn.id, "r1", "user", "What cache policy?");
  const answer = entry(store, owner.id, turn.id, "r2", "assistant", "LRU.");
  const pending = entry(store, owner.id, turn.id, "r3", "user", "A pending question.");
  memory.selectEntries(owner.id, "main", [ask.id, answer.id, pending.id]);
  store.setCurrentPath(owner.id, "main", turn.id, "fixture");
  const path = { sessionId: owner.id, branch: "main", headTurnId: turn.id };
  const f = fact(memory, path, "Cache policy", [{ entry: ask, text: "The user asks about the cache." },
    { entry: answer, text: "The agent answers LRU." }]);
  recorded(memory, owner.id, "main", turn.id);
  const k = knowledge(store, path, "project", "constraint", [f.id], "The cache uses LRU.");
  const files = memoryFiles(memory, { ...path, projectId: project.id });
  const S = `/tm/S${owner.id}`, T = `${S}/T${turn.id}`;
  return { memory, store, files, owner, turn, f, k, S, T };
}

test("virtual files never return internal 100-line cursor pages before host pagination", () => {
  const x = fixture();
  try {
    const path = { sessionId: x.owner.id, branch: "main", headTurnId: x.turn.id };
    const body = Array.from({ length: 220 }, (_, i) => `FULL-LINE-${i}`).join("\n");
    const source = entry(x.store, x.owner.id, x.turn.id, "long-full-entry", "user", body);
    const extra = Array.from({ length: 120 }, (_, i) =>
      entry(x.store, x.owner.id, x.turn.id, `overview-${i}`, "assistant", `OVERVIEW-${i}`));
    x.memory.selectEntries(x.owner.id, "main", [
      ...x.store.sourcePath(x.owner.id, "main", x.turn.id).map(e => e.id), source.id, ...extra.map(e => e.id),
    ]);
    const f = fact(x.memory, path, "Long fact", [{ entry: source, text: body }]);
    // Long stored/manual knowledge is legal; only N/D result bodies have the 1k write cap.
    const k = knowledge(x.store, path, "project", "reference", [x.f.id], body,
      { run: { kind: "manual", createdAt: "2026-09-21T00:00:00.000Z" } });
    for (const virtual of [`/tm/F${f.id}`, `/tm/K${k.knowledgeId}`, `/tm/K${k.knowledgeId}@v1`,
      `/tm/K${k.knowledgeId}.history`, `/tm/raw/S${x.owner.id}/T${x.turn.id}#E${source.entryOrdinal}`]) {
      const text = x.files.read(virtual).content;
      expect(text, virtual).toContain(body);
      expect(text, virtual).not.toContain("cursor=");
    }
    const overview = x.files.read(`/tm/raw/S${x.owner.id}/T${x.turn.id}`).content;
    expect(overview).toContain("OVERVIEW-119");
    expect(overview).not.toContain("cursor=");
    const facts = x.files.read(`/tm/facts/S${x.owner.id}/T${x.turn.id}`).content;
    expect(facts).toContain(body);
    expect(facts).not.toContain("cursor=");
  } finally { x.memory.close(); }
});

test("all path classes, native whole-file contract and role checks", () => {
  const x = fixture(), { files, S, T } = x;
  expect(files.read("/tm").content).toContain(S);
  expect(files.read("/tm/knowledge").content).toContain(`/tm/K${x.k.knowledgeId}`);
  expect(files.read("/tm/knowledge-all").content).toContain(`/tm/K${x.k.knowledgeId}@v1`);
  expect(files.read(`/tm/K${x.k.knowledgeId}`).content).toContain("The cache uses LRU.");
  expect(files.read(`/tm/K${x.k.knowledgeId}@v1`).content).toContain("The cache uses LRU.");
  expect(files.read(`/tm/K${x.k.knowledgeId}.history`).content).toContain("history");
  const tag = /\[(K\d+#[a-z]+)\]/.exec(files.read(`/tm/K${x.k.knowledgeId}`).content)![1]!;
  expect(files.read(`/tm/${tag}`).content).toContain("The cache uses LRU.");
  expect(files.read(`/tm/F${x.f.id}`).content).toContain(`Source session: S${x.owner.id}`);
  const target = `/tm/facts/S${x.owner.id}/T${x.turn.id}`;
  const raw = `/tm/raw/S${x.owner.id}/T${x.turn.id}`;
  expect(files.read(S).content.split("\n")).toEqual([`${target}  ${raw}`]);
  expect(files.read("/tm").content).toContain("/tm/facts");
  expect(files.read("/tm").content).toContain("/tm/raw");
  expect(() => files.read(T)).toThrow(/no such path: .*; \/tm$/);
  expect(files.read(target).content).toContain("The agent answers LRU.");
  expect(files.read(target).content).toContain(`${raw}#E3`);
  expect(files.read(`/tm/facts/S${x.owner.id}`).content).toBe(files.read(target).content);
  expect(files.read(`/tm/facts/S${x.owner.id}`).content).not.toContain(`${target}  ${raw}`);
  expect(files.read(raw).content).toContain("A pending question.");
  expect(files.read(`/tm/raw/S${x.owner.id}`).content).toBe(files.read(raw).content);
  expect(files.read(`/tm/raw/S${x.owner.id}`).content).not.toContain(`${target}  ${raw}`);
  expect(files.read(`${raw}@user`).content).toContain("What cache policy?");
  expect(files.read(`${raw}@assistant`).content).toContain("LRU.");
  expect(files.read(`${raw}@observation`).content).not.toContain("LRU.");
  expect(files.read(`${raw}#E2@assistant`).content).toContain("LRU.");
  expect(files.read(`${raw}#E2`).content).toContain("LRU.");
  expect([...files.grep("LRU", `${raw}#E2@assistant`)].map(hit => hit.path)).toEqual([`${raw}#E2@assistant`]);
  expect(() => files.read(`${raw}#E2@user`)).toThrow(/role does not match/);
  expect(() => files.read(`${raw}#E4`)).toThrow(/no such path/);
  expect(() => [...files.grep("LRU", `${raw}#E2@user`)]).toThrow(/role does not match/);
  for (const removed of [`${raw}#E1..E2`, `${raw}#E1,E2`, `/tm/raw/S${x.owner.id}#E1`,
    `/tm/facts/S${x.owner.id}/T${x.turn.id}@user`, `/tm/compact/S${x.owner.id}/T${x.turn.id}#E1`,
    `/tm/knowledge/S${x.owner.id}@assistant`, `${raw}#E0`, `${raw}#E9007199254740992`, `${raw}@toolResult`,
    `${T}/facts`, `${T}/events`, `${T}/E2`, `/tm/F${x.f.id},K${x.k.knowledgeId}`, `/tm/T${x.turn.id}`, "/tm/R1", "/tm/alpha"])
    expect(() => files.read(removed)).toThrow(/no such path: .*; \/tm$/);
  expect(() => files.read(`/tm/S999/T${x.turn.id}`)).toThrow();
});

test("118: the shared guide stays within 200 tokens and appears once across knowledge groups", () => {
  for (const names of [canonicalToolNames, ccPluginToolNames, ccWorkerToolNames])
    for (const id of [undefined, 1, 140, Number.MAX_SAFE_INTEGER])
      expect(tokens(readingGuide(id, names))).toBeLessThanOrEqual(200);
  const x = fixture(), path = { sessionId: x.owner.id, branch: "main", headTurnId: x.turn.id };
  knowledge(x.store, path, "project", "understanding", [x.f.id], "Additional cache context.");
  knowledge(x.store, path, "project", "goal", [x.f.id], "Preserve cache behaviour.");
  const guide = readingGuide(x.owner.id, canonicalToolNames);
  for (const virtual of ["/tm", `/tm/knowledge/S${x.owner.id}`, `/tm/compact/S${x.owner.id}`]) {
    const text = x.files.read(virtual).content;
    expect(text.split(guide)).toHaveLength(2);
    expect(text.match(/Memory is at \/tm: virtual/g)).toHaveLength(1);
  }
  expect(x.files.read(x.S).content).not.toContain("Memory is at /tm");
});

test("knowledge and compact select exactly the requested node without recording delivery", () => {
  const x = fixture(), node = x.store.currentPath(x.owner.id);
  const injection = x.memory.injection(node).text;
  expect(x.files.read(`/tm/knowledge/S${x.owner.id}`)).toEqual({ content: injection, unbounded: true });
  expect(x.files.read(`/tm/knowledge/S${x.owner.id}/T${x.turn.id}`)).toEqual({ content: injection, unbounded: true });
  expect(x.files.read("/tm/knowledge").unbounded).toBe(false);
  const result = x.memory.compact(x.owner.id, node.branch, node.headTurnId!);
  if ("native" in result) throw new Error(result.reason);
  expect(x.files.read(`/tm/compact/S${x.owner.id}`)).toEqual({ content: result.text, unbounded: false });
  expect(x.files.read(`/tm/compact/S${x.owner.id}/T${x.turn.id}`).content).toBe(result.text);
  const before = x.store.db.prepare("SELECT * FROM knowledge_deliveries").all();
  x.files.read(`/tm/knowledge/S${x.owner.id}`); x.files.read(`/tm/compact/S${x.owner.id}`);
  expect(x.store.db.prepare("SELECT * FROM knowledge_deliveries").all()).toEqual(before);
});

test("explicit sibling Turn remains readable outside the selected cursor, while omitted T stays at the selected head", () => {
  const x = fixture(), base = x.store.sourcePath(x.owner.id, "main", x.turn.id).map(e => e.id);
  const sibling = x.store.appendTurn({ sessionId: x.owner.id, parentTurnId: x.turn.id, kind: "turn", startedAt: "2026-09-22T00:00:00.000Z" });
  const siblingEntry = entry(x.store, x.owner.id, sibling.id, "sibling", "user", "SIBLING_ORIGINAL_TEXT");
  x.memory.selectEntries(x.owner.id, "sibling", [...base, siblingEntry.id]);
  x.store.setCurrentPath(x.owner.id, "sibling", sibling.id, "sibling-live");
  const main = x.store.appendTurn({ sessionId: x.owner.id, parentTurnId: x.turn.id, kind: "turn", startedAt: "2026-09-23T00:00:00.000Z" });
  const mainEntry = entry(x.store, x.owner.id, main.id, "main-next", "user", "MAIN_PATH_ONLY");
  x.memory.selectEntries(x.owner.id, "main", [...base, mainEntry.id]);
  x.store.setCurrentPath(x.owner.id, "main", main.id, "fixture");
  const branch = { sessionId: x.owner.id, branch: "sibling", headTurnId: sibling.id };
  const siblingFact = fact(x.memory, branch, "Sibling decision", [{ entry: siblingEntry, text: "Sibling decision evidence." }]);
  recorded(x.memory, x.owner.id, "sibling", sibling.id);
  knowledge(x.store, branch, "session", "constraint", [siblingFact.id], "Sibling-only guidance.");
  const explicit = `/tm/raw/S${x.owner.id}/T${sibling.id}`;
  expect(x.files.read(x.S).content).toContain(`/tm/facts/S${x.owner.id}/T${sibling.id}  ${explicit}`);
  expect(x.files.glob(`/tm/raw/S${x.owner.id}/*`).lines).toContain(`/tm/raw/S${x.owner.id}/T${sibling.id}`);
  expect(x.files.read(`/tm/raw/S${x.owner.id}`).content).toContain("MAIN_PATH_ONLY");
  expect(x.files.read(`/tm/raw/S${x.owner.id}`).content).not.toContain("SIBLING_ORIGINAL_TEXT");
  expect(x.files.read(`/tm/raw/S${x.owner.id}/T${sibling.id}`).content).toContain("SIBLING_ORIGINAL_TEXT");
  expect(x.files.read(`/tm/raw/S${x.owner.id}/T${sibling.id}#E${siblingEntry.entryOrdinal}@user`).content).toContain("SIBLING_ORIGINAL_TEXT");
  expect(x.files.read(`/tm/facts/S${x.owner.id}/T${sibling.id}`).content).toContain("Sibling decision evidence.");
  expect(x.files.read(`/tm/knowledge/S${x.owner.id}/T${sibling.id}`).content).toBe(x.memory.injection(branch).text);
  expect(x.files.read(`/tm/knowledge/S${x.owner.id}/T${sibling.id}`).content).toContain("Sibling-only guidance.");
  const fullSibling = `/tm/raw/S${x.owner.id}/T${sibling.id}#E${siblingEntry.entryOrdinal}`;
  expect([...x.files.grep("SIBLING_ORIGINAL_TEXT", `/tm/raw/S${x.owner.id}/T${sibling.id}`)].map(file => file.path)).toContain(fullSibling);
  expect([...x.files.grep("SIBLING_ORIGINAL_TEXT", x.S)].map(file => file.path)).toContain(fullSibling);
  expect(() => x.files.read(`/tm/raw/S999/T${sibling.id}`)).toThrow(/not in S999|does not exist/);
});

test("explicit Turn prefers its containing current branch, then source HWM and path id across every branch-sensitive view", () => {
  const x = fixture(), base = x.store.sourcePath(x.owner.id, "main", x.turn.id).map(e => e.id);
  const shared = x.store.appendTurn({ sessionId: x.owner.id, parentTurnId: x.turn.id, kind: "turn", startedAt: "2026-09-24T00:00:00.000Z" });
  const a = entry(x.store, x.owner.id, shared.id, "a", "user", "EARLY_BRANCH_ONLY");
  const b = entry(x.store, x.owner.id, shared.id, "b", "assistant", "LATE_BRANCH_ONLY");
  const last = entry(x.store, x.owner.id, shared.id, "last", "user", "COMMON_LATEST_ENTRY");
  const target = `/tm/raw/S${x.owner.id}/T${shared.id}`;
  x.memory.selectEntries(x.owner.id, "early", [...base, a.id, last.id]);
  x.memory.selectEntries(x.owner.id, "late", [...base, b.id]);
  const early = { sessionId: x.owner.id, branch: "early", headTurnId: shared.id };
  const late = { ...early, branch: "late" };
  // Keep both sets of supporting facts live, while the selected head lies on neither branch.
  x.store.setCurrentPath(x.owner.id, "early", shared.id, "early-live");
  x.store.setCurrentPath(x.owner.id, "late", shared.id, "late-live");
  const outside = x.store.appendTurn({ sessionId: x.owner.id, parentTurnId: x.turn.id, kind: "turn", startedAt: "2026-09-25T00:00:00.000Z" });
  const outsideEntry = entry(x.store, x.owner.id, outside.id, "outside", "user", "OUTSIDE_SHARED_ANCESTRY");
  x.memory.selectEntries(x.owner.id, "main", [...base, outsideEntry.id]);
  x.store.setCurrentPath(x.owner.id, "main", outside.id, "fixture");
  expect(x.store.currentPath(x.owner.id)).toMatchObject({ branch: "main", headTurnId: outside.id });
  const earlyFact = fact(x.memory, early, "Early decision", [{ entry: a, text: "EARLY_FACT" }]);
  const lateFact = fact(x.memory, late, "Late decision", [{ entry: b, text: "LATE_FACT" }]);
  knowledge(x.store, early, "session", "constraint", [earlyFact.id], "EARLY_KNOWLEDGE");
  knowledge(x.store, late, "session", "constraint", [lateFact.id], "LATE_KNOWLEDGE");
  const assertViews = (branch: "early" | "late", selected: typeof a | typeof b, absent: string) => {
    const node = { ...early, branch };
    expect(x.files.glob(`${target}#E*`).lines).toContain(`${target}#E${selected.entryOrdinal}`);
    expect(x.files.glob(`${target}#E*`).lines).not.toContain(`${target}#E${branch === "early" ? b.entryOrdinal : a.entryOrdinal}`);
    const raw = `/tm/raw/S${x.owner.id}/T${shared.id}`;
    expect(x.files.read(raw).content).toContain(branch === "early" ? "EARLY_BRANCH_ONLY" : "LATE_BRANCH_ONLY");
    expect(x.files.read(raw).content).not.toContain(absent);
    expect(x.files.read(`${raw}@${branch === "early" ? "user" : "assistant"}`).content).toContain(branch === "early" ? "EARLY_BRANCH_ONLY" : "LATE_BRANCH_ONLY");
    expect(x.files.read(`/tm/facts/S${x.owner.id}/T${shared.id}`).content).toContain(branch === "early" ? "EARLY_FACT" : "LATE_FACT");
    expect(x.files.read(`/tm/facts/S${x.owner.id}/T${shared.id}`).content).not.toContain(branch === "early" ? "LATE_FACT" : "EARLY_FACT");
    const inherited = x.files.read(`/tm/knowledge/S${x.owner.id}/T${shared.id}`).content;
    expect(inherited).toBe(x.memory.injection(node).text);
    expect(inherited).toContain(branch === "early" ? "EARLY_KNOWLEDGE" : "LATE_KNOWLEDGE");
    expect(inherited).not.toContain(branch === "early" ? "LATE_KNOWLEDGE" : "EARLY_KNOWLEDGE");
    const compact = x.memory.compact(x.owner.id, branch, shared.id);
    if ("native" in compact) throw new Error(compact.reason);
    expect(x.files.read(`/tm/compact/S${x.owner.id}/T${shared.id}`).content).toBe(compact.text);
  };
  const before = x.store.db.prepare("SELECT * FROM knowledge_deliveries").all();
  assertViews("early", a, "LATE_BRANCH_ONLY"); // HWM wins over later path id.
  x.memory.selectEntries(x.owner.id, "late", [...base, b.id, last.id]);
  assertViews("late", b, "EARLY_BRANCH_ONLY"); // Tied HWM: larger path id wins.
  const newer = entry(x.store, x.owner.id, shared.id, "late-newer", "assistant", "NEWER_LATE_ENTRY");
  x.memory.selectEntries(x.owner.id, "late", [...base, b.id, last.id, newer.id]);
  const compactHead = x.store.appendTurn({ sessionId: x.owner.id, parentTurnId: shared.id, kind: "compaction", startedAt: "2026-09-26T00:00:00.000Z" });
  x.store.setCurrentPath(x.owner.id, "early", compactHead.id, "early-live");
  expect(x.store.currentPath(x.owner.id)).toMatchObject({ branch: "early", headTurnId: compactHead.id });
  assertViews("early", a, "LATE_BRANCH_ONLY"); // Current containing branch beats a higher HWM.

  // The compact node has no source entry: after switching away, its lineage head still identifies its branch.
  const newestOutside = x.store.appendTurn({ sessionId: x.owner.id, parentTurnId: outside.id, kind: "turn", startedAt: "2026-09-27T00:00:00.000Z" });
  x.store.setCurrentPath(x.owner.id, "main", newestOutside.id, "fixture");
  expect(x.store.currentPath(x.owner.id)).toMatchObject({ branch: "main", headTurnId: newestOutside.id });
  expect(x.files.read(`/tm/knowledge/S${x.owner.id}/T${compactHead.id}`).content).toContain("EARLY_KNOWLEDGE");
  expect(x.files.read(`/tm/knowledge/S${x.owner.id}/T${compactHead.id}`).content).not.toContain("LATE_KNOWLEDGE");
  const headlessCompact = x.memory.compact(x.owner.id, "early", compactHead.id);
  if ("native" in headlessCompact) throw new Error(headlessCompact.reason);
  expect(x.files.read(`/tm/compact/S${x.owner.id}/T${compactHead.id}`).content).toBe(headlessCompact.text);
  expect(x.store.db.prepare("SELECT * FROM knowledge_deliveries").all()).toEqual(before);
  const exact = `/tm/raw/S${x.owner.id}/T${shared.id}#E${b.entryOrdinal}`;
  expect(x.files.read(`${exact}@assistant`).content).toContain("LATE_BRANCH_ONLY");
  expect([...x.files.grep("LATE_BRANCH_ONLY", exact)].map(hit => hit.path)).toEqual([exact]);
  expect(() => x.files.read(`${exact}@user`)).toThrow(/role does not match/);
  expect(() => [...x.files.grep("LATE_BRANCH_ONLY", `${exact}@user`)]).toThrow(/role does not match/);
});

test("manual long fact/knowledge and full E are not cut by Core's former page or item cap", () => {
  const x = fixture();
  const extra = x.store.appendTurn({ sessionId: x.owner.id, kind: "turn", startedAt: "2026-09-22T00:00:00.000Z", parentTurnId: x.turn.id });
  const body = "full-original ".repeat(4500) + "MIDDLE_NEEDLE " + "full-original ".repeat(4500) + "TAIL_NEEDLE";
  const source = entry(x.store, x.owner.id, extra.id, "long", "user", body);
  x.memory.selectEntries(x.owner.id, "main", [...x.store.sourcePath(x.owner.id, "main", x.turn.id).map(e => e.id), source.id]);
  x.store.setCurrentPath(x.owner.id, "main", extra.id, "fixture");
  const E = `/tm/raw/S${x.owner.id}/T${extra.id}#E${source.entryOrdinal}`;
  expect(x.files.read(E).unbounded).toBe(true);
  expect(x.files.read(E).content).toContain("TAIL_NEEDLE");
  expect(x.files.read(E).content.length).toBeGreaterThan(8000 * 4);
  const matches = [...x.files.grep("TAIL_NEEDLE", E)];
  expect(matches.map(file => file.path)).toEqual([E]);
  expect(matches[0]!.hits.map(index => matches[0]!.lines[index])).toEqual(expect.arrayContaining([expect.stringContaining("TAIL_NEEDLE")]));
  const overview = `/tm/raw/S${x.owner.id}/T${extra.id}`;
  expect(x.files.read(`${overview}@user`).content).not.toContain("MIDDLE_NEEDLE");
  expect([...x.files.grep("MIDDLE_NEEDLE", `${overview}@user`)].map(file => file.path)).toEqual([E]);
  expect([...x.files.grep("MIDDLE_NEEDLE", `/tm/raw/S${x.owner.id}@user`)].map(file => file.path)).toEqual([E]);
  expect([...x.files.grep("MIDDLE_NEEDLE", `${overview}@assistant`)]).toEqual([]);
});

test("layer listing coexists with exact reads; recursive Grep uses facts and whole Raw once", () => {
  const x = fixture(), facts = `/tm/facts/S${x.owner.id}/T${x.turn.id}`;
  const raw = `/tm/raw/S${x.owner.id}/T${x.turn.id}`;
  expect(x.files.read(`/tm/facts/S${x.owner.id}`).content).toContain("The agent answers LRU.");
  expect(x.files.read(`/tm/raw/S${x.owner.id}`).content).toContain("What cache policy?");
  expect(x.files.read(raw).content).toContain("LRU.");
  expect(x.files.glob(`/tm/raw/S${x.owner.id}/*`).lines).toEqual([raw]);
  expect(x.files.glob(`${raw}#E*`).lines).toEqual([`${raw}#E1`, `${raw}#E2`, `${raw}#E3`]);
  expect(x.files.glob(`/tm/raw/S${x.owner.id}/**`).lines).toContain(`${raw}#E2`);
  expect(x.files.glob(`/tm/facts/S${x.owner.id}/*`).lines).toEqual([facts]);
  expect([...x.files.grep("LRU", x.S)].map(file => file.path)).toEqual([facts, `${raw}#E2`]);
  expect([...x.files.grep("LRU", "/tm")].filter(file => file.path === facts || file.path === `${raw}#E2`)
    .map(file => file.path)).toEqual([facts, `${raw}#E2`]);
  expect([...x.files.grep("LRU", `/tm/facts/S${x.owner.id}`)].map(file => file.path)).toEqual([facts]);
  expect([...x.files.grep("LRU", `/tm/raw/S${x.owner.id}`)].map(file => file.path)).toEqual([`${raw}#E2`]);
  expect([...x.files.grep("pending", x.S, { ignoreCase: true })].map(file => file.path)).toEqual([`${raw}#E3`]);
  const injection = vi.spyOn(x.memory, "injection"), compact = vi.spyOn(x.memory, "compact");
  const before = x.store.db.prepare("SELECT * FROM knowledge_deliveries").all();
  [...x.files.grep("cache", "/tm")]; x.files.glob("/tm/**");
  expect(injection).not.toHaveBeenCalled(); expect(compact).not.toHaveBeenCalled();
  expect(x.store.db.prepare("SELECT * FROM knowledge_deliveries").all()).toEqual(before);
});

test("compaction node facts and Raw do not include its synthetic summary", () => {
  const x = fixture();
  const compact = x.store.appendTurn({ sessionId: x.owner.id, parentTurnId: x.turn.id, kind: "compaction",
    startedAt: "2026-09-28T00:00:00.000Z", assistantText: "SYNTHETIC_COMPACTION_SUMMARY" });
  x.store.setCurrentPath(x.owner.id, "main", compact.id, "fixture");
  for (const layer of ["facts", "raw"])
    expect(x.files.read(`/tm/${layer}/S${x.owner.id}/T${compact.id}`).content).not.toContain("SYNTHETIC_COMPACTION_SUMMARY");
  expect(x.memory.trace(`T${compact.id}`)).toContain("SYNTHETIC_COMPACTION_SUMMARY");
});

test("normalised absolute memory paths only", () => {
  expect(memoryPath("/tm/./S1/../K1")).toBe("/tm/K1");
  for (const path of ["/tmp/K1", "/tm/../etc", "tm/K1", "~/tm/K1"]) expect(memoryPath(path)).toBeNull();
  expect(memoryGlob("raw/S1/T2#E*", "/tm/")).toBe("/tm/raw/S1/T2#E*");
});
