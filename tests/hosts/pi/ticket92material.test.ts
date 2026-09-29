import { expect, test, vi } from "vitest";
import { forkFixture, piSession, worker, say, call, type Body } from "./native-fixture.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TraceMemory } from "../../../src/core/api/index.ts";
import extension from "../../../src/hosts/pi/index.ts";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { runNative, NotForkable } from "../../../src/hosts/pi/native.ts";

for (const moved of [false, true]) {
  test(`ticket92material real SDK extension events ${moved ? "refuse moved parent once" : "fork stable parent between tool rounds"}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "trace-memory-material-"));
    const dbPath = join(dir, "trace.db");
    const f = await piSession({ extensions: [extension], activeTools: ["evidence", "trace", "search", "note", "memory"],
      env: { TRACE_MEMORY_CONFIG: JSON.stringify({ dbPath, "noting.forkModeDefault": true,
        "noting.triggerTokens": 30, "consolidation.triggerTokens": 1e9 }) },
      prepare: ({ agentDir }) => writeFileSync(join(agentDir, "trace-memory-baseline.json"), JSON.stringify("2000-01-01T00:00:00.000Z")),
      tools: [{ name: "evidence", description: "Read evidence", parameters: { type: "object", properties: {} },
        execute: async () => ({ content: [{ type: "text", text: "tool evidence ".repeat(30) }], details: {} }) }] });
    const observer = TraceMemory(dbPath, async () => { throw new Error("observer never runs"); });
    const original = DefaultResourceLoader.prototype.reload;
    let changed = false;
    const reload = vi.spyOn(DefaultResourceLoader.prototype, "reload").mockImplementation(async function (this: DefaultResourceLoader) {
      await original.call(this);
      if (moved && !changed) { changed = true; f.manager.appendCustomEntry("material-parent-moved", {}); }
    });
    let parentRounds = 0;
    try {
      f.script(async body => {
        if (worker(body)) return emptyProtocol(body);
        if (++parentRounds === 1) {
          expect(f.session.getAllTools().map(tool => tool.name)).toEqual(expect.arrayContaining(["trace", "search", "note", "memory"]));
          return call("parent-evidence", "evidence", {});
        }
        return say("parent finished");
      });
      await f.session.prompt("Keep this original evidence. ".repeat(20));
      await vi.waitFor(() => expect(observer.store.listRuns(1).filter(run => run.kind === "noting").length).toBeGreaterThan(0), { timeout: 5000 });
      const runs = observer.store.listRuns(1).filter(run => run.kind === "noting");
      expect(runs).toHaveLength(1);
      const first = runs[0]!;
      expect(first.outcome, first.response ?? "missing audit").toBe("success");
      expect(first.mode, first.response ?? "missing audit").toBe(moved ? "subagent" : "fork");
      if (moved) expect(JSON.parse(first.response!).fallbackReason).toContain("Fork parent changed");
      expect(f.sent.filter(body => worker(body))).toHaveLength(3);
    } finally { reload.mockRestore(); f.dispose(); observer.close(); rmSync(dir, { recursive: true, force: true }); }
  }, 30_000);
}

for (const rejected of [false, true]) {
  test(`ticket92material native first-payload admission ${rejected ? "refuses without request, usage or retry" : "runs only once across tool rounds"}`, async () => {
    const f = await forkFixture({ "noting.triggerTokens": 1e9 });
    try {
      f.script(() => say("Parent reply"));
      const captured = await f.turn("Quiet parent evidence");
      const before = f.sent.length;
      const recheck = vi.fn(() => rejected ? "local admission 500: exact parent changed" : undefined);
      const onRequest = vi.fn(), onProgress = vi.fn(), onRetry = vi.fn();
      f.script(body => (body.messages ?? []).some((message: Body) => message.role === "tool")
        ? say("Done") : call("single-note", "note", { facts: [] }));
      const run = runNative(f.task(captured, { recheck, onRequest, onProgress, onRetry,
        tools: [{ name: "note", description: "write", parameters: { type: "object", properties: {} }, execute: () => "held: $1" }] }));
      if (rejected) {
        await expect(run).rejects.toThrow(NotForkable);
        expect(onRequest).not.toHaveBeenCalled();
        expect(onRetry).not.toHaveBeenCalled();
        expect(f.sent).toHaveLength(before);
        expect(onProgress.mock.calls.every(([state]) => state.usage === undefined)).toBe(true);
      } else {
        expect((await run).outcome).toBe("success");
        expect(onRequest).toHaveBeenCalledTimes(2);
        expect(f.sent).toHaveLength(before + 2);
      }
      expect(recheck).toHaveBeenCalledTimes(1);
    } finally { await f.dispose(); }
  }, 30_000);
}

const emptyProtocol = (body: Body) => {
  const calls = (body.messages ?? []).flatMap((message: Body) => message.tool_calls ?? []);
  if (!calls.some((item: Body) => item.function?.name === "note")) return call("material-note", "note", { facts: [] });
  if (!calls.some((item: Body) => item.function?.name === "memory")) return call("material-memory", "memory", { operations: [], skipped: [] });
  return say("Done.");
};

for (const change of ["leaf", "knowledge", "cancel"] as const) {
  test(`ticket92material Pi rechecks ${change} after native preparation and before first fork request`, async () => {
    const f = await forkFixture({ "noting.triggerTokens": 1 });
    let reload: ReturnType<typeof vi.spyOn> | undefined;
    try {
      f.script(body => worker(body) ? emptyProtocol(body) : say("Initial reply"));
      await f.turn("Initial evidence");
      const memory = f.h.memory;
      expect(memory.store.listRuns(1).filter(run => run.kind === "noting")).toHaveLength(1);
      const sentBefore = f.sent.length;
      const offered = await f.h.emit("before_agent_start", { prompt: "Second evidence" });
      if (offered?.message) await f.parent.sendCustomMessage(offered.message);
      await f.parent.prompt("Second evidence");
      const original = DefaultResourceLoader.prototype.reload;
      reload = vi.spyOn(DefaultResourceLoader.prototype, "reload").mockImplementationOnce(async function (this: DefaultResourceLoader) {
        await original.call(this);
        if (change === "leaf") f.manager().appendMessage({ role: "user", content: "new selected leaf", timestamp: Date.now() });
        else if (change === "cancel") void f.h.commands.get("trace")!.handler("stop", f.h.ctx);
        else {
          const target = { sessionId: 1, branch: "main", headTurnId: memory.store.listTurns(1).at(-1)!.id };
          const note = memory.tools({ kind: "manual", ...target, currentTurnId: 1 }).find(tool => tool.name === "note")!;
          const fact = JSON.parse(note.execute({ facts: [{ title: "Evidence", sources: [{ address: "T1#E1", text: "Evidence" }] }] })).factIds[0];
          const result = memory.store.commitConsolidationRun({ path: target, run: { kind: "manual", sessionId: 1, createdAt: "now" },
            operations: [{ op: "create", handle: "$new", author: "fixture", category: "constraint", scope: "project",
              text: "Knowledge changed during child preparation", supports: [fact], topics: [], reason: "fixture", createdAt: "now" }] });
          if (!result.ok) throw new Error(result.problems.join("; "));
        }
      });
      await f.h.emit("before_provider_request", { payload: f.sent[sentBefore] });
      await f.h.emit("agent_settled");
      await f.h.drain();
      expect(reload).toHaveBeenCalled();
      // Refused native preparation adds no failed-attempt run; only one fresh worker is sent.
      expect(f.sent.slice(sentBefore).filter(body => worker(body))).toHaveLength(change === "cancel" ? 0 : 3);
      const runs = memory.store.listRuns(1).filter(run => run.kind === "noting").sort((a, b) => a.id - b.id);
      expect(runs, JSON.stringify(runs.map(run => ({ id: run.id, mode: run.mode, outcome: run.outcome, response: run.response })))).toHaveLength(2);
      const last = runs.at(-1)!;
      const response = JSON.parse(last.response!);
      if (change === "cancel") {
        expect(last.outcome).toBe("cancelled");
        expect(f.sent.slice(sentBefore).filter(body => worker(body))).toEqual([]);
        expect(memory.pendingEntries(1, "main", memory.store.listTurns(1).at(-1)!.id).length).toBeGreaterThan(0);
      } else {
        expect(last.mode, last.response ?? "missing audit").toBe("subagent");
        expect(last.outcome).toBe("success");
        expect(response.fallbackReason).toContain(change === "leaf" ? "Fork parent changed" : "Knowledge publication");
        expect(response.requestedMode).toBe("fork");
        expect(f.h.notices.filter(message => message.includes("fell back to subagent mode"))).toHaveLength(1);
      }
    } finally { reload?.mockRestore(); await f.dispose(); }
  }, 30_000);
}

for (const delivery of ["landed", "missing", "offered-only", "budget-omitted"] as const) {
  test(`ticket92material Pi ${delivery} ordinary carrier decides fork eligibility through existing fallback`, async () => {
    const f = await forkFixture({ "noting.triggerTokens": 1 });
    try {
      f.script(body => worker(body) ? emptyProtocol(body) : say("Initial reply"));
      await f.turn("Initial evidence");
      const memory = f.h.memory;
      await vi.waitFor(() => expect(memory.store.listRuns(1).filter(run => run.kind === "noting")).toHaveLength(1));
      const target = { sessionId: 1, branch: "main", headTurnId: memory.store.listTurns(1).at(-1)!.id };
      const note = memory.tools({ kind: "manual", ...target, currentTurnId: 1 }).find(tool => tool.name === "note")!;
      const fact = JSON.parse(note.execute({ facts: [{ title: "Original evidence", sources: [{ address: "T1#E1", text: "User's original evidence" }] }] })).factIds[0];
      const create = () => {
        const result = memory.store.commitConsolidationRun({ path: target,
          run: { kind: "manual", sessionId: 1, createdAt: "now" }, operations: [{ op: "create", handle: "$new",
            author: "fixture", category: "constraint", scope: "project", text: delivery === "budget-omitted" ? "unfit body ".repeat(15000) : "Newly visible instruction", supports: [fact], topics: [], reason: "fixture", createdAt: "now" }] });
        if (!result.ok) throw new Error(result.problems.join("; "));
      };
      if (delivery !== "missing") create();
      let injected = false;
      f.script(body => {
        if (worker(body)) return emptyProtocol(body);
        if (delivery === "missing" && !injected) { injected = true; create(); }
        return say("Second reply");
      });
      const offered = await f.h.emit("before_agent_start", { prompt: "Second evidence" });
      if (delivery === "offered-only") expect(offered?.message).toBeTruthy();
      else if (offered?.message) await f.parent.sendCustomMessage(offered.message);
      const at = f.sent.length;
      await f.parent.prompt("Second evidence");
      await f.h.emit("before_provider_request", { payload: f.sent[at] });
      // Keep the synthetic settled boundary from appending parent state during child preparation.
      await f.h.drain();
      await f.h.emit("agent_settled");
      await f.h.drain();
      await vi.waitFor(() => expect(memory.store.listRuns(1).filter(run => run.kind === "noting")).toHaveLength(2));
      const run = memory.store.listRuns(1).filter(run => run.kind === "noting").sort((a, b) => a.id - b.id).at(-1)!;
      expect(run.outcome, run.response ?? "missing audit").toBe("success");
      const response = JSON.parse(run.response!);
      const shouldFork = delivery === "landed" || delivery === "budget-omitted";
      expect(run.mode).toBe(shouldFork ? "fork" : "subagent");
      if (!shouldFork) {
        expect(response.requestedMode).toBe("fork");
        expect(response.fallbackReason).toContain("Knowledge publication");
        expect(f.h.notices.filter(message => message.includes("fell back to subagent mode"))).toHaveLength(1);
      }
    } finally { await f.dispose(); }
  }, 30_000);
}
