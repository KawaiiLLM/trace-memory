// Ticket 144, Stage 4: the Dreamer's trigger counts the live knowledge a Noter revision changed since coverage
// (`knowledge_processed`), each item once at its current title plus body.
import { afterEach, describe, expect, test } from "vitest";
import { applyWorkspace } from "../../../src/core/workspace/index.ts";
import { knowledgeTitle, tokens } from "../../../src/core/render/index.ts";
import { writeHandoff } from "../../../src/core/store/executions.ts";
import { archive, knowledgeBatch, updateKnowledge } from "../../support/seed.ts";
import { block, workspaceBatch, type WorkspaceBatch } from "../../support/workspace.ts";

const opened: WorkspaceBatch[] = [];
afterEach(() => { for (const b of opened.splice(0)) b.memory.close(); });
function setup() {
  const b = workspaceBatch(); opened.push(b);
  const pool = `project:${b.project.id}`;
  const run = b.store.recordRun({ kind: "dreaming", sessionId: b.session.id, branch: "main", outcome: "success", createdAt: "now" });
  const cover = (commit: number, inPool = pool) => b.store.db.prepare("INSERT OR IGNORE INTO knowledge_processed(pool,revision_id,run_id) VALUES (?,?,?)").run(inPool, commit, run.id);
  /** A Noter-created item (actor role `noting`). */
  const noterItem = (text: string) => knowledgeBatch(b.store, b.path, [{ scope: "project", category: "constraint", supports: [b.existingFact(`Support for ${text}`).id], title: text.slice(0, 20), text }]).committed[0]!;
  /** A hand-written item (actor role `manual`; the workspace builder's own `item` is a Noter item). */
  const manualItem = (text: string) => {
    const committed = knowledgeBatch(b.store, b.path, [{ scope: "project", category: "constraint", supports: [b.existingFact(`Support for ${text}`).id], title: text.slice(0, 20), text }],
      { kind: "manual", createdAt: "now" }).committed[0]!;
    return { ...committed, ref: `K${committed.knowledgeId}@v${b.store.versionOrdinal(committed.knowledgeId, committed.commit)}` };
  };
  const weight = (commit: number) => { const r = b.store.knowledgeRevision(commit)!; return tokens(knowledgeTitle(r, b.store.writing.titleTokens)) + tokens(r.text); };
  const merge = (primary: { ref: string }, absorbed: { ref: string }) => {
    const result = applyWorkspace(b.store, { kind: "curate", operation: "merge", sessionId: b.session.id, path: b.path,
      file: { name: "curate.md", text: block(`merge ${primary.ref}`, { absorb: absorbed.ref, reason: "same rule" }, "Merged rule body.") } });
    if (!result.ok) throw new Error(result.problems.join("\n"));
    return b.store.liveKnowledge(b.path).find(r => r.op === "merge")!;
  };
  const support = () => [b.existingFact("Another support").id];
  return { b, run, pool, cover, noterItem, manualItem, weight, merge, support, changed: (floor = 0, stopAt?: number) => b.store.noterChangedTokens(b.path, floor, stopAt) };
}

describe("what counts", () => {
  test("a Noter item counts once at its title plus body; the sum stops at the limit; the floor excludes older revisions", () => {
    const s = setup();
    const one = s.noterItem("Rule one body"), two = s.noterItem("Rule two body is a little longer than rule one");
    expect(s.changed()).toBe(s.weight(one.commit) + s.weight(two.commit));
    expect(s.changed(0, 1)).toBe(s.weight(one.commit)); // stopped after the first item reached the limit
    expect(s.changed(one.commit)).toBe(s.weight(two.commit));
    expect(s.changed(two.commit)).toBe(0);
  });

  test("manual and Dreamer revisions never make an item count; a Noter revision under a newer manual one still does", () => {
    const s = setup();
    const manual = s.manualItem("Manual rule");
    expect(s.changed()).toBe(0);
    const noted = s.noterItem("Noter rule");
    const edited = updateKnowledge(s.b.store, s.b.path, noted.knowledgeId, noted.commit, "Noter rule, edited by hand", s.support());
    expect(s.changed()).toBe(s.weight(edited.commit)); // the manual update is current; the walk reaches the Noter create
    s.cover(noted.commit);
    expect(s.changed()).toBe(0); // the covered ancestor ends the branch
    const dreamed = applyWorkspace(s.b.store, { kind: "curate", operation: "update", sessionId: s.b.session.id, path: s.b.path,
      file: { name: "curate.md", text: block(`update ${manual.ref}`, { reason: "tidy" }, "Manual rule, tidied.") } });
    expect(dreamed.ok).toBe(true);
    expect(s.changed()).toBe(0);
  });

  test("coverage is read in the item's own pool", () => {
    const s = setup();
    const item = s.noterItem("Rule");
    s.cover(item.commit, "global");
    expect(s.changed()).toBe(s.weight(item.commit));
    s.cover(item.commit);
    expect(s.changed()).toBe(0);
  });

  test("an archived item is no longer live and counts for nothing", () => {
    const s = setup();
    const item = s.noterItem("Rule");
    expect(s.changed()).toBeGreaterThan(0);
    archive(s.b.store, s.b.path, item.knowledgeId, item.commit, s.support(), "invalid");
    expect(s.changed()).toBe(0);
  });

  test("the live list is built once per graph state and rebuilt after a write", () => {
    const s = setup();
    s.noterItem("Rule");
    const first = s.b.store.liveKnowledge(s.b.path);
    expect(s.b.store.liveKnowledge(s.b.path)).toBe(first);
    s.noterItem("Another rule");
    expect(s.b.store.liveKnowledge(s.b.path)).not.toBe(first);
    expect(s.b.store.liveKnowledge(s.b.path).filter(r => r.op === "archive")).toEqual([]);
  });
});

// A merge's current version has two parents: the primary's base and each absorbed item's base. One covered parent
// must not hide an uncovered Noter branch, whichever parent comes first.
describe.each([["the Noter side absorbed", true], ["the Noter side primary", false]])("coverage walk over a merge (%s)", (_name, noterIsAbsorbed) => {
  test("covered manual primary + uncovered Noter absorbed: the merged item counts once", () => {
    const s = setup();
    const manual = s.manualItem("Manual rule"), noted = s.noterItem("Noter rule");
    s.cover(manual.commit);
    const merged = noterIsAbsorbed ? s.merge(manual, { ref: refOf(s.b, noted) }) : s.merge({ ref: refOf(s.b, noted) }, manual);
    expect(s.changed()).toBe(s.weight(merged.id));
  });

  test("both parents covered: not counted", () => {
    const s = setup();
    const manual = s.manualItem("Manual rule"), noted = s.noterItem("Noter rule");
    s.cover(manual.commit); s.cover(noted.commit);
    noterIsAbsorbed ? s.merge(manual, { ref: refOf(s.b, noted) }) : s.merge({ ref: refOf(s.b, noted) }, manual);
    expect(s.changed()).toBe(0);
  });

  test("two uncovered Noter parents: the merged item counts once, at its own weight", () => {
    const s = setup();
    const first = s.noterItem("Noter rule one"), second = s.noterItem("Noter rule two");
    const merged = noterIsAbsorbed ? s.merge({ ref: refOf(s.b, first) }, { ref: refOf(s.b, second) }) : s.merge({ ref: refOf(s.b, second) }, { ref: refOf(s.b, first) });
    expect(s.changed()).toBe(s.weight(merged.id));
  });

  test("covered primary + uncovered manual absorbed over a covered Noter grandparent: not counted", () => {
    const s = setup();
    const primary = s.manualItem("Manual rule"), noted = s.noterItem("Noter rule");
    s.cover(primary.commit); s.cover(noted.commit);
    const edited = updateKnowledge(s.b.store, s.b.path, noted.knowledgeId, noted.commit, "Noter rule, edited by hand", s.support());
    const absorbed = { ref: refOf(s.b, edited) };
    noterIsAbsorbed ? s.merge(primary, absorbed) : s.merge(absorbed, primary);
    expect(s.changed()).toBe(0);
  });
});

const refOf = (b: WorkspaceBatch, item: { knowledgeId: number; commit: number }) => `K${item.knowledgeId}@v${b.store.versionOrdinal(item.knowledgeId, item.commit)}`;

describe("the due rule", () => {
  test("due at the trigger and not below it", () => {
    const s = setup();
    const item = s.noterItem("Rule");
    const need = s.weight(item.commit);
    expect(s.b.store.dreamingDue(s.b.path, need)).toBe(true);
    expect(s.b.store.dreamingDue(s.b.path, need + 1)).toBe(false);
  });

  test("a hand-off without waitFrom is due at once; with waitFrom only newer Noter changes count", () => {
    const s = setup();
    const item = s.noterItem("Rule");
    const need = s.weight(item.commit);
    const handoff = (detail: { curateRuns: number[]; doneCategories: string[]; waitFrom?: number }) => 
      writeHandoff(s.b.store, { sessionId: s.b.session.id, phase: "dreaming", nextTask: "curate", runId: s.run.id, branch: null, entryIds: [], detail });
    expect(s.b.store.dreamingDue(s.b.path, need + 1)).toBe(false);
    handoff({ curateRuns: [], doneCategories: [] });
    expect(s.b.store.handoff(s.b.session.id, "dreaming")!.detail).toEqual({ curateRuns: [], doneCategories: [] });
    expect(s.b.store.dreamingDue(s.b.path, need + 1)).toBe(true); // retry or resume at this check
    handoff({ curateRuns: [], doneCategories: [], waitFrom: item.commit });
    expect(s.b.store.dreamingDue(s.b.path, need)).toBe(false); // the old change is behind waitFrom
    const newer = s.noterItem("A newer rule");
    expect(s.b.store.dreamingDue(s.b.path, s.weight(newer.commit))).toBe(true);
  });
});
