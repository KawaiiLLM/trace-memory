import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TraceMemory } from "../../../src/core/api/index.ts";
import extension from "../../../src/hosts/pi/index.ts";

/** Seed only at the real hook boundary: no earlier entry-completion opportunity can run Dreamer.
 * The test DB and the real worker remain authoritative; only the provider response is scripted. */
export const dreamerRecoveryExtension = (dbPath: string) => (pi: ExtensionAPI) => {
  let seeded = false;
  pi.on("session_before_compact", () => {
    if (seeded) return;
    seeded = true;
    const memory = TraceMemory(dbPath, async () => { throw Error("fixture observer cannot run a model"); });
    try {
      const store = memory.store;
      const turnId = store.listTurns(1).find(t => t.kind !== "compaction")!.id;
      const noted = store.commitNotingRun({ run: { kind: "manual", sessionId: 1, createdAt: "seed" }, facts: [{ turnId, source: [`T${turnId}#user`], actor: "user", category: "decision", text: "A rule to maintain", createdAt: "seed" }] });
      if (!noted.ok) throw Error(noted.problems.join());
      const result = store.commitConsolidationRun({ run: { kind: "manual", sessionId: 1, createdAt: "seed" }, operations: [{ op: "create", handle: "$1", author: "fixture", text: "rule ".repeat(6000), category: "constraint", scope: "project", supports: [noted.facts[0]!.id], topics: [], reason: "fixture evidence", createdAt: "seed" }] });
      if (!result.ok) throw Error(result.problems.join());
      const pool = `project:${store.getSession(1)!.projectId}`;
      const pendingTokens = store.pendingVersions(pool, store.knowledgePath(1))[0]!.tokens;
      memory.setKnowledgeBudget("project", pendingTokens * 2);
    } finally { memory.close(); }
  });
  extension(pi);
};
