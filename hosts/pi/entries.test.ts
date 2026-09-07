import { expect, test } from "vitest";
import { join } from "node:path";
import { TraceMemory, renderEntry, tokens, type RecordingAgentInput } from "../../core/api/index.ts";
import { host, reply } from "./test-host.ts";

const quiet = { "recording.triggerAnsweredTurns": 999, "recording.triggerTokens": 1_000_000_000 };
const rawOf = (input: string) => input.split("Raw:\n\n")[1]!.split("\n\nRecent facts")[0]!.split("\n\nReceipts:")[0]!;

test("17a 2026-09-08: completion alone has no native identity; next safe boundary reconciles persisted entries", async () => {
  const h = host(quiet);
  try {
    await h.prompt("Persist first");
    const completed = reply("Complete assistant");
    await h.hooks.get("message_end")!({ message: completed }, h.ctx);
    expect(h.memory.pendingEntries(1, "main", 1).map(e => e.role)).toEqual(["user"]);
    const native = h.persist(completed);
    expect(h.memory.pendingEntries(1, "main", 1).map(e => e.role)).toEqual(["user"]);
    await h.emit("message_start", { message: reply("") });
    const entries = h.memory.pendingEntries(1, "main", 1);
    expect(entries.map(e => [e.nativeId, e.role])).toEqual([[h.entries.find(e => e.type === "message").id, "user"], [native.id, "assistant"]]);
    expect(entries[1]!.raw).toBe(JSON.stringify(completed));
    await h.emit("message_start", { message: reply("") });
    expect(h.memory.pendingEntries(1, "main", 1)).toEqual(entries);
  } finally { await h.dispose(); }
});

test("17a 2026-09-08: attach imports earlier native history, preserves repeated occurrences, and excludes plugin and empty sources", async () => {
  const h = host(quiet);
  try {
    h.persist({ role: "user", content: "same", timestamp: 1 });
    h.persist(reply("same answer"));
    h.persist(reply("same answer"));
    h.persist({ role: "user", content: "same", timestamp: 2 });
    h.persist(reply("same answer"));
    h.persist({ ...reply(""), content: [{ type: "thinking", thinking: "private", thinkingSignature: "sig" }] });
    h.persist({ role: "custom", customType: "trace-memory", content: "injected", display: false });
    h.persist({ role: "compactionSummary", summary: "summary" });
    h.persist({ role: "branchSummary", summary: "carry" });
    await h.emit("session_start");
    const entries = h.memory.pendingEntries(1, "main", 2);
    expect(entries.map(e => [e.turnId, e.role, e.text])).toEqual([[1, "user", "same"], [1, "assistant", "same answer"], [1, "assistant", "same answer"], [2, "user", "same"], [2, "assistant", "same answer"]]);
    expect(new Set(entries.map(e => e.nativeId)).size).toBe(5);
    expect(h.memory.trace("T1#assistant", { full: true })).toContain("same answer\nsame answer");
    await h.emit("session_start");
    expect(h.memory.pendingEntries(1, "main", 2)).toEqual(entries);
    expect(h.memory.store.getSession(2)).toBeNull();
    await h.prompt("continue imported session"); await h.answer("okay");
    expect(h.memory.store.listTurns(1)).toHaveLength(3);
    expect(h.requests).toEqual([]);
  } finally { await h.dispose(); }
});

test("17a 2026-09-08: attach surfaces missing native ancestry without manufacturing sources", async () => {
  const h = host(quiet);
  try {
    await h.turn();
    h.entries.splice(0, h.entries.length, ...h.entries.filter(e => e.type === "custom"));
    await h.emit("session_start");
    expect(h.notices.some(n => n.includes("missing native history"))).toBe(true);
    expect(h.memory.pendingEntries(1, "main", 1)).toEqual([]);
    expect(h.memory.store.listSourceEntries(1)).toHaveLength(2);
    expect(h.requests).toEqual([]);
  } finally { await h.dispose(); }
});

test("17a 2026-09-08: frozen entries leave late same-Turn sources pending and reject their citations despite unrestricted reads", async () => {
  const h = host(quiet);
  let release!: () => void;
  let input!: RecordingAgentInput;
  const recorder = TraceMemory(join(h.dir, "trace.db"), async raw => {
    input = raw as RecordingAgentInput;
    await new Promise<void>(resolve => { release = resolve; });
    return { outcome: "success", output: "zero facts", request: {} };
  });
  try {
    await h.prompt("Check");
    await h.emit("message_end", { message: { ...reply("first"), content: [{ type: "text", text: "first" }, { type: "toolCall", id: "call", name: "bash", arguments: { command: "check" } }] } });
    await h.emit("message_start", { message: reply("") });
    const before = h.memory.pendingEntries(1, "main", 1);
    const pending = recorder.record({ sessionId: 1, branch: "main", headTurnId: 1, mode: "subagent" });
    const oldView = renderEntry(before[1]!, h.memory.config.render).content;
    await h.emit("tool_result", { toolCallId: "call", toolName: "bash", input: { command: "check" }, content: [{ type: "text", text: "late result" }], isError: false });
    await h.answer("late assistant");
    const read = input.tools.find(t => t.name === "trace")!.execute({ address: "T1#t1", full: true });
    expect(read).toContain("late result");
    for (const address of ["T1#assistant", "T1#t1"]) {
      expect(JSON.parse(input.tools.find(t => t.name === "note")!.execute({ facts: [{ category: "observation", actor: "agent", text: "Late evidence", source: [address] }] })).results[0]).toMatch(/^rejected:/);
    }
    // Correct the rejected batch to zero facts: success covers only the exact frozen entries.
    input.reportRequest({ frozen: true });
    expect(JSON.parse(input.tools.find(t => t.name === "note")!.execute({ facts: [] })).results).toEqual([]);
    release();
    expect((await pending).outcome).toBe("success");
    expect(h.memory.store.getWatermark(1, "main")?.lastRecordedTurn).toBeNull();
    const after = h.memory.pendingEntries(1, "main", 1);
    expect(after.map(e => e.role)).toEqual(["toolResult", "assistant"]);
    expect(renderEntry(h.memory.store.getSourceEntry(before[1]!.id)!, h.memory.config.render).content).toBe(oldView);
    const audit = JSON.parse(h.memory.store.listRuns(1)[0]!.response!).entryAudit;
    expect(audit.entries.map((e: { id: number }) => e.id)).toEqual(before.map(e => e.id));
    expect(audit).toMatchObject({ branch: "main", viewVersion: "17a-v1-fixed-halves", viewBudgets: { toolCallTokens: 1000, entryTokens: 10000 } });
    await h.emit("session_start");
    expect(h.memory.pendingEntries(1, "main", 1)).toEqual(after);
    expect(h.memory.trace("T1#t1", { full: true })).toContain("late result");
    const next = TraceMemory(join(h.dir, "trace.db"), async raw => {
      const branchInput = raw as RecordingAgentInput;
      expect(branchInput.input).not.toContain("T1#user");
      expect(branchInput.input).toContain("late assistant");
      return { outcome: "success", output: "", request: {} };
    });
    try { expect((await next.record({ sessionId: 1, branch: "main", headTurnId: 1, mode: "branch" })).outcome).toBe("success"); }
    finally { next.close(); }
  } finally { release?.(); recorder.close(); await h.dispose(); }
});

test("17a 2026-09-08: Recording, fallback, compaction and carry supply identical bounded entry bytes", async () => {
  const h = host({ ...quiet, "recording.triggerAnsweredTurns": 1 });
  try {
    await h.prompt("HEAD " + "word ".repeat(30000) + " TAIL");
    await h.answer();
    const expected = h.memory.pendingEntries(1, "main", 1).map(e => renderEntry(e, h.memory.config.render).content);
    const compact = (await h.emit("session_before_compact", { preparation: { tokensBefore: 100000 } })).compaction.summary;
    const carry = h.memory.branchSummary(1, "main", 1);
    expect(rawOf(compact)).toBe(expected.join("\n\n"));
    expect(carry.split("Unrecorded raw:\n")[1]!.slice(0, -"\n</branch_carry>".length)).toBe(expected.join("\n"));
    expect(h.requests).toEqual([]); // summary preparation itself is a read; the tree-switch trigger belongs to 17b.
    let subagent!: string;
    const recorder = TraceMemory(join(h.dir, "trace.db"), async raw => {
      subagent = (raw as RecordingAgentInput).input;
      return { outcome: "failure", output: "leave entries pending", request: {} };
    });
    await recorder.record({ sessionId: 1, branch: "main", headTurnId: 1, mode: "subagent" }); recorder.close();
    expect(rawOf(subagent)).toBe(expected.join("\n\n"));
    await h.emit("agent_settled"); await h.drain(); // no captured prefix: the real host falls back
    const sent = h.conversations[0]!.messages[0]!.content as string;
    expect(rawOf(sent)).toBe(rawOf(subagent));
    expect(JSON.parse(h.memory.store.listRuns(1).at(-1)!.response!).fallbackReason).toBeTruthy();
    expect(expected.every(view => tokens(view) <= 10000)).toBe(true);
  } finally { await h.dispose(); }
});

test("17a 2026-09-08: compaction measures compressed tokens and preserves facts that fit beside excerpts", async () => {
  const h = host(quiet);
  try {
    await h.prompt("check"); await h.answer("observed");
    const tools = h.memory.tools({ kind: "manual", sessionId: 1, branch: "main", currentTurnId: 1 });
    tools[2]!.execute({ facts: [{ category: "observation", actor: "user", text: "A useful fact", source: ["T1#user"] }] });
    await h.emit("tool_result", { toolName: "read", input: { path: "large" }, content: [{ type: "text", text: "head " + "word ".repeat(60000) + " tail" }], isError: false });
    const entries = h.memory.pendingEntries(1, "main", 1);
    expect(tokens(entries.map(e => e.raw).join("\n\n"))).toBeGreaterThan(20000);
    expect(tokens(entries.map(e => renderEntry(e, h.memory.config.render).content).join("\n\n"))).toBeLessThan(20000);
    const block = h.memory.compact(1, "main", 1);
    expect(block.split("Recent facts (newest first):\n\n")[1]).toBe("[F1] " + h.memory.store.getTurn(1)!.startedAt + " [observation/user] A useful fact\n  source: T1#user\n</episodic>");
    let sent = "";
    const recording = TraceMemory(join(h.dir, "trace.db"), async raw => {
      sent = (raw as RecordingAgentInput).input;
      return { outcome: "failure", output: "leave pending", request: {} };
    });
    try { await recording.record({ sessionId: 1, branch: "main", headTurnId: 1, mode: "subagent" }); }
    finally { recording.close(); }
    expect(sent.split("Recent facts (newest first):\n\n")[1]!.split("\n\nRaw:")[0]).toBe(h.memory.trace("F1"));
  } finally { await h.dispose(); }
});

test("17a 2026-09-08: forks reuse shared identities and ordinals but native short ids in different lineages never collide", async () => {
  const h = host(quiet);
  const recorder = TraceMemory(join(h.dir, "trace.db"), async () => ({ outcome: "success", output: "", request: {} }));
  try {
    await h.prompt("same Turn");
    await h.emit("message_end", { message: { ...reply(""), content: [{ type: "toolCall", id: "one", name: "bash", arguments: { command: "first" } }] } });
    await h.emit("agent_end");
    const shared = [...h.entries];
    const initial = h.memory.pendingEntries(1, "main", 1);
    expect((await recorder.record({ sessionId: 1, branch: "main", headTurnId: 1 })).outcome).toBe("success");
    h.persist({ ...reply(""), content: [{ type: "toolCall", id: "two", name: "bash", arguments: { command: "original tail" } }] }, "collision");
    await h.emit("message_start", { message: reply("") });
    const original = h.memory.pendingEntries(1, "main", 1)[0]!;
    h.entries.splice(0, h.entries.length, ...shared); h.ctx.sessionManager.getSessionId = () => "fork-native-session";
    await h.emit("session_start");
    const branch = h.entries.filter(e => e.type === "custom").at(-1)!.data.branch;
    expect(h.memory.pendingEntries(1, branch, 1)).toEqual([]);
    h.persist({ ...reply(""), content: [{ type: "toolCall", id: "two", name: "bash", arguments: { command: "fork tail" } }] }, "collision");
    await h.emit("message_start", { message: reply("") });
    const fork = h.memory.pendingEntries(1, branch, 1)[0]!;
    const manual = h.memory.tools({ kind: "manual", sessionId: 1, branch, currentTurnId: 1 });
    expect(JSON.parse(manual[2]!.execute({ facts: [{ category: "observation", actor: "agent", text: "Sibling result", source: ["T1#t2"] }] })).results[0]).toMatch(/^rejected:/);
    expect([original.nativeId, fork.nativeId]).toEqual(["collision", "collision"]);
    expect(original.nativeLineage).not.toBe(fork.nativeLineage);
    expect([initial[1]!.calls[0]!.ordinal, original.calls[0]!.ordinal, fork.calls[0]!.ordinal]).toEqual([1, 2, 3]);
    await h.emit("session_start");
    const reopened = TraceMemory(join(h.dir, "trace.db"), async () => { throw new Error("read only"); });
    try {
      expect(reopened.pendingEntries(1, branch, 1)).toEqual([fork]);
      expect(reopened.trace("T1#t1", { full: true })).toContain('{"command":"first"}');
      expect(reopened.trace("T1#t2", { full: true })).toContain('{"command":"original tail"}');
      expect(reopened.trace("T1#t3", { full: true })).toContain('{"command":"fork tail"}');
    } finally { reopened.close(); }
  } finally { recorder.close(); await h.dispose(); }
});

test("17a 2026-09-08: shared-call fork results retain both originals through unrestricted full trace", async () => {
  const h = host(quiet);
  try {
    await h.prompt("check");
    await h.emit("message_end", { message: { ...reply(""), content: [{ type: "toolCall", id: "shared", name: "bash", arguments: { command: "check", timeout: 20 } }] } });
    await h.emit("agent_end");
    const shared = [...h.entries];
    await h.emit("tool_result", { toolCallId: "shared", toolName: "bash", input: {}, content: [{ type: "text", text: "RESULT A" }], isError: false });
    await h.emit("agent_end");
    h.entries.splice(0, h.entries.length, ...shared);
    await h.emit("session_tree"); // an earlier entry inside the same Turn must create a different path
    const branch = h.entries.filter(e => e.type === "custom").at(-1)!.data.branch;
    expect(branch).not.toBe("main");
    await h.emit("tool_result", { toolCallId: "shared", toolName: "bash", input: {}, content: [{ type: "text", text: "RESULT B" }], isError: true });
    const full = h.memory.trace("T1#t1", { full: true });
    expect(full).toContain('input:\n{"command":"check","timeout":20}');
    expect(full.match(/RESULT [AB]/g)).toEqual(["RESULT A", "RESULT B"]);
    expect(full).toMatch(/status=success[\s\S]*RESULT A[\s\S]*status=failure[\s\S]*RESULT B/);
    expect(h.memory.pendingEntries(1, branch, 1).flatMap(e => e.calls.map(c => c.result).filter(Boolean)).join("\n")).not.toContain("RESULT A");
  } finally { await h.dispose(); }
});

test("17a 2026-09-08: thinking-only reply remains answered for the existing trigger but is not a source", async () => {
  const h = host({ ...quiet, "recording.triggerAnsweredTurns": 1 });
  try {
    await h.prompt("question");
    await h.emit("message_end", { message: { ...reply(""), content: [{ type: "thinking", thinking: "private reasoning", thinkingSignature: "sig" }] } });
    await h.emit("agent_settled"); await h.drain();
    expect(h.conversations).toHaveLength(1);
    expect(h.memory.store.listSourceEntries(1).map(e => e.role)).toEqual(["user"]);
    expect(h.conversations[0]!.messages[0]!.content).not.toContain("private reasoning");
  } finally { await h.dispose(); }
});

test("17a 2026-09-08: huge native JSON arguments and results remain byte-exact through full trace", async () => {
  const h = host(quiet);
  try {
    await h.prompt("inspect original evidence");
    const args = { command: "HEAD" + "字".repeat(30000) + "TAIL", timeout: 42, env: { RAW: "unchanged" } };
    const message = { ...reply(""), content: [{ type: "toolCall", id: "huge", name: "bash", arguments: args }] };
    await h.emit("message_end", { message });
    await h.emit("message_start", { message: reply("") });
    const before = h.memory.pendingEntries(1, "main", 1).find(e => e.role === "assistant")!;
    const argumentView = renderEntry(before, h.memory.config.render).content;
    const content = [{ type: "text", text: "HEAD" + "z".repeat(200000) + "TAIL" }];
    const details = { exitCode: 0, retained: true };
    await h.emit("tool_result", { toolCallId: "huge", toolName: "bash", input: args, content, details, isError: false });
    expect(before.raw).toBe(JSON.stringify(message));
    expect(h.memory.trace("T1#t1", { full: true })).toBe(`[T1#t1] tool=bash status=success omitted=false\ninput:\n${JSON.stringify(args)}\nresult:\n${JSON.stringify({ content, details })}`);
    const result = h.memory.pendingEntries(1, "main", 1).find(e => e.role === "toolResult")!;
    expect(JSON.parse(result.raw)).toMatchObject({ content, details, toolCallId: "huge", toolName: "bash", isError: false });
    expect(renderEntry(h.memory.store.getSourceEntry(before.id)!, h.memory.config.render).content).toBe(argumentView);
    expect(tokens(argumentView.split("\n").slice(1).join("\n") + "\n" + renderEntry(result, h.memory.config.render).content.split("\n").slice(1).join("\n"))).toBeLessThanOrEqual(1000);
    expect(h.memory.compact(1, "main", 1)).not.toContain(JSON.stringify(args));
  } finally { await h.dispose(); }
});

test("17a acceptance 2026-09-08: streaming updates on an unchanged persisted leaf do not walk the ancestry again", async () => {
  const h = host(quiet);
  try {
    await h.prompt("question"); await h.answer("answer"); await h.emit("agent_settled"); await h.drain();
    await h.prompt("second");
    await h.emit("message_update", { message: reply("first delta") }); // the user entry is new: one walk creates the Turn
    const turns = h.memory.store.listTurns(1).length;
    const manager = h.ctx.sessionManager as { getBranch: () => unknown[] };
    const walks: number[] = []; const original = manager.getBranch;
    manager.getBranch = () => { walks.push(1); return original(); };
    for (let i = 0; i < 50; i++) await h.emit("message_update", { message: reply(`delta ${i}`) });
    manager.getBranch = original;
    expect(walks).toHaveLength(0); // 10 ms per update at 400 entries when this walked every time
    expect(h.memory.store.listTurns(1)).toHaveLength(turns);
    await h.answer("done"); await h.emit("agent_settled"); await h.drain();
    expect(h.memory.store.listSourceEntries(1).map(e => e.role)).toEqual(["user", "assistant", "user", "assistant"]); // the moved leaf is still reconciled
  } finally { await h.dispose(); }
});
