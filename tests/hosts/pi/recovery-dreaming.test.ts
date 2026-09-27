import { expect, test } from "vitest";
import { host } from "./test-host.ts";
import { knowledge, legacyFacts } from "../../support/seed.ts";

const compact = (h: ReturnType<typeof host>, signal?: AbortSignal) =>
  h.emit("session_before_compact", { preparation: { tokensBefore: 100000 }, signal }) as Promise<any>;

async function seeded(options: { rawTokens?: number } = {}) {
  const h = host({ "noting.triggerTokens": 10_000, "consolidation.triggerTokens": 5_000,
    "compaction.factsTokens": 10_000, "compaction.rawTokens": options.rawTokens ?? 10_000 });
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
    "rule ".repeat(6000), { run: { kind: "manual", createdAt: "seed" }, operation: { createdAt: "seed" } });
  const pool = `project:${store.getSession(1)!.projectId}`;
  const pending = store.pendingVersions(pool, store.knowledgePath(1))[0]!.tokens;
  h.memory.setKnowledgeBudget("project", pending * 2);
  return { h, store, pool, revisionId: created.commit };
}

// Pending changed knowledge is a scheduling trigger, not required compaction material.
test("64c: due changed knowledge fits the knowledge window without compaction Dreamer recovery", async () => {
  const { h, store, pool, revisionId } = await seeded();
  try {
    const path = store.knowledgePath(1, "main");
    if (path.headTurnId === null) throw new Error("fixture requires a current Turn");
    expect(store.duePools(path).map(value => value.pool)).toContain(pool);
    const result = await compact(h);
    expect(result.compaction.summary).toContain("rule");
    expect(h.requests).toEqual([]);
    expect(store.listRuns(1).filter(run => run.kind === "dreaming")).toEqual([]);
    expect(store.db.prepare("SELECT 1 FROM knowledge_processed WHERE pool = ? AND revision_id = ?").get(pool, revisionId)).toBeUndefined();
  } finally { await h.dispose(); }
});

test("73: genuinely oversized pending Raw truncates to the newest span; pending knowledge does not fake retention or a Dreamer run", async () => {
  const { h, store } = await seeded({ rawTokens: 100 });
  try {
    h.memory.setKnowledgeBudget("global", 0);
    h.memory.setKnowledgeBudget("project", 0);
    h.memory.setKnowledgeBudget("session", 0);
    const turnId = store.listTurns(1).at(-1)!.id;
    for (let i = 0; i < 20; i++) h.memory.appendEntry({ sessionId: 1, turnId, nativeLineage: "oversized",
      nativeId: `extra-${i}`, role: "assistant", text: "word ".repeat(3_000), raw: "", calls: [] });
    h.memory.selectEntries(1, "main", store.listSourceEntries(1).map(entry => entry.id));
    const result = await compact(h);
    // 73: no fallback. Compact truncates to the newest contiguous Raw span instead of delegating, and
    // the foreground warns about what it omitted once Pi appends the carrier.
    expect(result.compaction).toBeTruthy();
    const entry = { id: "compact", parentId: h.entries.at(-1)!.id, timestamp: "now", type: "compaction",
      summary: result.compaction.summary, firstKeptEntryId: "", tokensBefore: 100_000, details: result.compaction.details };
    h.entries.push(entry as never); h.allEntries.push(entry as never);
    await h.emit("session_compact", { compactionEntry: entry });
    expect(h.notices.some(n => n.includes("compaction omitted"))).toBe(true);
    expect(h.requests.every(request => !JSON.stringify(request).includes("# Dreamer"))).toBe(true);
    expect(store.listRuns(1).filter(run => run.kind === "dreaming")).toEqual([]);
  } finally { await h.dispose(); }
});
