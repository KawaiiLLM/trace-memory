import { afterEach, expect, test } from "vitest";
import { readFileSync, writeFileSync, readdirSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { host as createHost, reply, recordingFact, usage, type Reply } from "./test-host.ts";

const disposers: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of disposers.splice(0)) await dispose(); });
function host(...args: Parameters<typeof createHost>) {
  const h = createHost(...args);
  disposers.push(h.dispose);
  return h;
}

test("smoke: the default extension loads and registers the Pi hooks, tools, and read-only command", async () => {
  const h = host();
  expect([...h.tools.keys()]).toEqual(["trace", "search", "mark"]);
  for (const name of ["agent_settled", "session_before_compact", "before_agent_start", "message_update", "message_end", "tool_result", "session_start", "session_before_tree", "session_tree"]) expect(h.hooks.has(name)).toBe(true);
  await h.emit("session_start");
  await h.commands.get("trace").handler("", h.ctx);
  expect(h.notices.at(-1)).toContain("no session id");
  expect(h.memory.store.getSession(1)).toBeNull();
  expect(h.requests).toHaveLength(0);
});

test("five answered turns trigger only at stop, reset at the watermark, and slash commands do not count", async () => {
  const h = host();
  for (let i = 0; i < 4; i++) { await h.turn(); await h.commands.get("trace").handler("", h.ctx); }
  expect(h.requests).toHaveLength(0);
  await h.prompt(); await h.answer();
  expect(h.requests).toHaveLength(0);
  await h.emit("agent_settled"); await h.drain();
  expect(h.requests).toHaveLength(1);
  expect(h.memory.store.getWatermark(1, "main")?.lastRecordedTurn).toBe(5);
  await h.turn();
  expect(h.requests).toHaveLength(1);
  expect(h.memory.store.listTurns(1)).toHaveLength(6);
});

test("50K raw context growth triggers recording, including tool results; no assistant means no answered turn", async () => {
  const h = host();
  await h.prompt(); await h.answer();
  await h.emit("tool_result", { toolName: "read", input: { path: "large.txt" }, content: [{ type: "text", text: "x".repeat(200_000) }], isError: false });
  expect(h.requests).toHaveLength(0);
  await h.emit("agent_settled"); await h.drain();
  expect(h.requests).toHaveLength(1);
  await h.prompt("/a-command-without-a-reply");
  await h.emit("session_before_compact", { preparation: { tokensBefore: 10 } });
  await h.emit("agent_settled");
  expect(h.memory.store.listTurns(1).at(-1)?.assistantText).toBeNull();
  expect(h.requests).toHaveLength(1);
});

test("recording through runAgent commits the exact provider request, prompt, model, usage and subagent mode", async () => {
  const h = host({ "recording.triggerAnsweredTurns": 1 });
  h.provider(async c => recordingFact(c));
  await h.turn();
  const run = h.memory.store.listRuns(1)[0]!;
  expect(run.outcome).toBe("success");
  expect(run.mode).toBe("subagent"); expect(run.model).toBe("fake/test");
  expect(JSON.parse(run.request!)).toEqual(h.requests.at(-1));
  expect(h.conversations.at(-1)!.messages.map(m => m.role)).toEqual(["user", "assistant", "toolResult"]);
  expect(h.conversations[0]!.systemPrompt).toBe(readFileSync(new URL("../../core/prompts/recording.md", import.meta.url), "utf8"));
  expect(h.conversations[0]!.messages).toHaveLength(1);
  expect(h.conversations[0]!.tools!.map(t => t.name)).toEqual(["trace", "search", "note", "memory"]);
  expect(JSON.parse(run.response!).usage).toEqual(usage);
  expect(h.memory.store.listSessionFacts(1)[0]!.text).toBe("用 pnpm，不要 npm");
});

test("first prompt injects project/global knowledge without allocating a session; marker is declared and mark wins", async () => {
  const h = host({}, "project-name");
  const p = h.memory.store.createProject({ name: "project-name", declaredBy: "marker" });
  const s = h.memory.store.createSession({ host: "fixture", projectId: p.id, startedAt: "now", firstReplyAt: "now" });
  const t = h.memory.store.appendTurn({ sessionId: s.id, kind: "turn", startedAt: "now", userPrompt: "规则" });
  const recorded = h.memory.store.commitRecordingRun({ run: { kind: "recording", sessionId: s.id, createdAt: "now" }, facts: [
    { turnId: t.id, category: "observation", actor: "user", text: "规则", source: [`T${t.id}#user`], createdAt: "now" },
  ] });
  if (!recorded.ok) throw new Error(recorded.problems.join("; "));
  const seeded = h.memory.store.commitIntegrationRun({ run: { kind: "integration", sessionId: s.id, createdAt: "now" }, operations: [
    { op: "new", handle: "$e1", author: "fixture", text: "项目规则", supports: [recorded.facts[0]!.id], createdAt: "now", category: "constraint", scope: "project" },
    { op: "new", handle: "$e2", author: "fixture", text: "全局规则", supports: [recorded.facts[0]!.id], createdAt: "now", category: "constraint", scope: "global" },
  ] });
  expect(seeded.ok && seeded.rejected.length === 0).toBe(true);
  const injection = await h.prompt();
  expect(injection.message.content).toContain("项目规则"); expect(injection.message.content).toContain("全局规则");
  expect(h.memory.store.getSession(2)).toBeNull();
  await h.answer();
  expect(h.memory.store.projectDeclaration(2)).toBe("marker");
  await h.tools.get("mark").execute("id", { input: { project: "override" } });
  await h.emit("session_start");
  expect(h.memory.status(2)).toContain("override (mark)");
  expect(h.requests).toHaveLength(0);
});

test("raw is incremental and compaction contains intermediate assistant text without calling a model", async () => {
  const h = host();
  await h.prompt();
  expect(h.memory.store.getSession(1)).toBeNull();
  await h.emit("message_update", { message: reply("partial") });
  expect(h.memory.store.listTurns(1)[0]?.assistantText).toBe("partial");
  await h.emit("tool_result", { toolName: "bash", input: { command: "pwd" }, content: [{ type: "text", text: "result" }], isError: false });
  expect(h.memory.store.listToolCalls(1)).toHaveLength(1);
  const block = await h.emit("session_before_compact", { preparation: { tokensBefore: 99, firstKeptEntryId: "old" } });
  expect(block.compaction.summary).toBe(h.memory.compact(1, "main", 1));
  expect(block.compaction.summary).toContain("partial"); expect(block.compaction.firstKeptEntryId).toBe("");
  expect(h.requests).toHaveLength(0);
  await h.emit("session_compact", { compactionEntry: { summary: block.compaction.summary } });
  expect(h.memory.store.listTurns(1)[1]!.kind).toBe("compaction");
  await h.answer("finished"); await h.emit("agent_settled");
  await h.prompt("next");
  expect(h.memory.store.listTurns(1)[2]!.assistantText).toBeNull();
});

test("pending delivery is injected once on its own branch", async () => {
  const h = host({ "recording.triggerAnsweredTurns": 1 });
  let release!: (value: Reply) => void;
  h.provider(async () => new Promise(resolve => { release = resolve; }));
  await h.turn();
  const original = [...h.entries];
  await h.prompt("second"); await h.answer();
  const mainTip = [...h.entries];
  release(recordingFact(h.conversations[0]!)); await h.drain();
  expect(h.memory.store.listPendingDeliveries(1, "main")).toHaveLength(1);
  h.entries.splice(0, h.entries.length, ...original);
  await h.emit("session_tree");
  const injected = async () => (await h.prompt())?.message?.content ?? "";
  expect(await injected()).not.toContain("recorded");
  h.entries.splice(0, h.entries.length, ...mainTip); await h.emit("session_tree");
  expect(await injected()).toContain("recorded");
  expect(await injected()).not.toContain("recorded");
  expect(h.memory.store.listPendingDeliveries(1, "main")).toHaveLength(0);
});

test("in-flight duplicate is dropped; new raw and branch switches cannot change its frozen range", async () => {
  const h = host({ "recording.triggerAnsweredTurns": 1 });
  let release!: (value: Reply) => void;
  h.provider(async () => new Promise(resolve => { release = resolve; }));
  await h.prompt(); await h.answer(); await h.emit("agent_settled");
  await h.emit("agent_settled"); expect(h.requests).toHaveLength(1);
  const old = [...h.entries];
  await h.prompt("later raw"); await h.answer();
  h.entries.splice(0, h.entries.length, ...old);
  await h.emit("session_tree");
  release(recordingFact(h.conversations[0]!)); await h.drain();
  expect(h.memory.store.getWatermark(1, "main")?.lastRecordedTurn).toBe(1);
  expect(h.memory.store.listPendingDeliveries(1, "main")).toHaveLength(1);
  expect(h.conversations[0]!.messages[0]!.content).not.toContain("later raw");
});

test("integration waits for a turn stop after facts arrive and final replays candidate plus one feedback message", async () => {
  const h = host({ "recording.triggerAnsweredTurns": 1, "integration.triggerUnintegratedFacts": 1, integrationModel: "fake/Integrator" });
  const output = JSON.stringify({ new: [], edit: [], merge: [], delete: [], not_admitted: [{ id: "F1", because: "Not durable." }], near_ack: [], over_budget: false });
  h.provider(async c => c.systemPrompt!.includes("### Second-round user message") ? reply(output) : recordingFact(c));
  await h.turn();
  expect(h.requests).toHaveLength(2); // Only the recording tool loop; no Integration trigger.
  await h.emit("agent_settled"); await h.drain();
  expect(h.requests).toHaveLength(4);
  const candidate = h.conversations[2]!, final = h.conversations[3]!;
  expect(final.systemPrompt).toBe(candidate.systemPrompt);
  expect(final.messages.slice(0, 1)).toEqual(candidate.messages);
  expect(final.messages[1]).toEqual(reply(output));
  expect(final.messages).toHaveLength(3); expect(final.messages[2]!.role).toBe("user");
  const runs = h.memory.store.listRuns(1).filter(r => r.kind === "integration");
  expect(runs.map(r => r.outcome)).toEqual(["success", "success"]);
  expect(runs.map(r => r.model)).toEqual(["fake/Integrator", "fake/Integrator"]);
  expect(JSON.parse(runs[1]!.request!)).toEqual(h.requests[3]);
});

test.each(["new", "resume", "fork"])("shutdown for session replacement (%s) waits for pending runs, launches nothing, and closes the store", async reason => {
  const h = host({ "recording.triggerAnsweredTurns": 1 });
  let release!: (value: Reply) => void;
  h.provider(async () => new Promise(resolve => { release = resolve; }));
  await h.turn();
  let closed = false;
  const shutdown = h.emit("session_shutdown", { reason }).then(() => { closed = true; });
  await h.drain(); expect(closed).toBe(false);
  release(recordingFact(h.conversations[0]!)); await shutdown;
  expect(h.memory.store.listRuns(1)[0]!.outcome).toBe("success"); expect(h.requests).toHaveLength(2);
  await expect(h.emit("session_start")).rejects.toThrow(/not open/); // Pi re-runs the factory; this instance is dead.
});

test("core contains no Pi imports and host imports core only through the facade", () => {
  const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]);
  for (const file of files("core").filter(f => f.endsWith(".ts"))) expect(readFileSync(file, "utf8")).not.toMatch(/(?:from\s*|import\s*\(|require\s*\()["'][^"']*(?:pi-coding-agent|pi-ai|pi-agent-core|hosts\/pi)/);
  expect(readFileSync("hosts/pi/index.ts", "utf8").match(/from "\.\.\/\.\.\/core\/[^\"]+"/g)).toEqual(['from "../../core/api/index.ts"']);
});

test("token threshold uses growth since watermark, including the CJK heuristic", async () => {
  const h = host({ "recording.triggerTokens": 4 });
  await h.prompt("一"); await h.answer("a"); await h.emit("agent_settled");
  expect(h.requests).toHaveLength(0); // 0.75 + 0.25 = 1.
  await h.prompt("一一一"); await h.answer("aaa"); await h.emit("agent_settled"); await h.drain();
  expect(h.requests).toHaveLength(1); // Three more tokens, exactly four since watermark.
  await h.prompt("一一一"); await h.answer("aaa"); await h.emit("agent_settled");
  expect(h.requests).toHaveLength(1); // Three since the new watermark.
});

test("provider failures retain captured request and do not advance a watermark", async () => {
  const h = host({ "recording.triggerAnsweredTurns": 1 });
  h.provider(async () => { throw new Error("provider unavailable"); });
  await h.turn();
  const run = h.memory.store.listRuns(1)[0]!;
  expect(run.outcome).toBe("failure"); expect(JSON.parse(run.request!)).toEqual(h.requests[0]);
  expect(h.memory.store.getWatermark(1, "main")).toBeNull();
});

test("integration in-flight duplicates cannot erase the candidate continuation", async () => {
  const h = host({ "recording.triggerAnsweredTurns": 1, "integration.triggerUnintegratedFacts": 1 });
  h.provider(async c => recordingFact(c)); await h.turn();
  const output = JSON.stringify({ new: [], edit: [], merge: [], delete: [], not_admitted: [{ id: "F1", because: "Not durable." }], near_ack: [], over_budget: false });
  let release!: (value: Reply) => void;
  h.provider(async c => c.messages.length === 1 ? new Promise(resolve => { release = resolve; }) : reply(output));
  await h.emit("agent_settled"); await h.emit("agent_settled");
  expect(h.requests).toHaveLength(3);
  release(reply(output)); await h.drain();
  expect(h.requests).toHaveLength(4);
  expect(h.memory.store.listRuns(1).map(r => r.outcome)).toEqual(["success", "success", "success"]);
});

test("knowledge are injected once per session, only once something exists; later prompts carry only deliveries", async () => {
  const h = host();
  expect((await h.prompt())?.message?.content ?? "").not.toContain("<knowledge>"); // empty store: no block at all
  await h.answer();
  const p = h.memory.store.getSession(1)!.projectId;
  const t = h.memory.store.appendTurn({ sessionId: 1, kind: "turn", startedAt: "2026-09-06T00:00:00Z" });
  const recorded = h.memory.store.commitRecordingRun({ run: { kind: "recording", sessionId: 1, createdAt: "2026-09-06T00:00:00Z" },
    facts: [{ turnId: t.id, category: "decision", actor: "user", text: "用 pnpm", source: ["T1#user"], createdAt: "2026-09-06T00:00:00Z" }] });
  if (!recorded.ok) throw new Error("setup");
  h.memory.store.commitIntegrationRun({ run: { kind: "integration", sessionId: 1, createdAt: "2026-09-06T00:00:00Z" }, operations: [
    { op: "new", handle: "$e1", author: "t", text: "项目用 pnpm。", category: "constraint", scope: "project", supports: [recorded.facts[0]!.id], createdAt: "2026-09-06T00:00:00Z" }] });
  void p;
  const second = await h.prompt("again");
  expect(second?.message?.content).toContain("<knowledge>");
  await h.answer();
  const third = await h.prompt("once more");
  expect(third?.message?.content ?? "").not.toContain("<knowledge>");
});


test("marker walk uses the nearest hit and shares an ancestor marker across worktree directories", async () => {
  const h = host({}, "shared");
  const main = join(h.dir, "main", "src", "nested"), worktree = join(h.dir, "worktrees", "feature", "src");
  mkdirSync(main, { recursive: true }); mkdirSync(worktree, { recursive: true });
  h.ctx.cwd = main;
  await h.turn();
  const shared = h.memory.store.getSession(1)!.projectId;
  h.entries.length = 0; h.ctx.sessionManager.getSessionId = () => "worktree-session"; h.ctx.cwd = worktree;
  await h.emit("session_start"); await h.turn();
  expect(h.memory.store.getSession(2)!.projectId).toBe(shared);
  writeFileSync(join(h.dir, "worktrees", ".trace-memory"), "nearest");
  h.entries.length = 0; h.ctx.sessionManager.getSessionId = () => "nested-session";
  await h.emit("session_start"); await h.turn();
  expect(h.memory.status(3)).toContain("nearest (marker)");
  expect(h.memory.status(1)).toContain("shared (marker)");
});

test("mark persists in host state across tree restoration without merging marker peers", async () => {
  const h = host({}, "shared");
  await h.turn(); const first = [...h.entries];
  h.entries.length = 0; h.ctx.sessionManager.getSessionId = () => "peer";
  await h.emit("session_start"); await h.turn();
  const shared = h.memory.store.getSession(2)!.projectId;
  await h.tools.get("mark").execute("id", { input: { project: "override" } });
  expect(h.entries.at(-1).data.project).toBe("override");
  expect(h.entries.at(-1).data.projectId).toBe(h.memory.store.getSession(2)!.projectId);
  await h.emit("session_tree");
  expect(h.memory.status(2)).toContain("override (mark)");
  expect(h.memory.store.getProject(shared)!.mergedInto).toBeNull();
  h.entries.splice(0, h.entries.length, ...first); h.ctx.sessionManager.getSessionId = () => "pi-test";
  await h.emit("session_start");
  expect(h.memory.status(1)).toContain("shared (marker)");
});

test("declaring an own project moves facts and project knowledge, preserves session scope, and injects immediately", async () => {
  const h = host({ "recording.triggerAnsweredTurns": 1 });
  h.provider(async c => recordingFact(c)); await h.turn();
  const store = h.memory.store, own = store.getSession(1)!.projectId;
  const seed = (sessionId: number, fact: number, scopes: ("project" | "session")[]) => {
    const commit = store.commitIntegrationRun({ run: { kind: "integration", sessionId, createdAt: "now" }, operations: scopes.map((scope, i) => ({
      op: "new" as const, handle: `$e${i + 1}`, author: "fixture", text: scope === "project" ? "用 pnpm，不要 npm" : "仅当前会话", supports: [fact],
      createdAt: "now", category: "constraint" as const, scope,
    })) });
    expect(commit.ok && commit.rejected.length === 0).toBe(true);
  };
  seed(1, 1, ["project", "session"]);
  const sessionRevision = store.getKnowledgeRevision(2, 1);
  const target = store.createProject({ name: "named", declaredBy: "mark" });
  const peer = store.createSession({ host: "peer", projectId: target.id, startedAt: "now", firstReplyAt: "now" });
  const turn = store.appendTurn({ sessionId: peer.id, kind: "turn", startedAt: "now", userPrompt: "用 pnpm，不要 npm" });
  const recorded = store.commitRecordingRun({ run: { kind: "recording", sessionId: peer.id, createdAt: "now" }, facts: [
    { turnId: turn.id, category: "observation", actor: "user", text: "用 pnpm，不要 npm", source: [`T${turn.id}#user`], createdAt: "now" },
  ] });
  if (!recorded.ok) throw new Error(recorded.problems.join("; "));
  seed(peer.id, recorded.facts[0]!.id, ["project"]);
  const marked = await h.tools.get("mark").execute("id", { input: { project: "named" } });
  expect(store.getProject(own)!.mergedInto).toBe(target.id);
  expect(store.listProjectFacts(own)).toEqual([]);
  expect(store.listProjectFacts(target.id)).toHaveLength(2);
  // Both duplicate project knowledge are now in the next integration's NEAR pool.
  expect(store.getKnowledge(1)!.projectId).toBe(target.id);
  expect(store.getKnowledge(3)!.projectId).toBe(target.id);
  expect(store.listVisibleKnowledge(1, target.id).map(v => v.knowledge.id)).toEqual([1, 2, 3]);
  expect(store.getKnowledgeRevision(2, 1)).toEqual(sessionRevision);
  expect(h.memory.inject(peer.id)).not.toContain("仅当前会话");
  expect(marked.content[0].text).toContain(h.memory.inject(1));
  expect(h.memory.inject(1)).toContain("仅当前会话");
});

test("before-tree waits for a frozen pending recording and summarizes its facts plus later raw without delivering", async () => {
  const h = host({ "recording.triggerAnsweredTurns": 1 });
  let release!: (value: Reply) => void;
  h.provider(async () => new Promise(resolve => { release = resolve; }));
  await h.turn(); const forkPoint = [...h.entries];
  await h.prompt("later unrecorded raw"); await h.answer("later reply");
  const tip = [...h.entries];
  let finished = false;
  const switching = h.emit("session_before_tree", { preparation: { userWantsSummary: true } }).then(r => { finished = true; return r; });
  await h.drain(); expect(finished).toBe(false); expect(h.requests).toHaveLength(1);
  release(recordingFact(h.conversations[0]!));
  const result = await switching;
  expect(result.summary.summary).toContain("[F1]");
  expect(result.summary.summary).toContain("later unrecorded raw");
  expect(result.summary.summary).toContain("later reply");
  expect(result.summary.summary).toBe(h.memory.branchSummary(1, "main", 2));
  expect(h.conversations[0]!.messages[0]!.content).not.toContain("later unrecorded raw");
  expect(h.memory.store.getWatermark(1, "main")!.lastRecordedTurn).toBe(1);
  expect(h.memory.store.listRuns(1)[0]!.branch).toBe("main");
  h.entries.splice(0, h.entries.length, ...forkPoint); await h.emit("session_tree");
  const branch = h.entries.at(-1).data.branch;
  expect(branch).not.toBe("main");
  expect(h.memory.store.listPendingDeliveries(1, branch)).toEqual([]);
  expect((await h.prompt())?.message?.content ?? "").not.toContain("recorded");
  expect(h.memory.store.listPendingDeliveries(1, "main")).toHaveLength(1);
  h.entries.splice(0, h.entries.length, ...tip); await h.emit("session_tree");
  expect((await h.prompt())?.message?.content).toContain("recorded");
});

test.each(["success", "failure", "unavailable"])("before-tree attempts subagent recording below threshold: %s", async outcome => {
  const h = host();
  h.provider(async c => { if (outcome === "failure") throw new Error("offline"); return recordingFact(c); });
  await h.turn();
  if (outcome === "unavailable") h.ctx.model = undefined;
  const result = await h.emit("session_before_tree");
  expect(result.summary.summary).toContain("用 pnpm，不要 npm");
  if (outcome === "success") {
    expect(result.summary.summary).toContain("[F1]");
    expect(h.memory.store.listRuns(1)[0]!.mode).toBe("subagent");
    expect(h.notices).toEqual([]); // No attempted branch request or fallback.
  } else {
    expect(result.summary.summary).toContain("好的。");
    expect(result.summary.summary).not.toContain("[F1]");
    expect(h.memory.store.getWatermark(1, "main")).toBeNull();
  }
});

test("an empty session allocates neither session nor turns through prompt, compact, and tree hooks", async () => {
  const h = host();
  await h.emit("session_start"); await h.prompt("unanswered");
  await h.emit("message_end", { message: reply("") });
  await h.emit("agent_settled");
  await h.emit("session_before_compact", { preparation: { tokensBefore: 0 } });
  await h.emit("session_compact", { compactionEntry: { summary: "empty" } });
  await h.emit("session_before_tree"); await h.emit("session_tree");
  expect(h.memory.store.getSession(1)).toBeNull();
  expect(h.memory.store.listTurns(1)).toEqual([]);
  expect(h.requests).toEqual([]);
});


test("branch summaries retain earlier committed facts and exclude sibling facts", async () => {
  const h = host({ "recording.triggerAnsweredTurns": 1 });
  h.provider(async c => recordingFact(c)); await h.turn();
  const point = [...h.entries];
  await h.prompt("abandoned tail"); await h.answer("tail reply");
  const summary = await h.emit("session_before_tree");
  expect(summary.summary.summary).toContain("[F1]");
  expect(summary.summary.summary).toContain("[F2]");
  h.entries.splice(0, h.entries.length, ...point); await h.emit("session_tree");
  h.provider(async () => { throw new Error("offline"); });
  await h.prompt("sibling raw"); await h.answer();
  const sibling = await h.emit("session_before_tree");
  expect(sibling.summary.summary).not.toContain("[F2]");
  expect(sibling.summary.summary).not.toContain("abandoned tail");
  expect(sibling.summary.summary).toContain("sibling raw");
});

test("a tool-call-only first assistant reply allocates the session before mark executes", async () => {
  const h = host(); await h.prompt();
  await h.emit("message_end", { message: { role: "assistant", content: [{ type: "toolCall", id: "m", name: "mark", arguments: { input: { project: "named" } } }] } });
  expect(h.memory.store.getSession(1)).not.toBeNull();
  await h.tools.get("mark").execute("m", { input: { project: "named" } });
  expect(h.memory.status(1)).toContain("named (mark)");
});


test("removing a marker before first reply cannot turn its shared project into an undeclared merge source", async () => {
  const h = host({}, "shared"); await h.turn();
  const shared = h.memory.store.getSession(1)!.projectId;
  h.entries.length = 0; h.ctx.sessionManager.getSessionId = () => "new-session";
  await h.emit("session_start"); await h.prompt();
  unlinkSync(join(h.dir, ".trace-memory")); await h.answer();
  expect(h.memory.store.getSession(2)!.projectId).not.toBe(shared);
  await h.tools.get("mark").execute("m", { input: { project: "override" } });
  expect(h.memory.store.getSession(1)!.projectId).toBe(shared);
  expect(h.memory.store.getProject(shared)!.mergedInto).toBeNull();
});

test.each([true, false])("08:53 premise: a branch note (%s) waits until a note result committed mid-turn has been delivered; subagent mode does not", async branchMode => {
  const h = host({ "recording.triggerAnsweredTurns": 1, "recording.branchModeDefault": branchMode, recordingModel: "fake/recorder" });
  let release!: (value: Reply) => void;
  h.provider(async () => new Promise(resolve => { release = resolve; }));
  await h.turn(); // Recording A in flight over T1.
  await h.prompt("second"); await h.answer(); // This prompt saw no delivery.
  release(recordingFact(h.conversations[0]!)); await h.drain();
  expect(h.memory.store.listPendingDeliveries(1, "main")).toHaveLength(1);
  h.provider(async c => recordingFact(c));
  await h.emit("agent_settled"); await h.drain();
  expect(h.requests).toHaveLength(branchMode ? 2 : 4);
  expect((await h.prompt("third"))?.message?.content).toContain("recorded");
  await h.answer(); await h.emit("agent_settled"); await h.drain();
  expect(h.requests).toHaveLength(branchMode ? 4 : 6);
  expect(h.memory.store.listRuns(1).at(-1)).toMatchObject({ rangeFrom: branchMode ? "S1/T2" : "S1/T3", rangeTo: "S1/T3" });
});

test("spec overflow policy: a subagent recording fetches cut evidence through the trace tool; the run records the fetch and the last request", async () => {
  const h = host({ "recording.triggerAnsweredTurns": 1, "recording.branchModeDefault": false, recordingModel: "fake/recorder" });
  await h.prompt(); await h.answer();
  await h.emit("tool_result", { toolName: "Bash", input: { command: "pnpm test" }, content: [{ type: "text", text: "x".repeat(5000) + "\n1 passed" }], isError: false });
  const call = { type: "toolCall" as const, id: "call-1", name: "trace", arguments: { address: "T1", tool: 1, full: true } };
  h.provider(async c => c.messages.length === 1 ? { ...reply(""), content: [call], stopReason: "toolUse" } : recordingFact(c));
  await h.emit("agent_settled"); await h.drain();
  expect(h.conversations).toHaveLength(3);
  expect(h.conversations[1]!.messages.map(m => m.role)).toEqual(["user", "assistant", "toolResult"]);
  const result = h.conversations[1]!.messages[2] as { toolCallId: string; isError: boolean; content: { text: string }[] };
  expect(result.toolCallId).toBe("call-1"); expect(result.isError).toBe(false);
  expect(result.content[0]!.text).toBe(h.memory.trace("T1", { tool: 1, full: true }));
  expect(result.content[0]!.text).toContain("x".repeat(5000));
  expect(h.conversations[1]!.tools!.map(t => t.name)).toEqual(["trace", "search", "note", "memory"]);
  const run = h.memory.store.listRuns(1)[0]!;
  expect(run.outcome).toBe("success");
  expect(JSON.parse(run.response!).fetched).toEqual([{ address: "T1", input: { address: "T1", tool: 1, full: true }, content: h.memory.trace("T1", { tool: 1, full: true }) }]);
  expect(JSON.parse(run.request!)).toEqual(h.requests[2]);
  expect(h.memory.store.listSessionFacts(1)).toHaveLength(1);
});

test("an integration call carries no tools; a recording tool call for a bad address returns an error result and the recording still completes", async () => {
  const h = host({ "recording.triggerAnsweredTurns": 1, "recording.branchModeDefault": false, "integration.triggerUnintegratedFacts": 1 });
  const call = { type: "toolCall" as const, id: "call-2", name: "trace", arguments: { address: "K999" } };
  const output = JSON.stringify({ new: [], edit: [], merge: [], delete: [], not_admitted: [{ id: "F1", because: "Not durable." }], near_ack: [], over_budget: false });
  h.provider(async c => c.systemPrompt!.includes("### Second-round user message") ? reply(output)
    : c.messages.length === 1 ? { ...reply(""), content: [call], stopReason: "toolUse" } : recordingFact(c));
  await h.turn();
  const result = h.conversations[1]!.messages[2] as { isError: boolean; content: { text: string }[] };
  expect(result.isError).toBe(true); expect(result.content[0]!.text).toContain("does not exist");
  await h.emit("agent_settled"); await h.drain();
  expect(h.conversations.slice(3).map(c => c.tools)).toEqual([undefined, undefined]);
  expect(h.memory.store.listRuns(1).map(r => [r.kind, r.outcome])).toEqual([["recording", "success"], ["integration", "success"], ["integration", "success"]]);
});
