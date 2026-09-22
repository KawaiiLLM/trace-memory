import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { runNative, type NativeSubagentTask } from "../../../src/hosts/pi/native.ts";
import { broken, call, fixture, say, toolResults } from "./native-fixture.ts";

const nativeTask = (f: Awaited<ReturnType<typeof fixture>>, overrides: Partial<NativeSubagentTask> = {}): NativeSubagentTask => ({
  mode: "subagent", runsDir: f.runsDir, cwd: f.h.dir, agentDir: f.agentDir, model: f.model as never,
  systemPrompt: "Offline native worker test.", task: "Complete the scripted task.", maxToolRounds: 0,
  tools: [{ name: "trace", description: "Read synthetic material", parameters: { type: "object", properties: {} }, execute: () => "synthetic material" }],
  onRequest: () => {}, onProgress: () => {}, ...overrides,
});

// The real Pi session and HTTP adapter run; the fixture replaces only fetch and uses a temporary HOME.
test("68: native Dreamer with an unlimited round count completes more than fifty tool rounds", async () => {
  const f = await fixture({ "noting.triggerTokens": 1e9 });
  try {
    const observed: number[] = [], passes: number[] = [];
    let writes = 0;
    f.script(body => toolResults(body) < 55 ? call(`read-${toolResults(body)}`, "trace", {}) : say("Finished."));
    const result = await runNative(nativeTask(f, {
      tools: [{ name: "trace", description: "Read synthetic material", parameters: { type: "object", properties: {} }, execute: () => { writes++; return "synthetic material"; } }],
      reportRounds: rounds => observed.push(rounds), passEnd: rounds => { passes.push(rounds); return undefined; },
    }));
    expect(result.outcome).toBe("success");
    expect(writes).toBe(55);
    expect(result.calls).toHaveLength(55);
    expect(observed.at(-1)).toBe(55);
    expect(passes).toEqual([55]);
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
