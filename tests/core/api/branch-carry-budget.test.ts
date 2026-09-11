import { expect, test } from "vitest";
import { TraceMemory } from "../../../src/core/api/index.ts";
import { charge, renderEntry, tokens } from "../../../src/core/render/index.ts";
import { piSourceBlocks } from "../../../src/hosts/pi/source.ts";

function fixture(texts: string[], normalized = false) {
  const memory = TraceMemory(":memory:", async () => { throw new Error("No provider expected"); }, {}, undefined, normalized ? piSourceBlocks : undefined);
  const project = memory.store.createProject({ name: "carry", declaredBy: "mark" });
  const session = memory.store.createSession({ host: "test", projectId: project.id, enrollmentChoice: true, startedAt: "now", firstReplyAt: "now" });
  const turn = memory.store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: texts[0] ?? "", assistantText: "reply", startedAt: "now" });
  const entries = texts.map((text, index) => memory.appendEntry({ sessionId: session.id, turnId: turn.id,
    nativeLineage: "test", nativeId: `entry-${index}`, role: index === 0 ? "user" : "assistant", text,
    raw: JSON.stringify(normalized ? { role: index === 0 ? "user" : "assistant", content: [{ type: "text", text }] } : { text }), calls: [] }));
  memory.selectEntries(session.id, "main", entries.map(entry => entry.id));
  const carry = () => memory.branchSummary(session.id, "main", turn.id);
  const raw = () => carry().split("Pending raw:\n")[1]!.replace(/\n?<\/branch_carry>$/, "");
  return { memory, session, turn, entries, carry, raw };
}
const receipt = (n: number) => `[... ${n} earlier pending entries omitted from the carry budget; read them with trace]`;

test("entry/cleanup integration: carry budgets only its exact normalized Raw suffix, not complete grouped facts or commits", () => {
  const f = fixture(["old evidence ".repeat(500), "SIBLING-ONLY"], true);
  try {
    const { memory: m, session, turn } = f;
    const call = { ordinal: 1, name: "bash", callId: "call,one", input: JSON.stringify({ command: "run ".repeat(400) }), status: "attempted" };
    const text = "complete assistant text ".repeat(500);
    const mixed = m.appendEntry({ sessionId: session.id, turnId: turn.id, nativeLineage: "test", nativeId: "mixed", role: "assistant", text, calls: [call],
      raw: JSON.stringify({ role: "assistant", content: [{ type: "text", text }, { type: "toolCall", id: call.callId, name: call.name, arguments: JSON.parse(call.input) }, { type: "text", text }] }) });
    const result = m.appendEntry({ sessionId: session.id, turnId: turn.id, nativeLineage: "test", nativeId: "result", role: "toolResult", text: "", calls: [{ ...call, result: "result ".repeat(500), status: "success" }],
      raw: JSON.stringify({ role: "toolResult", toolCallId: call.callId, content: [{ type: "text", text: "result ".repeat(500) }] }) });
    const selected = [f.entries[0]!, mixed, result];
    m.selectEntries(session.id, "main", selected.map(e => e.id));
    const source = `T${turn.id}#E${result.entryOrdinal}@"call,one"`;
    const factText = "complete event evidence ".repeat(1000), knowledgeText = "complete conclusion ".repeat(1000);
    const note = m.tools({ kind: "manual", sessionId: session.id, branch: "main", currentTurnId: turn.id }).find(t => t.name === "note")!;
    expect(note.execute({ facts: [
      { category: "event", actor: "agent", status: "completed", text: factText, source: [`T${turn.id}#E${mixed.entryOrdinal}`, source] },
      { category: "observation", actor: "user", text: "a later correction", source: [`T${turn.id}#E1@text`], negate: [["$1", "strong"]] },
    ] })).not.toContain("rejected:");
    const knowledge = m.store.commitConsolidationRun({ path: { sessionId: session.id, branch: "main", headTurnId: turn.id },
      run: { kind: "manual", sessionId: session.id, createdAt: "now" }, operations: [{ op: "create", handle: "$k", author: "test", text: knowledgeText,
        category: "mechanism", scope: "session", supports: [1], topics: [], reason: "synthetic integration evidence", createdAt: "now" }] });
    expect(knowledge.ok).toBe(true);
    const views = [mixed, result].map(e => renderEntry(e, m.config.render).content);
    const cap = charge(["Pending raw:", ...views, receipt(1)]);
    m.config.render.episodicBlockTokens = cap;
    const carry = f.carry();
    expect(f.raw()).toBe([...views, receipt(1)].join("\n"));
    expect(tokens(`Pending raw:\n${f.raw()}`)).toBeLessThanOrEqual(cap);
    expect(views[0]).toContain(`[T${turn.id}#E3@"call,one"]`);
    expect(views[1]).toContain(`[${source}]`);
    expect(views.every(view => view.includes("characters truncated"))).toBe(true);
    views.forEach(view => expect(tokens(view)).toBeLessThanOrEqual(m.config.render.entryTokens));
    expect(carry).toContain("(selected facts)");
    expect(carry).toContain(factText); expect(carry).toContain(knowledgeText);
    expect(carry).toContain("negate F1 strong"); expect(carry).toContain(`source: T${turn.id}#E3, ${source}`);
    expect(tokens(carry)).toBeGreaterThan(cap); // Only Pending raw owns the carry cap.
    expect(carry).not.toContain("SIBLING-ONLY");
    expect(m.trace(`T${turn.id}`, { branch: "main", full: true, pageBudget: null })).not.toContain("SIBLING-ONLY");
    expect(() => m.trace(`T${turn.id}#E2`, { branch: "main", full: true })).toThrow("does not exist on this path");
    expect(m.status(session.id, "main", turn.id)).toContain("Knowledge: 1 visible active");
    expect(m.pendingEntries(session.id, "main", turn.id).map(e => e.id)).toEqual(selected.map(e => e.id));
    m.config.render.episodicBlockTokens = cap - 1;
    expect(f.raw()).toBe([views[1], receipt(2)].join("\n"));
  } finally { f.memory.close(); }
});

test("an impossible optional carry envelope fails instead of retaining one oversized entry", () => {
  const f = fixture(["hello world"]);
  try {
    f.memory.config.render.episodicBlockTokens = 1;
    expect(f.carry).toThrow(/capacity/);
    expect(f.memory.pendingEntries(f.session.id, "main", f.turn.id).map(e => e.id)).toEqual(f.entries.map(e => e.id));
  } finally { f.memory.close(); }
});

test("a single oversized carry entry is omitted whole with a charged receipt, not a second Raw view", () => {
  const f = fixture(["large raw ".repeat(500)]);
  try {
    const cap = charge(["Pending raw:", receipt(1)]);
    f.memory.config.render.episodicBlockTokens = cap;
    expect(f.raw()).toBe(receipt(1));
    expect(tokens(`Pending raw:\n${f.raw()}`)).toBeLessThanOrEqual(cap);
    f.memory.config.render.episodicBlockTokens = cap - 1;
    expect(f.carry).toThrow(/capacity/);
    // Carry is optional; custom compaction still protects every pending entry and its coverage.
    const compact = f.memory.compact(f.session.id, "main", f.turn.id);
    expect("native" in compact).toBe(false);
    if ("native" in compact) throw new Error(compact.reason);
    expect(compact.supplied.entries.map(e => e.id)).toEqual(f.entries.map(e => e.id));
    expect(compact.text).toContain(renderEntry(f.entries[0]!, f.memory.config.render).content);
  } finally { f.memory.close(); }
});

test("carry keeps the newest whole suffix in source order and charges framing and omissions", () => {
  const f = fixture(["old ".repeat(500), "middle", "newest"]);
  try {
    const views = f.entries.map(e => renderEntry(e, f.memory.config.render).content);
    const cap = charge(["Pending raw:", ...views.slice(1), receipt(1)]);
    f.memory.config.render.episodicBlockTokens = cap;
    expect(f.raw()).toBe([...views.slice(1), receipt(1)].join("\n"));
    expect(tokens(`Pending raw:\n${f.raw()}`)).toBeLessThanOrEqual(cap);
    f.memory.config.render.episodicBlockTokens = cap - 1;
    expect(f.raw()).toBe([views[2], receipt(2)].join("\n"));
    expect(f.memory.progress(f.session.id, "main", f.turn.id).entries).toBe(3);
  } finally { f.memory.close(); }
});

test("empty carry and a complete small Raw view need no omission receipt", () => {
  for (const texts of [[], ["hello world"]]) {
    const f = fixture(texts);
    try {
      const views = f.entries.map(e => renderEntry(e, f.memory.config.render).content);
      f.memory.config.render.episodicBlockTokens = charge(["Pending raw:", ...views]);
      expect(f.raw()).toBe(views.join("\n"));
      expect(f.carry()).not.toContain("omitted from the carry budget");
      f.memory.config.render.episodicBlockTokens = 1;
      expect(f.carry).toThrow(/capacity/);
    } finally { f.memory.close(); }
  }
});
