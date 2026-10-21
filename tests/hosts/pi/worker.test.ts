// The worker adapter's own boundary (maintainability finding 4): `runWorker` is handed a frozen
// task and a binding of values, and nothing else. These cases call it with no ExtensionContext and
// no host at all — the fixture only supplies an agent directory, a model and the stubbed wire — so
// they fail if the adapter ever reaches back into the host's session state. The mid-flight mutation
// below states the other half of the contract — the binding is read once, at launch.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { fixture, say } from "./native-fixture.ts";
import { runWorker, type WorkerBinding } from "../../../src/hosts/pi/worker.ts";
import { memoryReadTool } from "../../../src/hosts/pi/memory-files.ts";
import { memoryFiles } from "../../../src/core/api/index.ts";
import type { NotingAgentInput, ToolDefinition } from "../../../src/core/api/index.ts";

const read = (f: Awaited<ReturnType<typeof fixture>>) => memoryReadTool(f.h.dir,
  path => memoryFiles(f.h.memory, {}).read(path), { memoryOnly: true });
const note = (): ToolDefinition => ({ name: "note", description: "Record facts.", parameters: { type: "object", properties: {} }, execute: () => "committed" });
/** One frozen core task, as the façade prepares it. */
const task = (): NotingAgentInput => ({
  kind: "noting", model: "fake/test", sessionId: 1, branch: "main", entryIds: [7, 8],
  prompt: "You are the Noter.", text: "note what happened",
  reportRequest: () => {}, reportProgress: () => {},
} as unknown as NotingAgentInput);

test("finding 4: a run is bound to the values it was handed, and a host change after launch does not reach it", async () => {
  const f = await fixture();
  try {
    const sent: any[] = [];
    let release = () => {};
    const held = new Promise<void>(resolve => { release = resolve; });
    f.script(async body => { sent.push(body); await held; return say("Done."); });
    const checked: (number | undefined)[] = [], reported: unknown[] = [];
    const binding: WorkerBinding = { model: f.model as never, checkCapacity: contextTokens => { checked.push(contextTokens); },
      tools: [note()], read: read(f), runsDir: f.runsDir, cwd: f.h.dir, agentDir: f.agentDir, maxToolRounds: 0,
      onRetry: () => {}, onRetryEnd: () => {} };
    const frozen = { ...task(), reportRequest: (body: unknown) => { reported.push(body); } };
    const run = runWorker(frozen, binding);
    await vi.waitFor(() => expect(sent.length).toBe(1));
    // The host moves on while the child is still in flight: a new runs directory, no tools, no model.
    binding.runsDir = join(f.h.dir, "elsewhere"); binding.tools = []; binding.model = undefined;
    release();
    const result = await run;
    expect(result.outcome).toBe("success");
    expect(result.output).toBe("Done.");
    expect(sent[0].tools.map((t: any) => t.function.name).sort()).toEqual(["note", "read"]); // frozen note and restricted Read, not the later binding
    expect(String(result.nativeLog).startsWith(f.runsDir)).toBe(true);        // the directory handed in at launch
    expect(existsSync(join(f.h.dir, "elsewhere"))).toBe(false);
    expect(reported).toEqual([result.request]);
    // 27a: the last check is handed Pi's measure of the child's own context, once per outgoing body and
    // before it leaves — never the body, so it can read no provider shape. One body left, one measure.
    expect(checked).toHaveLength(1);
    expect(checked[0]).toBeTypeOf("number");
    expect(checked[0] as number).toBeGreaterThan(0);
  } finally { await f.dispose(); }
});
