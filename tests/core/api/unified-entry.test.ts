import { expect, test } from "vitest";
import { TraceMemory, DEFAULT_CONFIG, renderEntry, tokens, type NotingAgentInput, type RunAgentResult } from "../../../src/core/api/index.ts";
import { piSourceBlocks } from "../../../src/hosts/pi/source.ts";
const time = "2026-09-01T00:00:00Z";
function fixture() {
  let run: (input: NotingAgentInput) => Promise<RunAgentResult> = async () => { throw new Error("offline test"); };
  const m = TraceMemory(":memory:", raw => run(raw as NotingAgentInput), {}, undefined, piSourceBlocks);
  const project = m.store.createProject({ name: "p", declaredBy: "mark" });
  const session = m.store.createSession({ host: "pi:entry", projectId: project.id, startedAt: time, firstReplyAt: time, enrollmentChoice: true });
  const turn = m.store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "question", startedAt: time });
  let serial = 0;
  const append = (role: "user" | "assistant" | "toolResult", content: any, calls: any[] = []) => m.appendEntry({ sessionId: session.id, turnId: turn.id, nativeLineage: "test", nativeId: String(++serial), role,
    text: role === "toolResult" ? "" : typeof content === "string" ? content : content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n"),
    raw: JSON.stringify({ role, content: Array.isArray(content) ? content.map((block: any) => block.type === "toolCall" ? { ...block, name: calls.find(c => c.callId === block.id)?.name, arguments: JSON.parse(calls.find(c => c.callId === block.id)?.input ?? "{}") } : block) : content,
      ...(role === "toolResult" ? { toolCallId: calls[0]?.callId, isError: false } : {}) }), calls });
  return { m, turn, session, append, setNoter: (agent: typeof run) => { run = agent; } };
}
test("33/93: entry lists retain repeats/order; ranges tolerate sibling gaps; whole-entry role reads preserve blocks", () => {
  const f = fixture();
  try {
    const user = f.append("user", "question"), calls = [{ ordinal: 1, name: "bash", callId: "opaque:a-b.c|d", input: '{"command":"run"}', status: "attempted" }];
    const assistant = f.append("assistant", [{ type: "text", text: "before" }, { type: "toolCall", id: calls[0]!.callId }, { type: "text", text: "after" }, { type: "thinking", thinking: "stored reasoning" }], calls);
    const sibling = f.append("assistant", "sibling");
    const result = f.append("toolResult", [{ type: "text", text: "tool evidence" }], [{ ...calls[0], result: "tool evidence", status: "success" }]);
    f.m.selectEntries(f.session.id, "main", [user.id, assistant.id, result.id]);
    const options = { sessionId: f.session.id, branch: "main", pageBudget: null };
    const text = f.m.trace(`T${f.turn.id}`, options);
    expect(text.indexOf("before")).toBeLessThan(text.indexOf("bash(")); expect(text.indexOf("bash(")).toBeLessThan(text.indexOf("after"));
    expect(text).not.toContain("stored reasoning"); expect(text).not.toContain("sibling");
    const fullTurn = f.m.trace(`T${f.turn.id}`, { ...options, full: true });
    expect(fullTurn).not.toContain("sibling");
    expect(fullTurn).toContain("stored reasoning");
    const selected = f.m.trace(`T${f.turn.id}#E4,T${f.turn.id}#E2,T${f.turn.id}#E4`, options);
    expect(selected.indexOf("tool evidence")).toBeLessThan(selected.indexOf("before")); expect(selected.match(/tool evidence/g)).toHaveLength(2);
    expect(selected).toContain('command="run"');
    expect(selected).toContain("stored reasoning");
    const range = f.m.trace(`T${f.turn.id}#E2..E4`, options);
    expect(range).toContain("before");
    expect(range).toContain("stored reasoning");
    expect(() => f.m.trace(`T${f.turn.id}#E${sibling.entryOrdinal}`, options)).toThrow(/does not exist/);
    expect(f.m.trace(`T${f.turn.id}@user`, options)).toContain("question");
    for (const removed of [`T${f.turn.id}#E1@thinking`, `T${f.turn.id}#E2@opaque:a-b.c|d`, `T${f.turn.id}#E2@text`])
      expect(() => f.m.trace(removed, options)).toThrow(/invalid public trace address/);
    const exact = f.m.trace(`T${f.turn.id}#E2@assistant`, options);
    expect(exact).toContain('command="run"');
    expect(exact).toContain("stored reasoning");
    expect(f.m.trace(`T${f.turn.id}@assistant`, options)).toContain("stored reasoning");
  } finally { f.m.close(); }
});
test("33: Turn budgets each entry, entry budgets each block; null disables each independent ceiling", () => {
  const f = fixture();
  try {
    f.append("user", "word ".repeat(200));
    const assistant = f.append("assistant", [{ type: "text", text: "one ".repeat(200) }, { type: "text", text: "two ".repeat(200) }]);
    const profile = { ...DEFAULT_CONFIG.render, entryTokens: 80 };
    const inTurn = renderEntry(assistant, profile).content;
    expect(tokens(inTurn)).toBeLessThanOrEqual(80);
    const direct = f.m.trace(`T${f.turn.id}#E2`, { itemBudget: 80, pageBudget: null });
    expect(tokens(direct)).toBeGreaterThan(80); expect(tokens(direct)).toBeLessThanOrEqual(160);
    expect(f.m.trace(`T${f.turn.id}`, { itemBudget: 80, pageBudget: null })).toContain(inTurn);
    const call = { ordinal: 1, name: "tool", callId: "c", input: JSON.stringify({ command: "word ".repeat(500) }), status: "attempted" };
    f.append("assistant", [{ type: "toolCall", id: "c" }], [call]);
    expect(f.m.trace(`T${f.turn.id}#E3`, { itemBudget: null, pageBudget: null })).toContain("characters truncated");
    const full = f.m.trace(`T${f.turn.id}#E3`, { itemBudget: null, toolCallBudget: null, toolResultBudget: null, pageBudget: null });
    expect(full).not.toContain("characters truncated");
    expect(full).toBe(f.m.trace(`T${f.turn.id}#E3`, { full: true, pageBudget: null }));
    expect(() => f.m.trace(`T${f.turn.id}`, { full: true, toolCallBudget: 100 })).toThrow(/conflicts/);
  } finally { f.m.close(); }
});
test("92: whole-entry frozen citations bind only that occurrence; block selectors and placeholders are not evidence", async () => {
  const f = fixture();
  try {
    const a = f.append("user", "question"), b = f.append("assistant", "first"), c = f.append("assistant", "sibling");
    f.m.selectEntries(f.session.id, "main", [a.id, b.id, c.id]);
    f.setNoter(async input => {
      const noter = input.tools.find(t => t.name === "note")!;
      const fact = (source: string) => ({ facts: [{ slot: "$1", title: "Statement", sources: [{ address: source, text: "Pi agent reports a statement" }] }] });
      expect(noter.execute({ facts: [{ title: "Rejected sibling", sources: [{ address: `T${f.turn.id}#E3`, text: "Sibling evidence" }] }] })).toContain("rejected:");
      for (const source of [`T${f.turn.id}#E2@thinking`, `T${f.turn.id}#E2@nonexistent`, `T${f.turn.id}#E2@text`]) expect(noter.execute(fact(source))).toContain("rejected:");
      expect(noter.execute(fact(`T${f.turn.id}#E2`))).toContain("held: $1");
      input.tools.find(t => t.name === "memory")!.execute({ operations: [], skipped: [] });
      expect(f.m.store.listTurnFacts(f.turn.id)).toEqual([]);
      return { outcome: "success", output: "done", request: {} };
    });
    const result = await f.m.noting({ sessionId: f.session.id, branch: "main", headTurnId: f.turn.id, boundary: { exactEntryIds: [a.id, b.id] } });
    expect(result.outcome, JSON.stringify(result)).toBe("success");
    expect(f.m.store.factEntries(1)).toEqual([b.id]);
    expect(f.m.store.factCoveredByRaw(f.m.store.getFact(1)!, new Set([b.id]))).toBe(true);
    expect(f.m.store.entryNoted(c.id)).toBe(false);
    const image = f.append("user", [{ type: "image", data: "not evidence" }]);
    expect(() => f.m.trace(`T${f.turn.id}#E${image.entryOrdinal}@text`)).toThrow(/invalid public trace address/);
  } finally { f.m.close(); }
});
test("33: malformed or changed-budget continuations never consume a cursor", () => {
  const f = fixture();
  try {
    f.append("user", "字😀".repeat(4000));
    const first = f.m.trace(`T${f.turn.id}#E1`, { full: true, pageBudget: 200 });
    const cursor = /cursor=(\S+)/.exec(first)![1]!;
    for (const [address, options] of [[`T${f.turn.id}#E0`, { cursor }], [`cursor=${cursor}`, { itemBudget: 30 }], [`cursor=${cursor}`, { pageBudget: 201 }]] as const)
      expect(() => f.m.trace(address, options)).toThrow();
    expect(f.m.trace(`cursor=${cursor}`)).not.toContain("rejected:");
    expect(tokens(first)).toBeLessThanOrEqual(200);
  } finally { f.m.close(); }
});
