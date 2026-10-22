import { expect, test } from "vitest";
import { TraceMemory, memoryFiles, type RunAgent } from "../../../src/core/api/index.ts";
import { piSourceBlocks } from "../../../src/hosts/pi/source.ts";
import { factSources } from "../../support/seed.ts";
import { curateNow } from "../../support/dreamer.ts";
import { block } from "../../support/workspace.ts";

const time = "2026-09-01T00:00:00Z";
function setup(agent: RunAgent = async () => { throw Error("offline only"); }) {
  const m = TraceMemory(":memory:", agent, { writing: { bodyWords: 1_000_000 } }, undefined, piSourceBlocks);
  const projectId = m.store.createProject({ name: 'alpha"beta', declaredBy: "mark" }).id;
  const sessionId = m.store.createSession({ host: "pi:source-budget", projectId, startedAt: time, firstReplyAt: time, enrollmentChoice: true }).id;
  const turn = m.store.appendTurn({ sessionId, kind: "turn", startedAt: time });
  const call = { callId: "actual", ordinal: 1, name: "bash", input: '{"command":"test"}', status: "attempted" };
  const entry = m.appendEntry({ sessionId, turnId: turn.id, nativeLineage: "test", nativeId: "assistant", role: "assistant", text: "", calls: [call],
    raw: JSON.stringify({ role: "assistant", content: [{ type: "toolCall", id: call.callId, name: call.name, arguments: { command: "test" } }] }) });
  m.selectEntries(sessionId, "main", [entry.id]);
  return { m, sessionId, turn, entry, call, files: () => memoryFiles(m, { sessionId, branch: "main", headTurnId: turn.id }) };
}

test("33 historical JSON call IDs preserve authored sources and exact coverage", () => {
  const { m, sessionId, turn, entry, files } = setup();
  try {
    const source = `T${turn.id}#E1@"\\u0061ctual"`;
    expect(files().read(`trace://raw/S${sessionId}/T${turn.id}#E1@assistant`).content).toContain('command="test"');
    const result = m.store.commitNotingRun({ run: { kind: "noting", sessionId, branch: "main", createdAt: time }, entryIds: [entry.id], facts: [{ turnId: turn.id,
      category: "event", actor: "agent", status: "attempted", text: "Started the check.", source: [source], entryIds: [entry.id], createdAt: time }] });
    if (!result.ok) throw Error(result.problems.join("; "));
    const fact = result.facts[0]!;
    expect(fact.source).toEqual([source]);
    expect(m.store.factEntries(fact.id)).toEqual([entry.id]);
    expect(m.store.factCoveredByRaw(fact, new Set([entry.id]))).toBe(true);
    expect(files().read(`trace://facts/S${sessionId}/T${turn.id}`).content).toContain(`[F${fact.id}]`);
  } finally { m.close(); }
});

test("92 dispatch and result derive different roles; new sources reject call fragments", () => {
  const { m, sessionId, turn, entry, call, files } = setup();
  try {
    const note = m.tools({ kind: "manual", sessionId, currentTurnId: turn.id, branch: "main" }).find(tool => tool.name === "note")!;
    const fact = (source: string) => ({ title: "Check evidence", sources: factSources([{ address: source, text: "The cited entry describes the check." }]) });
    expect(note.execute(fact("T1#E1@actual"))).toContain("invalid source");
    expect(note.execute(fact("T1#E1"))).not.toContain("rejected:");
    expect(m.store.getFact(1)!.roles).toEqual([{ role: "assistant", harness: "Pi agent" }]);
    const result = m.appendEntry({ sessionId, turnId: turn.id, nativeLineage: "test", nativeId: "result", role: "toolResult", text: "",
      calls: [{ ...call, result: "passed", status: "success" }], raw: JSON.stringify({ role: "toolResult", toolCallId: call.callId, isError: false, content: [{ type: "text", text: "passed" }] }) });
    m.selectEntries(sessionId, "main", [entry.id, result.id]);
    expect(note.execute(fact("T1#E2"))).not.toContain("rejected:");
    expect(m.store.getFact(2)!.roles).toEqual([{ role: "observation" }]);
    expect(files().read(`trace://raw/S${sessionId}/T${turn.id}@user`).content).not.toContain("passed");
    expect(files().read(`trace://raw/S${sessionId}/T${turn.id}@observation`).content).toContain("passed");
    expect(files().read(`trace://raw/S${sessionId}/T${turn.id}@observation`).content).not.toContain("command=");
  } finally { m.close(); }
});

test("93 Turn facts show only contributing segments, with earliest source owning the fact", () => {
  const { m, sessionId, turn, entry } = setup();
  try {
    const next = m.store.appendTurn({ sessionId, parentTurnId: turn.id, kind: "turn", startedAt: "2026-08-01T00:00:00Z" });
    const user = m.appendEntry({ sessionId, turnId: next.id, nativeLineage: "test", nativeId: "user", role: "user", text: "confirmation", calls: [], raw: JSON.stringify({ role: "user", content: "confirmation" }) });
    m.selectEntries(sessionId, "main", [entry.id, user.id]);
    const note = m.tools({ kind: "manual", sessionId, currentTurnId: next.id, branch: "main" }).find(t => t.name === "note")!;
    const first = JSON.parse(note.execute({ title: "First ownership", sources: factSources([{ address: "T1#E1", text: "First ownership" }, { address: "T2#E1", text: "Confirmed ownership" }]) }));
    const second = JSON.parse(note.execute({ title: "Second ownership", sources: factSources([{ address: "T2#E1", text: "Second ownership" }]) }));
    expect([...first.factIds, ...second.factIds]).toEqual([1, 2]);
    const files = memoryFiles(m, { sessionId, branch: "main", headTurnId: next.id });
    const firstTurn = files.read(`trace://facts/S${sessionId}/T${turn.id}`).content;
    const secondTurn = files.read(`trace://facts/S${sessionId}/T${next.id}`).content;
    expect(firstTurn).toContain("[F1] First ownership");
    expect(firstTurn).toContain("[T1#E1@assistant] First ownership");
    expect(firstTurn).not.toContain("Confirmed ownership");
    expect(firstTurn).not.toContain("[F2]");
    expect(secondTurn).toContain("[F1] First ownership");
    expect(secondTurn).toContain("[T2#E1@user] Confirmed ownership");
    expect(secondTurn).toContain("[F2] Second ownership");
    expect(secondTurn).not.toContain("[T1#E1@assistant] First ownership");
    expect(m.store.getFact(1)!.turnId).toBe(turn.id);
    expect(m.store.getFact(2)!.turnId).toBe(next.id);
  } finally { m.close(); }
});

test("92 exact historical versions retain complete tags without granting stale update authority", () => {
  const { m, sessionId, turn, files } = setup();
  try {
    const tools = m.tools({ kind: "manual", sessionId, currentTurnId: turn.id, branch: "main" });
    const note = tools.find(t => t.name === "note")!, memory = tools.find(t => t.name === "memory")!;
    expect(note.execute({ title: "Started check", sources: factSources([{ address: "T1#E1", text: "Started the check." }]) })).not.toContain("rejected:");
    const text = "A complete durable claim has its conditions and evidence. ".repeat(500);
    expect(memory.execute({ op: "create", title: "Fixture title", text, category: "understanding", scope: "project", supports: ["F1"], reason: "Initial evidence", topics: [] })).not.toContain("rejected:");
    const path = { sessionId, headTurnId: turn.id, branch: "main" };
    const oldTag = `K1#${m.store.versionTag(1, 1)}`;
    // A Dreamer's curate update makes the old revision historical.
    expect(curateNow(m, path, block("update K1@v1", { reason: "Make old revision historical" }, "Current replacement")).blocks[0]).toMatchObject({ status: "applied", versions: ["K1@v2"] });
    expect(files().read("trace://K1@v1").content).toContain(oldTag);
    expect(files().read("trace://K1@v2").content).toContain("Current replacement");
    const rejected = curateNow(m, path, block("update K1@v1", { reason: "Wrong base" }, "Wrong replacement")).blocks[0]!;
    expect(rejected).toMatchObject({ status: "refused", stale: true });
    expect(rejected.reason).toContain("base is not the latest effective applicable revision; current: K1@v2");
    expect(files().read("trace://K1@v2").content).toContain("Current replacement");
    expect(() => files().read("trace://K1@v1..v2")).toThrow();
  } finally { m.close(); }
});
