import { expect, test, vi } from "vitest";
import { Store } from "../../../src/core/store/index.ts";
import { host, reply } from "./test-host.ts";

// Exercise both host event boundaries, not merely the standalone branch renderer.
test("67: a long before-tree carry and after-tree restore have bounded projection work and start no phase", async () => {
  const h = host({ "noting.triggerTokens": 1, "consolidation.triggerTokens": 1 });
  try {
    h.persist({ role: "user", content: "evidence", timestamp: 1 });
    for (let i = 0; i < 1_200; i++) h.persist(reply(`history ${i} ` + "word ".repeat(30)));
    await h.emit("session_start");
    const store = h.memory.store, head = store.listTurns(1).at(-1)!.id;
    for (const lineage of ["sibling-open", "closed-retained"]) store.setCurrentPath(1, "main", head, lineage);
    const facts = store.commitNotingRun({ run: { kind: "manual", sessionId: 1, createdAt: "now" }, facts: [
      { turnId: head, source: [`T${head}#user`], actor: "user", category: "decision", text: "retain evidence", createdAt: "now" },
    ] });
    if (!facts.ok) throw new Error(facts.problems.join("; "));
    const written = store.commitConsolidationRun({ run: { kind: "manual", sessionId: 1, createdAt: "now" }, operations:
      Array.from({ length: 80 }, (_, i) => ({ op: "create" as const, handle: `$k${i}`, author: "test", text: `rule ${i}`,
        category: "constraint" as const, scope: "session" as const, supports: [facts.facts[0]!.id], topics: [], reason: "fixture", createdAt: "now" })) });
    if (!written.ok) throw new Error(written.problems.join("; "));
    const projection = vi.spyOn(Store.prototype, "commitGraphInput");
    const publication = vi.spyOn(Store.prototype, "publishSourcePath");
    const eligibility = vi.spyOn(Store.prototype, "duePools");
    const cursorOnly = vi.spyOn(Store.prototype, "setCurrentPath");
    try {
      await h.emit("session_before_tree");
      expect(projection.mock.calls.length).toBeLessThanOrEqual(2);
      expect(publication.mock.calls.length).toBeLessThanOrEqual(1);
      process.stdout.write(`67 before-tree ${JSON.stringify({ graphInputs: projection.mock.calls.length, publications: publication.mock.calls.length })}\n`);
      expect(cursorOnly).not.toHaveBeenCalled(); // No second full-path validation just to end the Turn.
      projection.mockClear(); publication.mockClear();
      await h.emit("session_tree");
      expect(publication).toHaveBeenCalledTimes(1);
      expect(publication.mock.calls[0]![2]).toHaveLength(1_201);
      expect(projection.mock.calls.length).toBeLessThanOrEqual(2);
      process.stdout.write(`67 after-tree ${JSON.stringify({ graphInputs: projection.mock.calls.length, publications: publication.mock.calls.length,
        entries: publication.mock.calls[0]![2].length, dueChecks: eligibility.mock.calls.length })}\n`);
      expect(eligibility).not.toHaveBeenCalled();
      await h.drain(); expect(h.requests).toEqual([]);
      expect(store.listSourceEntries(1)).toHaveLength(1_201);
    } finally { projection.mockRestore(); publication.mockRestore(); eligibility.mockRestore(); cursorOnly.mockRestore(); }
  } finally { await h.dispose(); }
}, 30000);
