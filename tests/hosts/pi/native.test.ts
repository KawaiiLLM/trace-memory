import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { addUsage, placeholderUsage, runNative } from "../../../src/hosts/pi/native.ts";
import { memoryReadTool } from "../../../src/hosts/pi/memory-files.ts";
import { memoryFiles, toolDefinitions } from "../../../src/core/api/index.ts";
import { broken, call, noterTurn, fixture, noteBatch, say, settled, sse, submitted, toolResults, usage, worker, type Body } from "./native-fixture.ts";

test("92: native Noter writes optional relations without NEAR feedback", async () => {
  const f = await fixture({ "noting.triggerTokens": 1 });
  try {
    f.script(body => {
      if (!worker(body)) return say("好的。");
      const prior = f.h.memory.store.listSessionFacts(1).length; // the first batch publishes after its verify task
      return noterTurn(body, prior ? { ...noteBatch, sources: noteBatch.sources.replace("[T1#E1]", "[T2#E1]"), caused_by: [["F1", "strong"]] } : noteBatch);
    });
    await f.turn();
    await vi.waitFor(() => expect(f.h.memory.store.listSessionFacts(1)).toHaveLength(1));
    await f.turn();
    await vi.waitFor(() => expect(f.h.memory.store.listSessionFacts(1)).toHaveLength(2));
    expect(f.sent.filter(body => worker(body)).some(body => (body.messages ?? []).some((message: Body) =>
      message.role === "user" && JSON.stringify(message.content).includes("System-generated review guidance")))).toBe(false);
    expect(f.h.memory.store.listFactRelations(2)).toContainEqual({ fromFact: 2, toFact: 1, kind: "caused_by", strength: "strong" });
  } finally { await f.dispose(); }
});

test.each(["noting", "dreaming"] as const)("117/125: native %s gets no end review after a length stop and the truncated run stays a failure", async kind => {
  const f = await fixture({ "noting.triggerTokens": 1e9 });
  try {
    f.script(body => !worker(body, kind === "noting" ? "Noting" : "Dreaming") ? say("Parent ready.")
      : JSON.stringify(body.messages).includes("Host followup") ? say("Reviewed.")
      : sse([{ id: "c", object: "chat.completion.chunk", created: 1, model: "test",
        choices: [{ index: 0, delta: { role: "assistant", content: "Truncated." }, finish_reason: "length" }], usage: usage() }]));
    await f.turn();
    const passEnd = vi.fn(() => "Host followup");
    const result = await runNative(f.task({ kind, task: `${kind === "noting" ? "Noting (facts and knowledge)" : "Dreaming (knowledge extraction)"} material`, passEnd }));
    expect(passEnd).toHaveBeenCalledTimes(kind === "dreaming" ? 1 : 0); // the Dreamer still reports its rounds
    expect(f.sent.filter(body => worker(body, kind === "noting" ? "Noting" : "Dreaming") &&
      JSON.stringify(body.messages).includes("Host followup"))).toHaveLength(0);
    expect(result.outcome).toBe("failure");
  } finally { await f.dispose(); }
});

// ------------------------------------- checkbox 3: real writes through native tool execution
test("19a 2026-09-08: a Noting run publishes the files its child wrote through native tool execution", async () => {
  const f = await fixture();
  try {
    f.script(body => !worker(body) ? say("好的。") : noterTurn(body, noteBatch));
    await f.turn();
    const run = await settled(f);
    expect(run.outcome).toBe("success");
    expect(JSON.parse(run.response!).output).toBe("Done.");
    expect(JSON.parse(run.response!).toolCalls.map((c: Body) => c.name)).toEqual(["check"]);
    const facts = f.h.memory.store.listSessionFacts(1);
    expect(facts.map(fact => fact.text)).toEqual(["用 pnpm，不要 npm"]);
    expect(f.h.memory.store.sourcePath(1, "main", 1).every(e => f.h.memory.store.entryNoted(e.id))).toBe(true);
  } finally { await f.dispose(); }
});

test("19a 2026-09-08: a source entry outside the frozen range fails the child's files although the child copied it", async () => {
  const f = await fixture();
  try {
    f.script(body => !worker(body) ? say("好的。")
      : noterTurn(body, { ...noteBatch, sources: noteBatch.sources.replace("[T1#E1]", "[T9#E1]") }));
    await f.turn();
    const run = await settled(f);
    expect(f.h.memory.store.listSessionFacts(1)).toEqual([]);
    const response = JSON.parse(run.response!);
    expect(response.problems.join(" ")).toContain("invalid source");
    expect(run.outcome).toBe("failure");
  } finally { await f.dispose(); }
});

test("19a/92: a provider error after the child wrote both files publishes nothing and records the problem", async () => {
  const f = await fixture();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  try {
    f.script(async body => {
      if (!worker(body)) return say("Done.");
      if (!submitted(body)) return noterTurn(body, noteBatch);
      await held;
      return broken();
    });
    await f.turn();
    await vi.waitFor(() => expect(f.sent.filter(body => worker(body)).some(body => submitted(body))).toBe(true));
    expect(f.h.memory.store.listSessionFacts(1)).toEqual([]);
    expect(f.h.memory.store.sourcePath(1, "main", 1).every(e => !f.h.memory.store.entryNoted(e.id))).toBe(true);
    release();
    const run = await settled(f);
    expect(f.h.memory.store.listSessionFacts(1)).toEqual([]);
    expect(run.outcome).toBe("failure");
    expect(JSON.parse(run.response!).problems.join(" ")).toContain("provider exploded");
  } finally { release(); await f.dispose(); }
});

test("19a/118: restricted Read denies non-trace:// paths while only authorized tools execute in call order", async () => {
  const f = await fixture({ "noting.triggerTokens": 1000000000 });
  try {
    f.script(() => say("好的。"));
    await f.turn();
    const calls = [{ index: 0, id: "a", type: "function", function: { name: "read", arguments: JSON.stringify({ path: "/etc/passwd" }) } },
      { index: 1, id: "b", type: "function", function: { name: "search", arguments: JSON.stringify({ query: "synthetic" }) } }];
    f.script((body, index) => index === 0 ? say("好的。") : index === 1 ? sse([{ id: "c", object: "chat.completion.chunk", created: 1, model: "test",
      choices: [{ index: 0, delta: { role: "assistant", tool_calls: calls }, finish_reason: "tool_calls" }], usage: usage() }]) : say("Done."));
    const executed: string[] = [];
    const result = await runNative(f.task({ tools: [{ name: "search", description: "", parameters: {}, execute: () => { executed.push("search"); return "found"; } }] }));
    expect(result.calls).toEqual([{ name: "read", executed: true }, { name: "search", executed: true }]);
    expect(executed).toEqual(["search"]); // the foreground tool never ran
    const results = f.sent.at(-1)!.messages.filter((m: Body) => m.role === "tool");
    expect(results.map((m: Body) => m.tool_call_id)).toEqual(["a", "b"]); // sequential, in call order
    expect(String(results[0].content)).toContain("restricted to trace://");
    expect(String(results[1].content)).toBe("found");
  } finally { await f.dispose(); }
});

// ------------------------------------------------------- checkbox 5: usage, checkbox 6: cache
test("19a 2026-09-08: usage counts the child's new responses only, including a failed attempt", async () => {
  const f = await fixture();
  try {
    let attempt = 0;
    f.script(body => !worker(body) ? say("好的。", usage(777, 555))
      : body.messages?.some((m: Body) => m.role === "tool") ? say("Done.", usage(30, 4))
      : attempt++ === 0 ? broken() : noterTurn(body, noteBatch, usage(20, 3)));
    await f.turn();
    const run = await settled(f);
    const response = JSON.parse(run.response!);
    expect(response.retries).toEqual([{ attempt: 1, error: expect.any(String) }]);
    // 20 from the note round, 30 from the terminal reply and 30 from the end review (117): this child's
    // three responses; the parent's 777 is not in the total.
    expect(response.usage.input).toBe(80);
    expect(response.usage.output).toBe(11);
    expect(f.h.memory.spend(1).input).toBe(80);
  } finally { await f.dispose(); }
});

test("19a 2026-09-08: a cancelled child without reported usage records unknown, not zero", async () => {
  const f = await fixture();
  try {
    f.script(() => say("好的。"));
    await f.turn();
    const controller = new AbortController();
    controller.abort();
    const result = await runNative(f.task({ signal: controller.signal }));
    expect(result.outcome).toBe("cancelled");
    expect(result.usage).toBeUndefined();
  } finally { await f.dispose(); }
});

// ------------------------------------------ 19b: subagent parity on the same native runner
test("a native subagent gets its bound tools, confined file tools and Bash without a legacy loop", async () => {
  const f = await fixture();
  try {
    f.script(body => !worker(body) ? say("好的。") : noterTurn(body, noteBatch));
    await f.turn();
    const run = await settled(f);
    expect(run.mode).toBe("subagent");
    expect(run.outcome).toBe("success");
    const response = JSON.parse(run.response!);
    expect(response.requestedMode).toBe("subagent");
    expect(response.verification).toBeUndefined(); // no parent body to reproduce, so no gate
    // Ticket 152 adds native Bash to the fresh child's existing tool set.
    const child = f.sent[1]!;
    expect(child.messages[0].role).toBe("system");
    expect(String(child.messages[0].content)).toContain("Noting (facts and knowledge)");
    expect(child.tools.map((t: Body) => t.function.name)).toEqual(["search", "check", "read", "write", "edit", "bash"]);
    expect(String(JSON.stringify(child.messages[1]))).toContain("Raw:"); // the full fresh-context material
    // Its own private session in the runs directory.
    const log = response.nativeLog as string;
    expect(log.startsWith(`${f.runsDir}/`)).toBe(true);
    expect(readFileSync(log, "utf8")).not.toContain('"customType":"trace-memory"');
    expect(readFileSync(f.original.file, "utf8")).toContain('"customType":"trace-memory"');
    expect(f.manager().getSessionId()).toBe(f.original.id);
    // No legacy custom tool loop ran: the request-copy runner would have gone through the registry.
    expect(f.h.conversations).toEqual([]);
    expect(f.h.memory.store.listSessionFacts(1).map(fact => fact.text)).toEqual(["用 pnpm，不要 npm"]);
  } finally { await f.dispose(); }
});

test("19b 2026-09-08: the fresh child activates no inherited extension", async () => {
  const f = await fixture();
  const marker = join(f.h.dir, "extension-loaded");
  try {
    // A global Pi extension the child would discover if resource discovery were on.
    mkdirSync(join(f.agentDir, "extensions"), { recursive: true });
    writeFileSync(join(f.agentDir, "extensions", "probe.js"),
      `import { writeFileSync } from "node:fs";\nexport default function (pi) { writeFileSync(${JSON.stringify(marker)}, "loaded"); pi.registerTool({ name: "probe", label: "probe", description: "probe", parameters: {}, execute: async () => ({ content: [], details: {} }) }); }\n`);
    f.script(body => !worker(body) ? say("好的。") : noterTurn(body, noteBatch));
    await f.turn();
    const run = await settled(f);
    expect(run.outcome).toBe("success");
    expect(existsSync(marker)).toBe(false); // the extension was never loaded, so it never ran
    expect(f.sent[1]!.tools.map((t: Body) => t.function.name)).toEqual(["search", "check", "read", "write", "edit", "bash"]);
    expect(f.h.memory.store.listRuns(1)).toHaveLength(4);
  } finally { await f.dispose(); }
});

// ------------------------------------------------- 19c: cancellation into the child AgentSession
test("19c 2026-09-08: cancelling one native child disposes only that child; a sibling worker and the parent session continue", async () => {
  const f = await fixture({ "noting.triggerTokens": 1000000000 }); // this test drives both children itself
  try {
    f.script(() => say("好的。"));
    await f.turn();
    const parentBytes = readFileSync(f.original.file), parentLeaf = f.manager().getLeafId();
    const controller = new AbortController();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    f.script(async (body: Body) => { if (JSON.stringify(body).includes("child A")) { await held; return say("A finished"); } return say("B done."); });
    const a = runNative(f.task({ task: "child A: note what happened", signal: controller.signal }));
    const b = await runNative(f.task({ task: "child B: note what happened" }));
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

test("19c/92: /trace stop cancels the child after staging without publication or fresh extraction", async () => {
  const f = await fixture();
  let release: () => void = () => {};
  try {
    const held = new Promise<void>(resolve => { release = resolve; });
    f.script(async (body: Body) => !worker(body) ? say("好的。")
      : submitted(body) ? (await held, say("Done.")) : noterTurn(body, noteBatch));
    await f.turn();
    // Both files are written; the child is waiting for the normal terminal reply when the user stops.
    await vi.waitFor(() => expect(f.sent.filter(body => worker(body)).some(body => submitted(body))).toBe(true));
    expect(f.h.memory.store.listSessionFacts(1)).toEqual([]);
    const parentLeaf = f.manager().getLeafId(), parentBytes = readFileSync(f.original.file);
    await f.h.commands.get("trace").handler("stop", f.h.ctx);
    release();
    const run = await settled(f);
    expect(run.outcome).toBe("cancelled");
    expect(run.mode).toBe("subagent");
    expect(f.h.memory.store.listRuns(1)).toHaveLength(1); // stopping never re-extracts
    expect(f.h.memory.store.listSessionFacts(1)).toEqual([]);
    expect(f.h.memory.store.sourcePath(1, "main", 1).every(e => !f.h.memory.store.entryNoted(e.id))).toBe(true);
    expect(f.manager().getSessionId()).toBe(f.original.id);
    expect(f.manager().getLeafId()).toBe(parentLeaf);
    expect(readFileSync(f.original.file)).toEqual(parentBytes);
    await f.h.emit("message_start", { message: { role: "user", content: "next", timestamp: 1 } });
    await f.h.drain();
    expect(f.h.memory.store.listRuns(1)).toHaveLength(1);
  } finally { release(); await f.dispose(); }
}, 20000);

test("27b 2026-09-10 (amendment 1): the memory child runs with Pi's automatic compaction off, and the user's own settings are untouched", async () => {
  // The user's settings ask for automatic compaction, with a recent-token budget small enough that
  // Pi really has something to compact. Without the child's in-memory override, Pi answers the
  // overflow below by deleting the failed reply, paying for a native summary and retrying — two
  // provider requests, a `compaction` entry in the worker log, and no overflow to classify. (Measured
  // on this fixture: with the override removed the child sends 2 requests and writes that entry; with it, 1 and none.)
  const OVERFLOW = "prompt is too long: 213462 tokens > 200000 maximum";
  const f = await fixture({ compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 1 } });
  try {
    f.script(body => worker(body) ? new Response(JSON.stringify({ error: { message: OVERFLOW } }), { status: 400, headers: { "content-type": "application/json" } }) : say("好的。"));
    await f.turn();
    const before = f.sent.length;
    const result = await runNative(f.task({
      tools: toolDefinitions.map(t => ({ ...t, execute: () => "committed" })),
      task: "# Noting (facts and knowledge)\n\nnote what happened",
    }));
    expect(result.outcome).toBe("failure");
    expect(result.output).toContain(OVERFLOW);
    expect(f.sent.length - before).toBe(1); // no summarization call was paid for
    expect(readFileSync(result.nativeLog!, "utf8")).not.toContain('"type":"compaction"');
    // In memory only: the user's settings file still says what it said, and a manager built over the
    // same directories still reads it.
    const settings = JSON.parse(readFileSync(`${f.agentDir}/settings.json`, "utf8"));
    expect(settings.compaction).toEqual({ enabled: true, keepRecentTokens: 1, reserveTokens: 1 });
    expect(SettingsManager.create(f.h.dir, f.agentDir).getCompactionSettings()).toEqual({ enabled: true, keepRecentTokens: 1, reserveTokens: 1 });
  } finally { await f.dispose(); }
}, 30000);

test("19c 2026-09-08: the child's retry policy is Pi's own, read from settings.json by SettingsManager", async () => {
  // Gate 6: the adapter keeps no retry settings of its own. `retry.maxRetries` in the agent
  // directory's settings.json is the only thing deciding how often a failing provider is retried.
  const f = await fixture({ retry: { maxRetries: 2, baseDelayMs: 1 } });
  try {
    f.script(body => !worker(body) ? say("好的。") : broken());
    await f.turn();
    const run = await settled(f);
    expect(run.outcome).toBe("failure");
    const response = JSON.parse(run.response!);
    expect(response.retries.map((r: { attempt: number }) => r.attempt)).toEqual([1, 2]);
    expect(response.retries.every((r: { error: string }) => r.error.includes("provider exploded"))).toBe(true);
    expect(f.sent.filter(body => worker(body))).toHaveLength(3); // the first attempt plus two retries
    expect(f.h.notices.filter(n => n.includes("noting retry"))).toEqual([
      expect.stringContaining("retry 1/2"), expect.stringContaining("retry 2/2")]);
    expect(f.h.memory.store.listSessionFacts(1)).toEqual([]); // nothing committed, nothing advanced
  } finally { await f.dispose(); }
}, 20000);

test("review 2026-09-08: provider retries never spend the tool-round cap; the cap counts model turns that call tools", async () => {
  const f = await fixture({ "noting.maxToolRounds": 3, retry: { maxRetries: 3, baseDelayMs: 1 } }); // check, then one file per step: three rounds
  try {
    let attempt = 0;
    f.script(body => !worker(body) ? say("好的。") : attempt++ < 2 ? broken() : noterTurn(body, noteBatch));
    await f.turn();
    const run = await settled(f);
    // Two failed attempts, then the write task's three tool rounds within the cap and its two stops, then the verify task's three requests.
    expect(run.outcome).toBe("success");
    expect(f.h.memory.store.listSessionFacts(1).map(fact => fact.text)).toEqual(["用 pnpm，不要 npm"]);
    expect(f.sent.filter(body => worker(body))).toHaveLength(14);
    expect(JSON.stringify(f.sent.filter(body => worker(body)).at(-1)!.messages)).not.toContain("Your files do not pass the check"); // the files pass, so no repair
    expect(JSON.parse(run.response!).retries).toHaveLength(2);
  } finally { await f.dispose(); }
}, 20000);

test("review 2026-09-08: the tool-round cap still fails the round over it before its tools run", async () => {
  const f = await fixture({ "noting.maxToolRounds": 1 });
  try {
    let traces = 0;
    f.script(body => !worker(body) ? say("好的。") : call(`t${++traces}`, "read", { path: "trace://raw/S1/T1" }));
    await f.turn();
    const run = await settled(f);
    expect(run.outcome).toBe("failure");
    expect(JSON.parse(run.response!).output).toContain("tool rounds exceeded (1)");
    expect(f.sent.filter(body => worker(body))).toHaveLength(2); // the first round ran its tool; the second was over the cap
    expect(f.h.memory.store.listSessionFacts(1)).toEqual([]);
  } finally { await f.dispose(); }
}, 20000);

test("review 2026-09-08: a child cancelled before any usage arrived reports unknown usage, not zero", async () => {
  const f = await fixture({ "noting.triggerTokens": 1e9 });
  let release = () => {};
  try {
    f.script(() => say("好的。"));
    await f.turn();
    const controller = new AbortController();
    let sent = false;
    const held = new Promise<void>(resolve => { release = resolve; });
    f.script(async () => { sent = true; await held; throw new DOMException("Cancelled before usage arrived", "AbortError"); });
    const task = runNative(f.task({ signal: controller.signal }));
    await vi.waitFor(() => expect(sent).toBe(true));
    controller.abort(); release();
    const result = await task;
    expect(result.outcome).toBe("cancelled");
    expect(result.usage).toBeUndefined(); // the SDK's placeholder zeros are not reported usage
    expect(placeholderUsage({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } })).toBe(true);
    expect(placeholderUsage({ input: 5, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 5 })).toBe(false); // really reported partial usage still counts
  } finally { release(); await f.dispose(); }
}, 20000);

test("review 2026-09-08: a failed response's partial tool call never spends a tool round; the retried complete call is the first round", async () => {
  const f = await fixture({ "noting.maxToolRounds": 3, retry: { maxRetries: 2, baseDelayMs: 1 } });
  try {
    let attempt = 0;
    f.script(body => {
      if (!worker(body)) return say("好的。");
      if (attempt++ === 0) {
        // A partial `note` call streams out, then the connection dies before the tool could run.
        const data = { id: "c", object: "chat.completion.chunk", created: 1, model: "test", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "partial", type: "function", function: { name: "check", arguments: "{" } }] }, finish_reason: null }] };
        return new Response(new ReadableStream({ start(controller) {
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`));
          setTimeout(() => controller.error(new Error("Connection error.")), 15);
        } }), { headers: { "content-type": "text/event-stream" } });
      }
      return noterTurn(body, noteBatch);
    });
    await f.turn();
    const run = await settled(f);
    expect(run.outcome).toBe("success");
    expect(JSON.parse(run.response!).retries).toHaveLength(1);
    expect(f.h.memory.store.listSessionFacts(1).map(fact => fact.text)).toEqual(["用 pnpm，不要 npm"]);
  } finally { await f.dispose(); }
}, 20000);

// ---------------------------------------------------------------- review 2026-09-10 (ebdfe35..ba94941) P2
test("review 2026-09-10 P2: the child's thinking pair is reported through progress as soon as the child exists, before any request", async () => {
  const f = await fixture({ "noting.triggerTokens": 1e9 });
  try {
    const tools = [{ name: "search" as const, description: "Synthetic tool", parameters: { type: "object", properties: {} }, execute: () => "ok" }];
    const events: string[] = [];
    let first: { thinking?: { requested?: string; effective: string } } | undefined;
    await runNative({ kind: "noting", model: f.model as never, cwd: f.h.dir, agentDir: f.agentDir, runsDir: f.runsDir,
      systemPrompt: "Test", task: "Reply OK", tools,
      read: memoryReadTool(f.h.dir, path => memoryFiles(f.h.memory, {}).read(path), { memoryOnly: true }),
      maxToolRounds: 0, thinkingLevel: "low",
      onRequest: () => { events.push("request"); },
      onProgress: state => { if (!first) { first = state; events.push("progress"); } } });
    // A run the host force-cancels at its cleanup deadline is built from the last progress report, so
    // the level the child was really sent at must be known there and not only with the final result.
    expect(events.slice(0, 2)).toEqual(["progress", "request"]);
    expect(first?.thinking?.requested).toBe("low");
    expect(typeof first?.thinking?.effective).toBe("string");
  } finally { await f.dispose(); }
}, 20000);

test("27d repair 5 (review 2026-09-10): usage accumulates over the union of both operands' keys", () => {
  // A counter only one response reports is kept: a cross-model fallback used to drop `reasoning` and
  // `cacheWrite1h` the moment the other model omitted them, which is metadata loss, not an unknown.
  expect(addUsage({ input: 10, reasoning: 7, cacheWrite1h: 20 }, { input: 5 })).toEqual({ input: 15, reasoning: 7, cacheWrite1h: 20 });
  expect(addUsage({ input: 5 }, { input: 10, reasoning: 7 })).toEqual({ input: 15, reasoning: 7 });
  expect(addUsage({ cost: { input: 1 } }, { cost: { output: 2 } })).toEqual({ cost: { input: 1, output: 2 } }); // nested counters too
  expect(addUsage(undefined, { input: 3 })).toEqual({ input: 3 });
  expect(addUsage({ input: 3 }, undefined)).toEqual({ input: 3 }); // an unreported response adds nothing
});
