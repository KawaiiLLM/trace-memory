// Ticket 73, Pi review of c03010e: each window is charged exactly what it adds to the output, so
// the output never exceeds the envelope. A Raw receipt and entry view receipts leave the allowance
// with the Raw window; an empty window emits nothing; only a capacity error omits an entry quietly.
import { expect, test } from "vitest";
import { sourceSeededMemory } from "../../source-fixture.ts";
import { setKnowledgeInjection } from "../../knowledge-budget-fixture.ts";
import { tokens } from "../../../src/core/render/index.ts";
import { noVisibility } from "../../../src/core/api/visible.ts";

const at = "2026-09-23T00:00:00Z";
function setup(resultText?: (text: string) => { text: string }) {
  const memory = sourceSeededMemory(":memory:", async () => { throw new Error("no model"); }, {}, resultText);
  setKnowledgeInjection(memory, 0);
  const project = memory.store.createProject({ name: "p", declaredBy: "marker" });
  const session = memory.store.createSession({ enrollmentChoice: true, host: "fake", projectId: project.id, startedAt: at, firstReplyAt: at });
  const turn = memory.store.appendTurn({ sessionId: session.id, kind: "turn", startedAt: at, userPrompt: "old ".repeat(300) });
  return { memory, session, turn };
}
const windows = (charged: { knowledge: number; facts: number; raw: number }) => charged.knowledge + charged.facts + charged.raw;

test("73: the Raw window's receipt leaves the shared allowance with it, so facts cannot spend it again", () => {
  const { memory, session, turn } = setup();
  try {
    memory.appendEntry({ sessionId: session.id, turnId: turn.id, nativeId: "new", nativeLineage: "fixture", role: "assistant",
      text: "new ".repeat(40), raw: "", calls: [] });
    const noted = memory.store.commitNotingRun({ run: { kind: "noting", sessionId: session.id, branch: "main", createdAt: at },
      facts: [{ turnId: turn.id, text: "fact ".repeat(45), category: "observation", actor: "user", source: [`T${turn.id}#user`], createdAt: at }] });
    if (!noted.ok) throw new Error(JSON.stringify(noted));
    Object.assign(memory.config.compaction, { rawTokens: 30, factsTokens: 40, sharedAllowanceTokens: 100 });
    const result = memory.compact(session.id, "main", turn.id);
    if ("native" in result) throw new Error("native");
    expect(result.truncated?.raw?.entries).toBeGreaterThan(0); // the Raw window emitted an omission receipt
    expect(tokens(result.text)).toBeLessThanOrEqual(result.charged!.envelope); // was 186 of 170
    expect(tokens(result.text)).toBeLessThanOrEqual(windows(result.charged!));
    expect(windows(result.charged!)).toBeLessThanOrEqual(result.charged!.envelope);
  } finally { memory.close(); }
});

test("73: windows with no room even for a bare receipt emit nothing — no titles, tags or receipts", () => {
  const { memory, session, turn } = setup();
  try {
    const noted = memory.store.commitNotingRun({ run: { kind: "noting", sessionId: session.id, branch: "main", createdAt: at },
      entryIds: memory.store.sourcePath(session.id, "main", turn.id).map(entry => entry.id),
      facts: [{ turnId: turn.id, text: "fact ".repeat(300), category: "observation", actor: "user", source: [`T${turn.id}#user`], createdAt: at }] });
    if (!noted.ok) throw new Error(JSON.stringify(noted));
    const created = memory.store.commitConsolidationRun({ run: { kind: "consolidation", sessionId: session.id, branch: "main", createdAt: at },
      operations: [{ op: "create", handle: "$k", author: "test", text: "knowledge", category: "constraint", scope: "project", topics: [],
        supports: [noted.facts[0]!.id], reason: "fixture", createdAt: at }] });
    if (!created.ok) throw new Error(JSON.stringify(created));
    const base = created.committed[0]!;
    const archived = memory.store.commitConsolidationRun({ run: { kind: "manual", sessionId: session.id, branch: "main", createdAt: at },
      operations: [{ op: "archive", knowledgeId: base.knowledgeId, baseCommit: base.commit, supports: [noted.facts[0]!.id], reason: "archive", createdAt: at }] });
    if (!archived.ok) throw new Error(JSON.stringify(archived));
    const visible = noVisibility(); visible.knowledgeCommitIds.add(base.commit); // a status notice is now due
    Object.assign(memory.config.compaction, { rawTokens: 1, factsTokens: 1, sharedAllowanceTokens: 1 });
    const result = memory.compact(session.id, "main", turn.id, visible);
    if ("native" in result) throw new Error("native");
    expect(result.text).toBe(""); // was 39 tokens: empty titles, the episodic tag and a notices receipt
    expect(result.charged).toMatchObject({ knowledge: 0, facts: 0, raw: 0 });
  } finally { memory.close(); }
});

test("73: counting an omitted entry's tokens raises a data error instead of counting it as zero", () => {
  const { memory, session, turn } = setup(text => { if (text === "broken") throw new Error("corrupt result payload"); return { text }; });
  try {
    memory.store.appendToolCall({ turnId: turn.id, name: "bash", input: "test", result: "broken", status: "success" });
    memory.appendEntry({ sessionId: session.id, turnId: turn.id, nativeId: "new", nativeLineage: "fixture", role: "assistant",
      text: "word ".repeat(1000), raw: "", calls: [] });
    Object.assign(memory.config.compaction, { rawTokens: 30, sharedAllowanceTokens: 1 });
    expect(() => memory.compact(session.id, "main", turn.id)).toThrow("corrupt result payload");
  } finally { memory.close(); }
});
