// A fact is covered by Raw only when every entry it is bound to lies in the covered set, so the proof
// lookup (the Noting runs' noted entries and their addresses) runs only for facts bound inside it.
// On production S3 the unfiltered lookup parsed every noted entry behind every fact on the path at
// each compact (about 0.9 s of a 1.5 s compact).
import { expect, test } from "vitest";
import { sourceSeededMemory } from "../../source-fixture.ts";

test("facts bound outside the covered window never reach the noted-entry proof lookup; answers unchanged", () => {
  const memory = sourceSeededMemory(":memory:", async () => { throw new Error("no model"); });
  try {
    const store = memory.store, at = "2026-09-24T00:00:00Z";
    const project = store.createProject({ name: "p", declaredBy: "marker" });
    const session = store.createSession({ enrollmentChoice: true, host: "fake", projectId: project.id, startedAt: at, firstReplyAt: at });
    const turn = store.appendTurn({ sessionId: session.id, kind: "turn", startedAt: at, userPrompt: "question" });
    const inside = memory.appendEntry({ sessionId: session.id, turnId: turn.id, nativeId: "in", nativeLineage: "fixture", role: "assistant", text: "inside", raw: "", calls: [] });
    const entries = store.sourcePath(session.id, "main", turn.id);
    const noted = store.commitNotingRun({ run: { kind: "noting", sessionId: session.id, branch: "main", createdAt: at }, entryIds: entries.map(e => e.id),
      facts: [{ turnId: turn.id, text: "fact", category: "observation", actor: "user", source: [`T${turn.id}#user`], entryIds: [entries[0]!.id], createdAt: at }] });
    if (!noted.ok) throw new Error(JSON.stringify(noted));
    const fact = noted.facts[0]!, boundId = entries[0]!.id;
    let proofQueries = 0;
    const prepare = store.db.prepare.bind(store.db);
    store.db.prepare = ((sql: string) => { if (sql.includes("noted_entries")) proofQueries++; return prepare(sql); }) as typeof store.db.prepare;
    expect(store.factsCoveredByRaw([fact], new Set([inside.id]))).toEqual(new Set()); // bound entry outside the window
    expect(proofQueries).toBe(0);
    expect(store.factsCoveredByRaw([fact], new Set([boundId, inside.id]))).toEqual(new Set([fact.id])); // inside: still proven
    expect(proofQueries).toBe(1);
  } finally { memory.close(); }
});
