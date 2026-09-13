import { expect, test, vi } from "vitest";
import { TraceMemory, type SourceEntry } from "../../../src/core/api/index.ts";
import { piSourceBlocks } from "../../../src/hosts/pi/source.ts";

const time = "2026-09-01T00:00:00Z";
function setup() {
  const m = TraceMemory(":memory:", async () => { throw new Error("offline only"); }, {}, undefined, piSourceBlocks);
  const projectId = m.store.createProject({ name: "completion", declaredBy: "mark" }).id;
  const sessionId = m.store.createSession({ host: "test", projectId, startedAt: time, firstReplyAt: time, enrollmentChoice: true }).id;
  const turn = m.store.appendTurn({ sessionId, kind: "turn", startedAt: time });
  let serial = 0;
  const append = (role: "assistant" | "toolResult", ordinal = 1, callId = "reused", status = "success", turnId = turn.id) => {
    const call = { ordinal, callId, name: "bash", input: '{"command":"test"}', status: role === "assistant" ? "attempted" : status,
      ...(role === "toolResult" ? { result: status === "failure" ? "Test ran and failed" : "Test passed" } : {}) };
    return m.appendEntry({ sessionId, turnId, nativeLineage: "completion", nativeId: String(++serial), role,
      text: role === "assistant" ? "Here is the explanation; starting tests." : "", calls: [call],
      raw: JSON.stringify(role === "assistant" ? { role, content: [{ type: "text", text: "Here is the explanation; starting tests." },
        { type: "toolCall", id: callId, name: call.name, arguments: JSON.parse(call.input) }] }
        : { role, toolCallId: callId, isError: status === "failure", content: [{ type: "text", text: call.result }] }) });
  };
  const select = (entries: SourceEntry[], branch = "main") => m.selectEntries(sessionId, branch, entries.map(e => e.id));
  const note = (kind: "manual" | "noting", entries: SourceEntry[], head = turn.id) => m.tools(kind === "manual"
    ? { kind, sessionId, branch: "main", currentTurnId: head }
    : { kind, sessionId, branch: "main", entryIds: entries.map(e => e.id), range: { from: `S${sessionId}/T${turn.id}`, to: `S${sessionId}/T${head}` }, readKnowledgeCommits: [] }).find(t => t.name === "note")!;
  return { m, sessionId, turn, append, select, note };
}
const address = (entry: SourceEntry, exact: boolean) => `T${entry.turnId}#E${entry.entryOrdinal}${exact ? `@${entry.calls[0]!.callId}` : ""}`;
const event = (source: string[], status = "completed") => ({ category: "event", actor: "agent", status, text: "Tests ran; their outcome was observed.", source });

for (const kind of ["manual", "noting"] as const) for (const exact of [false, true]) {
  test.each(["reused ordinal", "wrong ordinal after dispatch", "result before dispatch", "wrong callId", "sibling", "uncited result", "dispatch only", "other Turn"] as const)(
    `completion: ${kind}, ${exact ? "exact fragment" : "whole entry"}, rejects %s atomically`, scenario => {
      const f = setup();
      try {
        // The before-dispatch case must reject even when its result has the higher E ordinal.
        const firstDispatch = scenario === "result before dispatch" ? f.append("assistant") : undefined;
        const result = f.append("toolResult", 1, scenario === "wrong callId" ? "other" : "reused");
        const dispatch = firstDispatch ?? f.append("assistant", scenario === "reused ordinal" || scenario === "wrong ordinal after dispatch" ? 2 : 1);
        let head = f.turn.id;
        let evidence = result;
        if (scenario === "other Turn") {
          head = f.m.store.appendTurn({ sessionId: f.sessionId, parentTurnId: head, kind: "turn", startedAt: time }).id;
          evidence = f.append("toolResult", 1, "reused", "success", head);
        }
        const path = scenario === "result before dispatch" || scenario === "reused ordinal" ? [evidence, dispatch]
          : scenario === "sibling" || scenario === "dispatch only" ? [dispatch] : [dispatch, evidence];
        f.select(path); f.select([dispatch, evidence], "sibling");
        const writer = f.note(kind, path, head);
        const scan = vi.spyOn(f.m.store, "sourcePath");
        const sources = [address(dispatch, exact), ...(scenario === "uncited result" || scenario === "dispatch only" ? [] : [address(evidence, exact)])];
        // A valid earlier item must not leak into facts or settle any entry/run on rejection.
        const response = writer.execute({ facts: [{ category: "observation", actor: "agent", text: "An explanation was supplied.", source: [`T${dispatch.turnId}#E${dispatch.entryOrdinal}@text`] }, event(sources)] });
        expect(response).toContain(scenario === "sibling" ? "invalid source" : "requires result evidence");
        expect(scan).toHaveBeenCalledTimes(kind === "manual" ? 1 : 0);
        expect(f.m.store.db.prepare("SELECT COUNT(*) AS n FROM facts").get()!.n).toBe(0);
        expect(f.m.store.db.prepare("SELECT COUNT(*) AS n FROM noted_entries").get()!.n).toBe(0);
        expect(f.m.store.listRuns(f.sessionId).every(run => run.outcome === "bounced")).toBe(true);
      } finally { f.m.close(); }
    });

  test.each(["success", "failure"])(`completion: ${kind}, ${exact ? "exact fragment" : "whole entry"}, accepts matching %s in path order`, status => {
    const f = setup();
    try {
      const result = f.append("toolResult", 2, "reused", status), dispatch = f.append("assistant", 2);
      f.select([dispatch, result]);
      // Frozen membership order and authored citation order are not path order either.
      const writer = f.note(kind, [result, dispatch]);
      const scan = vi.spyOn(f.m.store, "sourcePath");
      const response = JSON.parse(writer.execute({ facts: [event([address(result, exact), address(dispatch, exact)])] }));
      expect(response.factIds).toHaveLength(1);
      expect(scan).toHaveBeenCalledTimes(kind === "manual" ? 1 : 0);
      expect(new Set(f.m.store.factEntries(response.factIds[0]))).toEqual(new Set([dispatch.id, result.id]));
      expect(f.m.store.getFact(response.factIds[0])!.status).toBe("completed");
    } finally { f.m.close(); }
  });
}

test.each(["manual", "noting"] as const)("completion: %s retains explicit text delivery and weaker statuses", kind => {
  const f = setup();
  try {
    const dispatch = f.append("assistant"); f.select([dispatch]);
    const writer = f.note(kind, [dispatch]);
    const response = JSON.parse(writer.execute({ facts: [event([`T1#E1@text`]),
      ...["reported", "dispatched", "attempted"].map(status => event([address(dispatch, false)], status))] }));
    expect(response.factIds).toHaveLength(4);
    expect(response.factIds.map((id: number) => f.m.store.getFact(id)!.status)).toEqual(["completed", "reported", "dispatched", "attempted"]);
  } finally { f.m.close(); }
});

test.each([true, false])("completion: Noter keeps frozen path order after live reorder (initially valid: %s)", valid => {
  const f = setup();
  try {
    const dispatch = f.append("assistant"), result = f.append("toolResult");
    const path = valid ? [dispatch, result] : [result, dispatch];
    f.select(path);
    const writer = f.note("noting", path);
    f.select([...path].reverse());
    const response = writer.execute({ facts: [event([address(dispatch, true), address(result, true)])] });
    expect(response.includes("requires result evidence")).toBe(!valid);
    expect(f.m.store.entryNoted(dispatch.id)).toBe(valid);
  } finally { f.m.close(); }
});

test.each(["already present", "arrives later"])("completion: Noter cannot borrow matching result outside frozen entries: %s", timing => {
  const f = setup();
  try {
    const dispatch = f.append("assistant");
    let result = timing === "already present" ? f.append("toolResult") : undefined;
    f.select(result ? [dispatch, result] : [dispatch]);
    const writer = f.note("noting", [dispatch]);
    result ??= f.append("toolResult");
    f.select([dispatch, result]);
    const scan = vi.spyOn(f.m.store, "sourcePath");
    const response = writer.execute({ facts: [event([address(dispatch, true), address(result, true)])] });
    expect(response).toContain("invalid source");
    expect(scan).toHaveBeenCalledTimes(0);
    expect(f.m.store.entryNoted(dispatch.id)).toBe(false);
    expect(f.m.store.listRuns(f.sessionId)).toEqual([]);
  } finally { f.m.close(); }
});
