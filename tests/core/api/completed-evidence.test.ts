import { expect, test } from "vitest";
import { TraceMemory, type NotingAgentInput, type SourceEntry } from "../../../src/core/api/index.ts";
import { piSourceBlocks } from "../../../src/hosts/pi/source.ts";

const time = "2026-09-01T00:00:00Z";
function setup() {
  let run: (input: NotingAgentInput) => void = () => {};
  const m = TraceMemory(":memory:", async input => {
    if (input.kind !== "noting") throw new Error("Only Noting is expected");
    input.reportRequest({ fixture: "source evidence" });
    run(input);
    return { outcome: "success", output: "done", request: { fixture: "source evidence" } };
  }, {}, undefined, piSourceBlocks);
  const projectId = m.store.createProject({ name: "completion", declaredBy: "mark" }).id;
  const sessionId = m.store.createSession({ host: "pi:completion", projectId, startedAt: time, firstReplyAt: time, enrollmentChoice: true }).id;
  const turn = m.store.appendTurn({ sessionId, kind: "turn", startedAt: time });
  let serial = 0;
  const append = (role: "assistant" | "toolResult", ordinal = 1, callId = "reused", status = "success", turnId = turn.id) => {
    const call = { ordinal, callId, name: "bash", input: '{"command":"test"}', status: role === "assistant" ? "attempted" : status,
      ...(role === "toolResult" ? { result: status === "failure" ? "Test ran and failed" : "Test passed" } : {}) };
    return m.appendEntry({ sessionId, turnId, nativeLineage: "completion", nativeId: String(++serial), role,
      text: role === "assistant" ? "Pi agent reported starting tests." : "", calls: [call],
      raw: JSON.stringify(role === "assistant" ? { role, content: [{ type: "text", text: "Pi agent reported starting tests." },
        { type: "toolCall", id: callId, name: call.name, arguments: JSON.parse(call.input) }] }
        : { role, toolCallId: callId, isError: status === "failure", content: [{ type: "text", text: call.result }] }) });
  };
  const select = (entries: SourceEntry[], branch = "main") => m.selectEntries(sessionId, branch, entries.map(e => e.id));
  const manual = () => m.tools({ kind: "manual", sessionId, branch: "main", currentTurnId: turn.id }).find(t => t.name === "note")!;
  const noting = async (entries: SourceEntry[], callback: (input: NotingAgentInput) => void) => {
    run = callback;
    return m.noting({ sessionId, branch: "main", headTurnId: turn.id, boundary: { exactEntryIds: entries.map(e => e.id) } });
  };
  return { m, sessionId, turn, append, select, manual, noting };
}
const address = (entry: SourceEntry) => `T${entry.turnId}#E${entry.entryOrdinal}`;

// 92 removes status-based call/result policing. Roles describe cited entries, not
// whether prose is true or whether a call happened before the result it names.
for (const kind of ["manual", "noting"] as const) test.each(["success", "failure"])(
  `92 evidence: ${kind} derives roles in citation order for a %s result`, async status => {
    const f = setup();
    try {
      const result = f.append("toolResult", 2, "reused", status), dispatch = f.append("assistant", 2);
      f.select([dispatch, result]);
      const fact = { text: `Pi agent dispatched tests; the tool returned ${status}.`, source: [address(result), address(dispatch)] };
      if (kind === "manual") expect(JSON.parse(f.manual().execute({ facts: [fact] })).factIds).toHaveLength(1);
      else {
        const done = await f.noting([dispatch, result], input => {
          expect(input.tools.find(t => t.name === "note")!.execute({ facts: [fact] })).toContain("held");
          expect(f.m.store.listTurnFacts(f.turn.id)).toEqual([]);
          expect(f.m.store.entryNoted(dispatch.id)).toBe(false);
          input.tools.find(t => t.name === "memory")!.execute({ operations: [], skipped: [] });
        });
        expect(done.outcome, JSON.stringify(done)).toBe("success");
        expect(f.m.store.entryNoted(dispatch.id)).toBe(true);
      }
      const stored = f.m.store.listTurnFacts(f.turn.id)[0]!;
      expect(stored).toMatchObject({ category: null, actor: null, status: null, source: fact.source,
        roles: [{ role: "observation" }, { role: "assistant", harness: "Pi agent" }] });
      expect(new Set(f.m.store.factEntries(stored.id))).toEqual(new Set([dispatch.id, result.id]));
    } finally { f.m.close(); }
  });

for (const kind of ["manual", "noting"] as const) test.each(["category", "actor", "status", "quote", "role"])(
  `92 evidence: ${kind} rejects caller-supplied %s without publishing an accepted sibling`, async field => {
    const f = setup();
    try {
      const dispatch = f.append("assistant"); f.select([dispatch]);
      const fact = { text: "Pi agent reported completion; this is an agent claim.", source: [address(dispatch)] };
      const batch = { facts: [fact, { ...fact, [field]: field === "status" ? "completed" : "user" }] };
      if (kind === "manual") expect(f.manual().execute(batch)).toContain(`${field}: unexpected field`);
      else {
        const done = await f.noting([dispatch], input => {
          expect(input.tools.find(t => t.name === "note")!.execute(batch)).toContain(`${field}: unexpected field`);
          input.tools.find(t => t.name === "memory")!.execute({ operations: [], skipped: [] });
        });
        expect(done.outcome).toBe("bounced");
      }
      expect(f.m.store.listTurnFacts(f.turn.id)).toEqual([]);
      expect(f.m.store.entryNoted(dispatch.id)).toBe(false);
    } finally { f.m.close(); }
  });

for (const kind of ["manual", "noting"] as const) test.each(["T1", "T1#assistant", "T1#E1@text", "T1#E1@reused", "T1#E1..E2"])(
  `92 evidence: ${kind} rejects non-whole-entry source %s atomically`, async source => {
    const f = setup();
    try {
      const dispatch = f.append("assistant"), result = f.append("toolResult"); f.select([dispatch, result]);
      const facts = [{ text: "Pi agent started tests.", source: [address(dispatch)] }, { text: "Invalid source shape", source: [source] }];
      if (kind === "manual") expect(f.manual().execute({ facts })).toContain("invalid source");
      else {
        const done = await f.noting([dispatch, result], input => {
          expect(input.tools.find(t => t.name === "note")!.execute({ facts })).toContain("invalid source");
          input.tools.find(t => t.name === "memory")!.execute({ operations: [], skipped: [] });
        });
        expect(done.outcome).toBe("bounced");
      }
      expect(f.m.store.listTurnFacts(f.turn.id)).toEqual([]);
      expect(f.m.store.entryNoted(dispatch.id)).toBe(false);
    } finally { f.m.close(); }
  });

test.each(["already present", "arrives later"])("92 evidence: N cannot cite a result outside its frozen entries: %s", async timing => {
  const f = setup();
  try {
    const dispatch = f.append("assistant");
    let result = timing === "already present" ? f.append("toolResult") : undefined;
    f.select(result ? [dispatch, result] : [dispatch]);
    const done = await f.noting([dispatch], input => {
      result ??= f.append("toolResult");
      f.select([dispatch, result]);
      expect(input.tools.find(t => t.name === "note")!.execute({ facts: [{ text: "The tool returned a result", source: [address(result)] }] })).toContain("invalid source");
      input.tools.find(t => t.name === "memory")!.execute({ operations: [], skipped: [] });
    });
    expect(done.outcome).toBe("bounced");
    expect(f.m.store.listTurnFacts(f.turn.id)).toEqual([]);
    expect(f.m.store.entryNoted(dispatch.id)).toBe(false);
  } finally { f.m.close(); }
});

test("92 evidence: historical completion fields and selected-block sources stay readable unchanged", () => {
  const f = setup();
  try {
    const dispatch = f.append("assistant"); f.select([dispatch]);
    const source = [`${address(dispatch)}@text`];
    const legacy = f.m.store.commitNotingRun({ run: { kind: "manual", sessionId: f.sessionId, createdAt: time }, facts: [{
      turnId: f.turn.id, category: "event", actor: "agent", status: "completed", quote: "reported", text: "Historical delivery", source, createdAt: time,
    }] });
    if (!legacy.ok) throw new Error(legacy.problems.join("; "));
    const fact = legacy.facts[0]!;
    const before = f.m.store.getFact(fact.id);
    expect(f.m.trace(`F${fact.id}`)).toContain("completed: Historical delivery");
    expect(f.m.trace(`F${fact.id}`)).toContain(source[0]);
    expect(f.m.trace(source[0]!)).toContain("Pi agent reported starting tests.");
    expect(f.m.store.getFact(fact.id)).toEqual(before);
  } finally { f.m.close(); }
});
