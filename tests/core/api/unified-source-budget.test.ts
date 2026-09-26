import { expect, test } from "vitest";
import { TraceMemory, tokens, type RunAgent } from "../../../src/core/api/index.ts";
import { piSourceBlocks } from "../../../src/hosts/pi/source.ts";
import { wholeTrace } from "../../trace-pages.ts";
import { AdmittedDreamerScenarios, createDreamerTrigger } from "../../admitted-dreamer-scenario.ts";

const time = "2026-09-01T00:00:00Z";
function setup(agent: RunAgent = async () => { throw new Error("offline only"); }) {
  const m = TraceMemory(":memory:", agent, {}, undefined, piSourceBlocks);
  const projectId = m.store.createProject({ name: 'alpha"beta', declaredBy: "mark" }).id;
  const sessionId = m.store.createSession({ host: "pi:source-budget", projectId, startedAt: time, firstReplyAt: time, enrollmentChoice: true }).id;
  const turn = m.store.appendTurn({ sessionId, kind: "turn", startedAt: time });
  const call = { callId: "actual", ordinal: 1, name: "bash", input: '{"command":"test"}', status: "attempted" };
  const entry = m.appendEntry({ sessionId, turnId: turn.id, nativeLineage: "test", nativeId: "assistant", role: "assistant", text: "", calls: [call],
    raw: JSON.stringify({ role: "assistant", content: [{ type: "toolCall", id: call.callId, name: call.name, arguments: { command: "test" } }] }) });
  m.selectEntries(sessionId, "main", [entry.id]);
  return { m, sessionId, turn, entry, call };
}

test("33 history: equivalent JSON call-ID spellings preserve authored sources and exact coverage", () => {
  const { m, sessionId, turn, entry } = setup();
  try {
    const source = `T${turn.id}#E1@"\\u0061ctual"`;
    expect(m.trace(source)).toContain('command="test"');
    const result = m.store.commitNotingRun({ run: { kind: "noting", sessionId, branch: "main", createdAt: time }, entryIds: [entry.id], facts: [{ turnId: turn.id,
      category: "event", actor: "agent", status: "attempted", text: "Started the check.", source: [source], entryIds: [entry.id], createdAt: time }] });
    if (!result.ok) throw new Error(result.problems.join("; "));
    expect(result.facts).toHaveLength(1);
    const fact = result.facts[0]!;
    expect(fact.source).toEqual([source]);
    expect(m.store.factEntries(fact.id)).toEqual([entry.id]);
    expect(m.store.factCoveredByRaw(fact, new Set([entry.id]))).toBe(true);
    expect(m.trace('alpha"beta', { pageBudget: null })).toContain(`[F${fact.id}]`);
  } finally { m.close(); }
});

test("92 supersedes completion policing: dispatch and result retain different derived roles, new sources reject fragments", () => {
  const { m, sessionId, turn, entry, call } = setup();
  try {
    const note = m.tools({ kind: "manual", sessionId, currentTurnId: turn.id, branch: "main" }).find(tool => tool.name === "note")!;
    const fact = (source: string) => ({ facts: [{ text: "The cited entry describes the check.", source: [source] }] });
    expect(note.execute(fact("T1#E1@actual"))).toContain("invalid source");
    expect(note.execute(fact("T1#E1"))).not.toContain("rejected:");
    expect(m.store.getFact(1)!.roles).toEqual([{ role: "assistant", harness: "Pi agent" }]);
    const result = m.appendEntry({ sessionId, turnId: turn.id, nativeLineage: "test", nativeId: "result", role: "toolResult", text: "",
      calls: [{ ...call, result: "passed", status: "success" }], raw: JSON.stringify({ role: "toolResult", toolCallId: call.callId, isError: false, content: [{ type: "text", text: "passed" }] }) });
    m.selectEntries(sessionId, "main", [entry.id, result.id]);
    expect(note.execute(fact("T1#E2"))).not.toContain("rejected:");
    expect(m.store.getFact(2)!.roles).toEqual([{ role: "observation" }]);
    expect(m.trace("T1@user", { pageBudget: null })).toBe("");
    expect(m.trace("T1@text", { pageBudget: null })).toContain("passed");
    expect(m.trace("T1@text", { pageBudget: null })).not.toContain("command=");
  } finally { m.close(); }
});

test("33: Turn facts use ownership rather than citation overlap; collections sort by owning time", () => {
  const { m, sessionId, turn, entry } = setup();
  try {
    const next = m.store.appendTurn({ sessionId, parentTurnId: turn.id, kind: "turn", startedAt: "2026-08-01T00:00:00Z" });
    const user = m.appendEntry({ sessionId, turnId: next.id, nativeLineage: "test", nativeId: "user", role: "user", text: "confirmation", calls: [],
      raw: JSON.stringify({ role: "user", content: "confirmation" }) });
    m.selectEntries(sessionId, "main", [entry.id, user.id]);
    const note = m.tools({ kind: "manual", sessionId, currentTurnId: next.id, branch: "main" }).find(t => t.name === "note")!;
    const result = JSON.parse(note.execute({ facts: [
      { text: "First ownership", source: ["T1#E1", "T2#E1"] },
      { text: "Second ownership", source: ["T2#E1"] }] }));
    expect(result.factIds).toEqual([1, 2]);
    expect(m.trace("T2@F*", { pageBudget: null })).toContain("[F2]");
    expect(m.trace("T2@F*", { pageBudget: null })).not.toContain("[F1]");
    expect(m.trace("T1@F*", { pageBudget: null })).toContain("[F1]");
    const grouped = m.trace("F1-F2", { pageBudget: null });
    expect(grouped.indexOf("[F2]")).toBeLessThan(grouped.indexOf("[F1]"));
    expect(grouped).toContain("source: T1#E1 (Pi agent), T2#E1 (user)");
  } finally { m.close(); }
});

test("92: partial semantic reads omit tags; full history paging reveals a tag but never makes a stale base writable", async () => {
  const scenarios = new AdmittedDreamerScenarios(async () => { throw new Error("unexpected model call"); });
  const { m, sessionId, turn } = setup(scenarios.agent);
  try {
    const tools = m.tools({ kind: "manual", sessionId, currentTurnId: turn.id, branch: "main" });
    const note = tools.find(t => t.name === "note")!, memory = tools.find(t => t.name === "memory")!, trace = tools.find(t => t.name === "trace")!;
    expect(note.execute({ facts: [{ text: "Started the check.", source: ["T1#E1"] }] })).not.toContain("rejected:");
    const text = "A complete durable claim has its conditions and evidence. ".repeat(500);
    expect(memory.execute({ operations: [{ op: "create", text, category: "understanding", scope: "project", supports: ["F1"], reason: "Initial evidence", topics: [] }], skipped: [] })).not.toContain("rejected:");
    const path = { sessionId, headTurnId: turn.id, branch: "main" };
    const firstTrigger = createDreamerTrigger(m, path, 1, 1, "project");
    let currentCommit = 0;
    const settled = await scenarios.run(m, path, input => {
      const request = { fixture: "make read target historical" }; input.reportRequest(request);
      const trace = input.tools.find(t => t.name === "trace")!, write = input.tools.find(t => t.name === "memory")!;
      const base = `K1#${m.store.versionTag(1, 1)}`;
      const receipt = JSON.parse(write.execute({ operations: [{ op: "update", id: base, text: "Current replacement", category: "understanding", scope: "project",
        supports: ["F1"], reason: "Make the large revision historical for the read-ledger test.", topics: [] },
      { op: "archive", id: `K${firstTrigger.knowledgeId}#${m.store.versionTag(firstTrigger.knowledgeId, firstTrigger.commit)}`, supports: ["F1"], reason: "Retire the initial fixture trigger." }], skipped: [] }));
      expect(receipt.committed.find((item: { knowledgeId: number }) => item.knowledgeId === 1).version).toBe("K1@v2");
      currentCommit = m.store.resolveVersionOrdinal(1, 2);
      return { outcome: "success", output: "settled", request };
    });
    if (settled.outcome !== "success") throw new Error(JSON.stringify(settled));
    const trigger = createDreamerTrigger(m, path, 1, 2, "project");
    const result = await scenarios.run(m, path, input => {
      const request = { fixture: "unified source pagination", trigger }; input.reportRequest(request);
      const read = input.tools.find(t => t.name === "trace")!, write = input.tools.find(t => t.name === "memory")!;
      const oldTag = `K1#${m.store.versionTag(1, 1)}`;
      const edit = () => write.execute({ operations: [{ op: "update", id: oldTag, text: "Revised claim", category: "understanding", scope: "project", supports: ["F1"], reason: "Correction", topics: [] }],
        skipped: [{ knowledge: `K${trigger.knowledgeId}@v1`, because: "The explicit later-run trigger is retired after the ledger assertion." }] });
      const drain = (first: string) => {
        let page = first, count = 0;
        for (let cursor = /cursor=(\S+)/.exec(page)?.[1]; cursor; cursor = /cursor=(\S+)/.exec(page)?.[1]) {
          expect(++count).toBeLessThan(100);
          expect(page).not.toContain(oldTag);
          expect(edit()).toContain("current: K1@v2");
          for (const address of ["K1@v2..", "T1#E0", "F9-F1"]) expect(read.execute({ address, cursor })).toContain("rejected:");
          page = read.execute({ address: `cursor=${cursor}` });
          expect(tokens(page)).toBeLessThanOrEqual(2000);
        }
        return page;
      };
      expect(drain(read.execute({ address: "K1@v1" }))).not.toContain(oldTag);
      expect(edit()).toContain("current: K1@v2");
      expect(drain(read.execute({ address: "K1@v1", itemBudget: null }))).toContain(oldTag);
      expect(edit()).toContain("base is not the latest effective applicable revision; current: K1@v2");
      write.execute({ operations: [{ op: "archive", id: `K${trigger.knowledgeId}#${m.store.versionTag(trigger.knowledgeId, trigger.commit)}`,  supports: ["F1"], reason: "Retire the explicit fixture trigger." }], skipped: [] });
      return { outcome: "success", output: "read ledger checked", request };
    });
    if (result.outcome !== "success") throw new Error(JSON.stringify(result));
    expect(wholeTrace(m, `K1@1..${currentCommit}`, { full: true })).toBe(wholeTrace(m, `K1@1..K1@${currentCommit}`, { full: true }));
    expect(m.trace(`K1@1..${currentCommit}`, { itemBudget: 200, pageBudget: null })).toContain("characters truncated");
    expect(trace.execute({ address: "K1", pageBudget: null })).toContain("internal-only");
  } finally { m.close(); }
});
