import { afterEach, expect, test } from "vitest";
import { noVisibility, deliveredView, type VisibleView } from "../../../src/core/api/index.ts";
import { tokens } from "../../../src/core/render/index.ts";
import { setKnowledgeInjection } from "../../knowledge-budget-fixture.ts";
import { injectionFixture as fixture, closeInjectionFixtures } from "../../support/injection.ts";

// 165: scored bodies use the base; overflow bodies and all omitted knowledge titles use separate pools.

afterEach(closeInjectionFixtures);
const shown = (text: string, label: string) => text.includes(`${label} word`);

test("injection and compaction read the Knowledge base from knowledge_base_policy; the three pool columns are unread", () => {
  const f = fixture();
  const item = f.create("ONLY", 800, 80);
  f.memory.store.db.exec("UPDATE knowledge_budget_policy SET global_tokens = 0, project_tokens = 0, session_tokens = 0");
  expect(f.memory.knowledgeBase()).toBe(20_000);
  expect(f.memory.injection(f.target).knowledgeCommitIds).toEqual([item.commit]);
  const compacted = (): number[] => {
    const result = f.memory.compact(f.session.id, "main", f.target.headTurnId);
    if ("native" in result) throw new Error(result.reason);
    return result.supplied.knowledgeCommitIds;
  };
  expect(compacted()).toEqual([item.commit]);
  f.memory.store.db.prepare("UPDATE knowledge_base_policy SET base_tokens = 0 WHERE id = 1").run();
  expect(f.memory.knowledgeBase()).toBe(0);
  expect(f.memory.injection(f.target).knowledgeCommitIds).toEqual([]);
  expect(compacted()).toEqual([]);
});

test("an item that fills the base exactly is delivered whole although a lower one is left to the temporary allowance as a title", () => {
  const f = fixture();
  const a = f.create("EXACT", 400, 90);
  setKnowledgeInjection(f.memory, 5_000);
  const exact = f.memory.injection(f.target).knowledgeTokens!; // A's window alone: the base that fits it to the token
  const b = f.create("MISFIT", 3_000, 50);
  setKnowledgeInjection(f.memory, exact);
  const delivery = f.memory.injection(f.target);
  expect(delivery.knowledgeCommitIds).toEqual([a.commit]);
  expect(delivery.knowledgeTitleCommitIds).toEqual([b.commit]);
  expect(delivery.knowledgeTokens).toBe(exact);
});

test("what fits nowhere is named even when only the mandatory reselection can make room: an unscored item is named, a lower scored body gives way", () => {
  const f = fixture();
  const a = f.create("ALPHA", 400, 90);
  f.create("BRAVO", 400, 80);
  setKnowledgeInjection(f.memory, 5_000);
  const exact = f.memory.injection(f.target).knowledgeTokens!; // A and B fill the base to the token
  const u = f.create("UNSCORED", 400, null);
  setKnowledgeInjection(f.memory, exact);
  f.memory.config.compaction.temporaryTokens = 0; // U fits nowhere
  f.memory.config.compaction.pointerTokens = 0; // 165: neither body nor title fits
  const delivery = f.memory.injection(f.target);
  expect(delivery.text).toContain(`trace://K${u.knowledgeId}`);
  expect(delivery.knowledgeCommitIds).toContain(a.commit);
  expect(delivery.knowledgeTokens!).toBeLessThanOrEqual(exact);
  expect(delivery.temporaryTokens ?? 0).toBe(0);
});

test("unscored bodies fill newest first while scored and unscored misfits retain their titles", () => {
  const f = fixture();
  const scoredBig = f.create("SCOREDBIG", 3_000, 60), unscoredOld = f.create("UNSCOREDOLD", 300, null), unscoredNew = f.create("UNSCOREDNEW", 300, null);
  setKnowledgeInjection(f.memory, 1_000); // SCOREDBIG misses the base
  f.memory.config.compaction.temporaryTokens = 1_200; // both unscored bodies fit, then the title
  const delivery = f.memory.injection(f.target);
  expect(delivery.knowledgeCommitIds.sort()).toEqual([unscoredOld.commit, unscoredNew.commit].sort());
  expect(delivery.knowledgeTitleCommitIds).toEqual([scoredBig.commit]);
  expect(delivery.knowledgeTokens).toBe(0);
  expect(delivery.temporaryTokens!).toBeLessThanOrEqual(1_200);
  f.memory.config.compaction.temporaryTokens = 450; // room for only the newest unscored body
  const tight = f.memory.injection(f.target);
  expect(tight.knowledgeCommitIds).toEqual([unscoredNew.commit]);
  expect(tight.knowledgeTitleCommitIds).toEqual(expect.arrayContaining([scoredBig.commit, unscoredOld.commit]));
});

test("base full, temporary left: temporary items arrive with their own framing and both caps hold", () => {
  const f = fixture();
  const base = f.create("BASEFULL", 1_500, 80);
  const unscored = f.create("UNSCORED", 300, null);
  setKnowledgeInjection(f.memory, 1_600);
  f.memory.config.compaction.temporaryTokens = 1_000;
  const first = f.memory.injection(f.target);
  expect(first.knowledgeCommitIds.sort()).toEqual([base.commit, unscored.commit].sort());
  expect(first.knowledgeTokens!).toBeLessThanOrEqual(1_600);
  expect(first.temporaryTokens!).toBeGreaterThan(0);
  expect(first.temporaryTokens!).toBeLessThanOrEqual(1_000);
  // A context whose base is already spent still receives a new unscored item from what its temporary allowance has left.
  const spent: VisibleView = { ...noVisibility(), knowledgeCommitIds: new Set([base.commit]), knowledgeTokens: 1_600, temporaryTokens: 0 };
  const next = f.memory.injection(f.target, spent);
  expect(next.knowledgeCommitIds).toEqual([unscored.commit]);
  expect(next.knowledgeTokens).toBe(0);
  expect(next.temporaryTokens!).toBe(tokens(next.text.split("\n\n").slice(1).join("\n\n")));
  expect(next.temporaryTokens!).toBeLessThanOrEqual(1_000);
});

test("a title is delivered once, is not re-sent, and a later body upgrades it", () => {
  const f = fixture();
  const big = f.create("BIG", 1_500, 70);
  setKnowledgeInjection(f.memory, 500); // BIG misses the base: a title
  const first = f.memory.injection(f.target);
  expect(first.knowledgeCommitIds).toEqual([]);
  expect(first.knowledgeTitleCommitIds).toEqual([big.commit]);
  const after = { ...noVisibility(), knowledgeCommitIds: new Set(first.knowledgeCommitIds), knowledgeTitleCommitIds: new Set(first.knowledgeTitleCommitIds),
    knowledgeTokens: first.knowledgeTokens!, temporaryTokens: first.temporaryTokens!, pointerTokens: first.pointerTokens! };
  expect(f.memory.injection(f.target, after).text).toBe(""); // not re-sent while it is still a title
  // Base room appears: the body is delivered although a title for the same version is visible.
  setKnowledgeInjection(f.memory, 5_000);
  const upgrade = f.memory.injection(f.target, after);
  expect(upgrade.knowledgeCommitIds).toEqual([big.commit]);
  expect(upgrade.knowledgeTitleCommitIds ?? []).toEqual([]);
  expect(shown(upgrade.text, "BIG")).toBe(true);
});

test("delivery rows carry the titles and the temporary charge; a title does not hide a body in the delivered view", () => {
  const f = fixture();
  const big = f.create("BIG", 1_500, 70);
  setKnowledgeInjection(f.memory, 500);
  const first = f.memory.injection(f.target);
  const owner = "test";
  f.memory.store.recordKnowledgeDelivery({ owner, turnId: f.target.headTurnId }, [{ knowledgeCommitIds: first.knowledgeCommitIds, knowledgeTitleCommitIds: first.knowledgeTitleCommitIds,
    knowledgeStates: [], knowledgeTokens: first.knowledgeTokens!, temporaryTokens: first.temporaryTokens!, pointerTokens: first.pointerTokens! }]);
  const view = deliveredView(f.memory.store.deliveredKnowledge({ owner, sessionId: f.session.id, branch: "main", headTurnId: f.target.headTurnId }));
  expect(view.knowledgeCommitIds.has(big.commit)).toBe(false);
  expect([...view.knowledgeTitleCommitIds!]).toEqual([big.commit]);
  expect(view.temporaryTokens).toBe(first.temporaryTokens);
  expect(view.pointerTokens).toBe(first.pointerTokens);
});

test("compaction keeps knowledge titles when pending Raw exhausts the body pool", () => {
  const f = fixture();
  const unscored = f.create("UNSCORED", 400, null), scoredBig = f.create("SCOREDBIG", 3_000, 60);
  setKnowledgeInjection(f.memory, 1_000);
  const roomy = f.memory.compact(f.session.id, "main", f.target.headTurnId);
  if ("native" in roomy) throw new Error(roomy.reason);
  expect(roomy.supplied.knowledgeCommitIds).toEqual([unscored.commit]);
  expect(roomy.supplied.knowledgeTitleCommitIds).toEqual([scoredBig.commit]);
  expect(roomy.supplied.temporaryTokens).toBe(roomy.charged!.temporary);
  expect(roomy.charged!.envelope).toBe(f.memory.knowledgeBase() + f.memory.config.compaction.factsTokens + f.memory.config.compaction.rawTokens + f.memory.config.compaction.temporaryTokens + f.memory.config.compaction.pointerTokens);
  expect(roomy.charged!.temporary).toBeLessThanOrEqual(f.memory.config.compaction.temporaryTokens);
  // 165: exhausting body capacity does not remove pointers.
  f.memory.config.compaction.temporaryTokens = 1;
  const none = f.memory.compact(f.session.id, "main", f.target.headTurnId);
  if ("native" in none) throw new Error(none.reason);
  expect(none.supplied.knowledgeCommitIds).toEqual([]);
  expect(none.supplied.knowledgeTitleCommitIds).toEqual(expect.arrayContaining([scoredBig.commit, unscored.commit]));
});

test("a compaction that spent the temporary allowance on pending Raw leaves none for the next prompt", () => {
  const f = fixture();
  const unscored = f.create("UNSCORED", 300, null);
  f.memory.config.compaction.rawTokens = 40; // the Raw framing fits its base; the entry itself borrows
  f.memory.appendEntry({ sessionId: f.session.id, turnId: f.target.headTurnId, nativeLineage: "fixture", nativeId: "pending", role: "assistant", text: "pending " + "other ".repeat(700), raw: "", calls: [] });
  const measured = f.memory.compact(f.session.id, "main", f.target.headTurnId);
  if ("native" in measured) throw new Error(measured.reason);
  expect(measured.supplied.entries.length).toBeGreaterThan(0);
  expect(measured.supplied.knowledgeCommitIds).toEqual([unscored.commit]); // room for both: Raw first, the item from what was left
  // An allowance that the Raw alone exhausts leaves nothing for the item: (a) comes first.
  const rawOnly = measured.charged!.temporary - 360; // about the Raw's borrow; the item (300 words plus framing) cannot join it
  f.memory.config.compaction.temporaryTokens = Math.max(1, rawOnly + 40);
  const compacted = f.memory.compact(f.session.id, "main", f.target.headTurnId);
  if ("native" in compacted) throw new Error(compacted.reason);
  expect(compacted.supplied.entries.length).toBeGreaterThan(0);
  expect(compacted.supplied.knowledgeCommitIds).toEqual([]);
  const owner = "test";
  f.memory.store.recordKnowledgeDelivery({ owner, nodeKey: "compaction-1" }, [{ knowledgeCommitIds: [], knowledgeStates: [], knowledgeTokens: compacted.supplied.knowledgeTokens ?? 0,
    temporaryTokens: compacted.supplied.temporaryTokens! }]);
  const view = deliveredView(f.memory.store.deliveredKnowledge({ owner, sessionId: null, headTurnId: null, pending: [{ key: "compaction-1" }] }));
  expect(view.temporaryTokens).toBe(compacted.supplied.temporaryTokens);
  expect(f.memory.injection(f.target, view).knowledgeCommitIds).toEqual([]); // nothing left of the allowance
  f.memory.config.compaction.temporaryTokens += 10_000; // a fresh 10k on top of what the compaction spent
  expect(f.memory.injection(f.target, view).knowledgeCommitIds).toEqual([unscored.commit]);
});
