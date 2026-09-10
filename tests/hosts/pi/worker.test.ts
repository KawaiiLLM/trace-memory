// The worker adapter's own boundary (maintainability finding 4): `runWorker` is handed a frozen
// task and a binding of values, and nothing else. These cases call it with no ExtensionContext and
// no host at all — the fixture only supplies an agent directory, a model and the stubbed wire — so
// they fail if the adapter ever reaches back into the host's session state. The mid-flight mutation
// below states the other half of the contract — the binding is read once, at launch. 27c: the
// adapter never calls the runner twice any more; a fork it cannot run comes back to the host as a
// refusal, and the host admits the task once more (tests/hosts/pi/fallback.test.ts).
import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { fixture, say } from "./native-fixture.ts";
import { runWorker, type WorkerBinding } from "../../../src/hosts/pi/worker.ts";
import type { NotingAgentInput, ToolDefinition } from "../../../src/core/api/index.ts";

const note = (): ToolDefinition => ({ name: "note", description: "Record facts.", parameters: { type: "object", properties: {} }, execute: () => "committed" });
/** One frozen core task, as the façade prepares it. */
const task = (mode: "fork" | "subagent"): NotingAgentInput => ({
  kind: "noting", mode, model: "fake/test", sessionId: 1, branch: "main", entryIds: [7, 8],
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
    const checked: (number | undefined)[] = [], reported: unknown[] = [];
    const binding: WorkerBinding = { model: f.model as never, checkCapacity: contextTokens => { checked.push(contextTokens); },
      tools: [note()], runsDir: f.runsDir, cwd: f.h.dir, agentDir: f.agentDir, maxToolRounds: 0,
      onCache: () => {}, onRetry: () => {}, onRetryEnd: () => {} };
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
    // 27a: the last check is handed Pi's measure of the child's own context, once per outgoing body and
    // before it leaves — never the body, so it can read no provider shape. One body left, one measure.
    expect(checked).toHaveLength(1);
    expect(checked[0]).toBeTypeOf("number");
    expect(checked[0] as number).toBeGreaterThan(0);
  } finally { await f.dispose(); }
});

test("27c: the host's fork refusal arrives as a value, and the run comes back to the host as a refusal", async () => {
  const f = await fixture();
  try {
    f.script(async () => say("Done."));
    const before = f.sent.length;
    const result = await runWorker(task("fork"), { model: f.model as never, checkCapacity: () => {},
      tools: [note()], runsDir: f.runsDir, cwd: f.h.dir, agentDir: f.agentDir, maxToolRounds: 0,
      fork: { refused: "No current-branch provider payload captured" },
      onCache: () => {}, onRetry: () => {}, onRetryEnd: () => {} });
    // 27c: the adapter runs the task in the mode it was admitted for, and no other. The refusal names
    // the reason for the audit and the frozen batch the host must re-admit on; nothing was sent, so it
    // carries no gate result, and no fresh child ran here on the frozen model.
    // 27d: the batch is the exact entry ids, never an upper bound; the refusal carries no usage and
    // no retries at all, because an attempt that spent something is its own run record.
    expect(result.refused).toEqual({ reason: "native runner: No current-branch provider payload captured", boundary: { entryIds: [7, 8] } });
    expect(result.request).toBeNull(); // which is how core tells an attempt from a refusal that never left
    expect(f.sent.length).toBe(before);
  } finally { await f.dispose(); }
});

test("27c: a task admitted with a reason runs fresh and records it — the launch is not offered a fork", async () => {
  const f = await fixture();
  try {
    f.script(async () => say("Done."));
    const result = await runWorker({ ...task("fork"), fallbackReason: "pre-compaction evidence: 2 selected entries precede the persisted compaction e5" } as NotingAgentInput,
      { model: f.model as never, checkCapacity: () => {},
        tools: [note()], runsDir: f.runsDir, cwd: f.h.dir, agentDir: f.agentDir, maxToolRounds: 0,
        onCache: () => {}, onRetry: () => {}, onRetryEnd: () => {} });
    expect(result.outcome).toBe("success");
    expect(result.mode).toBe("subagent");
    expect(result.refused).toBeUndefined();
    expect(result.fallbackReason).toBe("pre-compaction evidence: 2 selected entries precede the persisted compaction e5");
  } finally { await f.dispose(); }
});
