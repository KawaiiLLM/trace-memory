import { expect, test, vi } from "vitest";
import { TraceMemory, DEFAULT_CONFIG, tokens } from "../../../src/core/api/index.ts";
import { piSourceBlocks } from "../../../src/hosts/pi/source.ts";
import { renderEntry, renderEntryIndex, renderFact, renderNegationWalk } from "../../../src/core/render/index.ts";
import { freezeNoting } from "../../../src/core/noting/index.ts";
import { noVisibility } from "../../../src/core/api/visible.ts";
import { tracePage, wholeTrace } from "../../trace-pages.ts";

const time = "2026-09-01T00:00:00Z";
function setup(normalized = true) {
  const m = TraceMemory(":memory:", async () => { throw new Error("offline only"); }, {}, undefined, normalized ? piSourceBlocks : undefined);
  const projectId = m.store.createProject({ name: "sol", declaredBy: "mark" }).id;
  const sessionId = m.store.createSession({ host: "pi:sol", projectId, startedAt: time, firstReplyAt: time, enrollmentChoice: true }).id;
  const turn = m.store.appendTurn({ sessionId, kind: "turn", startedAt: time });
  let next = 0;
  const text = (body: string, role: "user" | "assistant" = "assistant", turnId = turn.id, parts = [body]) => m.appendEntry({
    sessionId, turnId, nativeLineage: "sol", nativeId: `text-${++next}`, role, text: parts.join("\n"), calls: [],
    raw: JSON.stringify({ role, content: parts.map(text => ({ type: "text", text })) }) });
  const call = { callId: "dispatch", ordinal: 1, name: "bash", input: '{"command":"run"}', status: "attempted" };
  const dispatch = (body = "") => m.appendEntry({ sessionId, turnId: turn.id, nativeLineage: "sol", nativeId: `call-${++next}`, role: "assistant", text: body, calls: [call],
    raw: JSON.stringify({ role: "assistant", content: [...(body ? [{ type: "text", text: body }] : []), { type: "toolCall", id: call.callId, name: call.name, arguments: { command: "run" } }] }) });
  const result = (callId = call.callId) => m.appendEntry({ sessionId, turnId: turn.id, nativeLineage: "sol", nativeId: `result-${++next}`, role: "toolResult", text: "", calls: [{ ...call, callId, result: "passed", status: "success" }],
    raw: JSON.stringify({ role: "toolResult", toolCallId: callId, isError: false, content: [{ type: "text", text: "passed" }] }) });
  const select = (ids: number[], branch = "main") => m.selectEntries(sessionId, branch, ids);
  const note = (kind: "manual" | "noting" = "manual", entryIds?: number[]) => m.tools(kind === "manual"
    ? { kind, sessionId, currentTurnId: turn.id, branch: "main" }
    : { kind, sessionId, branch: "main", entryIds, range: { from: `S${sessionId}/T${turn.id}`, to: `S${sessionId}/T${turn.id}` } }).find(tool => tool.name === "note")!;
  return { m, sessionId, turn, text, dispatch, result, select, note };
}

test("Sol 1: bound empty Turn/path never expands, full preserves membership, unbound and legacy reads remain available", () => {
  const f = setup();
  try {
    const left = f.text("LEFT PRIVATE");
    const rightTurn = f.m.store.appendTurn({ sessionId: f.sessionId, kind: "turn", startedAt: time });
    const right = f.text("RIGHT", "user", rightTurn.id);
    f.select([left.id], "left"); f.select([right.id], "right"); f.select([], "empty");
    for (const branch of ["right", "empty"]) for (const full of [false, true]) {
      const options = { branch, full, pageBudget: null };
      for (const address of ["T1", "T1@assistant", "T1@text", "T1#E1..E9"]) expect(f.m.trace(address, options)).not.toContain("LEFT PRIVATE");
      expect(f.m.trace("T1@assistant", options)).toBe("");
      expect(() => f.m.trace("T1#E1", options)).toThrow("does not exist on this path");
      expect(() => f.m.trace("T1#assistant", options)).toThrow("does not exist");
    }
    expect(f.m.trace("T1", { full: true, pageBudget: null })).toContain("LEFT PRIVATE");
    expect(f.m.trace("T1#assistant", { branch: "legacy-without-path", full: true })).toContain("LEFT PRIVATE");
    const otherSession = f.m.store.createSession({ host: "test", projectId: f.m.store.getSession(f.sessionId)!.projectId, startedAt: time, firstReplyAt: time, enrollmentChoice: true });
    expect(f.m.trace("T1#E1", { sessionId: otherSession.id, full: true, pageBudget: null })).toContain("LEFT PRIVATE");
  } finally { f.m.close(); }
});

test("Sol 2: single entry selectors budget each selected block; collections retain entry budgets", () => {
  const f = setup();
  try {
    const entry = f.text("", "assistant", f.turn.id, ["alpha ".repeat(180), "beta ".repeat(180)]);
    f.select([entry.id]);
    for (const address of ["T1#E1", "T1#E1@text", "T1#E1@assistant"]) {
      const text = f.m.trace(address, { itemBudget: 80, pageBudget: null });
      const blocks = text.split(/(?=\n\[T1#E1@text\])/).filter(Boolean);
      expect(blocks).toHaveLength(2);
      expect(tokens(text)).toBeGreaterThan(80);
      blocks.forEach(block => expect(tokens(block)).toBeLessThanOrEqual(80));
    }
    for (const address of ["T1", "T1@text", "T1#E1..E1", "T1#E1,E1@text"]) {
      const text = f.m.trace(address, { itemBudget: 80, pageBudget: null });
      expect(text).toContain("characters truncated");
      expect(tokens(text)).toBeLessThan(190);
    }
    expect(f.m.trace("T1#E1@text", { itemBudget: null, pageBudget: null })).not.toContain("truncated");
    expect(f.m.trace("T1#E1@text", { pageBudget: null })).not.toContain("truncated");
    const huge = { ...entry, text: "huge ".repeat(9000), blocks: [{ kind: "text" as const, text: "huge ".repeat(9000) }] };
    expect(tokens(renderEntry(huge, DEFAULT_CONFIG.render).content)).toBeLessThanOrEqual(2000);
    expect(tokens(renderEntry(huge, DEFAULT_CONFIG.render).content)).toBeGreaterThan(1900);
  } finally { f.m.close(); }
});

test.each(["manual", "noting"] as const)("92 supersedes Sol 4 status policing: %s sources are whole entries, not incidental text or siblings", kind => {
  const f = setup();
  try {
    const mixed = f.dispatch("I will start it"), pure = f.dispatch(), delivery = f.text("Here is the requested explanation."), sibling = f.result(), unrelated = f.result("other");
    f.select([mixed.id, pure.id, delivery.id, unrelated.id]);
    const submit = (sources: string[]) => f.note(kind).execute({ facts: [{ text: "Pi agent claimed delivery; evidence remains separately attributed.", source: sources }] });
    for (const sources of [["T1#E1@dispatch"], ["T1#t1"], ["T1#E1", "T1#E3@text"], ["T1#E1", "T1#E5@other"], ["T1#assistant"]])
      expect(submit(sources)).toContain("invalid source");
    expect(submit(["T1#E1", "T1#E4"])).toContain("invalid source");
    for (const sources of [["T1#E1"], ["T1#E2"], ["T1#E3"], ["T1#E1", "T1#E5"]]) expect(submit(sources)).not.toContain("rejected:");
    f.select([mixed.id, pure.id, delivery.id, sibling.id, unrelated.id]);
    for (const sources of [["T1#E4"], ["T1#E1", "T1#E4"]]) expect(submit(sources)).not.toContain("rejected:");
    if (kind === "manual") {
      expect(f.m.store.listTurnFacts(f.turn.id).at(-1)!.roles).toEqual([{ role: "assistant", harness: "Pi agent" }, { role: "observation" }]);
    } else expect(f.m.store.listTurnFacts(f.turn.id)).toEqual([]); // tool holds do not publish
  } finally { f.m.close(); }
});

test("92: an unnormalized whole entry remains assistant evidence; legacy read aliases retain text projection", () => {
  const f = setup(false);
  try {
    const entry = f.dispatch("Claimed delivery"); f.select([entry.id]);
    const submit = (source: string) => f.note().execute({ facts: [{ text: "Pi agent claimed delivery", source: [source] }] });
    expect(submit("T1#E1")).not.toContain("rejected:");
    expect(f.m.store.listTurnFacts(f.turn.id)[0]!.roles).toEqual([{ role: "assistant", harness: "Pi agent" }]);
    expect(submit("T1#assistant")).toContain("invalid source");
    expect(submit("T1#E1@text")).toContain("invalid source");
    expect(f.m.trace("T1#assistant")).toContain("Claimed delivery");
  } finally { f.m.close(); }
});

test("Sol 3: mixed supplied/visible material has one body, a full identity index and only the actual last reply", () => {
  const f = setup();
  try {
    const user = f.text("USER-BODY", "user"), early = f.text("EARLY-BODY"), fresh = f.text("FRESH-BODY"), head = f.dispatch("HEAD-BODY");
    const entries = [user, early, fresh, head]; f.select(entries.map(e => e.id));
    const visible = noVisibility();
    for (const entry of [user, early, head]) visible.raw.set(entry.nativeId, "source");
    const input = { sessionId: f.sessionId, branch: "main", headTurnId: f.turn.id, mode: "fork" as const, visible };
    const frozen = freezeNoting(f.m.store, input, f.m.config), prepared = frozen.prepared!;
    expect(prepared.material.entries.map(e => e.id)).toEqual([fresh.id]);
    expect(prepared.material.head).toBe(renderEntry(head, f.m.config.render).content);
    expect(prepared.material.sources).toEqual(entries.map(renderEntryIndex));
    for (const body of ["FRESH-BODY", "HEAD-BODY"]) expect(prepared.text.split(body)).toHaveLength(2);
    for (const body of ["USER-BODY", "EARLY-BODY"]) expect(prepared.text).not.toContain(body);
    expect(prepared.material.sources.join("\n")).not.toContain("BODY");
    expect(prepared.supplied.entries.map(e => e.id)).toEqual([fresh.id, head.id]);
    const actual = tokens(prepared.text);
    // Exact membership makes the capacity boundary about this text, never a smaller batch.
    const boundary = { exactEntryIds: entries.map(e => e.id) };
    const probe = (inputTokens: number) => freezeNoting(f.m.store, { ...input, boundary, capacity: { inputTokens, prefixTokens: 73 } }, f.m.config);
    let low = actual, high = actual + 20000;
    while (low < high) { const mid = Math.floor((low + high) / 2); try { probe(mid); high = mid; } catch { low = mid + 1; } }
    expect(probe(low).prepared!.text).toBe(prepared.text);
    expect(() => probe(low - 1)).toThrow("Noting capacity");
    // The retired Noter-only episodic limit no longer gates the shared compact material;
    // the exact frozen membership still faces the model's hard input limit above.
    // A shorter frozen prefix must not relabel its final assistant as the captured missing reply.
    const prefix = freezeNoting(f.m.store, { ...input, boundary: { maxEntryId: early.id } }, f.m.config).prepared!;
    expect(prefix.material.head).toBeNull();
    // Once the head is actually supplied in Raw it is never repeated in the head supplement.
    visible.raw.delete(head.nativeId);
    const supplied = freezeNoting(f.m.store, input, f.m.config).prepared!;
    expect(supplied.material.head).toBeNull();
    expect(supplied.text.split("HEAD-BODY")).toHaveLength(2);
  } finally { f.m.close(); }
});

test("Sol 5: semantic groups and walks budget complete framing; automatic facts and pagination remain whole", () => {
  const f = setup();
  try {
    const entry = f.text("evidence", "user"); f.select([entry.id]);
    const fact = { text: "long evidence ".repeat(180), source: ["T1#E1"] };
    expect(f.note().execute({ facts: [fact, { ...fact, negate: [["$1", "strong"]] }] })).not.toContain("rejected:");
    for (const address of ["F1", "T1@F*", "F1-F1", "F1-F2"]) {
      const text = f.m.trace(address, { itemBudget: 100, pageBudget: null });
      const items = text.split(/\n(?=\[F2\])/);
      items.forEach(item => expect(tokens(item)).toBeLessThanOrEqual(100));
      expect(text).toContain("characters truncated");
      expect(() => f.m.trace(address, { itemBudget: 10, pageBudget: null })).toThrow("semantic item capacity");
      expect(wholeTrace(f.m, address, { itemBudget: 100, pageBudget: 150 })).toBe(text);
    }
    const facts = [f.m.store.getFact(1)!, f.m.store.getFact(2)!];
    const steps = facts.map((fact, depth) => ({ fact, depth, terminal: depth === 1, relations: f.m.store.listFactRelations(fact.id) }));
    const walk = renderNegationWalk(steps, 130);
    const chunks = walk.split(/\n(?=  \[F2\])/);
    chunks.forEach(chunk => expect(tokens(chunk)).toBeLessThanOrEqual(130));
    expect(walk).toContain("no later strong negation recorded");
    expect(() => renderNegationWalk(steps, 10)).toThrow("semantic item capacity");
    expect(f.m.trace("F1..", { itemBudget: 130, pageBudget: null })).toBe(walk);
    expect(wholeTrace(f.m, "F1..", { itemBudget: 130, pageBudget: 150 })).toBe(walk);
    expect(renderFact(facts[0]!, [])).toContain(fact.text);
    expect(f.m.trace("T1@F*", { itemBudget: null, pageBudget: null })).toContain(fact.text);
    const frozen = freezeNoting(f.m.store, { sessionId: f.sessionId, branch: "main", headTurnId: f.turn.id, mode: "subagent" }, f.m.config).prepared!;
    expect(frozen.material.facts.join("\n")).toContain(fact.text);
    expect(frozen.material.facts.join("\n")).not.toContain("truncated");
    const later = f.m.store.appendTurn({ sessionId: f.sessionId, parentTurnId: f.turn.id, kind: "turn", startedAt: "2026-09-02T00:00:00Z" });
    const evidence = f.text("later evidence", "user", later.id); f.select([entry.id, evidence.id]);
    const writer = f.m.tools({ kind: "manual", sessionId: f.sessionId, currentTurnId: later.id, branch: "main" }).find(t => t.name === "note")!;
    expect(writer.execute({ facts: [{ ...fact, source: ["T2#E1"] }] })).not.toContain("rejected:");
    for (const address of ["F1-F3", "F3-F3,F1-F1", "sol"]) {
      const assembled = f.m.trace(address, { itemBudget: 100, pageBudget: null });
      const grouped = tracePage(assembled).body; // collection receipts spend the page budget, not a fact's item budget
      expect(grouped).toContain("[T2]");
      grouped.split(/(?=\n\[(?:T\d+|F2)\])/).forEach(item => expect(tokens(item)).toBeLessThanOrEqual(100));
      if (address === "sol") expect(assembled).toContain("One representative per K");
      // drainTrace measures every whole response including receipts against maxTokens.
      expect(wholeTrace(f.m, address, { itemBudget: 100, pageBudget: 150, maxTokens: 150 })).toBe(grouped);
    }
  } finally { f.m.close(); }
});

test("Sol 4: one source-path read serves a whole submission, including repeated multi-source citations", () => {
  const f = setup();
  try {
    const a = f.text("one"), b = f.text("two"); f.select([a.id, b.id]);
    const note = f.note();
    const scan = vi.spyOn(f.m.store, "sourcePath");
    expect(note.execute({ facts: Array.from({ length: 6 }, () => ({ text: "Claim", source: ["T1#E1", "T1#E2"] })) })).not.toContain("rejected:");
    expect(scan).toHaveBeenCalledTimes(1);
    expect(f.m.store.factEntries(1)).toEqual([a.id, b.id]);
    f.select([b.id]); // same Turn, different actual entry path; reuse the same manual tool
    expect(note.execute({ facts: [{ text: "still present", source: ["T1#E2"] },
      { text: "no longer on path", source: ["T1#E1"] }] })).toContain("invalid source");
    expect(scan).toHaveBeenCalledTimes(2); // exactly one fresh read on the next call
    expect(f.m.store.listTurnFacts(f.turn.id)).toHaveLength(6); // no partial write
  } finally { f.m.close(); }
});

test("Sol 2: selected call/result leaves retain additional 100-token ceilings and independent null limits", () => {
  const f = setup();
  try {
    const call = { ordinal: 1, name: "bash", callId: "long", status: "attempted", input: JSON.stringify({ command: "command ".repeat(900) }) };
    const entry = f.m.appendEntry({ sessionId: f.sessionId, turnId: f.turn.id, nativeId: "long-call", nativeLineage: "sol", role: "assistant", text: "", calls: [call], raw: JSON.stringify({ role: "assistant", content: [{ type: "toolCall", id: "long", name: "bash", arguments: JSON.parse(call.input) }] }) });
    const result = { ...call, result: "output ".repeat(900), status: "success" };
    const returned = f.m.appendEntry({ sessionId: f.sessionId, turnId: f.turn.id, nativeId: "long-result", nativeLineage: "sol", role: "toolResult", text: "", calls: [result], raw: JSON.stringify({ role: "toolResult", toolCallId: "long", content: [{ type: "text", text: result.result }] }) });
    f.select([entry.id, returned.id]);
    for (const source of [entry, returned]) {
      const selector = { kind: "call" as const, id: "long" };
      const bounded = renderEntry(source, { ...f.m.config.render, entryTokens: 400 }, undefined, undefined, selector, true);
      expect(tokens(bounded.content)).toBeLessThanOrEqual(100);
      expect(bounded.content).toContain("truncated");
      const eighty = renderEntry(source, { ...f.m.config.render, entryTokens: 80 }, undefined, undefined, selector, true);
      expect(tokens(eighty.content)).toBeLessThanOrEqual(80);
      expect(f.m.trace(`T1#E${source.entryOrdinal}@long`, { itemBudget: null, pageBudget: null })).toContain("truncated");
      expect(f.m.trace(`T1#E${source.entryOrdinal}@long`, { itemBudget: null, toolCallBudget: null, toolResultBudget: null, pageBudget: null })).not.toContain("truncated");
    }
  } finally { f.m.close(); }
});
