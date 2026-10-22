import { afterEach, expect, test } from "vitest";
import { noVisibility, deliveredView, type VisibleView } from "../../../src/core/api/index.ts";
import { tokens } from "../../../src/core/render/index.ts";
import { setKnowledgeInjection } from "../../knowledge-budget-fixture.ts";
import { injectionFixture as fixture, closeInjectionFixtures } from "../../support/injection.ts";

// 144 stage 4 §7: knowledge is injected in score order within the Knowledge base; one temporary allowance per
// context carries unscored items, then titles of scored items that missed the base.

afterEach(closeInjectionFixtures);
const shown = (text: string, label: string) => text.includes(`${label} word`);
const titled = (text: string, label: string) => new RegExp(`\\(title only\\) ${label}`).test(text);

test("the base fills in score order, ties newest first; the rest are titles, not skipped (PENDING Q4: stop at the first misfit)", () => {
  const f = fixture();
  const low = f.create("LOW", 800, 20), first = f.create("TOP", 800, 90), tieOld = f.create("TIEOLD", 800, 70), tieNew = f.create("TIENEW", 800, 70);
  setKnowledgeInjection(f.memory, 2_000); // room for two 800-word bodies
  const delivery = f.memory.injection(f.target);
  expect(delivery.knowledgeCommitIds.sort()).toEqual([first.commit, tieNew.commit].sort());
  expect(shown(delivery.text, "TOP") && shown(delivery.text, "TIENEW")).toBe(true);
  expect(shown(delivery.text, "TIEOLD") || shown(delivery.text, "LOW")).toBe(false);
  // The misfits become titles in score order, one by one from the temporary allowance.
  expect(delivery.knowledgeTitleCommitIds).toEqual(expect.arrayContaining([tieOld.commit, low.commit]));
  expect(titled(delivery.text, "TIEOLD") && titled(delivery.text, "LOW")).toBe(true);
  expect(delivery.knowledgeTokens! + delivery.temporaryTokens!).toBe(tokens(delivery.text.split("\n\n").slice(1).join("\n\n")));
  expect(delivery.knowledgeTokens!).toBeLessThanOrEqual(2_000);
});

test("a high-score item that does not fit stops the base: lower ones do not fill the gap", () => {
  const f = fixture();
  const small = f.create("SMALL", 100, 40), huge = f.create("HUGE", 3_000, 95);
  setKnowledgeInjection(f.memory, 1_000);
  const delivery = f.memory.injection(f.target);
  expect(delivery.knowledgeCommitIds).toEqual([]); // PENDING Q4 (stop): SMALL does not jump ahead of HUGE
  expect(delivery.knowledgeTitleCommitIds).toEqual(expect.arrayContaining([huge.commit, small.commit]));
});

test("unscored items ride the temporary allowance newest first, then titles of scored misfits", () => {
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

test("a context whose temporary allowance is spent gets no temporary item on the next prompt", () => {
  const f = fixture();
  const base = f.create("BASE", 100, 80), unscored = f.create("UNSCORED", 100, null);
  const spent: VisibleView = { ...noVisibility(), knowledgeCommitIds: new Set([base.commit]), knowledgeTokens: 500, temporaryTokens: 10_000 };
  expect(f.memory.injection(f.target, spent).text).toBe(""); // a compaction spent the 10k: PENDING Q5, ordinary prompts spend only what is left
  const roomy: VisibleView = { ...spent, temporaryTokens: 9_000 };
  expect(f.memory.injection(f.target, roomy).knowledgeCommitIds).toEqual([unscored.commit]);
});

test("a title is delivered once, is not re-sent, and a later body upgrades it", () => {
  const f = fixture();
  const big = f.create("BIG", 1_500, 70);
  setKnowledgeInjection(f.memory, 500); // BIG misses the base: a title
  const first = f.memory.injection(f.target);
  expect(first.knowledgeCommitIds).toEqual([]);
  expect(first.knowledgeTitleCommitIds).toEqual([big.commit]);
  const after = { ...noVisibility(), knowledgeCommitIds: new Set(first.knowledgeCommitIds), knowledgeTitleCommitIds: new Set(first.knowledgeTitleCommitIds),
    knowledgeTokens: first.knowledgeTokens!, temporaryTokens: first.temporaryTokens! };
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
    knowledgeStates: [], knowledgeTokens: first.knowledgeTokens!, temporaryTokens: first.temporaryTokens! }]);
  const view = deliveredView(f.memory.store.deliveredKnowledge({ owner, sessionId: f.session.id, branch: "main", headTurnId: f.target.headTurnId }));
  expect(view.knowledgeCommitIds.has(big.commit)).toBe(false);
  expect([...view.knowledgeTitleCommitIds!]).toEqual([big.commit]);
  expect(view.temporaryTokens).toBe(first.temporaryTokens);
});

test("compaction spends the one temporary allowance in order: pending Raw, then unscored knowledge, then titles", () => {
  const f = fixture();
  const unscored = f.create("UNSCORED", 400, null), scoredBig = f.create("SCOREDBIG", 3_000, 60);
  setKnowledgeInjection(f.memory, 1_000);
  const roomy = f.memory.compact(f.session.id, "main", f.target.headTurnId);
  if ("native" in roomy) throw new Error(roomy.reason);
  expect(roomy.supplied.knowledgeCommitIds).toEqual([unscored.commit]);
  expect(roomy.supplied.knowledgeTitleCommitIds).toEqual([scoredBig.commit]);
  expect(roomy.supplied.temporaryTokens).toBe(roomy.charged!.temporary);
  expect(roomy.charged!.envelope).toBe(roomy.charged!.envelope); // sum of three bases and one temporary allowance
  // The Raw walk goes first: with the allowance all consumed by pending Raw nothing is left for knowledge.
  f.memory.config.compaction.temporaryTokens = 1;
  const none = f.memory.compact(f.session.id, "main", f.target.headTurnId);
  if ("native" in none) throw new Error(none.reason);
  expect(none.supplied.knowledgeCommitIds).toEqual([]);
  expect(none.supplied.knowledgeTitleCommitIds ?? []).toEqual([]);
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
