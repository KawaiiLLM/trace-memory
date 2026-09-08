import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { hash, messageKey, verifyForkRequest, verifyNativeRequest } from "./branch.ts";
import { runNative } from "./native.ts";
import { recorded } from "../../test/source-fixture.ts";
import { broken, call, fixture, memoryBatch, noteBatch, say, settled, sse, toolResults, usage, worker, type Body } from "./native-fixture.ts";

// ---------------------------------------------------------------- checkbox 1: the gate
test("19a 2026-09-08: the native child's first request passes prefix verification against the captured parent request", async () => {
  const f = await fixture();
  try {
    f.script(body => !worker(body) ? say("好的。") : toolResults(body) ? say("Done.") : call("t1", "note", noteBatch));
    await f.turn();
    const run = await settled(f);
    const response = JSON.parse(run.response!);
    expect(response.verification.differingPath, JSON.stringify(response.verification)).toBe(null);
    expect(response.verification.passed).toBe(true);
    expect(run.mode).toBe("branch");
    // Both hashes are recorded, and they are the hashes of the two real bodies.
    expect(response.verification.capturedHash).toBe(hash(f.sent[0]));
    expect(response.verification.requestHash).toBe(hash(f.sent[1]));
    expect(JSON.parse(run.request!)).toEqual(f.sent[1]);
    // The production Noter prompt and the production tool definitions really went out.
    expect(String(JSON.stringify(f.sent[1]!.messages.at(-1)))).toContain("Noting (fact extraction)");
    expect(f.sent[1]!.tools.map((t: Body) => t.function.name)).toEqual(["read", "trace", "search", "note", "memory"]);
    expect(f.sent[1]!.tools).toEqual(f.sent[0]!.tools);
    // The gate, recomputed here over the same two bodies with nothing excluded from the comparison.
    const key = messageKey("openai-completions");
    const gate = verifyNativeRequest(f.sent[0]!, f.sent[1]!, "openai-completions", f.sent[1]![key].slice(f.sent[0]![key].length));
    expect(gate.passed).toBe(true);
    expect(gate.appendedMessages).toHaveLength(2); // the head assistant reply, then the task
    expect(JSON.stringify(gate.appendedMessages.at(-1))).toContain("Noting (fact extraction)");
  } finally { await f.dispose(); }
});

test("19a ruling 2026-09-08: the anthropic-messages child passes the gate with cache_control stripped from both sides and nothing else", async () => {
  const f = await fixture({}, "fakeanthropic");
  const anthropic = (events: Body[]) => new Response(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  const reply = (text: string) => anthropic([
    { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "test", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } },
    { type: "message_stop" }]);
  try {
    f.script(() => reply("好的。"));
    await f.turn();
    const run = await settled(f);
    const response = JSON.parse(run.response!);
    // The child really sent its request: the run is native branch mode, verified, with no fallback.
    expect(run.mode).toBe("branch");
    expect(response.fallbackReason).toBeUndefined();
    expect(response.verification.passed).toBe(true);
    expect(response.verification.differingPath).toBe(null);
    expect(response.verification.normalized).toEqual(["cache_control"]);
    expect(response.verification.capturedHash).toBe(hash(f.sent[0]));
    expect(response.verification.requestHash).toBe(hash(f.sent[1]));
    expect(JSON.parse(run.request!)).toEqual(f.sent[1]);
    // The raw bodies do differ, and only at the adapter-placed cache breakpoint: the parent's
    // marker sits on the message the child inherited, the child's on its appended task message.
    const key = messageKey("anthropic-messages");
    const raw = verifyNativeRequest(f.sent[0]!, f.sent[1]!, "anthropic-messages", f.sent[1]![key].slice(f.sent[0]![key].length));
    expect(raw.passed).toBe(false);
    expect(raw.differingPath).toMatch(/^\$\.messages\.\d+\.content\.\d+\.cache_control$/);
    expect(JSON.stringify(f.sent[1]![key].at(-1))).toContain("cache_control");
    expect(verifyForkRequest(f.sent[0]!, f.sent[1]!, "anthropic-messages").passed).toBe(true);
    expect(run.outcome).toBe("success");
  } finally { await f.dispose(); }
});

// ------------------------------------------- checkbox 2: parent preserved, private child log
test("19a 2026-09-08: a child run leaves the parent file, id and tree position byte-identical and logs under the runs directory", async () => {
  const f = await fixture();
  try {
    f.script(body => !worker(body) ? say("好的。") : toolResults(body) ? say("Done.") : call("t1", "note", noteBatch));
    const captured = await f.turn();
    const run = await settled(f);
    // The foreground manager still points at its own file and id after a whole native run.
    expect(f.manager().getSessionId()).toBe(f.original.id);
    expect(f.manager().getSessionFile()).toBe(f.original.file);
    const parentFile = f.manager().getSessionFile()!;
    const before = readFileSync(parentFile), id = f.manager().getSessionId(), leaf = f.manager().getLeafId();
    const first = JSON.parse(run.response!).nativeLog as string;
    expect(first).toBe(join(f.h.dir, "runs", id, `${first.split("/").at(-1)}`)); // dirname(dbPath)/runs/<parent id>/
    expect(statSync(first).isFile()).toBe(true);
    // A second child on the same parent: still no mutation, and its own id and file.
    const second = await runNative(f.task(captured));
    expect(readFileSync(parentFile)).toEqual(before);
    expect(f.manager().getSessionId()).toBe(id);
    expect(f.manager().getLeafId()).toBe(leaf);
    expect(second.nativeLog).not.toBe(first);
    const logs = readdirSync(join(f.h.dir, "runs", id));
    expect(logs).toHaveLength(2);
    expect(new Set(logs.map(name => name.split("_").at(-1)))).not.toContain(`${id}.jsonl`);
    // The foreground session list scans Pi's sessions directory; the children are not in it.
    expect(readdirSync(f.sessionsDir)).toEqual([parentFile.split("/").at(-1)]);
    expect((await SessionManager.list(f.h.dir, f.sessionsDir)).map(s => s.id)).toEqual([id]);
  } finally { await f.dispose(); }
});

test("19a 2026-09-08: the child copies the selected ancestry only, not a sibling branch", async () => {
  const f = await fixture();
  try {
    f.script(() => say("好的。"));
    const captured = await f.turn();
    const selected = f.manager().getLeafId()!;
    // A sibling branch on the same parent file: an abandoned edit of the same user message.
    f.manager().branch(f.manager().getBranch(selected)[0]!.id);
    f.manager().appendMessage({ role: "user", content: "sibling branch prompt", timestamp: Date.now() } as never);
    const sibling = f.manager().getLeafId()!;
    f.manager().branch(selected);
    const result = await runNative(f.task(captured, { checkpoint: selected }));
    const child = readFileSync(result.nativeLog!, "utf8");
    expect(child).not.toContain("sibling branch prompt");
    expect(child).not.toContain(sibling);
    expect(child).toContain("用 pnpm，不要 npm");
  } finally { await f.dispose(); }
});

// ------------------------------------- checkbox 3: real writes through native tool execution
test("19a 2026-09-08: a Noting write commits through native tool execution", async () => {
  const f = await fixture();
  try {
    f.script(body => !worker(body) ? say("好的。") : toolResults(body) ? say("Noted.") : call("t1", "note", noteBatch));
    await f.turn();
    const run = await settled(f);
    expect(run.outcome).toBe("success");
    expect(JSON.parse(run.response!).output).toBe("Noted.");
    expect(JSON.parse(run.response!).toolCalls.map((c: Body) => c.name)).toEqual(["note"]);
    const facts = f.h.memory.store.listSessionFacts(1);
    expect(facts.map(fact => fact.text)).toEqual(["用 pnpm，不要 npm"]);
    expect(f.h.memory.store.sourcePath(1, "main", 1).every(e => f.h.memory.store.entryNoted(e.id))).toBe(true);
  } finally { await f.dispose(); }
});

test("19a 2026-09-08: a source entry outside the frozen range is rejected although the child copied it", async () => {
  const f = await fixture();
  try {
    f.script(body => !worker(body) ? say("好的。") : toolResults(body) ? say("Done.")
      : call("t1", "note", { facts: [{ ...noteBatch.facts[0], source: ["T9#user"] }] }));
    await f.turn();
    const run = await settled(f);
    expect(f.h.memory.store.listSessionFacts(1)).toEqual([]);
    const response = JSON.parse(run.response!);
    expect(String(response.toolCalls[0].result)).toContain("rejected:");
    expect(run.outcome).toBe("bounced");
  } finally { await f.dispose(); }
});

test("19a 2026-09-08: a provider error after the commit keeps the commit and records the problem", async () => {
  const f = await fixture();
  try {
    f.script(body => !worker(body) ? say("好的。") : toolResults(body) ? broken() : call("t1", "note", noteBatch));
    await f.turn();
    const run = await settled(f);
    expect(f.h.memory.store.listSessionFacts(1).map(fact => fact.text)).toEqual(["用 pnpm，不要 npm"]);
    expect(run.outcome).toBe("success");
    expect(JSON.parse(run.response!).problems.join(" ")).toContain("provider failed after commit");
  } finally { await f.dispose(); }
});

test("19a 2026-09-08: Consolidation's two submissions and its review round run natively", async () => {
  const f = await fixture({ "noting.triggerTokens": 1000000000, "consolidation.triggerUnconsolidatedFacts": 1, "consolidation.subagentModeDefault": false });
  try {
    f.script(body => !worker(body, "Consolidation") ? say("好的。")
      : toolResults(body) >= 2 ? say("Integrated.") : call(`t${toolResults(body)}`, "memory", memoryBatch));
    await f.turn();
    f.h.memory.tools({ kind: "manual", sessionId: 1, branch: "main", currentTurnId: 1 })
      .find(t => t.name === "note")!.execute({ facts: [{ category: "decision", actor: "user", text: "Use pnpm", source: ["T1#user"] }] });
    recorded(f.h.memory, 1, "main", 1); // T1 recorded: F1 may enter the Consolidation batch
    await f.turn("tick"); // a second real parent turn is the opportunity that admits the phase
    const run = await settled(f, "consolidation");
    expect(run.outcome, run.response ?? "").toBe("success");
    const response = JSON.parse(run.response!);
    expect(response.toolCalls).toHaveLength(2); // candidate, then the answered resubmission
    expect(response.output).toBe("Integrated.");
    // The review feedback reached the child as a native user message before its second submission.
    const review = f.sent.at(-2)!.messages.filter((m: Body) => m.role === "user").at(-1);
    expect(JSON.stringify(review)).toContain("NEAR:");
  } finally { await f.dispose(); }
});

// ------------------------- checkbox 4: copied custom state, tool whitelist, sequential execution
test("19a 2026-09-08: copied plugin custom state activates no extension and starts no worker", async () => {
  const f = await fixture();
  try {
    f.script(body => !worker(body) ? say("好的。") : toolResults(body) ? say("Done.") : call("t1", "note", noteBatch));
    await f.turn();
    const run = await settled(f);
    const child = readFileSync(JSON.parse(run.response!).nativeLog, "utf8");
    expect(child).toContain('"customType":"trace-memory"'); // the foreground's own state came along
    // ... and nothing acted on it: one run, no second worker, and the child's tools are the
    // parent's definitions, not a set an extension registered inside the child.
    expect(f.h.memory.store.listRuns(1)).toHaveLength(1);
    expect(f.sent[1]!.tools.map((t: Body) => t.function.name)).toEqual(["read", "trace", "search", "note", "memory"]);
    expect(readdirSync(join(f.h.dir, "runs", f.manager().getSessionId()))).toHaveLength(1);
  } finally { await f.dispose(); }
});

test("19a 2026-09-08: only the memory tools execute; other copied tools are rejected in call order", async () => {
  const f = await fixture({ "noting.triggerTokens": 1000000000 });
  try {
    f.script(() => say("好的。"));
    const captured = await f.turn();
    const calls = [{ index: 0, id: "a", type: "function", function: { name: "read", arguments: JSON.stringify({ path: "/etc/passwd" }) } },
      { index: 1, id: "b", type: "function", function: { name: "trace", arguments: JSON.stringify({ address: "S1/T1" }) } }];
    f.script(body => worker(body) || toolResults(body) === 0 && JSON.stringify(body).includes("note what happened") ? sse([{ id: "c", object: "chat.completion.chunk", created: 1, model: "test",
      choices: [{ index: 0, delta: { role: "assistant", tool_calls: calls }, finish_reason: "tool_calls" }], usage: usage() }]) : say("Done."));
    const executed: string[] = [];
    const result = await runNative(f.task(captured, { tools: [{ name: "trace", description: "", parameters: {}, execute: () => { executed.push("trace"); return "traced"; } }] }));
    expect(result.calls).toEqual([{ name: "read", executed: false }, { name: "trace", executed: true }]);
    expect(executed).toEqual(["trace"]); // the foreground tool never ran
    const results = f.sent.at(-1)!.messages.filter((m: Body) => m.role === "tool");
    expect(results.map((m: Body) => m.tool_call_id)).toEqual(["a", "b"]); // sequential, in call order
    expect(String(results[0].content)).toContain("not available to a Trace Memory worker");
    expect(String(results[1].content)).toContain("traced");
  } finally { await f.dispose(); }
});

// ------------------------------------------------------- checkbox 5: usage, checkbox 6: cache
test("19a 2026-09-08: usage counts the child's new responses only, including a failed attempt", async () => {
  const f = await fixture();
  try {
    let attempt = 0;
    f.script(body => !worker(body) ? say("好的。", usage(777, 555))
      : body.messages?.some((m: Body) => m.role === "tool") ? say("Done.", usage(30, 4))
      : attempt++ === 0 ? broken() : call("t1", "note", noteBatch, usage(20, 3)));
    await f.turn();
    const run = await settled(f);
    const response = JSON.parse(run.response!);
    expect(response.retries).toEqual([{ attempt: 1, error: expect.any(String) }]);
    // 20 + 30 from this child's two responses; the copied parent's 777 is not in the total.
    expect(response.usage.input).toBe(50);
    expect(response.usage.output).toBe(7);
    expect(f.h.memory.spend(1).input).toBe(50);
  } finally { await f.dispose(); }
});

test("19a 2026-09-08: a cancelled child without reported usage records unknown, not zero", async () => {
  const f = await fixture();
  try {
    f.script(() => say("好的。"));
    const captured = await f.turn();
    const controller = new AbortController();
    controller.abort();
    const result = await runNative(f.task(captured, { signal: controller.signal }));
    expect(result.outcome).toBe("cancelled");
    expect(result.usage).toBeUndefined();
  } finally { await f.dispose(); }
});

test("19a 2026-09-08: each child response's reported cache read is recorded as an observation", async () => {
  const f = await fixture();
  try {
    f.script(body => !worker(body) ? say("好的。") : toolResults(body) ? say("Done.", usage(30, 4, 0))
      : call("t1", "note", noteBatch, usage(20, 3, 12)));
    await f.turn();
    const run = await settled(f);
    const response = JSON.parse(run.response!);
    // Recorded, never required: the run's outcome does not depend on this number.
    expect(response.verification.cache_read).toBe(12);
    expect(response.usage.cacheRead).toBe(12);
    expect(run.outcome).toBe("success");
  } finally { await f.dispose(); }
});

// ------------------------------------------ 19b: subagent parity on the same native runner
test("19b 2026-09-08: an explicit subagent task runs in a fresh native child with only the memory tools and no legacy loop", async () => {
  const f = await fixture({ "noting.branchModeDefault": false });
  try {
    f.script(body => !worker(body) ? say("好的。") : toolResults(body) ? say("Done.") : call("t1", "note", noteBatch));
    await f.turn();
    const run = await settled(f);
    expect(run.mode).toBe("subagent");
    expect(run.outcome).toBe("success");
    const response = JSON.parse(run.response!);
    expect(response.requestedMode).toBe("subagent");
    expect(response.verification).toBeUndefined(); // no parent body to reproduce, so no gate
    // The fresh child: core's domain prompt as its system prompt and only the four memory tools.
    const child = f.sent[1]!;
    expect(child.messages[0].role).toBe("system");
    expect(String(child.messages[0].content)).toContain("Noting (fact extraction)");
    expect(child.tools.map((t: Body) => t.function.name)).toEqual(["trace", "search", "note", "memory"]);
    expect(String(JSON.stringify(child.messages[1]))).toContain("Raw:"); // the full fresh-context material
    // Its own private session in the runs directory, not a fork of the parent file.
    const log = response.nativeLog as string;
    expect(log.startsWith(join(f.h.dir, "runs", f.manager().getSessionId()))).toBe(true);
    expect(readFileSync(log, "utf8")).not.toContain('"customType":"trace-memory"');
    expect(readFileSync(f.original.file, "utf8")).toContain('"customType":"trace-memory"');
    expect(f.manager().getSessionId()).toBe(f.original.id);
    // No legacy custom tool loop ran: the request-copy runner would have gone through the registry.
    expect(f.h.conversations).toEqual([]);
    expect(f.h.memory.store.listSessionFacts(1).map(fact => fact.text)).toEqual(["用 pnpm，不要 npm"]);
  } finally { await f.dispose(); }
});

test("19b 2026-09-08: an unforkable branch task falls back to the native subagent and records requested and actual mode", async () => {
  const f = await fixture();
  try {
    f.script(body => !worker(body) ? say("好的。") : toolResults(body) ? say("Done.") : call("t1", "note", noteBatch));
    await f.turn("用 pnpm，不要 npm", { capture: false }); // no captured parent body: the fork cannot be prepared
    const run = await settled(f);
    expect(run.mode).toBe("subagent");
    const response = JSON.parse(run.response!);
    expect(response.requestedMode).toBe("branch");
    expect(response.fallbackReason).toContain("native runner: No current-branch provider payload captured");
    expect(response.nativeLog).toBeTruthy();
    expect(f.h.conversations).toEqual([]); // the request-copy runner did not serve the fallback
    expect(f.h.memory.store.listSessionFacts(1).map(fact => fact.text)).toEqual(["用 pnpm，不要 npm"]);
    expect(f.h.notices.join("\n")).toContain("fell back to subagent mode");
  } finally { await f.dispose(); }
});

test("19b 2026-09-08: the fresh child activates no inherited extension", async () => {
  const f = await fixture({ "noting.branchModeDefault": false });
  const marker = join(f.h.dir, "extension-loaded");
  try {
    // A global Pi extension the child would discover if resource discovery were on.
    mkdirSync(join(f.agentDir, "extensions"), { recursive: true });
    writeFileSync(join(f.agentDir, "extensions", "probe.js"),
      `import { writeFileSync } from "node:fs";\nexport default function (pi) { writeFileSync(${JSON.stringify(marker)}, "loaded"); pi.registerTool({ name: "probe", label: "probe", description: "probe", parameters: {}, execute: async () => ({ content: [], details: {} }) }); }\n`);
    f.script(body => !worker(body) ? say("好的。") : toolResults(body) ? say("Done.") : call("t1", "note", noteBatch));
    await f.turn();
    const run = await settled(f);
    expect(run.outcome).toBe("success");
    expect(existsSync(marker)).toBe(false); // the extension was never loaded, so it never ran
    expect(f.sent[1]!.tools.map((t: Body) => t.function.name)).toEqual(["trace", "search", "note", "memory"]);
    expect(f.h.memory.store.listRuns(1)).toHaveLength(1); // and started no second worker
  } finally { await f.dispose(); }
});

test("19b 2026-09-08: Consolidation's two submissions and its review round run in the fresh child", async () => {
  const f = await fixture({ "noting.triggerTokens": 1000000000, "consolidation.triggerUnconsolidatedFacts": 1 });
  try {
    f.script(body => !worker(body, "Consolidation") ? say("好的。")
      : toolResults(body) >= 2 ? say("Integrated.") : call(`t${toolResults(body)}`, "memory", memoryBatch));
    await f.turn();
    f.h.memory.tools({ kind: "manual", sessionId: 1, branch: "main", currentTurnId: 1 })
      .find(t => t.name === "note")!.execute({ facts: [{ category: "decision", actor: "user", text: "Use pnpm", source: ["T1#user"] }] });
    recorded(f.h.memory, 1, "main", 1);
    await f.turn("tick");
    const run = await settled(f, "consolidation");
    expect(run.mode).toBe("subagent");
    expect(run.outcome, run.response ?? "").toBe("success");
    const response = JSON.parse(run.response!);
    expect(response.toolCalls).toHaveLength(2); // candidate, then the answered resubmission
    expect(response.output).toBe("Integrated.");
    // Core's review guidance reached the fresh child as a user message before its second submission.
    const review = f.sent.at(-2)!.messages.filter((m: Body) => m.role === "user").at(-1);
    expect(JSON.stringify(review)).toContain("NEAR:");
    expect(f.h.conversations).toEqual([]);
  } finally { await f.dispose(); }
});

// ------------------------------------------------- 19c: cancellation into the child AgentSession
test("19c 2026-09-08: cancelling one native child disposes only that child; a sibling worker and the parent session continue", async () => {
  const f = await fixture({ "noting.triggerTokens": 1000000000 }); // this test drives both children itself
  try {
    f.script(() => say("好的。"));
    const captured = await f.turn();
    const parentBytes = readFileSync(f.original.file), parentLeaf = f.manager().getLeafId();
    const controller = new AbortController();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    f.script(async (body: Body) => { if (JSON.stringify(body).includes("child A")) { await held; return say("A finished"); } return say("B done."); });
    const a = runNative(f.task(captured, { task: "child A: note what happened", signal: controller.signal }));
    const b = await runNative(f.task(captured, { task: "child B: note what happened" }));
    controller.abort(); // only A's task signal
    release();
    const cancelled = await a;
    expect(cancelled.outcome).toBe("cancelled");
    expect(b.outcome).toBe("success"); // the sibling worker ran to completion untouched
    expect(b.output).toBe("B done.");
    expect(cancelled.nativeLog).not.toBe(b.nativeLog);
    // The parent session: same file bytes, same id, same tree position, and still usable.
    expect(readFileSync(f.original.file)).toEqual(parentBytes);
    expect(f.manager().getSessionId()).toBe(f.original.id);
    expect(f.manager().getLeafId()).toBe(parentLeaf);
    f.script(() => say("still here."));
    await f.parent.prompt("and the foreground continues");
    expect(f.manager().getSessionId()).toBe(f.original.id);
    expect(readFileSync(f.original.file).length).toBeGreaterThan(parentBytes.length);
  } finally { await f.dispose(); }
}, 20000);

test("19c 2026-09-08: /trace stop cancels the running child after its commit and starts no fresh extraction", async () => {
  const f = await fixture();
  let release: () => void = () => {};
  try {
    const held = new Promise<void>(resolve => { release = resolve; });
    f.script(async (body: Body) => !worker(body) ? say("好的。")
      : toolResults(body) ? (await held, say("Done.")) : call("t1", "note", noteBatch));
    await f.turn();
    // The batch is committed; the child is waiting for its trailing reply when the user stops.
    await vi.waitFor(() => expect(f.h.memory.store.listSessionFacts(1)).toHaveLength(1), { timeout: 5000 });
    const parentLeaf = f.manager().getLeafId(), parentBytes = readFileSync(f.original.file);
    await f.h.commands.get("trace").handler("stop", f.h.ctx);
    release();
    // Wait for the run record the run itself completed, not the one its commit created.
    const run = await vi.waitFor(() => { const r = f.h.memory.store.listRuns(1)[0]!; expect(JSON.parse(r.response ?? "{}").problems?.length).toBeTruthy(); return r; }, { timeout: 5000 });
    expect(run.outcome).toBe("success"); // a committed batch is never turned into a failure
    expect(run.mode).toBe("branch");
    expect(JSON.parse(run.response!).problems.join(" ")).toContain("cancelled after commit");
    expect(f.h.memory.store.listRuns(1)).toHaveLength(1); // no re-extraction because the reply died
    expect(f.h.memory.store.listSessionFacts(1)).toHaveLength(1);
    expect(f.manager().getSessionId()).toBe(f.original.id);
    expect(f.manager().getLeafId()).toBe(parentLeaf);
    expect(readFileSync(f.original.file)).toEqual(parentBytes);
    await f.h.emit("message_start", { message: { role: "user", content: "next", timestamp: 1 } });
    await f.h.drain();
    expect(f.h.memory.store.listRuns(1)).toHaveLength(1);
  } finally { release(); await f.dispose(); }
}, 20000);
