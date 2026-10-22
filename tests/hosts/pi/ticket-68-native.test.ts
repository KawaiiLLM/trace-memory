import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { runNative, type NativeTask } from "../../../src/hosts/pi/native.ts";
import { memoryReadTool } from "../../../src/hosts/pi/memory-files.ts";
import { memoryFiles } from "../../../src/core/api/index.ts";
import { broken, call, fixture, say, toolResults } from "./native-fixture.ts";

const nativeTask = (f: Awaited<ReturnType<typeof fixture>>, overrides: Partial<NativeTask> = {}): NativeTask => ({
  kind: "dreaming", runsDir: f.runsDir, cwd: f.h.dir, agentDir: f.agentDir, model: f.model as never,
  systemPrompt: "Offline native worker test.", task: "Complete the scripted task.", maxToolRounds: 0,
  read: memoryReadTool(f.h.dir, path => memoryFiles(f.h.memory, { projectId: f.h.memory.store.getSession(1)?.projectId }).read(path), { memoryOnly: true }),
  tools: [{ name: "search", description: "Read synthetic material", parameters: { type: "object", properties: {} }, execute: () => "synthetic material" }],
  onRequest: () => {}, onProgress: () => {}, ...overrides,
});

// The real Pi session and HTTP adapter run; the fixture replaces only fetch and uses a temporary HOME.
test("68: native Dreamer with an unlimited round count completes more than fifty tool rounds", async () => {
  const f = await fixture({ "noting.triggerTokens": 1e9 });
  try {
    let passEnds = 0, writes = 0;
    f.script(body => toolResults(body) < 55 ? call(`read-${toolResults(body)}`, "search", {}) : say("Finished."));
    const result = await runNative(nativeTask(f, {
      tools: [{ name: "search", description: "Read synthetic material", parameters: { type: "object", properties: {} }, execute: () => { writes++; return "synthetic material"; } }],
      passEnd: () => { passEnds++; return undefined; },
    }));
    expect(result.outcome).toBe("success");
    expect(writes).toBe(55);
    expect(result.calls).toHaveLength(55);
    expect(passEnds).toBe(1); // one stop check, after the 55 rounds
  } finally { await f.dispose(); }
});

test("Noter gets one fixed review at the exact tool-round cap; the second normal pass cannot open a third", async () => {
  const f = await fixture({ "noting.triggerTokens": 1e9 });
  try {
    let reviews = 0; const requests: unknown[] = [];
    let responses = 0;
    f.script(() => ++responses === 1 ? call("first", "search", {}) : say(responses === 2 ? "First pass done" : "Review done"));
    const result = await runNative(nativeTask(f, { kind: "noting", maxToolRounds: 1,
      passEnd: () => { reviews++; return "Your files do not pass the check"; },
      onRequest: body => { requests.push(body); } }));
    expect(result.outcome).toBe("success");
    expect(result.output, `requests=${requests.length} reviews=${reviews}`).toBe("Review done");
    expect(reviews).toBe(1);
    expect(requests).toHaveLength(3);
    expect(JSON.stringify(requests.at(-1))).toContain("Your files do not pass the check");
  } finally { await f.dispose(); }
});

test("Noter never sends its end review after a provider error or cancellation", async () => {
  const f = await fixture({ "noting.triggerTokens": 1e9 });
  try {
    let reviews = 0;
    f.script(() => broken());
    const task = nativeTask(f, { kind: "noting", passEnd: () => { reviews++; return "review"; } });
    expect((await runNative(task)).outcome).toBe("failure");
    const controller = new AbortController(); controller.abort();
    expect((await runNative({ ...task, signal: controller.signal })).outcome).toBe("cancelled");
    expect(reviews).toBe(0);
  } finally { await f.dispose(); }
});

test.each([0, 2])("68: native Pi retry.maxRetries=%i bounds retries and reports the native events", async maxRetries => {
  const f = await fixture({ "noting.triggerTokens": 1e9 });
  try {
    const file = join(f.agentDir, "settings.json"), previous = JSON.parse(readFileSync(file, "utf8"));
    // Delay remains native policy; shorten its native test setting, not any adapter timer.
    const configured = JSON.stringify({ ...previous, retry: { enabled: true, maxRetries, baseDelayMs: 1 } });
    writeFileSync(file, configured);
    const events: { attempt: number; maxAttempts: number; delayMs: number; error: string }[] = [];
    let attempts = 0, retryEnds = 0;
    f.script(() => { attempts++; return broken(); });
    const result = await runNative(nativeTask(f, { onRetry: event => events.push(event), onRetryEnd: () => { retryEnds++; } }));
    expect(result.outcome).toBe("failure");
    expect(attempts).toBe(1 + maxRetries);
    expect(events).toHaveLength(maxRetries);
    expect(result.retries.map(value => value.attempt)).toEqual(Array.from({ length: maxRetries }, (_, i) => i + 1));
    expect(events.every(value => value.maxAttempts === maxRetries && value.error.includes("provider exploded"))).toBe(true);
    expect(retryEnds).toBe(maxRetries ? 1 : 0);
    expect(readFileSync(file, "utf8")).toBe(configured);
  } finally { await f.dispose(); }
});

test("68: native Pi retry succeeds within the same worker and preserves retry accounting", async () => {
  const f = await fixture({ "noting.triggerTokens": 1e9 });
  try {
    const file = join(f.agentDir, "settings.json"), previous = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify({ ...previous, retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } }));
    let attempts = 0, ends = 0;
    f.script(() => ++attempts === 1 ? broken() : say("Recovered."));
    const result = await runNative(nativeTask(f, { onRetryEnd: () => { ends++; } }));
    expect(result.outcome).toBe("success");
    expect(result.output).toBe("Recovered.");
    expect(result.retries).toHaveLength(1);
    expect(attempts).toBe(2);
    expect(ends).toBe(1);
  } finally { await f.dispose(); }
});
