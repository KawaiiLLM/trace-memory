import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { call, fixture, piSession, say } from "./native-fixture.ts";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { host } from "./test-host.ts";
import { knowledgeBatch, legacyFacts } from "../../support/seed.ts";
import extension from "../../../src/hosts/pi/index.ts";

// Real foreground hooks and persisted Pi compactions, not repeated calls to the allocator.
test("Pi refuses an immediate repeat before the hook; small pending turns preserve earlier Raw", async () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-memory-idempotence-"));
  const f = await piSession({ extensions: [extension as never],
    env: { TRACE_MEMORY_CONFIG: JSON.stringify({ dbPath: join(dir, "trace.db"),
      "noting.triggerTokens": 1_000_000_000 }) },
    prepare: ({ agentDir }) => writeFileSync(join(agentDir, "trace-memory-baseline.json"), JSON.stringify("2000-01-01T00:00:00.000Z")) });
  try {
    f.script(() => say("answer"));
    await f.session.prompt("FIRST");
    await f.session.prompt("SECOND");
    const first = await f.session.compact();
    await expect(f.session.compact()).rejects.toThrow("Nothing to compact (session too small)");
    expect(f.manager.getEntries().filter(e => e.type === "compaction")).toHaveLength(1);
    await f.session.prompt("THIRD");
    await f.session.prompt("FOURTH");
    const third = await f.session.compact();
    expect(third.summary).toContain("FIRST");
    expect(third.summary).toContain("SECOND");
    expect(third.summary).toContain("THIRD");
    expect(third.summary).toContain("FOURTH");
    expect((third.summary.match(/Raw:/g) ?? [])).toHaveLength(1);
    const rawLines = first.summary.split("\n").filter(line => line.startsWith("[T"));
    for (const line of rawLines) expect(third.summary).toContain(line);
    await expect(f.session.compact()).rejects.toThrow("Nothing to compact (session too small)");
    expect(f.sent).toHaveLength(4);
  } finally { f.dispose(); rmSync(dir, { recursive: true, force: true }); }
}, 30000);

// The native API above refuses a no-Turn repeat before extension dispatch. Drive that missing
// dispatch explicitly, but persist every result through the real manager and run session_compact.
test("persisted hook lifecycle: repeat, N progress, 117 knowledge commits, small turns and cold restore", async () => {
  const quiet = { "noting.triggerTokens": 1_000_000_000, "dreaming.triggerTokens": 1 };
  const f = await fixture(quiet);
  const compact = async (h = f.h, manager = f.manager()) => {
    const result = await h.emit("session_before_compact", { preparation: { tokensBefore: 1000 } });
    expect(result?.compaction).toBeTruthy();
    const c = result.compaction;
    const id = manager.appendCompaction(c.summary, c.firstKeptEntryId, c.tokensBefore, c.details, true);
    await h.emit("session_compact", { compactionEntry: manager.getEntry(id) });
    // 97: each emission records its own delivery under a fresh key; the material is what repeats.
    const { prompt, ...traceMemory } = c.details.traceMemory;
    expect(prompt).toMatch(/^[0-9a-f-]{36}$/);
    return { ...c, details: { ...c.details, traceMemory } };
  };
  try {
    f.script(() => say("answer"));
    await f.turn("FIRST");
    const early = f.manager().getLeafId()!;
    await f.turn("SECOND");
    const store = f.h.memory.store;
    const sources = store.listSourceEntries(1);
    const first = await compact();
    expect(await compact()).toEqual(first);
    expect(store.listSourceEntries(1)).toEqual(sources);
    const user = sources.find(source => store.getSourceEntry(source.id)?.role === "user")!;
    const noted = legacyFacts(store, { kind: "noting", sessionId: 1, branch: "main", createdAt: "seed" },
      [{ sources: [{ entry: user, address: `T1#E${user.entryOrdinal}` }], category: "observation", actor: "user",
        text: "durable evidence", createdAt: "seed" }], sources.map(source => source.id));
    const afterNoting = await compact();
    // The retained Raw already covers these facts, so Noting progresses without duplicating them in the summary.
    expect(sources.every(source => store.entryNoted(source.id))).toBe(true);
    expect(afterNoting.summary).toBe(first.summary);
    expect(await compact()).toEqual(afterNoting);
    const fact = store.listSessionFacts(1)[0]!;
    const consolidated = knowledgeBatch(store, store.knowledgePath(1, "main", 1),
      Array.from({ length: 117 }, (_, i) => ({ topics: [], reason: "Initial admission.", author: "fixture",
        text: `Durable knowledge ${i}`, category: "constraint" as const, scope: "global" as const,
        supports: [fact.id], createdAt: "seed" })), { kind: "manual", createdAt: "seed" });
    let dreamSubmitted = false;
    f.script(body => {
      if (!JSON.stringify(body).includes("# Dreamer")) return say("answer");
      if (dreamSubmitted) return say("Done");
      dreamSubmitted = true;
      return call("skip-all", "memory", { operations: [], skipped: consolidated.committed.map(item => ({
        knowledge: `K${item.knowledgeId}@v1`, because: "reviewed; retain",
      })) });
    });
    const knowledge = await compact();
    expect(knowledge.details.traceMemory.supplied.knowledgeCommitIds).toHaveLength(117);
    expect(await compact()).toEqual(knowledge);
    expect(await f.h.emit("before_agent_start", { prompt: "probe" })).toBeUndefined();
    await f.turn("THIRD"); await f.turn("FOURTH");
    const added = await compact();
    expect(added.summary.split("Raw:")[0]).toBe(knowledge.summary.split("Raw:")[0]);
    for (const line of knowledge.summary.split("\n").filter((line: string) => line.startsWith("[T")))
      expect(added.summary).toContain(line);
    expect(added.summary).toContain("THIRD"); expect(added.summary).toContain("FOURTH");
    expect(await compact()).toEqual(added);
    expect(store.listSourceEntries(1)).toHaveLength(8);
    expect(f.sent).toHaveLength(6); // four foreground requests plus the Dreamer's skip batch and closing reply
    expect(store.listRuns(1).filter(run => run.kind === "dreaming")).toHaveLength(1);

    const tip = f.manager().getLeafId()!;
    f.manager().branch(early);
    await f.h.emit("session_tree");
    const sibling = await compact();
    expect(sibling.summary).toContain("FIRST");
    expect(sibling.summary).not.toContain("SECOND");
    expect(sibling.summary).not.toContain("THIRD");
    expect(await compact()).toEqual(sibling);
    f.manager().branch(tip);
    await f.h.emit("session_tree");
    expect(await compact()).toEqual(added);

    // New extension closure, new DB connection and manager reopened from the persisted JSONL.
    await f.h.emit("session_shutdown", { reason: "quit" });
    const manager = SessionManager.open(f.manager().getSessionFile()!);
    const restarted = host({ ...quiet, dbPath: f.h.dbPath }, { native: () => manager, fetch: false });
    try {
      await restarted.emit("session_start");
      expect(await compact(restarted, manager)).toEqual(added);
      expect(await restarted.emit("before_agent_start", { prompt: "after restart" })).toBeUndefined();
      // Opaque/native summary with IDENTICAL prose is deliberately not structural coverage.
      // This reproduces full reinjection when metadata is absent, not a reason to trust prose.
      const native = manager.appendCompaction(added.summary, "", 1000);
      await restarted.emit("session_compact", { compactionEntry: manager.getEntry(native) });
      const offered = await restarted.emit("before_agent_start", { prompt: "opaque summary" });
      expect(offered.message.details.traceMemory.supplied.knowledgeCommitIds).toHaveLength(117);
      expect((offered.message.content.match(/\[K\d+#[a-z]+\]/g) ?? [])).toHaveLength(117);
    } finally { await restarted.dispose(); }
  } finally { await f.dispose(); }
}, 30000);
