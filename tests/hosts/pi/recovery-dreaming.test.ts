import { expect, test } from "vitest";
import { host } from "./test-host.ts";
import { tokens } from "../../../src/core/render/index.ts";
import { knowledge, legacyFacts } from "../../support/seed.ts";

const compact = (h: ReturnType<typeof host>, signal?: AbortSignal) =>
  h.emit("session_before_compact", { preparation: { tokensBefore: 100000 }, signal }) as Promise<any>;

async function seeded(options: { rawTokens?: number } = {}) {
  const h = host({ "noting.triggerTokens": 10_000, "consolidation.triggerTokens": 5_000,
    "dreaming.triggerKnowledge": 1, "compaction.factsTokens": 10_000, "compaction.rawTokens": options.rawTokens ?? 10_000 });
  if (options.rawTokens !== undefined) {
    await h.prompt("oversized required raw " + "word ".repeat(12_000));
    await h.answer(); await h.emit("agent_end"); await h.drain();
  } else await h.turn();
  const store = h.memory.store;
  const user = store.sourcePath(1, "main", 1).find(entry => store.getSourceEntry(entry.id)?.role === "user")!;
  const evidence = legacyFacts(store, { kind: "manual", sessionId: 1, createdAt: "seed" },
    [{ sources: [{ entry: user, address: `T1#E${user.entryOrdinal}` }], actor: "user", category: "decision",
      text: "Keep this rule", createdAt: "seed" }]).facts[0]!;
  const created = knowledge(store, store.knowledgePath(1, "main", 1), "project", "constraint", [evidence.id],
    "rule ".repeat(6000), { operation: { createdAt: "seed", title: "Fixture title" } }); // Noter-written: only Noter changes make the Dreamer due
  const pool = `project:${store.getSession(1)!.projectId}`;
  const pending = tokens("rule ".repeat(6000)); // the item's weight in the knowledge window
  h.memory.setKnowledgeBase(pending * 2);
  return { h, store, pool, revisionId: created.commit };
}

// Pending changed knowledge is a scheduling trigger, not required compaction material.
test("64c: due changed knowledge fits the knowledge window without compaction Dreamer recovery", async () => {
  const { h, store, pool, revisionId } = await seeded();
  try {
    const path = store.knowledgePath(1, "main");
    if (path.headTurnId === null) throw new Error("fixture requires a current Turn");
    expect(store.dreamingDue(path, 1)).toBe(true);
    const result = await compact(h);
    expect(result.compaction.summary).toContain("rule");
    expect(h.requests).toEqual([]);
    expect(store.listRuns(1).filter(run => run.kind === "dreaming")).toEqual([]);
    expect(store.db.prepare("SELECT 1 FROM knowledge_processed WHERE pool = ? AND revision_id = ?").get(pool, revisionId)).toBeUndefined();
  } finally { await h.dispose(); }
});

test("133 R1 supersedes 73: oversized pending Raw delegates natively without a Dreamer run", async () => {
  const { h, store } = await seeded({ rawTokens: 100 });
  try {
    h.memory.setKnowledgeBase(0);
    const turnId = store.listTurns(1).at(-1)!.id;
    for (let i = 0; i < 20; i++) h.memory.appendEntry({ sessionId: 1, turnId, nativeLineage: "oversized",
      nativeId: `extra-${i}`, role: "assistant", text: "word ".repeat(3_000), raw: "", calls: [] });
    h.memory.selectEntries(1, "main", store.listSourceEntries(1).map(entry => entry.id));
    const pending = store.pendingEntries(1, "main", turnId).map(entry => entry.id);
    const result = await compact(h);
    expect(result).toBeUndefined();
    expect(store.pendingEntries(1, "main", turnId).map(entry => entry.id)).toEqual(pending);
    expect(h.notices.some(n => n.includes("native delegation") && n.includes("pending Raw does not fit"))).toBe(true);
    expect(h.notices.some(n => n.includes("compaction omitted"))).toBe(false);
    expect(h.requests).toEqual([]);
    expect(store.listRuns(1).filter(run => run.kind === "dreaming")).toEqual([]);
  } finally { await h.dispose(); }
});
