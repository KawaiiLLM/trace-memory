import { expect, test } from "vitest";
import { sourceSeededMemory, recorded, seedSourceEntry } from "../../source-fixture.ts";
import { facts, legacyFacts } from "../../support/seed.ts";
import { charge, renderEntry, tokens, xmlBlock } from "../../../src/core/render/index.ts";
import { freezeNoting } from "../../../src/core/noting/index.ts";
import { pricedToolDefinitions, notingToolDefinitions } from "../../../src/core/api/tools.ts";
import { FACT_TITLES_TITLE, measureRetainedMemoryText, rawWindowTokens } from "../../../src/core/render/material.ts";
import { noVisibility } from "../../../src/core/api/visible.ts";

const at = "2026-10-09T00:00:00Z";
function setup() {
  const memory = sourceSeededMemory(":memory:", async () => { throw new Error("no model"); });
  const project = memory.store.createProject({ name: "temporary", declaredBy: "marker" });
  const session = memory.store.createSession({ host: "fake", projectId: project.id, enrollmentChoice: true, startedAt: at, firstReplyAt: at });
  return { memory, session };
}


test("133/140: user words default to one hundred anchor-inclusive path turns, are configurable, human-only and middle-cut", () => {
  const { memory, session } = setup();
  try {
    let parent: number | undefined;
    const users = Array.from({ length: 102 }, (_, index) => {
      const text = index === 4 ? "<task-notification>agent done" : index === 101 ? `HEAD ${"middle ".repeat(3000)} TAIL` : `human-${index}`;
      const turn = memory.store.appendTurn({ sessionId: session.id, parentTurnId: parent, kind: "turn", startedAt: at, userPrompt: text });
      parent = turn.id;
      return memory.store.getSourceEntry(memory.store.listSourceEntries(session.id, turn.id)[0]!.id)!;
    });
    recorded(memory, session.id, "main", parent!);
    Object.assign(memory.config.compaction, { rawTokens: 1, temporaryTokens: 2000 });
    const result = memory.compact(session.id, "main", parent!);
    if ("native" in result) throw new Error("native");
    expect(result.material!.earlierUsers!.map(e => e.id)).toEqual(users.slice(2).filter((_, index) => index !== 2).map(e => e.id));
    const newest = result.material!.earlierUsers!.at(-1)!.view;
    expect(newest).toContain("HEAD"); expect(newest).toContain("TAIL");
    expect(newest).toMatch(/\[\.\.\. \d+ characters truncated\]/);
    expect(tokens(newest)).toBeLessThanOrEqual(300);
    expect(result.text).not.toContain("agent done");
    expect(result.supplied.entries).toEqual([]); // 300-token excerpts never claim ordinary Raw coverage
    memory.config.compaction.userTurns = 5;
    const shorter = memory.compact(session.id, "main", parent!);
    if ("native" in shorter) throw new Error("native");
    expect(shorter.material!.earlierUsers!.map(e => e.id)).toEqual(users.slice(-5).map(e => e.id));
    memory.config.compaction.temporaryTokens = 250;
    const limited = memory.compact(session.id, "main", parent!);
    if ("native" in limited) throw new Error("native");
    expect(limited.material!.earlierUsers).toEqual([]); // newest does not fit; older small entries cannot skip it
    expect(limited.material!.receipts.some(line => line.includes("earlier user messages; expand: trace://raw/"))).toBe(true);
  } finally { memory.close(); }
});

test("133: titles default to one hundred anchor-inclusive path turns, are configurable, and untitled facts stay bare", () => {
  const { memory, session } = setup();
  try {
    let parent: number | undefined;
    const seeded = Array.from({ length: 102 }, (_, index) => {
      const turn = memory.store.appendTurn({ sessionId: session.id, parentTurnId: parent, kind: "turn", startedAt: at, userPrompt: `source-${index}` });
      parent = turn.id;
      const source = memory.store.getSourceEntry(memory.store.listSourceEntries(session.id, turn.id)[0]!.id)!;
      if (index === 5) return legacyFacts(memory.store, { kind: "noting", sessionId: session.id, branch: "main", createdAt: at },
        [{ sources: [{ entry: source, address: `T${turn.id}#user` }], text: "legacy body", category: "observation", actor: "user", createdAt: at }]).facts[0]!;
      return facts(memory, { sessionId: session.id, branch: "main", headTurnId: turn.id },
        [{ title: `Episode ${index}`, sources: [{ entry: source, text: `evidence-${index} `.repeat(100) }] }])[0]!;
    });
    recorded(memory, session.id, "main", parent!);
    Object.assign(memory.config.compaction, { rawTokens: 1, factsTokens: 1000, temporaryTokens: 1 });
    const baseline = memory.compact(session.id, "main", parent!);
    memory.config.compaction.temporaryTokens = 20000; // room for both kinds to reach their 100 turns (140)
    const result = memory.compact(session.id, "main", parent!);
    if ("native" in result || "native" in baseline) throw new Error("native");
    expect(result.supplied.factIds).toEqual(baseline.supplied.factIds);
    const full = new Set(result.supplied.factIds);
    const expected = seeded.slice(2).filter(fact => fact.title && !full.has(fact.id));
    expect(result.material!.factTitles!.map(line => Number(/\[F(\d+)\]/.exec(line)![1]))).toEqual(expected.map(fact => fact.id));
    expect(result.material!.factTitles![0]).toBe(`[T${expected[0]!.turnId}] ${at}\n[F${expected[0]!.id}] ${expected[0]!.title}`);
    expect(result.text.indexOf("Earlier facts (titles only")).toBeLessThan(result.text.indexOf("Recent facts (by Turn)"));
    expect(result.material!.receipts.some(line => line.includes(`trace://F${seeded[5]!.id}`))).toBe(true);
    expect(result.charged!.temporary).toBeLessThanOrEqual(20000);
    memory.config.compaction.titleTurns = 7;
    const shorter = memory.compact(session.id, "main", parent!);
    if ("native" in shorter) throw new Error("native");
    expect(shorter.material!.factTitles!.map(line => Number(/\[F(\d+)\]/.exec(line)![1])))
      .toEqual(seeded.slice(-7).filter(fact => fact.title && !full.has(fact.id)).map(fact => fact.id));
    memory.config.compaction.titleTurns = 100;
    const latest = memory.store.appendTurn({ sessionId: session.id, parentTurnId: parent, kind: "turn", startedAt: at, userPrompt: "new batch" });
    const n = freezeNoting(memory.store, { sessionId: session.id, branch: "main", headTurnId: latest.id }, memory.config);
    expect(n.prepared!.material.entries.map(e => e.id)).toEqual(n.entries.map(e => e.id));
    expect(n.prepared!.material.earlierUsers!.map(e => e.id)).toEqual(memory.store.sourcePath(session.id, "main", latest.id).filter(e => e.turnId >= latest.id - 99 && e.turnId < latest.id).map(e => e.id));
    expect(n.prepared!.material.factTitles!.map(line => Number(/\[F(\d+)\]/.exec(line)![1]))).toEqual(seeded.slice(3).filter(fact => fact.title && !full.has(fact.id)).map(fact => fact.id));
    const fixed = tokens(n.prompt) + tokens(JSON.stringify(pricedToolDefinitions(notingToolDefinitions, n.names)));
    const capacity = fixed + tokens(n.prepared!.text) - 200;
    const smaller = freezeNoting(memory.store, { sessionId: session.id, branch: "main", headTurnId: latest.id,
      capacity: { inputTokens: capacity } }, memory.config);
    expect(smaller.entries.map(e => e.id)).toEqual(n.entries.map(e => e.id));
    expect(smaller.prepared!.material.facts).toEqual(n.prepared!.material.facts);
    // 140: negotiation trims both kinds from the oldest end, so the user entries shrink too.
    const keptUsers = n.prepared!.material.earlierUsers!, trimmedUsers = smaller.prepared!.material.earlierUsers!;
    expect(trimmedUsers.length).toBeLessThan(keptUsers.length);
    expect(trimmedUsers).toEqual(keptUsers.slice(keptUsers.length - trimmedUsers.length));
    expect(fixed + tokens(smaller.prepared!.text)).toBeLessThanOrEqual(capacity);
    expect(result.text).toMatchSnapshot("compaction material");
    expect(n.prepared!.text).toMatchSnapshot("Noter material");
  } finally { memory.close(); }
});

test("133: titles stop at the newest non-fitting title, skip untitled facts, and charge their omission receipt only to facts", () => {
  const { memory, session } = setup();
  try {
    const old = memory.store.appendTurn({ sessionId: session.id, kind: "turn", startedAt: at, userPrompt: "<task-notification>old source" });
    const olderSource = memory.store.getSourceEntry(memory.store.listSourceEntries(session.id, old.id)[0]!.id)!;
    const [small] = facts(memory, { sessionId: session.id, branch: "main", headTurnId: old.id },
      [{ title: "Small older episode", sources: [{ entry: olderSource, text: "older evidence" }] }]);
    const untitledTurn = memory.store.appendTurn({ sessionId: session.id, parentTurnId: old.id, kind: "turn", startedAt: at, userPrompt: "<task-notification>untitled source" });
    const untitledSource = memory.store.getSourceEntry(memory.store.listSourceEntries(session.id, untitledTurn.id)[0]!.id)!;
    const untitled = legacyFacts(memory.store, { kind: "noting", sessionId: session.id, branch: "main", createdAt: at },
      [{ sources: [{ entry: untitledSource, address: `T${untitledTurn.id}#user` }], text: "untitled evidence", category: "observation", actor: "user", createdAt: at }]).facts[0]!;
    const latest = memory.store.appendTurn({ sessionId: session.id, parentTurnId: untitledTurn.id, kind: "turn", startedAt: at, userPrompt: "<task-notification>latest source" });
    const newestSource = memory.store.getSourceEntry(memory.store.listSourceEntries(session.id, latest.id)[0]!.id)!;
    const [large] = facts(memory, { sessionId: session.id, branch: "main", headTurnId: latest.id },
      [{ title: "Oversized ".repeat(400), sources: [{ entry: newestSource, text: "newest evidence" }] }]);
    recorded(memory, session.id, "main", latest.id);
    Object.assign(memory.config.compaction, { rawTokens: 1, factsTokens: 1, temporaryTokens: 200 });
    const stopped = memory.compact(session.id, "main", latest.id);
    if ("native" in stopped) throw new Error("native");
    expect(stopped.material!.factTitles).toEqual([]); // break, not continue to the older small title
    expect(stopped.supplied.factIds).toEqual([]);

    const visible = noVisibility(); visible.factIds.add(large!.id);
    const olderFits = memory.compact(session.id, "main", latest.id, visible);
    if ("native" in olderFits) throw new Error("native");
    expect(olderFits.material!.earlierUsers).toEqual([]);
    expect(olderFits.material!.entries).toEqual([]);
    expect(olderFits.material!.factTitles).toEqual([`[T${old.id}] ${at}\n[F${small!.id}] Small older episode`]);
    expect(olderFits.material!.receipts).toHaveLength(1);
    const receipt = olderFits.material!.receipts[0]!;
    expect(receipt).toContain(`trace://F${untitled.id}`);
    expect(receipt).not.toContain(`trace://F${small!.id}`);
    expect(olderFits.charged!.facts).toBe(charge([receipt]) + charge(["Receipts:"]));
    expect(olderFits.charged!.temporary).toBe(
      charge([xmlBlock("episodic", ""), FACT_TITLES_TITLE]) + charge(olderFits.material!.factTitles!));
  } finally { memory.close(); }
});

test("133: pending Raw has first claim, user words next, and fact titles take only their remainder", () => {
  const { memory, session } = setup();
  try {
    const old = memory.store.appendTurn({ sessionId: session.id, kind: "turn", startedAt: at, userPrompt: "human ".repeat(30) });
    const source = memory.store.getSourceEntry(memory.store.listSourceEntries(session.id, old.id)[0]!.id)!;
    const [olderFact] = facts(memory, { sessionId: session.id, branch: "main", headTurnId: old.id },
      [{ title: "An older episode to locate after compaction", sources: [{ entry: source, text: "historical evidence ".repeat(30) }] }]);
    recorded(memory, session.id, "main", old.id);
    const latest = memory.store.appendTurn({ sessionId: session.id, parentTurnId: old.id, kind: "turn", startedAt: at, userPrompt: "pending ".repeat(60) });
    Object.assign(memory.config.compaction, { rawTokens: 100, factsTokens: 1, temporaryTokens: 80 });
    const result = memory.compact(session.id, "main", latest.id);
    if ("native" in result) throw new Error("native");
    expect(result.supplied.entries.map(e => e.id)).toEqual(memory.store.listSourceEntries(session.id, latest.id).map(e => e.id));
    expect(result.material!.earlierUsers!.map(e => e.id)).toEqual([source.id]);
    expect(result.material!.factTitles).toEqual([]);
    memory.config.compaction.temporaryTokens = 40;
    const rawFirst = memory.compact(session.id, "main", latest.id);
    if ("native" in rawFirst) throw new Error("native");
    expect(rawFirst.supplied.entries.map(e => e.id)).toEqual(result.supplied.entries.map(e => e.id));
    expect(rawFirst.material!.earlierUsers).toEqual([]);
    expect(rawFirst.material!.factTitles).toEqual([]);
    memory.config.compaction.temporaryTokens = 250;
    const roomy = memory.compact(session.id, "main", latest.id);
    if ("native" in roomy) throw new Error("native");
    expect(roomy.material!.factTitles).toEqual([`[T${old.id}] ${at}\n[F${olderFact!.id}] An older episode to locate after compaction`]);
    expect(roomy.supplied.factIds).toEqual([]);
  } finally { memory.close(); }
});

test("133: default pending Raw fills its 20k base-plus-temporary window, within the emitted 50k envelope (the shared allowance is gone)", () => {
  const { memory, session } = setup();
  try {
    const turn = memory.store.appendTurn({ sessionId: session.id, kind: "turn", startedAt: at, userPrompt: "pending source" });
    for (let index = 0; index < 12; index++) memory.appendEntry({ sessionId: session.id, turnId: turn.id,
      nativeLineage: "fixture", nativeId: `pending-${index}`, role: "assistant", text: `entry-${index} ${"word ".repeat(1750)}`, raw: "", calls: [] });
    const source = memory.store.sourcePath(session.id, "main", turn.id);
    const result = memory.compact(session.id, "main", turn.id);
    if ("native" in result) throw new Error("native");
    expect(result.charged!.envelope).toBe(50_000);
    expect(result.charged!.raw).toBe(10_000);
    const rawCharge = result.charged!.raw + result.charged!.temporary;
    expect(rawCharge).toBeGreaterThan(18_000);
    expect(rawCharge).toBeLessThanOrEqual(20_000);
    const kept = result.material!.entries!;
    const omitted = source.filter(entry => !result.supplied.entries.some(supplied => supplied.id === entry.id));
    expect(result.truncated?.raw).toEqual({ entries: omitted.length });
    expect(omitted.length).toBeGreaterThan(0);
    const next = renderEntry(memory.store.getSourceEntry(omitted.at(-1)!.id)!, memory.config.render);
    const rawReceipts = result.material!.receipts.filter(receipt => receipt.includes("earlier entries omitted from the Raw window"));
    expect(rawWindowTokens([next.content, ...kept.map(entry => entry.view)], [...next.receipts, ...rawReceipts])).toBeGreaterThan(20_000);
    const charged = result.charged!;
    expect(charged.knowledge + charged.facts + charged.raw + charged.temporary).toBeLessThanOrEqual(charged.envelope);
  } finally { memory.close(); }
});

test("133: live tasks survive exhausted windows and are included in measured text, never charged to them", () => {
  const { memory, session } = setup();
  try {
    const turn = memory.store.appendTurn({ sessionId: session.id, kind: "turn", startedAt: at, userPrompt: "pending" });
    Object.assign(memory.config.compaction, { rawTokens: 1, factsTokens: 1, temporaryTokens: 1, sharedAllowanceTokens: 1 });
    const without = memory.compact(session.id, "main", turn.id);
    const withTask = memory.compact(session.id, "main", turn.id, [], false,
      { runningTasks: [{ id: "live1", kind: "Explore", description: "Investigate the active branch", status: "running" }] });
    if ("native" in without || "native" in withTask) throw new Error("native");
    expect(without.text).not.toContain("Running tasks:");
    expect(withTask.text).toContain("Running tasks:");
    expect(withTask.text).toContain("- live1 Explore: Investigate the active branch (running)");
    expect(withTask.charged).toEqual(without.charged);
    expect(withTask.supplied).toEqual(without.supplied);
    expect(measureRetainedMemoryText(withTask.text, withTask.text, 0, withTask.text.length))
      .toEqual({ knowledge: 0, facts: 0, raw: 0, unclassified: tokens(withTask.text) });
  } finally { memory.close(); }
});

// 140: the user's words and fact titles fill together by turn, newest turn first.
function titledTurns(turns: number, userText: (index: number) => string, title: (index: number) => string) {
  const { memory, session } = setup();
  let parent: number | undefined;
  const seeded = Array.from({ length: turns }, (_, index) => {
    const turn = memory.store.appendTurn({ sessionId: session.id, parentTurnId: parent, kind: "turn", startedAt: at, userPrompt: userText(index) });
    parent = turn.id;
    const source = memory.store.getSourceEntry(memory.store.listSourceEntries(session.id, turn.id)[0]!.id)!;
    return facts(memory, { sessionId: session.id, branch: "main", headTurnId: turn.id }, [{ title: title(index), sources: [{ entry: source, text: `evidence-${index}` }] }])[0]!;
  });
  Object.assign(memory.config.compaction, { rawTokens: 1, factsTokens: 1, temporaryTokens: 3000 });
  return { memory, session, seeded, head: parent!, recorded: (to = parent!) => recorded(memory, session.id, "main", to) };
}
const userTurnsOf = (m: { earlierUsers?: { view: string }[] }) => (m.earlierUsers ?? []).map(e => Number(/^\[T(\d+)#/.exec(e.view)![1]));
const titleTurnsOf = (m: { factTitles?: string[] }) => (m.factTitles ?? []).map(line => Number(/\[F\d+\]/.test(line) ? /^\[T(\d+)\]/.exec(line)?.[1] ?? NaN : NaN)).filter(Number.isFinite);

test("140: defaults are one hundred user turns, three hundred tokens per user entry and one hundred title turns", () => {
  const { memory } = setup();
  try { expect(memory.config.compaction).toMatchObject({ userTurns: 100, userEntryTokens: 300, titleTurns: 100 }); } finally { memory.close(); }
});

test.each([
  ["large user entries", (i: number) => `user-${i} ${"word ".repeat(120)}`, (i: number) => `Episode ${i}`, 0],
  ["large titles", (i: number) => `user-${i}`, (i: number) => `Episode ${i} ${"title ".repeat(80)}`, 1],
])("140: with %s the oldest user entry and the oldest title come from the same depth", (_, userText, title, apart) => {
  const { memory, session, seeded, head, recorded: record } = titledTurns(60, userText, title);
  try {
    record();
    const result = memory.compact(session.id, "main", head);
    if ("native" in result) throw new Error("native");
    const users = userTurnsOf(result.material!), titles = titleTurnsOf(result.material!);
    expect(users.length).toBeGreaterThan(3); expect(titles.length).toBeGreaterThan(3);
    expect(users.length).toBeLessThan(60); // the allowance ran out before the reach
    expect(Math.min(...titles) - Math.min(...users)).toBe(apart);
    expect(result.charged!.temporary).toBeLessThanOrEqual(3000);
  } finally { memory.close(); }
});

test("140: a kind at its own reach drops out and the other continues alone to its reach", () => {
  const { memory, session, seeded, head, recorded: record } = titledTurns(40, i => `user-${i}`, i => `Episode ${i}`);
  try {
    record();
    Object.assign(memory.config.compaction, { temporaryTokens: 20000, userTurns: 10, titleTurns: 40 });
    const result = memory.compact(session.id, "main", head);
    if ("native" in result) throw new Error("native");
    expect(Math.min(...userTurnsOf(result.material!))).toBe(head - 9);
    expect(Math.min(...titleTurnsOf(result.material!))).toBe(head - 39);
  } finally { memory.close(); }
});

test("140: the first item that does not fit stops both kinds, and the receipts list what was left out", () => {
  const { memory, session, seeded, head, recorded: record } = titledTurns(30, i => `user-${i}`, i => i === 20 ? `Oversized ${"title ".repeat(5000)}` : `Episode ${i}`);
  try {
    record();
    const result = memory.compact(session.id, "main", head);
    if ("native" in result) throw new Error("native");
    const stop = seeded[20]!.turnId;
    expect(Math.min(...userTurnsOf(result.material!))).toBe(stop); // that turn's user entry precedes its title
    expect(Math.min(...titleTurnsOf(result.material!))).toBe(stop + 1); // older small titles and users do not skip ahead
    expect(result.material!.receipts.some(line => line.includes(`trace://F${seeded[20]!.id}`) && line.includes(`trace://F${seeded[0]!.id}`))).toBe(true);
    expect(result.material!.receipts.some(line => line.includes("earlier user messages") && line.includes(`T${stop - 1}#E1`))).toBe(true);
  } finally { memory.close(); }
});

test("140: pending Raw still borrows first, and the two kinds fill what it leaves", () => {
  const depth = (pending: boolean) => {
    const { memory, session, seeded, head, recorded: record } = titledTurns(60, i => i >= 57 ? `pending-${i} ${"word ".repeat(700)}` : `user-${i}`, i => `Episode ${i}`);
    try {
      memory.config.compaction.rawTokens = 1500; // the three pending entries fill it and borrow the rest
      record(pending ? seeded[56]!.turnId : head);
      const result = memory.compact(session.id, "main", head);
      if ("native" in result) throw new Error("native");
      expect(result.truncated).toBeUndefined();
      if (pending) expect(result.material!.entries).toHaveLength(3);
      expect(result.charged!.temporary).toBeLessThanOrEqual(3000);
      const users = userTurnsOf(result.material!), titles = titleTurnsOf(result.material!);
      return { users: Math.min(...users), titles: Math.min(...titles) };
    } finally { memory.close(); }
  };
  const free = depth(false), borrowing = depth(true);
  expect(borrowing.users).toBeGreaterThan(free.users); // the borrowed Raw took its share first
  expect(borrowing.titles).toBeGreaterThan(free.titles);
});

test("140: an entry appended to an older turn after a newer turn was written keeps the user receipt true to what was shown", () => {
  const { memory, session } = setup();
  try {
    const t1 = memory.store.appendTurn({ sessionId: session.id, kind: "turn", startedAt: at, userPrompt: "first" });
    const t2 = memory.store.appendTurn({ sessionId: session.id, parentTurnId: t1.id, kind: "turn", startedAt: at, userPrompt: "second" });
    seedSourceEntry(memory, t1.id, "user", `later ${"word ".repeat(150)}`); // written last, on the older turn
    const [e1, e2] = memory.store.listSourceEntries(session.id, t1.id); // the turns carry user entries alone
    const [second] = memory.store.listSourceEntries(session.id, t2.id);
    const address = (e: { turnId: number; entryOrdinal: number }) => `T${e.turnId}#E${e.entryOrdinal}`;
    recorded(memory, session.id, "main", t2.id);
    Object.assign(memory.config.compaction, { rawTokens: 1, factsTokens: 1, temporaryTokens: 150 });
    const result = memory.compact(session.id, "main", t2.id);
    if ("native" in result) throw new Error("native");
    expect(result.material!.entries).toEqual([]);
    expect(result.material!.earlierUsers!.map(e => e.id)).toEqual([second!.id]); // only the newest turn's entry fits
    const receipt = result.material!.receipts.filter(line => line.includes("earlier user messages"));
    expect(receipt).toHaveLength(1);
    expect(receipt[0]!.match(/trace:\/\/raw\/S\d+\/(T\d+#E\d+)/g)!.map(link => link.split("/").pop())).toEqual([address(e2!), address(e1!)]);
    expect(receipt[0]).toContain("omitted 2 earlier");
    expect(result.charged!.temporary).toBeLessThanOrEqual(150);
    // With room for all three, they display by path (turn, then entry), not by write order.
    memory.config.compaction.temporaryTokens = 3000;
    const all = memory.compact(session.id, "main", t2.id);
    if ("native" in all) throw new Error("native");
    expect(all.material!.earlierUsers!.map(e => e.id)).toEqual([e1!.id, e2!.id, second!.id]);
  } finally { memory.close(); }
});
