// The worker adapter's own boundary (maintainability finding 4): `runWorker` is handed a frozen
// task and a binding of values, and nothing else. These cases call it with no ExtensionContext and
// no host at all — the fixture only supplies an agent directory, a model and the stubbed wire — so
// they fail if the adapter ever reaches back into the host's session state. The mid-flight mutation
// below states the other half of the contract — the binding is read once, at launch — which is a
// structural property: the only place the adapter calls the runner twice (a fork that falls back)
// has no interleaving point, so nothing observable distinguishes it from the live reads it replaced.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { fixture, say } from "./native-fixture.ts";
import { runWorker, type WorkerBinding } from "../../../src/hosts/pi/worker.ts";
import type { NotingAgentInput, ToolDefinition } from "../../../src/core/api/index.ts";

const note = (): ToolDefinition => ({ name: "note", description: "Record facts.", parameters: { type: "object", properties: {} }, execute: () => "committed" });
/** One frozen core task, as the façade prepares it. */
const task = (mode: "fork" | "subagent"): NotingAgentInput => ({
  kind: "noting", mode, model: "fake/test", sessionId: 1, branch: "main",
  prompt: "You are the Noter.", text: { fresh: "note what happened", inherited: "the increment" },
  reportRequest: () => {}, reportProgress: () => {},
} as unknown as NotingAgentInput);

test("finding 4: a run is bound to the values it was handed, and a host change after launch does not reach it", async () => {
  const f = await fixture();
  try {
    const sent: any[] = [];
    let release = () => {};
    const held = new Promise<void>(resolve => { release = resolve; });
    f.script(async body => { sent.push(body); await held; return say("Done."); });
    const checked: unknown[] = [], reported: unknown[] = [];
    const binding: WorkerBinding = { model: f.model as never, checkCapacity: body => { checked.push(body); },
      tools: [note()], runsDir: f.runsDir, cwd: f.h.dir, agentDir: f.agentDir, maxToolRounds: 0,
      onCache: () => {}, onRetry: () => {}, onRetryEnd: () => {}, onFallback: () => {} };
    const frozen = { ...task("subagent"), reportRequest: (body: unknown) => { reported.push(body); } };
    const run = runWorker(frozen, binding);
    await vi.waitFor(() => expect(sent.length).toBe(1));
    // The host moves on while the child is still in flight: a new runs directory, no tools, no model.
    binding.runsDir = join(f.h.dir, "elsewhere"); binding.tools = []; binding.model = undefined;
    release();
    const result = await run;
    expect(result.outcome).toBe("success");
    expect(result.output).toBe("Done.");
    expect(result.mode).toBe("subagent");
    expect(sent[0].tools.map((t: any) => t.function.name)).toEqual(["note"]); // the list handed in at launch
    expect(String(result.nativeLog).startsWith(f.runsDir)).toBe(true);        // the directory handed in at launch
    expect(existsSync(join(f.h.dir, "elsewhere"))).toBe(false);
    expect(reported).toEqual([result.request]);
    expect(checked).toEqual([result.request]); // the capacity check saw every body before it left
  } finally { await f.dispose(); }
});

test("finding 4: the host's fork refusal arrives as a value, and the run continues as a fresh child with that reason", async () => {
  const f = await fixture();
  try {
    f.script(async () => say("Done."));
    const fallbacks: string[] = [];
    const result = await runWorker(task("fork"), { model: f.model as never, checkCapacity: () => {},
      tools: [note()], runsDir: f.runsDir, cwd: f.h.dir, agentDir: f.agentDir, maxToolRounds: 0,
      fork: { refused: "No current-branch provider payload captured" },
      onCache: () => {}, onRetry: () => {}, onRetryEnd: () => {}, onFallback: reason => fallbacks.push(reason) });
    expect(result.outcome).toBe("success");
    expect(result.mode).toBe("subagent");
    expect(result.fallbackReason).toBe("native runner: No current-branch provider payload captured");
    expect(fallbacks).toEqual(["native runner: No current-branch provider payload captured"]);
  } finally { await f.dispose(); }
});
