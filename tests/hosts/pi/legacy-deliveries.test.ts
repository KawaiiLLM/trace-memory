import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import { sourceSeededMemory } from "../../source-fixture.ts";
import { knowledge, legacyFacts } from "../../support/seed.ts";
import { host, notingFact } from "./test-host.ts";

// A legacy delivery table must survive reopening without becoming a worker gate, prompt delivery
// or visibility evidence. Build its historical schema explicitly: fresh stores no longer create it.
// Facts, runs, processing marks and knowledge beside the inert rows must remain readable.

/** A database shaped like a published Beta one: real facts, a real run, real processing marks and
 * knowledge, plus one delivered and one undelivered legacy row. */
function betaDatabase(directory: string) {
  const dbPath = join(directory, "beta.db");
  const memory = sourceSeededMemory(dbPath, async () => { throw new Error("no model in this fixture"); });
  const project = memory.store.createProject({ name: "beta", declaredBy: "mark" });
  const session = memory.store.createSession({ host: "pi:beta", projectId: project.id, startedAt: "now", firstReplyAt: "now", enrollmentChoice: true });
  const turn = memory.store.appendTurn({ sessionId: session.id, kind: "turn", startedAt: "now", userPrompt: "用 pnpm，不要 npm", assistantText: "好的。" });
  const path = memory.store.sourcePath(session.id, "main", turn.id);
  const user = path.find(value => memory.store.getSourceEntry(value.id)?.role === "user")!;
  const noted = legacyFacts(memory.store, { kind: "noting", sessionId: session.id, branch: "main", createdAt: "now" },
    [{ sources: [{ entry: user, address: `T${turn.id}#E${user.entryOrdinal}` }], category: "decision", actor: "user",
      text: "用 pnpm", createdAt: "now" }], path.map(value => value.id));
  knowledge(memory.store, memory.store.knowledgePath(session.id, "main", turn.id), "project", "constraint",
    [noted.facts[0]!.id], "项目用 pnpm。", { run: { kind: "manual", createdAt: "now" } });
  const historical = memory.store.recordRun({ kind: "consolidation", sessionId: session.id, branch: "main", createdAt: "now", outcome: "success" });
  memory.store.db.exec(`CREATE TABLE pending_deliveries (
    run_id INTEGER NOT NULL REFERENCES runs(id),
    session_id INTEGER NOT NULL REFERENCES sessions(id),
    branch TEXT,
    delivered_at TEXT
  )`);
  // One consumed row and one that the old version would still have delivered.
  memory.store.db.prepare("INSERT INTO pending_deliveries (run_id, session_id, branch, delivered_at) VALUES (?, ?, 'main', '2026-09-01T00:00:00Z')").run(noted.runId, session.id);
  memory.store.db.prepare("INSERT INTO pending_deliveries (run_id, session_id, branch, delivered_at) VALUES (?, ?, 'main', NULL)").run(historical.id, session.id);
  const rows = () => memory.store.db.prepare("SELECT run_id, session_id, branch, delivered_at FROM pending_deliveries ORDER BY run_id").all();
  const state = {
    schema: memory.store.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'pending_deliveries'").get(),
    rows: rows(),
    facts: memory.store.listSessionFacts(session.id).map(f => f.text),
    runs: memory.store.listRuns(session.id).map(r => [r.id, r.kind, r.outcome]),
    knowledge: memory.store.listVisibleKnowledge(session.id, project.id).map(k => k.revision.text),
    noted: memory.store.listSourceEntries(session.id).filter(e => memory.store.entryNoted(e.id)).map(e => e.id),
  };
  expect(state.rows).toHaveLength(2);
  memory.close();
  return { dbPath, sessionId: session.id, headTurnId: turn.id, projectId: project.id, state, rows };
}

test("29d case 23: a published Beta database's delivery rows pause nothing, deliver nothing and are never rewritten", async () => {
  const directory = mkdtempSync(join(tmpdir(), "trace-memory-beta-"));
  const beta = betaDatabase(directory);
  // Fork mode with a low trigger: the exact configuration the retired pause used to hold back.
  const h = host({ dbPath: beta.dbPath, "noting.triggerTokens": 30, "noting.forkModeDefault": true });
  try {
    const target = { sessionId: beta.sessionId, branch: "main", headTurnId: beta.headTurnId };
    // The undelivered row belongs to this very session and branch. Eligibility is the trigger alone.
    expect(h.memory.taskEligibility("noting", target).due).toBe(false); // nothing pending yet, not "paused"
    h.provider(async c => notingFact(c));
    await h.turn(); // this executor's own session: a fork-mode Noting task runs to completion
    expect(h.memory.store.listRuns(2).filter(r => r.kind === "noting").map(r => r.outcome)).toEqual(["success"]);
    // No burst, no drain: the prompt after that commit carries no receipt of any kind.
    expect(String((await h.prompt("second"))?.message?.content ?? "")).not.toContain("<noted>");
    expect(String((await h.prompt("third"))?.message?.content ?? "")).not.toContain("<consolidated>");
    // The old rows are exactly as they were found: no timestamp written, none consumed, none added.
    const store = h.memory.store;
    expect(store.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'pending_deliveries'").get()).toEqual(beta.state.schema);
    expect(store.db.prepare("SELECT run_id, session_id, branch, delivered_at FROM pending_deliveries ORDER BY run_id").all()).toEqual(beta.state.rows);
    // The undelivered row's commits did not become visibility either: its knowledge is offered as the
    // ordinary initial block for the new session, by applicability, not because a row said so.
    expect(store.listSessionFacts(beta.sessionId).map(f => f.text)).toEqual(beta.state.facts);
    expect(store.listRuns(beta.sessionId).map(r => [r.id, r.kind, r.outcome])).toEqual(beta.state.runs);
    expect(store.listVisibleKnowledge(beta.sessionId, beta.projectId).map(k => k.revision.text)).toEqual(beta.state.knowledge);
    expect(store.listSourceEntries(beta.sessionId).filter(e => store.entryNoted(e.id)).map(e => e.id)).toEqual(beta.state.noted);
    // Membership is untouched: the old session's processed entries stay processed and nothing of it re-enters a batch.
    expect(h.memory.pendingEntries(beta.sessionId, "main", beta.headTurnId)).toEqual([]);
  } finally { await h.dispose(); rmSync(directory, { recursive: true, force: true }); }
});
