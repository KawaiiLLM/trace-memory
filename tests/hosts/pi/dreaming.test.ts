import { expect, test, vi } from "vitest";
import type { JsonObject } from "@earendil-works/pi-ai";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import { host, reply, emptyNote, dreamerFiles, type Reply } from "./test-host.ts";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../../src/core/store/index.ts";
import { knowledge, legacyFacts } from "../../support/seed.ts";
import { block } from "../../support/workspace.ts";

const call = (id: string, name: string, args: unknown): Reply => ({ ...reply(""), stopReason: "toolUse", content: [{ type: "toolCall", id, name, arguments: args as JsonObject }] });
const isDreamer = (systemPrompt: string | undefined) => !!systemPrompt && (systemPrompt.startsWith("# Dreamer") || systemPrompt.startsWith("# Classifying"));
/** A session with one Noter-written constraint: only Noter changes make a Dreamer due (stage 4, 2026-10-22). */
async function seeded(config: Record<string, unknown> = {}, text = "Keep the user constraint") {
  const h = host({ "noting.triggerTokens": 1000000, "dreaming.triggerOperations": 1, ...config });
  await h.emit("session_start"); await h.turn();
  const store = h.memory.store;
  const user = store.sourcePath(1, "main", 1).find(value => store.getSourceEntry(value.id)?.role === "user")!;
  const evidence = legacyFacts(store, { kind: "manual", sessionId: 1, createdAt: "now" },
    [{ sources: [{ entry: user, address: `T1#E${user.entryOrdinal}` }], text,
      category: "decision", actor: "user", createdAt: "now" }]).facts[0]!;
  const path = store.knowledgePath(1);
  const created = knowledge(store, path, "project", "constraint", [evidence.id], text, { operation: { title: "Fixture title" } });
  const item = { ...created, heading: `K${created.knowledgeId}@v1` };
  const pool = `project:${store.getSession(1)!.projectId}`;
  expect(store.dreamingDue(path, 1)).toBe(true);
  return { h, store, item, pool };
}
/** curate's batch for the seeded item: a tidied body. */
const tidy = (item: { heading: string }) => block(`update ${item.heading}`, { reason: "tidy" }, "Keep the user constraint, tidied");
const terminal = async (h: ReturnType<typeof host>) => vi.waitFor(() => {
  const run = h.memory.store.listRuns(1).find(r => r.kind === "dreaming" && JSON.parse(r.response ?? "{}").check);
  expect(run).toBeTruthy(); return run!;
}, { timeout: 5000 });
const dreamingRuns = (store: Store) => store.listRuns(1).filter(r => r.kind === "dreaming");
const processedIn = (store: Store, pool: string, revisionId: number) => !!store.db.prepare(
  "SELECT 1 FROM knowledge_processed WHERE pool = ? AND revision_id = ?").get(pool, revisionId);

test("Dreamer pre-request capacity failure names its own phase and retains its work", async () => {
  const { h, store, item, pool } = await seeded();
  const measure = vi.spyOn(AgentSession.prototype, "getContextUsage").mockReturnValue({ tokens: 200_000, contextWindow: 200_000, percent: 100 });
  try {
    await h.turn(); await h.drain();
    const runs = dreamingRuns(store).filter(run => run.outcome === "failure");
    expect(runs[0]!.outcome).toBe("failure");
    expect(runs[0]!.response).toContain("Dreamer capacity: the child's context");
    expect(runs[0]!.response).not.toContain("Consolidation capacity");
    expect(h.requests).toEqual([]);
    expect(processedIn(store, pool, item.commit)).toBe(false);
    expect(store.getClaim(1, "dreaming")).toBeNull();
    expect(store.handoff(1, "dreaming")).not.toBeNull(); // the work is kept for the next trigger
    expect(store.taskFailures(1)).toMatchObject([{ phase: "dreaming", count: 1 }]); // 146: one failure is counted, and one leaves memory on
    expect(store.enabled(1)).toBe(true);
  } finally { measure.mockRestore(); await h.dispose(); }
});

test("156: Pi notes, grouped curate and in-conversation scoring use the frozen Dreamer model or foreground default", async () => {
  for (const [config, model, thinking] of [
    [{ "dreaming.model": "fake/test-thinking", "dreaming.thinking": "high" }, "fake/test-thinking", "high"],
    [{}, "fake/test", "off"],
  ] as const) {
    const { h, store } = await seeded(config);
    try {
      const seen: string[] = [];
      h.provider(async c => { seen.push(JSON.stringify(c.messages)); return dreamerFiles(c) ?? reply("Done"); }, { autoStop: false });
      await h.turn(); await h.drain();
      const runs = dreamingRuns(store).filter(run => run.request !== null);
      expect(runs.every(run => run.model === model)).toBe(true);
      expect(runs.every(run => JSON.parse(run.response!).thinking.requested === thinking)).toBe(true);
      expect(seen.some(text => text.includes("Task: scoring") && text.includes("Task: curate"))).toBe(true);
      expect(store.noterOperations(store.knowledgePath(1))).toBe(0);
    } finally { await h.dispose(); }
  }
});

test("the /trace notice area shows the Dreamer's latest failure while memory stays on", async () => {
  const { h, store } = await seeded();
  const measure = vi.spyOn(AgentSession.prototype, "getContextUsage").mockReturnValue({ tokens: 200_000, contextWindow: 200_000, percent: 100 });
  try {
    await h.turn(); await h.drain();
    h.ctx.hasUI = true;
    h.answers.push(undefined); await h.commands.get("trace").handler("", h.ctx);
    const failure = store.dreamerFailure(1)!;
    expect(failure.reason).toMatch(/^notes: /);
    for (const field of [failure.reason, `R${failure.runId}`, failure.at.slice(0, 16).replace("T", " ")]) expect(h.dialogs.at(-1)!.title, field).toContain(field); // task and class, run, time
    expect(store.enabled(1)).toBe(true);
  } finally { measure.mockRestore(); await h.dispose(); }
});

test("entry ingestion starts a fresh Dreamer on its own model and thinking and records the entry that triggered it", async () => {
  const { h, store, item, pool } = await seeded({ "dreaming.model": "fake/test-thinking", "dreaming.thinking": "high", compaction: { enabled: true } });
  try {
    h.provider(async c => { expect(isDreamer(c.systemPrompt)).toBe(true); expect(c.tools?.map(t => t.name)).toContain("check"); expect(c.tools?.map(t => t.name)).not.toContain("memory");
      return dreamerFiles(c) ?? reply("Done"); }, { autoStop: false });
    await h.turn(); await h.drain();
    const run = dreamingRuns(store).find(run => run.request !== null)!;
    expect(run.outcome).toBe("success"); expect(run.mode).toBe("subagent"); expect(run.model).toBe("fake/test-thinking");
    expect(JSON.parse(run.response!).thinking).toEqual({ requested: "high", effective: "high" });
    expect(run.origin).not.toBeNull();
    expect(run.origin!.sessionId).toBe(1);
    const exactTrigger = run.origin!.entryIds.at(-1)!;
    const laterHead = store.sourceHeadEntryId(1, "main", store.knowledgePath(1).headTurnId!)!;
    expect(exactTrigger).toBeLessThan(laterHead);
    expect(store.getSourceEntry(exactTrigger)!.turnId).toBe(store.getSourceEntry(laterHead)!.turnId);
    expect(run.origin!.entryIds).not.toContain(laterHead);
    const execution = store.db.prepare("SELECT e.origin_session_id, e.origin_entry_ids FROM task_executions e JOIN execution_runs x ON x.execution_id = e.id WHERE x.run_id = ?").get(run.id)!;
    expect({ sessionId: execution.origin_session_id, entryIds: JSON.parse(String(execution.origin_entry_ids)) }).toEqual(run.origin);
    expect(processedIn(store, pool, item.commit)).toBe(true); // curate passed: what its batches showed is covered
    expect(JSON.parse(readFileSync(join(h.dir, "agent", "settings.json"), "utf8")).compaction.enabled).toBe(true);
  } finally { await h.dispose(); }
});

test("136 review SPEC4: a Pi Dreamer's over-long search output is saved and its path is readable by the worker's Read", async () => {
  const { h, store, item, pool } = await seeded();
  try {
    const toolText = (message: { content?: unknown } | undefined) => ((message?.content as { text?: string }[] | undefined) ?? []).map(part => part.text ?? "").join("");
    let requests = 0, path = "", readBack = "";
    h.provider(async c => {
      requests++;
      const results = c.messages.filter(m => m.role === "toolResult");
      if (requests === 1) return call("s1", "search", { layer: "knowledge", code: "text(Array.from({ length: 40000 }, (_, i) => 'line ' + i + ' word').join('\\n'))" });
      if (requests === 2) {
        path = /\[Full output: (.+)\]/.exec(toolText(results.at(-1)))![1]!;
        return call("r1", "read", { path });
      }
      if (requests === 3) readBack = toolText(results.at(-1));
      return dreamerFiles(c) ?? reply("Done");
    }, { autoStop: false });
    await h.turn(); await h.drain();
    const run = dreamingRuns(store)[0]!;
    expect(run.outcome).toBe("success");
    expect(path).toMatch(/trace-memory-worker-[^/]+\/output-[^/]+\.txt$/);
    expect(readBack).toContain("line 0 word");
    expect(existsSync(path)).toBe(false); // removed with the run
    expect(processedIn(store, pool, item.commit)).toBe(true);
  } finally { await h.dispose(); }
});

test("32d native host: intermediate tool turns do not end a pass; the batch is kept once the file is written and the model stops, and applied at verify's pass", async () => {
  const { h, store, item, pool } = await seeded();
  try {
    let requests = 0, atStop: number | undefined;
    const revisions = () => store.listKnowledgeRevisions().length, before = revisions();
    h.provider(async c => {
      requests++;
      if (requests === 1) return call("read", "read", { path: `trace://K${item.knowledgeId}` });
      const written = c.messages.some(m => m.role === "toolResult" && (m as { toolName?: string }).toolName === "write");
      if (written && atStop === undefined) atStop = revisions(); // the request that answers the write: the model has not stopped yet
      return dreamerFiles(c, { curate: tidy(item) }) ?? reply("Done");
    }, { autoStop: false });
    await h.turn(); await h.drain();
    expect(atStop).toBe(before); // nothing is applied while the model is still working
    expect(revisions()).toBe(before + 1);
    expect(processedIn(store, pool, item.commit)).toBe(true);
  } finally { await h.dispose(); }
});

test("32d native host: Noter and Dreamer occupy independent seats", async () => {
  const { h, store } = await seeded({ "noting.triggerTokens": 1 });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  try {
    const phases = new Set<string>();
    h.provider(async c => { const dreamer = isDreamer(c.systemPrompt); phases.add(dreamer ? "D" : "N"); await held;
      return (dreamer ? dreamerFiles(c) : emptyNote(c)) ?? reply("Done"); }, { autoStop: false });
    await h.turn();
    await vi.waitFor(() => expect([...phases].sort()).toEqual(["D", "N"]));
    expect(store.getClaim(1, "dreaming")).not.toBeNull(); expect(store.getClaim(1, "noting")).not.toBeNull();
    release(); await h.drain();
    expect(dreamingRuns(store).every(run => run.outcome === "success")).toBe(true);
  } finally { release(); await h.dispose(); }
});

/** Interrupt scoring inside the curate conversation, after its files have passed. */
function curateThen(h: ReturnType<typeof host>, item: { heading: string }, after: (c: Parameters<Parameters<typeof h.provider>[0]>[0]) => Promise<Reply>) {
  h.provider(async c => {
    if (JSON.stringify(c.messages).includes("Task: scoring")) return after(c);
    return dreamerFiles(c, { curate: tidy(item) }) ?? reply("Done");
  }, { autoStop: false });
}

test("64c native host: stop after a kept batch keeps it, applies nothing, is not a failure and resumes at the next task on the next trigger", async () => {
  const { h, store, item } = await seeded();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let heldRequests = 0;
  try {
    curateThen(h, item, async () => { heldRequests++; await held; return reply("late reply"); });
    await h.turn();
    await vi.waitFor(() => expect(heldRequests).toBe(1));
    await h.commands.get("trace").handler("stop", h.ctx);
    await vi.waitFor(() => expect(dreamingRuns(store).at(-1)!.outcome).toBe("cancelled"));
    expect(store.getClaim(1, "dreaming")).toBeNull();
    expect(dreamingRuns(store).flatMap(run => store.listCommitsByRun(run.id))).toEqual([]);
    expect(store.currentKnowledge(store.knowledgePath(1)).map(value => value.revision.text)).toEqual(["Keep the user constraint"]);
    expect(store.taskFailures(1).every(f => f.count === 0)).toBe(true);
    const runsAfterStop = dreamingRuns(store).length;
    expect(store.handoff(1, "dreaming")).toMatchObject({ nextTask: "curate" });
    release();
    await h.drain();
    expect(dreamingRuns(store)).toHaveLength(runsAfterStop); // nothing retries by itself
    h.provider(async c => dreamerFiles(c, { curate: tidy(item) }) ?? reply("Done"), { autoStop: false });
    await h.turn(); await h.drain();
    expect(store.currentKnowledge(store.knowledgePath(1)).map(value => value.revision.text)).toEqual(["Keep the user constraint, tidied"]);
  } finally { release(); await h.dispose(); }
});

test("64c native host: provider overflow in the next task keeps the kept batch, fails the run and does not compact", async () => {
  const { h, store, item } = await seeded({ compaction: { enabled: true }, retry: { enabled: false } });
  try {
    curateThen(h, item, async () => ({ ...reply(""), stopReason: "error", errorMessage: "maximum context length exceeded" }));
    await h.turn(); await h.drain();
    const runs = dreamingRuns(store);
    expect(runs.at(-1)!.outcome).toBe("failure");
    expect(runs.flatMap(run => store.listCommitsByRun(run.id))).toEqual([]);
    expect(store.currentKnowledge(store.knowledgePath(1)).map(value => value.revision.text)).toEqual(["Keep the user constraint"]);
    const entries = readFileSync(JSON.parse(runs.at(-1)!.response!).nativeLog, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(entries.some(e => e.type === "compaction")).toBe(false);
  } finally { await h.dispose(); }
});

// 144 stage 4 part 4d. Loose ends found in part 4c, each at the boundary where it occurred.
test("the trigger a host is configured with is the one its Dreamer is due by: a Noter change below it starts no run, the same change at a lower trigger does", async () => {
  // `h.memory` is an observer built with the default core config; it does not carry the host's `dreaming.*` options (reading
  // `h.memory.config.dreaming.triggerOperations` right after setup gives 10000). The extension's own instance does, so the effect is observed on runs.
  const quiet = await seeded({ "dreaming.triggerOperations": 10_000 });
  try {
    quiet.h.provider(async c => dreamerFiles(c) ?? reply("Done"), { autoStop: false });
    await quiet.h.turn(); await quiet.h.drain();
    expect(dreamingRuns(quiet.store)).toEqual([]);
    expect(quiet.h.requests).toEqual([]);
  } finally { await quiet.h.dispose(); }
  const eager = await seeded({ "dreaming.triggerOperations": 1 });
  try {
    eager.h.provider(async c => dreamerFiles(c) ?? reply("Done"), { autoStop: false });
    await eager.h.turn(); await eager.h.drain();
    expect(dreamingRuns(eager.store).length).toBeGreaterThan(0);
  } finally { await eager.h.dispose(); }
});


test("2026-10-22, 144: curate reads repository files through the real worker's Read, past the one deny list, as verify does", async () => {
  const { h, store } = await seeded();
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tm-144-pi-curate-"))), outside = realpathSync(mkdtempSync(join(tmpdir(), "tm-144-pi-outside-")));
  try {
    writeFileSync(join(root, "a.ts"), "export const marker = 1;\n"); writeFileSync(join(root, ".env"), "SECRET=1\n"); writeFileSync(join(outside, "b.txt"), "x\n");
    store.db.prepare("UPDATE sessions SET directory = ? WHERE id = 1").run(root);
    const reads = [join(root, "a.ts"), join(root, ".env"), join(outside, "b.txt")];
    const text = (message: { content?: unknown } | undefined) => ((message?.content as { text?: string }[] | undefined) ?? []).map(part => part.text ?? "").join("");
    let curate: Parameters<Parameters<typeof h.provider>[0]>[0] | undefined;
    h.provider(async c => {
      const isCurate = c.messages.some(m => m.role === "toolResult" && /^Task: curate/m.test(text(m)));
      if (isCurate) {
        curate = c;
        const done = c.messages.filter(m => m.role === "toolResult" && (m as { toolName?: string }).toolName === "read").length;
        if (done < reads.length) return call(`r${done}`, "read", { path: reads[done] });
      }
      return dreamerFiles(c) ?? reply("Done");
    }, { autoStop: false });
    await h.turn(); await h.drain();
    const results = curate!.messages.filter(m => m.role === "toolResult" && (m as { toolName?: string }).toolName === "read").map(text);
    expect(results[0]).toContain("marker");
    expect(results[1]).toContain("secret file");
    expect(results[2]).toContain("outside the repositories you may read");
  } finally { await h.dispose(); rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});
