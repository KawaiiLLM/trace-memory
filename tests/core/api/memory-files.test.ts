// The /tm namespace returns complete virtual files; pagination belongs to each host.
import { afterEach, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryFiles, memoryGlob, memoryPath, recorded, sourceSeededMemory } from "../../source-fixture.ts";
import { entry, fact, knowledge, legacyFact, session } from "../../support/seed.ts";
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

test.each(["K0", "K01", "K1@0", "K1@1..", "K1@3...1", "K1 full", "F1.. full", "F0..", "F01..", "garbage"])(
  "rejects invalid /tm address %s", address => {
    const x = fixture(), path = `/tm/${address}`;
    expect(() => x.files.read(path)).toThrow(`no such path: ${path}; /tm`);
  });
test.each([
  ["K9007199254740992", "invalid trace address: K9007199254740992"],
  ["K1@v9007199254740992", "invalid address integer: 9007199254740992"],
])("rejects unsafe /tm knowledge identity or version %s", (address, error) => {
  const x = fixture();
  expect(() => x.files.read(`/tm/${address}`)).toThrow(error);
});
test("rejects the retired numeric version form even with an unsafe integer", () => {
  const x = fixture();
  expect(() => x.files.read("/tm/K1@9007199254740992")).toThrow("no such path: /tm/K1@9007199254740992; /tm");
});
test("rejects the retired unsafe fact interval", () => {
  const x = fixture();
  expect(() => x.files.read("/tm/F9007199254740992..")).toThrow("no such path: /tm/F9007199254740992..; /tm");
});
test.each(["K99", "K99@v1", "K1@v99", "F99"])("reports missing /tm target %s", address => {
  const x = fixture();
  expect(() => x.files.read(`/tm/${address}`)).toThrow(/does not exist|has no revision|unknown knowledge history/);
});

test("the shared guide stays within 200 tokens and appears once across knowledge groups", () => {
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
  expect(x.files.read(`/tm/compact/S${x.owner.id}`)).toEqual({ content: result.text, unbounded: true });
  expect(x.files.read(`/tm/compact/S${x.owner.id}/T${x.turn.id}`)).toEqual({ content: result.text, unbounded: true });
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
  // The old reader stays at T1; a foreground move binds a new reader, it does not retarget an in-flight one.
  expect(x.files.read(`/tm/raw/S${x.owner.id}`).content).not.toContain("MAIN_PATH_ONLY");
  const files = memoryFiles(x.memory, x.store.currentPath(x.owner.id));
  const explicit = `/tm/raw/S${x.owner.id}/T${sibling.id}`;
  expect(files.read(x.S).content.split("\n").find(line => line.startsWith(`T${sibling.id} `))).toContain("Sibling decision");
  expect(files.glob(`/tm/raw/S${x.owner.id}/*`).lines).toContain(`/tm/raw/S${x.owner.id}/T${sibling.id}`);
  expect(files.read(`/tm/raw/S${x.owner.id}`).content).toContain("MAIN_PATH_ONLY");
  expect(files.read(`/tm/raw/S${x.owner.id}`).content).not.toContain("SIBLING_ORIGINAL_TEXT");
  expect(files.read(`/tm/raw/S${x.owner.id}/T${sibling.id}`).content).toContain("SIBLING_ORIGINAL_TEXT");
  expect(files.read(`/tm/raw/S${x.owner.id}/T${sibling.id}#E${siblingEntry.entryOrdinal}@user`).content).toContain("SIBLING_ORIGINAL_TEXT");
  expect(files.read(`/tm/facts/S${x.owner.id}/T${sibling.id}`).content).toContain("Sibling decision evidence.");
  expect(files.read(`/tm/knowledge/S${x.owner.id}/T${sibling.id}`).content).toBe(x.memory.injection(branch).text);
  expect(files.read(`/tm/knowledge/S${x.owner.id}/T${sibling.id}`).content).toContain("Sibling-only guidance.");
  const fullSibling = `/tm/raw/S${x.owner.id}/T${sibling.id}#E${siblingEntry.entryOrdinal}`;
  expect([...files.grep("SIBLING_ORIGINAL_TEXT", `/tm/raw/S${x.owner.id}/T${sibling.id}`)].map(file => file.path)).toContain(fullSibling);
  expect([...files.grep("SIBLING_ORIGINAL_TEXT", x.S)].map(file => file.path)).toContain(fullSibling);
  expect(() => files.read(`/tm/raw/S999/T${sibling.id}`)).toThrow(/not in S999|does not exist/);
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
  let files = memoryFiles(x.memory, x.store.currentPath(x.owner.id));
  const assertViews = (branch: "early" | "late", selected: typeof a | typeof b, absent: string) => {
    const node = { ...early, branch };
    expect(files.glob(`${target}#E*`).lines).toContain(`${target}#E${selected.entryOrdinal}`);
    expect(files.glob(`${target}#E*`).lines).not.toContain(`${target}#E${branch === "early" ? b.entryOrdinal : a.entryOrdinal}`);
    const raw = `/tm/raw/S${x.owner.id}/T${shared.id}`;
    expect(files.read(raw).content).toContain(branch === "early" ? "EARLY_BRANCH_ONLY" : "LATE_BRANCH_ONLY");
    expect(files.read(raw).content).not.toContain(absent);
    expect(files.read(`${raw}@${branch === "early" ? "user" : "assistant"}`).content).toContain(branch === "early" ? "EARLY_BRANCH_ONLY" : "LATE_BRANCH_ONLY");
    expect(files.read(`/tm/facts/S${x.owner.id}/T${shared.id}`).content).toContain(branch === "early" ? "EARLY_FACT" : "LATE_FACT");
    expect(files.read(`/tm/facts/S${x.owner.id}/T${shared.id}`).content).not.toContain(branch === "early" ? "LATE_FACT" : "EARLY_FACT");
    const inherited = files.read(`/tm/knowledge/S${x.owner.id}/T${shared.id}`).content;
    expect(inherited).toBe(x.memory.injection(node).text);
    expect(inherited).toContain(branch === "early" ? "EARLY_KNOWLEDGE" : "LATE_KNOWLEDGE");
    expect(inherited).not.toContain(branch === "early" ? "LATE_KNOWLEDGE" : "EARLY_KNOWLEDGE");
    const compact = x.memory.compact(x.owner.id, branch, shared.id);
    if ("native" in compact) throw new Error(compact.reason);
    expect(files.read(`/tm/compact/S${x.owner.id}/T${shared.id}`).content).toBe(compact.text);
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
  files = memoryFiles(x.memory, x.store.currentPath(x.owner.id));
  assertViews("early", a, "LATE_BRANCH_ONLY"); // Current containing branch beats a higher HWM.

  // The compact node has no source entry: after switching away, its lineage head still identifies its branch.
  const newestOutside = x.store.appendTurn({ sessionId: x.owner.id, parentTurnId: outside.id, kind: "turn", startedAt: "2026-09-27T00:00:00.000Z" });
  x.store.setCurrentPath(x.owner.id, "main", newestOutside.id, "fixture");
  expect(x.store.currentPath(x.owner.id)).toMatchObject({ branch: "main", headTurnId: newestOutside.id });
  files = memoryFiles(x.memory, x.store.currentPath(x.owner.id));
  expect(files.read(`/tm/knowledge/S${x.owner.id}/T${compactHead.id}`).content).toContain("EARLY_KNOWLEDGE");
  expect(files.read(`/tm/knowledge/S${x.owner.id}/T${compactHead.id}`).content).not.toContain("LATE_KNOWLEDGE");
  const headlessCompact = x.memory.compact(x.owner.id, "early", compactHead.id);
  if ("native" in headlessCompact) throw new Error(headlessCompact.reason);
  expect(files.read(`/tm/compact/S${x.owner.id}/T${compactHead.id}`).content).toBe(headlessCompact.text);
  expect(x.store.db.prepare("SELECT * FROM knowledge_deliveries").all()).toEqual(before);
  const exact = `/tm/raw/S${x.owner.id}/T${shared.id}#E${b.entryOrdinal}`;
  expect(files.read(`${exact}@assistant`).content).toContain("LATE_BRANCH_ONLY");
  expect([...files.grep("LATE_BRANCH_ONLY", exact)].map(hit => hit.path)).toEqual([exact]);
  expect(() => files.read(`${exact}@user`)).toThrow(/role does not match/);
  expect(() => [...files.grep("LATE_BRANCH_ONLY", `${exact}@user`)]).toThrow(/role does not match/);
});

test("omitted T uses the reader's own branch, while another session uses its latest node", () => {
  const x = fixture();
  try {
    const base = x.store.sourcePath(x.owner.id, "main", x.turn.id).map(e => e.id);
    const sibling = x.store.appendTurn({ sessionId: x.owner.id, parentTurnId: x.turn.id, kind: "turn", startedAt: "2026-09-22T00:00:00.000Z" });
    const siblingEntry = entry(x.store, x.owner.id, sibling.id, "sibling-head", "user", "OWN_SIBLING_HEAD");
    x.memory.selectEntries(x.owner.id, "sibling", [...base, siblingEntry.id]);
    const latest = x.store.appendTurn({ sessionId: x.owner.id, parentTurnId: x.turn.id, kind: "turn", startedAt: "2026-09-23T00:00:00.000Z" });
    const latestEntry = entry(x.store, x.owner.id, latest.id, "latest-head", "user", "OTHER_LATEST_HEAD");
    x.memory.selectEntries(x.owner.id, "main", [...base, latestEntry.id]);
    x.store.setCurrentPath(x.owner.id, "main", latest.id, "fixture");
    const own = memoryFiles(x.memory, { sessionId: x.owner.id, branch: "sibling", headTurnId: sibling.id });
    const other = memoryFiles(x.memory, {});
    expect(own.read(`/tm/raw/S${x.owner.id}`).content).toContain("OWN_SIBLING_HEAD");
    expect(own.read(`/tm/raw/S${x.owner.id}`).content).not.toContain("OTHER_LATEST_HEAD");
    const branchOnly = memoryFiles(x.memory, { sessionId: x.owner.id, branch: "sibling" });
    expect(branchOnly.read(`/tm/raw/S${x.owner.id}`).content).toContain("OWN_SIBLING_HEAD");
    expect(branchOnly.read(`/tm/raw/S${x.owner.id}`).content).not.toContain("OTHER_LATEST_HEAD");
    const headless = memoryFiles(x.memory, { sessionId: x.owner.id, branch: "sibling", headTurnId: null });
    expect(() => headless.read(`/tm/raw/S${x.owner.id}`)).toThrow(`no such path: session S${x.owner.id} has no current Turn`);
    expect(other.read(`/tm/raw/S${x.owner.id}`).content).toContain("OTHER_LATEST_HEAD");
    expect(own.read(`/tm/raw/S${x.owner.id}/T${x.turn.id}`).content).toContain("What cache policy?");
  } finally { x.memory.close(); }
});

test("an orphan Turn exposes all its stored entries through read, recursive Grep and Glob", () => {
  const x = fixture();
  try {
    const orphan = x.store.appendTurn({ sessionId: x.owner.id, parentTurnId: x.turn.id, kind: "turn", startedAt: "2026-09-24T00:00:00.000Z" });
    const a = entry(x.store, x.owner.id, orphan.id, "orphan-a", "user", "ORPHAN_FIRST");
    const b = entry(x.store, x.owner.id, orphan.id, "orphan-b", "assistant", "ORPHAN_SECOND");
    const raw = `/tm/raw/S${x.owner.id}/T${orphan.id}`;
    expect(x.store.sourceBranchContainingTurn(x.owner.id, orphan.id)).toBeNull();
    expect(x.files.read(raw).content).toContain("ORPHAN_FIRST");
    expect(x.files.read(raw).content).toContain("ORPHAN_SECOND");
    expect(x.files.read(`/tm/facts/S${x.owner.id}/T${orphan.id}`).content).toContain(`${raw}#E${b.entryOrdinal}`);
    expect(x.files.glob(`/tm/raw/S${x.owner.id}/**`).lines).toEqual(expect.arrayContaining([`${raw}#E${a.entryOrdinal}`, `${raw}#E${b.entryOrdinal}`]));
    for (const root of ["/tm", x.S, `/tm/raw/S${x.owner.id}`])
      expect([...x.files.grep("ORPHAN_SECOND", root)].map(hit => hit.path)).toContain(`${raw}#E${b.entryOrdinal}`);
  } finally { x.memory.close(); }
});

test("empty session knowledge explains that a fresh context has none", () => {
  const x = fixture();
  try {
    const other = session(x.store, x.store.createProject({ name: "empty", declaredBy: "mark" }).id, "pi:empty");
    const turn = x.store.appendTurn({ sessionId: other.id, kind: "turn", startedAt: "2026-09-22T00:00:00.000Z" });
    expect(x.files.read(`/tm/knowledge/S${other.id}/T${turn.id}`).content).toContain(
      `(a fresh context at S${other.id}'s current head would receive no knowledge)`);
  } finally { x.memory.close(); }
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
  expect([...x.files.grep("MIDDLE_NEEDLE", `/tm/raw/S${x.owner.id}@user`)]).toEqual([]); // The original reader still names T1.
  const advanced = memoryFiles(x.memory, x.store.currentPath(x.owner.id));
  expect([...advanced.grep("MIDDLE_NEEDLE", `/tm/raw/S${x.owner.id}@user`)].map(file => file.path)).toEqual([E]);
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
  for (const [path, expected] of [["/tm", "/tm"], ["/tm/", "/tm"], ["/tm/K1", "/tm/K1"], ["//tm//K1", "/tm/K1"],
    ["/tm/./S1/../K1", "/tm/K1"], ["/tm/K12#qfzt", "/tm/K12#qfzt"]] as const)
    expect(memoryPath(path)).toBe(expected);
  for (const path of ["/tmp/K1", "/tm-foo/K1", "/tmx", "/TM/K1", "/tm/../etc/passwd", "/tm/S1/../../etc",
    "tm/K1", "./tm/K1", "~/tm/K1", "", "/", "/private/tm/K1", "/Users/me/tm/K1", undefined, null, 42])
    expect(memoryPath(path)).toBeNull();
  expect(memoryGlob("/tm/S*")).toBe("/tm/S*");
  expect(memoryGlob("S1/T*", "/tm")).toBe("/tm/S1/T*");
  expect(memoryGlob("raw/S1/T2#E*", "/tm/")).toBe("/tm/raw/S1/T2#E*");
  expect(memoryGlob("**/E2", "/tm/")).toBe("/tm/**/E2");
  for (const [pattern, path] of [["/t*/K1", undefined], ["/tm*", undefined], ["/tmp/*", undefined], ["tm/*", undefined],
    ["*", "tm"], ["../etc/*", "/tm"], ["*", "/tmp"], ["/tm/../etc/*", undefined]] as const)
    expect(memoryGlob(pattern, path)).toBeNull();
});

test("root indexes nonempty sessions by latest activity and binds navigation to the reader's branch", () => {
  const x = fixture();
  try {
    const unnamed = x.store.createProject({ name: "cc:undeclared", declaredBy: "marker" });
    const other = session(x.store, unnamed.id, "cc:undeclared");
    const empty = session(x.store, unnamed.id, "cc:empty");
    x.store.appendTurn({ sessionId: other.id, kind: "turn", startedAt: "2026-09-20T08:00:00.000Z" });
    let parent = x.turn.id;
    const branchTurns = [parent], branchEntries = x.store.sourcePath(x.owner.id, "main", parent).map(e => e.id);
    for (let i = 0; i < 11; i++) {
      const turn = x.store.appendTurn({ sessionId: x.owner.id, parentTurnId: parent, kind: "turn",
        startedAt: `2026-09-22T00:${String(i).padStart(2, "0")}:00.000Z` });
      branchTurns.push(turn.id); parent = turn.id;
      branchEntries.push(entry(x.store, x.owner.id, turn.id, `branch-${i}`, "user").id);
    }
    x.memory.selectEntries(x.owner.id, "reader", branchEntries);
    const sibling = x.store.appendTurn({ sessionId: x.owner.id, parentTurnId: x.turn.id, kind: "turn",
      startedAt: "2026-09-23T00:00:00.000Z" });
    x.memory.selectEntries(x.owner.id, "main", [
      ...x.store.sourcePath(x.owner.id, "main", x.turn.id).map(e => e.id),
      entry(x.store, x.owner.id, sibling.id, "sibling-nav", "user").id,
    ]);
    x.store.setCurrentPath(x.owner.id, "main", sibling.id, "main-live");
    const bound = memoryFiles(x.memory, { sessionId: x.owner.id, branch: "reader", headTurnId: parent }).read("/tm").content;
    const unbound = memoryFiles(x.memory, {}).read("/tm").content;
    expect(bound).toContain(`This session: S${x.owner.id} · Pi · project alpha`);
    expect(bound).toContain(`Current branch: 12 Turns, T${x.turn.id} … T${parent} (head)`);
    expect(bound.split("\n").find(line => line.startsWith("Recent Turns:"))?.match(/T\d+/g))
      .toEqual(branchTurns.slice(-10).map(id => `T${id}`));
    expect(bound).toContain(`Turn list: ${x.S}`);
    expect(unbound).not.toMatch(/This session:|Current branch:|Recent Turns:|Turn list:/);
    const sessions = bound.split("\n").filter(line => /^\/tm\/S\d+\s/.test(line));
    expect(sessions).toEqual([
      `${x.S}  Pi · alpha · 13 Turns · last 2026-09-23 00:00Z`,
      `/tm/S${other.id}  Claude Code · no project name · 1 Turns · last 2026-09-20 08:00Z`,
    ]);
    expect(bound).not.toMatch(/^\/tm\/F\d+/m);
    expect(bound).not.toMatch(new RegExp(`^/tm/S${empty.id}\\s`, "m"));
    expect(bound).toContain("/tm/knowledge  knowledge visible to you, current versions: 1");
    expect(bound).toContain("/tm/knowledge-all  every scope and project, archived included: 1");
    expect(memoryFiles(x.memory, { sessionId: empty.id, headTurnId: null }).read("/tm").content).toContain("Current branch: 0 Turns");
  } finally { x.memory.close(); }
});

test("Turn titles use the earliest contribution, include spanning facts, and list all branches newest first", () => {
  const x = fixture();
  try {
    const base = x.store.sourcePath(x.owner.id, "main", x.turn.id);
    const turn = x.store.appendTurn({ sessionId: x.owner.id, parentTurnId: x.turn.id, kind: "turn",
      startedAt: "2026-09-22T01:02:03.000Z" });
    const early = entry(x.store, x.owner.id, turn.id, "early-title", "user");
    const later = entry(x.store, x.owner.id, turn.id, "late-title", "assistant");
    x.memory.selectEntries(x.owner.id, "main", [...base.map(e => e.id), early.id, later.id]);
    const path = { sessionId: x.owner.id, branch: "main", headTurnId: turn.id };
    fact(x.memory, path, "Created first, contributed later", [{ entry: later, text: "LATER_CONTRIBUTION" }]);
    fact(x.memory, path, "Spanning decision", [
      { entry: x.store.hydrateSourceEntries([base[0]!.id])[0]!, text: "EARLIER_TURN_CONTRIBUTION" },
      { entry: early, text: "FIRST_CONTRIBUTION" },
    ]);
    const orphan = x.store.appendTurn({ sessionId: x.owner.id, parentTurnId: x.turn.id, kind: "turn",
      startedAt: "2026-09-23T00:00:00.000Z" });
    entry(x.store, x.owner.id, orphan.id, "orphan-title", "user");
    const lines = x.files.read(x.S).content.split("\n");
    expect(lines[0]).toContain("3 Turns, newest first");
    expect(lines.slice(1).map(line => /^T\d+/.exec(line)![0])).toEqual([orphan.id, turn.id, x.turn.id].map(id => `T${id}`));
    expect(lines[2]).toBe(`T${turn.id}  09-22 01:02Z  2 ev  Spanning decision (+1)`);
    expect(lines[3]).toContain("Cache policy (+1)");
    expect(lines.slice(1).every(line => !line.includes("/tm/"))).toBe(true);
    expect(x.files.read(`/tm/facts/S${x.owner.id}/T${turn.id}`).content).toContain("FIRST_CONTRIBUTION");
    expect(x.files.read(`/tm/facts/S${x.owner.id}/T${x.turn.id}`).content).toContain("EARLIER_TURN_CONTRIBUTION");
    const found = [...x.files.grep("FIRST_CONTRIBUTION", "/tm")].map(hit => hit.path);
    expect(found).toEqual([`/tm/facts/S${x.owner.id}/T${turn.id}`]);
    expect([...x.files.grep("LRU", "/tm")].some(hit => /^\/tm\/F\d+/.test(hit.path))).toBe(false);
    const spanSession = session(x.store, x.owner.projectId, "pi:span");
    const first = x.store.appendTurn({ sessionId: spanSession.id, kind: "turn", startedAt: "2026-09-21T00:00:00.000Z" });
    const second = x.store.appendTurn({ sessionId: spanSession.id, parentTurnId: first.id, kind: "turn", startedAt: "2026-09-22T00:00:00.000Z" });
    const start = entry(x.store, spanSession.id, first.id, "span-start", "user");
    const end = entry(x.store, spanSession.id, second.id, "span-end", "assistant");
    x.memory.selectEntries(spanSession.id, "main", [start.id, end.id]);
    fact(x.memory, { sessionId: spanSession.id, branch: "main", headTurnId: second.id }, "Both Turns",
      [{ entry: start, text: "Start." }, { entry: end, text: "End." }]);
    const spanLines = x.files.read(`/tm/S${spanSession.id}`).content.split("\n").slice(1);
    expect(spanLines).toEqual([
      `T${second.id}  09-22 00:00Z  1 ev  Both Turns`,
      `T${first.id}  09-21 00:00Z  1 ev  Both Turns`,
    ]);
  } finally { x.memory.close(); }
});

test("Turn list distinguishes pending and processed no-fact entries, marks kinds, and truncates legacy headings", () => {
  const x = fixture();
  try {
    const pending = x.store.appendTurn({ sessionId: x.owner.id, parentTurnId: x.turn.id, kind: "turn",
      startedAt: "2026-09-22T00:00:00.000Z" });
    const a = entry(x.store, x.owner.id, pending.id, "pending-title", "user");
    const processed = x.store.appendTurn({ sessionId: x.owner.id, parentTurnId: x.turn.id, kind: "turn",
      startedAt: "2026-09-23T00:00:00.000Z" });
    const b = entry(x.store, x.owner.id, processed.id, "processed-title", "user");
    x.store.commitNotingRun({ run: { kind: "manual", sessionId: x.owner.id, branch: "processed",
      createdAt: "2026-09-23T00:00:00.000Z" }, facts: [], entryIds: [b.id] });
    const legacy = x.store.appendTurn({ sessionId: x.owner.id, parentTurnId: x.turn.id, kind: "turn",
      startedAt: "2026-09-24T00:00:00.000Z" });
    const c = entry(x.store, x.owner.id, legacy.id, "legacy-title", "user");
    legacyFact(x.store, { sessionId: x.owner.id, branch: "legacy", headTurnId: legacy.id },
      [{ entry: c, address: `T${legacy.id}#E${c.entryOrdinal}` }], "旧".repeat(81) + "\nNot the heading.");
    const compact = x.store.appendTurn({ sessionId: x.owner.id, parentTurnId: legacy.id, kind: "compaction",
      startedAt: "2026-09-25T00:00:00.000Z" });
    const lines = x.files.read(x.S).content.split("\n");
    expect(lines.find(line => line.startsWith(`T${pending.id} `))).toBe(`T${pending.id}  09-22 00:00Z  1 ev  (not yet noted)`);
    expect(lines.find(line => line.startsWith(`T${processed.id} `))).toBe(`T${processed.id}  09-23 00:00Z  1 ev  (no fact)`);
    expect(lines.find(line => line.startsWith(`T${legacy.id} `))).toBe(`T${legacy.id}  09-24 00:00Z  1 ev  ${"旧".repeat(80)}…`);
    expect(lines[1]).toBe(`T${compact.id}  09-25 00:00Z  0 ev  [compaction] (no fact)`);
    expect(x.store.entryNoted(a.id)).toBe(false);
  } finally { x.memory.close(); }
});
