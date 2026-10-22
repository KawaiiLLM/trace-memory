// Ticket 146: the Dreamer's trigger counts the Noter knowledge operations (a create or an update) not yet covered
// (`knowledge_processed`) on the chains of the live items, each revision once.
import { afterEach, describe, expect, test } from "vitest";
import { applyWorkspace } from "../../../src/core/workspace/index.ts";
import { writeHandoff } from "../../../src/core/store/executions.ts";
import { commitNoterKnowledge } from "../../noting-knowledge-fixture.ts";
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
  /** A Noter update of an item: one more operation on its chain. */
  const noterUpdate = (item: { knowledgeId: number; commit: number }, text: string) => {
    const result = commitNoterKnowledge(b.store, { path: b.path, run: { sessionId: b.session.id, branch: "main", createdAt: "now" }, operations: [{ op: "update",
      knowledgeId: item.knowledgeId, baseCommit: item.commit, text, category: "constraint", scope: "project", supports: [b.existingFact(`Support for ${text}`).id],
      topics: [], reason: "update", createdAt: "now" }] });
    if (!result.ok) throw new Error(result.problems.join("\n"));
    return result.committed[0]!;
  };
  const merge = (primary: { ref: string }, absorbed: { ref: string }) => {
    const result = applyWorkspace(b.store, { kind: "curate", operation: "merge", sessionId: b.session.id, path: b.path,
      file: { name: "curate.md", text: block(`merge ${primary.ref}`, { absorb: absorbed.ref, reason: "same rule" }, "Merged rule body.") } });
    if (!result.ok) throw new Error(result.problems.join("\n"));
    return b.store.liveKnowledge(b.path).find(r => r.op === "merge")!;
  };
  const support = () => [b.existingFact("Another support").id];
  return { b, run, pool, cover, noterItem, noterUpdate, manualItem, merge, support, changed: (stopAt?: number) => b.store.noterOperations(b.path, stopAt) };
}

describe("what counts", () => {
  test("each Noter create counts one; the count stops at the limit", () => {
    const s = setup();
    s.noterItem("Rule one body"); s.noterItem("Rule two body is a little longer than rule one"); s.noterItem("Rule three");
    expect(s.changed()).toBe(3);
    expect(s.changed(2)).toBe(2); // stopped as soon as the limit was reached
  });

  test("a second Noter update of one item counts again: the walk goes on past a Noter revision", () => {
    const s = setup();
    const item = s.noterItem("Rule");
    const first = s.noterUpdate(item, "Rule, first update");
    expect(s.changed()).toBe(2);
    const second = s.noterUpdate(first, "Rule, second update");
    expect(s.changed()).toBe(3);
    s.cover(first.commit);
    expect(s.changed()).toBe(1); // the covered update ends the branch: the create behind it no longer counts
    s.cover(second.commit);
    expect(s.changed()).toBe(0);
  });

  test("a revision that two live items share counts once", () => {
    const s = setup();
    const item = s.noterItem("A rule about two topics");
        const split = applyWorkspace(s.b.store, { kind: "curate", operation: "split", sessionId: s.b.session.id, path: s.b.path,
      file: { name: "curate.md", text: block(`split K${item.knowledgeId}@v${s.b.store.versionOrdinal(item.knowledgeId, item.commit)}`, { reason: "two topics" }, "Rule, first part.")
        + `\n### child\ntitle: Child rule\ncategory: reference\nscope: project\ntopics: split\nsupports: F${s.support()[0]}\nreason: split out\n\nA child.\n` } });
    if (!split.ok) throw new Error(split.problems.join("\n"));
    expect(s.b.store.liveKnowledge(s.b.path).length).toBe(2);
    expect(s.changed()).toBe(1); // both children reach the one Noter create
  });

  test("manual and Dreamer revisions never make an item count; a Noter revision under a newer manual one still does", () => {
    const s = setup();
    const manual = s.manualItem("Manual rule");
    expect(s.changed()).toBe(0);
    const noted = s.noterItem("Noter rule");
    const edited = updateKnowledge(s.b.store, s.b.path, noted.knowledgeId, noted.commit, "Noter rule, edited by hand", s.support());
    expect(s.changed()).toBe(1); // the manual update is current; the walk reaches the Noter create
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
    expect(s.changed()).toBe(1);
    s.cover(item.commit);
    expect(s.changed()).toBe(0);
  });

  test("an archived item is no longer live and counts for nothing", () => {
    const s = setup();
    const item = s.noterItem("Rule");
    expect(s.changed()).toBe(1);
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
  test("covered manual primary + uncovered Noter absorbed: counts the one Noter create", () => {
    const s = setup();
    const manual = s.manualItem("Manual rule"), noted = s.noterItem("Noter rule");
    s.cover(manual.commit);
    noterIsAbsorbed ? s.merge(manual, { ref: refOf(s.b, noted) }) : s.merge({ ref: refOf(s.b, noted) }, manual);
    expect(s.changed()).toBe(1);
  });

  test("both parents covered: not counted", () => {
    const s = setup();
    const manual = s.manualItem("Manual rule"), noted = s.noterItem("Noter rule");
    s.cover(manual.commit); s.cover(noted.commit);
    noterIsAbsorbed ? s.merge(manual, { ref: refOf(s.b, noted) }) : s.merge({ ref: refOf(s.b, noted) }, manual);
    expect(s.changed()).toBe(0);
  });

  test("two uncovered Noter parents: each Noter create counts one", () => {
    const s = setup();
    const first = s.noterItem("Noter rule one"), second = s.noterItem("Noter rule two");
    noterIsAbsorbed ? s.merge({ ref: refOf(s.b, first) }, { ref: refOf(s.b, second) }) : s.merge({ ref: refOf(s.b, second) }, { ref: refOf(s.b, first) });
    expect(s.changed()).toBe(2);
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
    s.noterItem("Rule one"); s.noterItem("Rule two");
    expect(s.b.store.dreamingDue(s.b.path, 2)).toBe(true);
    expect(s.b.store.dreamingDue(s.b.path, 3)).toBe(false);
  });

  test("a hand-off is due at once, whatever the count", () => {
    const s = setup();
    s.noterItem("Rule");
    expect(s.b.store.dreamingDue(s.b.path, 2)).toBe(false);
    writeHandoff(s.b.store, { sessionId: s.b.session.id, phase: "dreaming", nextTask: "curate", runId: s.run.id, branch: null, entryIds: [], detail: { operation: "update" } });
    expect(s.b.store.dreamingDue(s.b.path, 2)).toBe(true); // retry or resume at this check
  });
});
