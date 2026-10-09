import { expect, test } from "vitest";
import { sourceSeededMemory, recorded } from "../../source-fixture.ts";
import { facts, legacyFacts } from "../../support/seed.ts";
import { tokens } from "../../../src/core/render/index.ts";
import { freezeNoting } from "../../../src/core/noting/index.ts";
import { pricedToolDefinitions, toolDefinitions } from "../../../src/core/api/tools.ts";
import { measureRetainedMemoryText } from "../../../src/core/render/material.ts";

const at = "2026-10-09T00:00:00Z";
function setup() {
  const memory = sourceSeededMemory(":memory:", async () => { throw new Error("no model"); });
  const project = memory.store.createProject({ name: "temporary", declaredBy: "marker" });
  const session = memory.store.createSession({ host: "fake", projectId: project.id, enrollmentChoice: true, startedAt: at, firstReplyAt: at });
  return { memory, session };
}


test("133: user words default to thirty anchor-inclusive path turns, are configurable, human-only and middle-cut", () => {
  const { memory, session } = setup();
  try {
    let parent: number | undefined;
    const users = Array.from({ length: 32 }, (_, index) => {
      const text = index === 4 ? "<task-notification>agent done" : index === 31 ? `HEAD ${"middle ".repeat(3000)} TAIL` : `human-${index}`;
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
    expect(tokens(newest)).toBeLessThanOrEqual(500);
    expect(result.text).not.toContain("agent done");
    expect(result.supplied.entries).toEqual([]); // 500-token excerpts never claim ordinary Raw coverage
    memory.config.compaction.userTurns = 5;
    const shorter = memory.compact(session.id, "main", parent!);
    if ("native" in shorter) throw new Error("native");
    expect(shorter.material!.earlierUsers!.map(e => e.id)).toEqual(users.slice(-5).map(e => e.id));
    memory.config.compaction.temporaryTokens = 400;
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
    memory.config.compaction.temporaryTokens = 8000;
    const result = memory.compact(session.id, "main", parent!);
    if ("native" in result || "native" in baseline) throw new Error("native");
    expect(result.supplied.factIds).toEqual(baseline.supplied.factIds);
    const full = new Set(result.supplied.factIds);
    const expected = seeded.slice(2).filter(fact => fact.title && !full.has(fact.id));
    expect(result.material!.factTitles!.map(line => Number(/\[F(\d+)\]/.exec(line)![1]))).toEqual(expected.map(fact => fact.id));
    expect(result.material!.factTitles![0]).toBe(`[T${expected[0]!.turnId}] ${at}\n[F${expected[0]!.id}] ${expected[0]!.title}`);
    expect(result.text.indexOf("Earlier facts (titles only")).toBeLessThan(result.text.indexOf("Recent facts (by Turn)"));
    expect(result.material!.receipts.some(line => line.includes(`trace://F${seeded[5]!.id}`))).toBe(true);
    expect(result.charged!.temporary).toBeLessThanOrEqual(8000);
    memory.config.compaction.titleTurns = 7;
    const shorter = memory.compact(session.id, "main", parent!);
    if ("native" in shorter) throw new Error("native");
    expect(shorter.material!.factTitles!.map(line => Number(/\[F(\d+)\]/.exec(line)![1])))
      .toEqual(seeded.slice(-7).filter(fact => fact.title && !full.has(fact.id)).map(fact => fact.id));
    memory.config.compaction.titleTurns = 100;
    const latest = memory.store.appendTurn({ sessionId: session.id, parentTurnId: parent, kind: "turn", startedAt: at, userPrompt: "new batch" });
    const n = freezeNoting(memory.store, { sessionId: session.id, branch: "main", headTurnId: latest.id, mode: "subagent" }, memory.config);
    expect(n.prepared!.material.entries.map(e => e.id)).toEqual(n.entries.map(e => e.id));
    expect(n.prepared!.material.earlierUsers!.map(e => e.id)).toEqual(memory.store.sourcePath(session.id, "main", latest.id).filter(e => e.turnId >= latest.id - 29 && e.turnId < latest.id).map(e => e.id));
    expect(n.prepared!.material.factTitles!.map(line => Number(/\[F(\d+)\]/.exec(line)![1]))).toEqual(seeded.slice(3).filter(fact => fact.title && !full.has(fact.id)).map(fact => fact.id));
    const fixed = tokens(n.prompt) + tokens(JSON.stringify(pricedToolDefinitions(toolDefinitions, n.names)));
    const capacity = fixed + tokens(n.prepared!.text) - 200;
    const smaller = freezeNoting(memory.store, { sessionId: session.id, branch: "main", headTurnId: latest.id,
      mode: "subagent", capacity: { inputTokens: capacity, prefixTokens: 0 } }, memory.config);
    expect(smaller.entries.map(e => e.id)).toEqual(n.entries.map(e => e.id));
    expect(smaller.prepared!.material.facts).toEqual(n.prepared!.material.facts);
    expect(smaller.prepared!.material.earlierUsers).toEqual(n.prepared!.material.earlierUsers);
    expect(fixed + tokens(smaller.prepared!.text)).toBeLessThanOrEqual(capacity);
    expect(result.text).toMatchSnapshot("compaction material");
    expect(n.prepared!.text).toMatchSnapshot("Noter material");
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
    memory.config.compaction.temporaryTokens = 400;
    const roomy = memory.compact(session.id, "main", latest.id);
    if ("native" in roomy) throw new Error("native");
    expect(roomy.material!.factTitles).toEqual([`[T${old.id}] ${at}\n[F${olderFact!.id}] An older episode to locate after compaction`]);
    expect(roomy.supplied.factIds).toEqual([]);
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
