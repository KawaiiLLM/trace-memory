// 19b: the adapter's layout of core's frozen material. Core supplies parts and composes nothing, so
// the byte-level rulings about what each execution mode sends are pinned here, on the adapter's own
// composition module, not on a core message string.
import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TraceMemory, type ConsolidationAgentInput, type NotingAgentInput, type RunAgentResult } from "../../test/source-fixture.ts";
import { composeMaterial, composeTask } from "./compose.ts";

let directory: string, memory: ReturnType<typeof TraceMemory>, calls: (NotingAgentInput | ConsolidationAgentInput)[];
const time = "2026-09-06T00:00:00Z";
const ok = (): RunAgentResult => ({ outcome: "success", output: "[]", request: { fake: true } });

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "trace-memory-compose-"));
  calls = [];
  memory = TraceMemory(join(directory, "test.sqlite"), async raw => { calls.push(raw as NotingAgentInput); return ok(); });
});
afterEach(() => { memory.close(); rmSync(directory, { recursive: true, force: true }); });

function session() {
  const project = memory.store.createProject({ name: "p", declaredBy: "mark" });
  const s = memory.store.createSession({ enrollmentChoice: true, host: "fake", startedAt: time, firstReplyAt: time, projectId: project.id });
  const t = memory.store.appendTurn({ sessionId: s.id, kind: "turn", userPrompt: "用 pnpm，不要 npm", assistantText: "好的。", startedAt: time });
  memory.store.appendToolCall({ turnId: t.id, name: "Bash", input: JSON.stringify({ command: "pnpm install" }), result: JSON.stringify({ stdout: "done", stderr: "" }), status: "success" });
  return { s, t };
}

test("19b 2026-09-08 for ruling 08:53: the adapter composes the inherited-context Noting message from the range, head reply and source index alone", async () => {
  const { s, t } = session();
  await memory.noting({ sessionId: s.id, branch: "main", headTurnId: t.id, mode: "branch" });
  const input = calls[0]! as NotingAgentInput;
  expect(composeMaterial(input, "branch")).toBe(`Range: S${s.id}/T${t.id}..S${s.id}/T${t.id}\n\n[Source entry id: T${t.id}#assistant]\n好的。\n\nSources:\nT${t.id}#user 用 pnpm，不要 npm | T${t.id}#assistant 好的。 | T${t.id}#t1 tool=Bash {"command":"pnpm install"}`);
  // The raw, the delivered facts and the injected knowledge are already in that conversation.
  const inherited = composeMaterial(input, "branch");
  expect(inherited).not.toContain("Raw:");
  expect(inherited).not.toContain("Active knowledge:");
  expect(inherited).not.toContain("Recent facts");
  // The fork has no system slot of its own: the instructions ride in the appended user message.
  const composed = composeTask(input, "branch");
  expect(composed.systemPrompt).toBeUndefined();
  expect(composed.message).toBe(`${input.prompt}\n\n${inherited}`);
});

test("19b 2026-09-08 for ruling 08:53: the same material composes the full fresh-context Noting message", async () => {
  const { s, t } = session();
  await memory.noting({ sessionId: s.id, branch: "main", headTurnId: t.id, mode: "subagent" });
  const input = calls[0]! as NotingAgentInput;
  const fresh = composeMaterial(input, "subagent");
  expect(fresh.startsWith(`Range: S${s.id}/T${t.id}..S${s.id}/T${t.id}\n\nActive knowledge:`)).toBe(true);
  expect(fresh).toContain("Recent facts (newest first):");
  expect(fresh.split("Raw:\n\n")[1]).toBe(input.material.entries.map(entry => entry.view).join("\n\n"));
  expect(fresh).toContain("用 pnpm，不要 npm");
  const composed = composeTask(input, "subagent");
  expect(composed.systemPrompt).toBe(input.prompt);
  expect(composed.message).toBe(fresh);
});

test("19b 2026-09-08 for ruling 08:53: an inherited-context Consolidation message carries the exact fact list, not the fact lines", async () => {
  const { s, t } = session();
  memory.tools({ kind: "manual", sessionId: s.id, branch: "main", currentTurnId: t.id })
    .find(tool => tool.name === "note")!.execute({ facts: [{ category: "decision", actor: "user", text: "Use pnpm", source: [`T${t.id}#user`] }] });
  await memory.consolidate({ sessionId: s.id, branch: "main", mode: "branch" });
  const input = calls[0]! as ConsolidationAgentInput;
  expect(composeMaterial(input, "branch")).toBe(`Range: F1..F1\n\nFacts to integrate: F1\n\nNegated-evidence reminder (review cues only; no status derived):\nnone`);
  const fresh = composeMaterial(input, "subagent");
  expect(fresh).toContain("Active knowledge:");
  expect(fresh).toContain("Range facts:");
  expect(fresh).toContain(memory.trace("F1"));
  expect(composeMaterial(input, "branch")).not.toContain("Range facts:");
});
