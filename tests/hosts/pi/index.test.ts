import { afterEach, expect, test, vi } from "vitest";
import { readFileSync, writeFileSync, readdirSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { host as createHost, reply, notingFact, consolidationReply, usage, type Reply } from "./test-host.ts";
import { compacted } from "../../source-fixture.ts";

const disposers: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of disposers.splice(0)) await dispose(); });
function host(...args: Parameters<typeof createHost>) {
  const h = createHost(...args);
  disposers.push(h.dispose);
  return h;
}

test("the fixture borrows PI_CODING_AGENT_DIR: two live hosts nest, and a failed shutdown still gives it back", async () => {
  const before = process.env.PI_CODING_AGENT_DIR;
  const outer = createHost(), inner = createHost();
  try {
    expect(process.env.PI_CODING_AGENT_DIR).toBe(join(inner.dir, "agent"));
    await inner.dispose();
    // The host that is still live keeps the variable; it is not reset to the value from before it.
    expect(process.env.PI_CODING_AGENT_DIR).toBe(join(outer.dir, "agent"));
  } finally {
    // Cleanup this fixture owns runs on the failure path too: a shutdown hook that throws must not
    // leave the process pointing at a directory this dispose is about to delete.
    outer.hooks.set("session_shutdown", () => { throw new Error("shutdown failed"); });
    await expect(outer.dispose()).rejects.toThrow("shutdown failed");
  }
  expect(process.env.PI_CODING_AGENT_DIR).toBe(before);
});

test("smoke: the default extension loads and registers the Pi hooks, tools, and read-only command", async () => {
  const h = host();
  expect([...h.tools.keys()]).toEqual(["trace", "search", "note", "memory"]);
  for (const name of ["agent_settled", "session_before_compact", "before_agent_start", "message_update", "message_end", "tool_result", "session_start", "session_before_tree", "session_tree"]) expect(h.hooks.has(name)).toBe(true);
  await h.emit("session_start");
  await h.commands.get("trace").handler("", h.ctx);
  expect(h.notices.at(-1)).toContain("Session: None (no assistant reply)");
  expect(h.memory.store.getSession(1)).toBeNull();
  expect(h.requests).toHaveLength(0);
});

test("2026-09-06 08:53 superseded 2026-09-08 (17b): five answered turns and 50K original Raw no longer trigger Noting", async () => {
  const h = host();
  for (let i = 0; i < 10; i++) await h.turn();
  await h.commands.get("trace").handler("", h.ctx);
  expect(h.requests).toEqual([]);
  expect(h.memory.pendingEntries(1, "main", 10)).toHaveLength(20);
});

test("17b supersedes 50K raw growth: compressed tool views alone do not trigger; an unanswered Turn remains pending", async () => {
  const h = host();
  await h.prompt(); await h.answer();
  await h.emit("tool_result", { toolName: "read", input: { path: "large.txt" }, content: [{ type: "text", text: "x".repeat(400_000) }], isError: false });
  await h.emit("agent_settled"); await h.drain();
  expect(h.requests).toEqual([]);
  await h.prompt("/a-command-without-a-reply");
  await h.emit("session_before_compact", { preparation: { tokensBefore: 10 } });
  expect(h.memory.store.listTurns(1).at(-1)?.assistantText).toBeNull();
  expect(h.requests).toEqual([]);
});

test("noting through runAgent commits the exact provider request, prompt, model, usage and subagent mode", async () => {
  const h = host({ "noting.triggerTokens": 30 });
  h.provider(async c => notingFact(c));
  await h.turn();
  const run = h.memory.store.listRuns(1)[0]!;
  expect(run.outcome).toBe("success");
  expect(run.mode).toBe("subagent"); expect(run.model).toBe("fake/test");
  expect(JSON.parse(run.request!)).toEqual(h.requests.at(-1));
  expect(h.conversations.at(-1)!.messages.map(m => m.role)).toEqual(["user", "assistant", "toolResult"]);
  expect(h.conversations[0]!.systemPrompt).toBe(readFileSync(new URL("../../../src/core/prompts/noting.md", import.meta.url), "utf8"));
  expect(h.conversations[0]!.messages).toHaveLength(1);
  expect(h.conversations[0]!.tools!.map(t => t.name)).toEqual(["trace", "search", "note", "memory"]);
  // Usage is summed over every model call of the run, not the last reply's alone.
  const calls = h.conversations.length;
  expect(JSON.parse(run.response!).usage).toEqual({ ...usage, input: usage.input * calls, output: usage.output * calls, totalTokens: usage.totalTokens * calls });
  expect(h.memory.store.listSessionFacts(1)[0]!.text).toBe("用 pnpm，不要 npm");
});

test("first prompt injects only global knowledge; project knowledge requires an explicit command", async () => {
  const h = host();
  writeFileSync(join(h.dir, ".trace-memory"), "project-name"); // Former markers have no attribution authority.
  const p = h.memory.store.createProject({ name: "project-name", declaredBy: "mark" });
  const s = h.memory.store.createSession({ enrollmentChoice: true, host: "fixture", projectId: p.id, startedAt: "now", firstReplyAt: "now" });
  const t = h.memory.store.appendTurn({ sessionId: s.id, kind: "turn", startedAt: "now", userPrompt: "规则" });
  const recorded = h.memory.store.commitNotingRun({ run: { kind: "noting", sessionId: s.id, createdAt: "now" }, facts: [
    { turnId: t.id, category: "observation", actor: "user", text: "规则", source: [`T${t.id}#user`], createdAt: "now" },
  ] });
  if (!recorded.ok) throw new Error(recorded.problems.join("; "));
  const seeded = h.memory.store.commitConsolidationRun({ run: { kind: "consolidation", sessionId: s.id, createdAt: "now" }, operations: [
    { op: "create", topics: [], reason: "Initial admission of this conclusion.", handle: "$e1", author: "fixture", text: "项目规则", supports: [recorded.facts[0]!.id], createdAt: "now", category: "constraint", scope: "project" },
    { op: "create", topics: [], reason: "Initial admission of this conclusion.", handle: "$e2", author: "fixture", text: "全局规则", supports: [recorded.facts[0]!.id], createdAt: "now", category: "constraint", scope: "global" },
  ] });
  expect(seeded.ok).toBe(true);
  const injection = await h.prompt();
  expect(injection.message.content).not.toContain("项目规则"); expect(injection.message.content).toContain("全局规则");
  expect(h.memory.store.getSession(2)).toBeNull();
  await h.answer();
  expect(h.memory.store.projectDeclaration(2)).toBe("undeclared");
  await h.commands.get("trace").handler("project project-name", h.ctx);
  // 31 (revising 29d for this one case): the declaration makes the project's knowledge applicable, and
  // the next prompt carries exactly what this conversation does not already hold — 项目规则, never the
  // 全局规则 the first prompt's block already supplied. Every later prompt carries nothing again.
  expect(h.memory.injection({ projectId: h.memory.store.getSession(2)!.projectId }).text).toContain("项目规则");
  const supplement = (await h.prompt())?.message;
  expect(supplement.content).toContain("项目规则");
  expect(supplement.content).not.toContain("全局规则");
  expect(supplement.details.traceMemory.generation).toBe(1);
  expect(supplement.details.traceMemory.supplied.knowledgeCommitIds).toEqual([1]);
  await h.answer(); await h.emit("agent_settled"); await h.drain();
  expect((await h.prompt("after"))?.message).toBeUndefined(); // one shot, never a running delivery
  await h.emit("session_start");
  expect(h.memory.status(2)).toContain("project-name (mark)");
  expect(h.requests).toHaveLength(0);
});

test("raw is incremental and compaction contains intermediate assistant text without calling a model", async () => {
  const h = host();
  await h.prompt();
  expect(h.memory.store.getSession(1)).toBeNull();
  await h.emit("message_update", { message: reply("partial") });
  // 17a supersedes partial-source compaction: streaming content is never an entry view.
  expect(h.memory.store.listTurns(1)[0]?.assistantText).toBeNull();
  await h.emit("tool_result", { toolName: "bash", input: { command: "pwd" }, content: [{ type: "text", text: "result" }], isError: false });
  expect(h.memory.store.listToolCalls(1)).toHaveLength(1);
  const block = await h.emit("session_before_compact", { preparation: { tokensBefore: 99, firstKeptEntryId: "old" } });
  expect(block.compaction.summary).toBe(compacted(h.memory.compact(1, "main", 1)));
  expect(block.compaction.summary).not.toContain("partial"); expect(block.compaction.firstKeptEntryId).toBe("");
  expect(h.requests).toHaveLength(0);
  await h.emit("session_compact", { compactionEntry: h.compaction(block.compaction.summary), fromExtension: true });
  expect(h.memory.store.listTurns(1)[1]!.kind).toBe("compaction");
  await h.answer("finished"); await h.emit("agent_settled");
  await h.prompt("next"); await h.emit("message_start", { message: reply("") });
  expect(h.memory.store.listTurns(1)[2]!.assistantText).toBeNull();
});

// 29d (ticket 29, "Retire automatic foreground receipt delivery") supersedes the ruling this test
// pinned, "a pending delivery is injected once on its own branch": there is no delivery to place on a
// branch. The same scenario is kept as its negative -- acceptance case 22 -- because the branch
// machinery around it (a worker committing after a tree switch) is exactly where a leftover receipt
// would surface. The foreground learns F1 through a later compaction or an explicit read instead.
// Ticket 29d, acceptance case 24 ("Operation boundaries"). Retiring the receipt queue removed the
// one thing that used to make a worker's completion interesting to the foreground; nothing replaced
// it. A commit is a terminal event: it starts no follow-up run of its own, and a tree switch — which
// re-selects a context and used to reset the injected-once flag — launches no extraction either.
// Manual catchup and borrowed work stay subagent, and their slots and claims are pinned by
// `catchup.test.ts`; what is pinned here is the absence of a drain loop behind an ordinary commit.
test("29d case 24: a worker's completion starts no drain loop, and a tree switch launches nothing", async () => {
  const h = host({ "noting.triggerTokens": 30 });
  h.provider(async c => notingFact(c));
  await h.turn(); // one Noting run over T1, committing F1
  const after = h.requests.length;
  expect(h.memory.store.listRuns(1).map(r => r.outcome)).toEqual(["success"]);
  // Settling again, draining again and idling start nothing: the commit is not itself a trigger.
  await h.emit("agent_settled"); await h.emit("agent_end"); await h.drain();
  expect(h.requests).toHaveLength(after);
  expect(h.memory.store.listRuns(1)).toHaveLength(1);
  // A tree switch re-selects the context and launches no extraction of its own.
  await h.emit("session_tree"); await h.drain();
  expect(h.requests).toHaveLength(after);
  expect(h.memory.store.listRuns(1)).toHaveLength(1);
  expect(h.memory.store.db.prepare("SELECT COUNT(*) AS n FROM pending_deliveries").get()).toEqual({ n: 0 });
});

test("29d case 22: a worker's commit reaches no later prompt, on the branch it ran on or a sibling", async () => {
  const h = host({ "noting.triggerTokens": 30 });
  let release!: (value: Reply) => void;
  h.provider(async () => new Promise(resolve => { release = resolve; }));
  await h.turn();
  const original = [...h.entries];
  await h.prompt("second"); await h.answer();
  const mainTip = [...h.entries];
  release(notingFact(h.conversations[0]!)); await h.drain();
  expect(h.memory.store.listSessionFacts(1)).toHaveLength(1); // the fact is committed and readable
  expect(h.memory.store.db.prepare("SELECT COUNT(*) AS n FROM pending_deliveries").get()).toEqual({ n: 0 });
  const injected = async () => (await h.prompt())?.message?.content ?? "";
  h.entries.splice(0, h.entries.length, ...original);
  await h.emit("session_tree");
  expect(await injected()).not.toContain("noted");
  h.entries.splice(0, h.entries.length, ...mainTip); await h.emit("session_tree");
  expect(await injected()).not.toContain("noted");
  expect(await injected()).not.toContain("[F1]");
  h.provider(async c => notingFact(c));
  await h.answer(); await h.emit("agent_settled"); await h.drain();
  expect(await injected()).not.toContain("[F1]"); // settling confirms nothing; there is nothing queued
  expect(h.memory.trace("F1")).toContain("[F1]"); // an explicit read still reaches it
});

// 29d supersedes the 2026-09-07 ruling this test pinned ("deliveries and the first injection are
// confirmed at agent_settled with only the run ids that prompt took"): nothing is confirmed at settle
// any more. The injection half of it is retargeted to 29a's baseline -- the knowledge block is offered
// until the *selected context* carries a marked injection of ours, so a prompt Pi never persisted
// injects again (duplicates over silent loss) and a persisted one ends it without a settle. The
// delivery half has no subject and is asserted as its negative.
test("29d: the knowledge block is offered until the selected context carries it, and the settle confirms nothing", async () => {
  const h = host({ "noting.triggerTokens": 30 });
  const store = h.memory.store, p = store.createProject({ name: "project-name", declaredBy: "mark" });
  const seed = store.createSession({ enrollmentChoice: true, host: "fixture", projectId: p.id, startedAt: "now", firstReplyAt: "now" });
  const st = store.appendTurn({ sessionId: seed.id, kind: "turn", startedAt: "now", userPrompt: "规则" });
  const noted = store.commitNotingRun({ run: { kind: "noting", sessionId: seed.id, createdAt: "now" }, facts: [{ turnId: st.id, category: "decision", actor: "user", text: "规则", source: [`T${st.id}#user`], createdAt: "now" }] });
  if (!noted.ok) throw new Error("seed");
  store.commitConsolidationRun({ run: { kind: "consolidation", sessionId: seed.id, createdAt: "now" }, operations: [{ op: "create", topics: [], reason: "Initial admission of this conclusion.", handle: "$e1", author: "fixture", text: "全局规则", supports: [noted.facts[0]!.id], createdAt: "now", category: "constraint", scope: "global" }] });
  // A prompt whose message Pi never persisted leaves no baseline, so the next prompt offers it again.
  const offered = await h.emit("before_agent_start", { prompt: "dropped", systemPrompt: "host" });
  expect(offered?.message?.content).toContain("<knowledge>");
  expect((await h.prompt())?.message?.content).toContain("<knowledge>");
  // `prompt` persisted that message as a `custom_message` carrying its commit ids: the baseline exists
  // now, with no settle and no `injected` flag in the host's own state entries.
  expect(h.entries.some(e => e.data?.injected !== undefined)).toBe(false);
  expect((await h.prompt("again"))?.message).toBeUndefined();
  await h.answer(); await h.emit("agent_settled"); await h.drain();
  expect((await h.prompt("third"))?.message).toBeUndefined();
  // A worker committing mid-turn changes none of it: no receipt on the next prompt, no queue behind it.
  let release!: (value: Reply) => void;
  h.provider(async () => new Promise(resolve => { release = resolve; }));
  await h.prompt("one"); await h.answer(); await h.emit("agent_settled"); await h.drain(); // noting A in flight
  await h.prompt("two");
  release(notingFact(h.conversations.at(-1)!)); await h.drain(); // A commits during turn two
  h.provider(async c => notingFact(c));
  await h.answer(); await h.emit("agent_settled"); await h.drain();
  expect(h.memory.store.db.prepare("SELECT COUNT(*) AS n FROM pending_deliveries").get()).toEqual({ n: 0 });
  expect((await h.prompt("three"))?.message?.content ?? "").not.toContain("<noted>");
});

test("in-flight duplicate is dropped; new raw and branch switches cannot change its frozen range", async () => {
  const h = host({ "noting.triggerTokens": 30 });
  let release!: (value: Reply) => void;
  h.provider(async () => new Promise(resolve => { release = resolve; }));
  await h.prompt(); await h.answer(); await h.emit("agent_settled");
  await h.emit("agent_settled"); await h.drain(); expect(h.requests).toHaveLength(1);
  const old = [...h.entries];
  await h.prompt("later raw"); await h.answer();
  h.entries.splice(0, h.entries.length, ...old);
  await h.emit("session_tree");
  release(notingFact(h.conversations[0]!)); await h.drain();
  expect(h.memory.store.sourcePath(1, "main", 1).length).toBeGreaterThan(0);
  expect(h.memory.store.sourcePath(1, "main", 1).every(e => h.memory.store.entryNoted(e.id))).toBe(true);
  expect(h.conversations[0]!.messages[0]!.content).not.toContain("later raw");
});

test("consolidation waits for a turn stop after facts arrive and final replays candidate plus one feedback message", async () => {
  const h = host({ "noting.triggerTokens": 30, "consolidation.triggerTokens": 1, consolidationModel: "fake/Consolidator" });
  const output = consolidationReply();
  h.provider(async c => c.systemPrompt!.includes("### Second-round user message") ? output : notingFact(c));
  await h.turn();
  expect(h.requests).toHaveLength(2); // Only the noting tool loop; no Consolidation trigger.
  await h.answer("next completed source"); await h.emit("agent_settled"); await h.drain();
  expect(h.requests).toHaveLength(5);
  const candidate = h.conversations[2]!, final = h.conversations[3]!;
  expect(final.systemPrompt).toBe(candidate.systemPrompt);
  expect(final.messages.slice(0, 1)).toEqual(candidate.messages);
  expect(final.messages[1]).toMatchObject({ role: "assistant", content: output.content });
  expect(final.messages).toHaveLength(4); expect(final.messages[2]!.role).toBe("toolResult"); expect(final.messages[3]!.role).toBe("user");
  const runs = h.memory.store.listRuns(1).filter(r => r.kind === "consolidation");
  expect(runs.map(r => r.outcome)).toEqual(["success"]);
  expect(runs.map(r => r.model)).toEqual(["fake/Consolidator"]);
  expect(JSON.parse(runs[0]!.request!)).toEqual(h.requests[4]);
});

test.each(["new", "resume", "fork"])("shutdown for session replacement (%s) waits for pending runs — superseded 17c 2026-09-08: cancels, launches nothing, and closes the store", async reason => {
  const h = host({ "noting.triggerTokens": 30 });
  let release!: (value: Reply) => void;
  h.provider(async () => new Promise(resolve => { release = resolve; }));
  await h.turn();
  await h.drain();
  const shutdown = h.emit("session_shutdown", { reason });
  release(notingFact(h.conversations[0]!)); await shutdown;
  expect(h.memory.store.listRuns(1)[0]!.outcome).toBe("cancelled"); expect(h.requests).toHaveLength(1);
  expect(h.memory.pendingEntries(1, "main", 1)).toHaveLength(2);
  expect(h.memory.store.getSession(1)!.closedAt).not.toBeNull();
  await expect(h.emit("session_start")).rejects.toThrow(/not open/); // Pi re-runs the factory; this instance is dead.
});

test("core contains no Pi imports and host imports core only through the facade", () => {
  const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]);
  for (const file of files("src/core").filter(f => f.endsWith(".ts"))) expect(readFileSync(file, "utf8")).not.toMatch(/(?:from\s*|import\s*\(|require\s*\()["'][^"']*(?:pi-coding-agent|pi-ai|pi-agent-core|hosts\/pi)/);
  expect(readFileSync("src/hosts/pi/index.ts", "utf8").match(/from "\.\.\/\.\.\/core\/[^\"]+"/g)).toEqual(['from "../../core/api/index.ts"']);
});

test("17b supersedes watermark growth: compressed source labels count along with CJK content", async () => {
  const h = host({ "noting.triggerTokens": 16 }); // the two labels and their two characters, and nothing else
  await h.prompt("一"); await h.answer("a"); await h.drain();
  expect(h.requests).toHaveLength(2); // 26a: the submitting round and its closing reply
  expect(h.memory.pendingEntries(1, "main", 1)).toEqual([]);
});

test("provider failures retain captured request and do not advance a watermark", async () => {
  const h = host({ "noting.triggerTokens": 30 });
  h.provider(async () => { throw new Error("provider unavailable"); });
  await h.turn();
  const run = h.memory.store.listRuns(1)[0]!;
  expect(run.outcome).toBe("failure"); expect(JSON.parse(run.request!)).toEqual(h.requests[0]);
  expect(h.memory.store.listSourceEntries(1).some(e => h.memory.store.entryNoted(e.id))).toBe(false);
});

test("consolidation in-flight duplicates cannot erase the candidate continuation", async () => {
  const h = host({ "noting.triggerTokens": 30, "consolidation.triggerTokens": 1 });
  h.provider(async c => notingFact(c)); await h.turn();
  const output = consolidationReply();
  let release!: (value: Reply) => void;
  h.provider(async c => c.messages.length === 1 ? new Promise(resolve => { release = resolve; }) : output);
  await h.answer("next completed source"); await h.emit("agent_settled"); await h.emit("agent_settled"); await h.drain();
  expect(h.requests).toHaveLength(3);
  release(output); await h.drain();
  expect(h.requests).toHaveLength(5);
  expect(h.memory.store.listRuns(1).map(r => r.outcome)).toEqual(["success", "success"]);
});

test("knowledge is injected once per visible baseline, only once something exists; later prompts carry nothing (29d)", async () => {
  const h = host();
  expect((await h.prompt())?.message?.content ?? "").not.toContain("<knowledge>"); // empty store: no block at all
  await h.answer();
  const p = h.memory.store.getSession(1)!.projectId;
  const t = h.memory.store.getTurn(1)!;
  const recorded = h.memory.store.commitNotingRun({ run: { kind: "noting", sessionId: 1, createdAt: "2026-09-06T00:00:00Z" },
    facts: [{ turnId: t.id, category: "decision", actor: "user", text: "用 pnpm", source: ["T1#user"], createdAt: "2026-09-06T00:00:00Z" }] });
  if (!recorded.ok) throw new Error("setup");
  h.memory.store.commitConsolidationRun({ run: { kind: "consolidation", sessionId: 1, createdAt: "2026-09-06T00:00:00Z" }, operations: [
    { op: "create", topics: [], reason: "Initial admission of this conclusion.", handle: "$e1", author: "t", text: "项目用 pnpm。", category: "constraint", scope: "project", supports: [recorded.facts[0]!.id], createdAt: "2026-09-06T00:00:00Z" }] });
  void p;
  const second = await h.prompt("again");
  expect(second?.message?.content).toContain("<knowledge>");
  // 29d: the baseline is the persisted carrier on that message, not a settle-time flag.
  await h.answer(); await h.emit("agent_settled");
  const third = await h.prompt("once more");
  expect(third?.message?.content ?? "").not.toContain("<knowledge>");
});


test.each(["file", "empty", "directory"])("project discovery ignores .trace-memory %s at cwd and ancestors", async kind => {
  const h = host();
  const path = join(h.dir, ".trace-memory");
  if (kind === "directory") mkdirSync(path); else writeFileSync(path, kind === "file" ? "shared" : "");
  await h.turn(); // Includes the storage-directory collision that used to fail at session_start.
  const first = h.memory.store.getSession(1)!.projectId;
  h.entries.length = 0; h.ctx.sessionManager.getSessionId = () => "same-directory-session";
  await h.emit("session_start"); await h.turn();
  const second = h.memory.store.getSession(2)!.projectId;
  const nested = join(h.dir, "worktrees", "feature"); mkdirSync(nested, { recursive: true });
  writeFileSync(join(nested, ".trace-memory"), "shared");
  h.entries.length = 0; h.ctx.sessionManager.getSessionId = () => "nested-session"; h.ctx.cwd = nested;
  await h.emit("session_start"); await h.turn();
  expect(new Set([first, second, h.memory.store.getSession(3)!.projectId]).size).toBe(3);
  for (const id of [1, 2, 3]) expect(h.memory.store.projectDeclaration(id)).toBe("undeclared");
  expect(h.memory.store.findProjectByName("shared")).toBeNull();
  expect(h.requests).toEqual([]);
});

test("explicit project names share across sessions and survive tree restoration without moving peers", async () => {
  const h = host();
  await h.turn(); const first = [...h.entries];
  await h.commands.get("trace").handler("project shared", h.ctx);
  const original = h.memory.store.getSession(1)!.projectId;
  h.entries.length = 0; h.ctx.sessionManager.getSessionId = () => "peer";
  await h.emit("session_start"); await h.turn();
  await h.commands.get("trace").handler("project shared", h.ctx);
  const shared = h.memory.store.getSession(2)!.projectId;
  expect(shared).toBe(original);
  writeFileSync(join(h.dir, ".trace-memory"), "unrelated");
  await h.commands.get("trace").handler("project override", h.ctx);
  expect(h.entries.at(-1).data.project).toBe("override");
  expect(h.entries.at(-1).data.projectId).toBe(h.memory.store.getSession(2)!.projectId);
  await h.emit("session_tree");
  expect(h.memory.status(2)).toContain("override (mark)");
  expect(h.memory.store.getProject(shared)!.mergedInto).toBeNull();
  h.entries.splice(0, h.entries.length, ...first); h.ctx.sessionManager.getSessionId = () => "pi-test";
  await h.emit("session_start");
  expect(h.memory.status(1)).toContain("shared (mark)");
});

test("provisional host state cannot restore a former file-derived shared project", async () => {
  const h = host(); await h.emit("session_start");
  const project = h.memory.store.createProject({ name: "former-marker-project", declaredBy: "marker" });
  h.entries.at(-1).data.projectId = project.id; // A prior version saved this before any assistant reply.
  await h.emit("session_start");
  expect(h.entries.at(-1).data.projectId).not.toBe(project.id);
  expect(h.memory.store.getSession(1)).toBeNull();
  await h.turn();
  expect(h.memory.store.getSession(1)!.projectId).not.toBe(project.id);
  expect(h.memory.store.projectDeclaration(1)).toBe("undeclared");
  expect(h.memory.store.getProject(project.id)!.mergedInto).toBeNull();
});

test("removing file discovery preserves stored project attribution on restore", async () => {
  const h = host(); await h.turn();
  h.memory.declareProject(1, "stored-project", "marker"); // A declaration already persisted by a prior version.
  const project = h.memory.store.getSession(1)!.projectId;
  writeFileSync(join(h.dir, ".trace-memory"), "different-project");
  await h.emit("session_start");
  expect(h.memory.store.getSession(1)!.projectId).toBe(project);
  expect(h.memory.status(1)).toContain("stored-project (marker)");
  expect(h.memory.store.findProjectByName("different-project")).toBeNull();
  expect(h.requests).toEqual([]);
});

test("declaring an own project moves facts and project knowledge, preserves session scope, and injects immediately", async () => {
  const h = host({ "noting.triggerTokens": 30 });
  h.provider(async c => notingFact(c)); await h.turn();
  const store = h.memory.store, own = store.getSession(1)!.projectId;
  const seed = (sessionId: number, fact: number, scopes: ("project" | "session")[]) => {
    const commit = store.commitConsolidationRun({ run: { kind: "consolidation", sessionId, createdAt: "now" }, operations: scopes.map((scope, i) => ({
      op: "create", topics: [], reason: "Initial admission of this conclusion." as const, handle: `$e${i + 1}`, author: "fixture", text: scope === "project" ? "用 pnpm，不要 npm" : "仅当前会话", supports: [fact],
      createdAt: "now", category: "constraint" as const, scope,
    })) });
    expect(commit.ok).toBe(true);
  };
  seed(1, 1, ["project", "session"]);
  const sessionRevision = store.getKnowledgeRevision(2, 2);
  const target = store.createProject({ name: "named", declaredBy: "mark" });
  const peer = store.createSession({ enrollmentChoice: true, host: "peer", projectId: target.id, startedAt: "now", firstReplyAt: "now" });
  const turn = store.appendTurn({ sessionId: peer.id, kind: "turn", startedAt: "now", userPrompt: "用 pnpm，不要 npm" });
  const recorded = store.commitNotingRun({ run: { kind: "noting", sessionId: peer.id, createdAt: "now" }, facts: [
    { turnId: turn.id, category: "observation", actor: "user", text: "用 pnpm，不要 npm", source: [`T${turn.id}#user`], createdAt: "now" },
  ] });
  if (!recorded.ok) throw new Error(recorded.problems.join("; "));
  seed(peer.id, recorded.facts[0]!.id, ["project"]);
  expect((await h.prompt("before"))?.message?.content).toContain("<knowledge>"); // the own project's knowledge is already injected
  await h.answer();
  await h.commands.get("trace").handler("project named", h.ctx);
  expect(store.getProject(own)!.mergedInto).toBe(target.id);
  expect(store.listProjectFacts(own)).toEqual([]);
  expect(store.listProjectFacts(target.id)).toHaveLength(2);
  // Both duplicate project knowledge are now in the next consolidation's NEAR pool.
  expect(store.getKnowledge(1)!.projectId).toBe(target.id);
  expect(store.getKnowledge(3)!.projectId).toBe(target.id);
  expect(store.listVisibleKnowledge(1, target.id).map(v => v.knowledge.id)).toEqual([1, 2, 3]);
  expect(store.getKnowledgeRevision(2, 2)).toEqual(sessionRevision);
  expect(h.memory.inject(peer.id)).not.toContain("仅当前会话");
  expect(h.memory.inject(1)).toContain("仅当前会话");
  // 31: the merged project's knowledge is applicable at once, and the project command is a supplement
  // trigger, so the next prompt carries the peer's K3 alone — the two commits the "before" prompt
  // already injected are visible at the same version and are never repeated.
  expect(h.memory.inject(1)).toContain("用 pnpm，不要 npm");
  const supplement = (await h.prompt("next"))?.message;
  expect(supplement.details.traceMemory.supplied.knowledgeCommitIds).toEqual([3]);
  expect(supplement.content).not.toContain("仅当前会话");
  await h.answer(); await h.emit("agent_settled"); await h.drain();
  expect((await h.prompt("later"))?.message).toBeUndefined();
});

test("before-tree waits for a frozen pending noting and summarizes its facts plus later raw, and delivers nothing on either branch (29d)", async () => {
  const h = host({ "noting.triggerTokens": 30 });
  let release!: (value: Reply) => void;
  h.provider(async () => new Promise(resolve => { release = resolve; }));
  await h.turn(); const forkPoint = [...h.entries];
  await h.prompt("later unrecorded raw"); await h.answer("later reply");
  const tip = [...h.entries];
  let finished = false;
  const switching = h.emit("session_before_tree", { preparation: { userWantsSummary: true } }).then(r => { finished = true; return r; });
  await h.drain(); expect(finished).toBe(true); expect(h.requests).toHaveLength(1);
  const result = await switching;
  expect(result.summary.summary).not.toContain("[F1]");
  expect(result.summary.summary).toBe(h.memory.branchSummary(1, "main", 2));
  release(notingFact(h.conversations[0]!)); await h.drain();
  expect(result.summary.summary).toContain("later unrecorded raw");
  expect(result.summary.summary).toContain("later reply");
  expect(h.conversations[0]!.messages[0]!.content).not.toContain("later unrecorded raw");
  expect(h.memory.store.sourcePath(1, "main", 1).length).toBeGreaterThan(0);
  expect(h.memory.store.sourcePath(1, "main", 1).every(e => h.memory.store.entryNoted(e.id))).toBe(true);
  expect(h.memory.store.listRuns(1)[0]!.branch).toBe("main");
  h.entries.splice(0, h.entries.length, ...forkPoint); await h.emit("session_tree");
  const branch = h.entries.filter(e => e.type === "custom").at(-1).data.branch;
  expect(branch).not.toBe("main");
  expect((await h.prompt())?.message?.content ?? "").not.toContain("noted");
  h.entries.splice(0, h.entries.length, ...tip); await h.emit("session_tree");
  // 29d: the branch the Noter actually ran on receives no receipt either -- the summary above is the
  // one place this conversation's own facts are still assembled for it.
  expect((await h.prompt())?.message?.content ?? "").not.toContain("noted");
  expect(h.memory.store.db.prepare("SELECT COUNT(*) AS n FROM pending_deliveries").get()).toEqual({ n: 0 });
});

test.each(["success", "failure", "unavailable"])("before-tree attempts subagent noting below threshold: %s", async outcome => {
  const h = host();
  h.provider(async c => { if (outcome === "failure") throw new Error("offline"); return notingFact(c); });
  await h.turn();
  if (outcome === "unavailable") h.ctx.model = undefined;
  const result = await h.emit("session_before_tree");
  expect(result.summary.summary).toContain("用 pnpm，不要 npm");
  expect(result.summary.summary).toContain("好的。");
  expect(result.summary.summary).not.toContain("[F1]");
  expect(h.memory.pendingEntries(1, "main", 1)).toHaveLength(2);
  expect(h.requests).toEqual([]);

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
  const h = host({ "noting.triggerTokens": 30 });
  h.provider(async c => notingFact(c)); await h.turn();
  const point = [...h.entries];
  await h.prompt("abandoned tail"); await h.answer("tail reply");
  const summary = await h.emit("session_before_tree");
  expect(summary.summary.summary).toContain("[F1]");
  expect(summary.summary.summary).not.toContain("[F2]");
  expect(summary.summary.summary).toContain("abandoned tail");
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
  await h.commands.get("trace").handler("project named", h.ctx);
  expect(h.memory.status(1)).toContain("named (mark)");
});


test("a former marker cannot make a new session merge an existing shared project", async () => {
  const h = host(); await h.turn();
  await h.commands.get("trace").handler("project shared", h.ctx);
  const shared = h.memory.store.getSession(1)!.projectId;
  writeFileSync(join(h.dir, ".trace-memory"), "shared");
  h.entries.length = 0; h.ctx.sessionManager.getSessionId = () => "new-session";
  await h.emit("session_start"); await h.prompt();
  unlinkSync(join(h.dir, ".trace-memory")); await h.answer();
  expect(h.memory.store.getSession(2)!.projectId).not.toBe(shared);
  await h.commands.get("trace").handler("project override", h.ctx);
  expect(h.memory.store.getSession(1)!.projectId).toBe(shared);
  expect(h.memory.store.getProject(shared)!.mergedInto).toBeNull();
});

// 29d supersedes both rulings this test pinned -- the 08:53 premise that "a fork note waits until a
// note result committed mid-turn has been delivered", and its 2026-09-08 amendment that an enabled
// session always receives that delivery. The wait went with the delivery: a fork-mode Noting task is
// no longer held until its predecessor's facts reached the foreground, so both modes now advance
// identically and neither prompt carries a receipt. Phase slots, enrollment, the readiness wait and
// claim checks still gate the launch and are exercised by their own tests.
test.each([true, false])("29d: a fork note (%s) waits for no receipt; both modes advance identically and neither prompt carries one", async forkMode => {
  const h = host({ "noting.triggerTokens": 30, "noting.forkModeDefault": forkMode, notingModel: "fake/noter" });
  let release!: (value: Reply) => void;
  h.provider(async () => new Promise(resolve => { release = resolve; }));
  await h.turn(); // Noting A in flight over T1.
  await h.prompt("second"); await h.answer();
  release(notingFact(h.conversations[0]!)); await h.drain();
  expect(h.memory.store.db.prepare("SELECT COUNT(*) AS n FROM pending_deliveries").get()).toEqual({ n: 0 });
  h.provider(async c => notingFact(c));
  await h.emit("agent_settled"); await h.answer("tick"); await h.drain();
  expect(h.requests).toHaveLength(4);
  expect(String((await h.prompt("third"))?.message?.content ?? "").includes("noted")).toBe(false);
  await h.answer(); await h.emit("agent_settled"); await h.answer("tick"); await h.drain();
  expect(h.requests).toHaveLength(6);
  expect(h.memory.store.listRuns(1).at(-1)).toMatchObject({ rangeFrom: "S1/T3", rangeTo: "S1/T3" });
});

test("spec overflow policy: a subagent noting fetches cut evidence through the trace tool; the run records the fetch and the last request", async () => {
  const h = host({ "noting.triggerTokens": 1000, "noting.forkModeDefault": false, notingModel: "fake/noter" });
  await h.prompt(); await h.answer();
  await h.emit("tool_result", { toolName: "Bash", input: { command: "pnpm test" }, content: [{ type: "text", text: "x".repeat(5000) + "\n1 passed" }], isError: false });
  const call = { type: "toolCall" as const, id: "call-1", name: "trace", arguments: { address: "T1", tool: 1, full: true } };
  h.provider(async c => c.messages.length === 1 ? { ...reply(""), content: [call], stopReason: "toolUse" } : notingFact(c));
  await h.answer("word ".repeat(1000)); await h.emit("agent_settled"); await h.drain();
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

test("an consolidation call carries no tools; a noting tool call for a bad address returns an error result and the noting still completes", async () => {
  const h = host({ "noting.triggerTokens": 30, "noting.forkModeDefault": false, "consolidation.triggerTokens": 1 });
  const call = { type: "toolCall" as const, id: "call-2", name: "trace", arguments: { address: "K999" } };
  const output = consolidationReply();
  h.provider(async c => c.systemPrompt!.includes("### Second-round user message") ? output
    : c.messages.length === 1 ? { ...reply(""), content: [call], stopReason: "toolUse" } : notingFact(c));
  await h.turn();
  const result = h.conversations[1]!.messages[2] as { isError: boolean; content: { text: string }[] };
  expect(result.isError).toBe(true); expect(result.content[0]!.text).toContain("does not exist");
  await h.answer("next completed source"); await h.emit("agent_settled"); await h.drain();
  expect(h.conversations.slice(3).map(c => c.tools!.map(t => t.name))).toEqual(Array.from({ length: 3 }, () => ["trace", "search", "note", "memory"]));
  expect(h.memory.store.listRuns(1).map(r => [r.kind, r.outcome])).toEqual([["noting", "success"], ["consolidation", "success"]]);
});

test("main facade tools bind each call to the current turn, commit immediately and record raw only at tool_result", async () => {
  const h = host({ "noting.triggerTokens": 1000000000 });
  await h.prompt();
  await h.emit("message_end", { message: { ...reply(""), content: [{ type: "toolCall", id: "n1", name: "note", arguments: {} }] } });
  const call = async (name: string, input: unknown) => {
    const result = await h.tools.get(name).execute("call", input, undefined, undefined, h.ctx);
    // 17a: the persisted assistant call is already a source; its result is still pending.
    expect(h.memory.store.listToolCalls(h.memory.store.listTurns(1).at(-1)!.id).every(c => c.result === null)).toBe(true);
    await h.emit("tool_result", { toolCallId: name === "note" ? "n1" : undefined, toolName: name, input, ...result, isError: false });
    return result.content[0].text as string;
  };
  const note = { facts: [{ category: "decision", actor: "user", text: "Use pnpm", source: ["T1#user"] }] };
  expect(await call("note", note)).toContain("ok: F1");
  expect(h.memory.store.listSessionFacts(1)).toHaveLength(1);
  expect(h.memory.store.listRuns(1)[0]).toMatchObject({ kind: "manual", branch: "main", rangeFrom: "S1/T1", request: JSON.stringify(note) });
  expect(h.memory.store.listToolCalls(1)).toHaveLength(1);
  await h.prompt("Make it durable"); await h.answer();
  const batch = { operations: [{ op: "create", topics: [], reason: "Initial admission of this conclusion.", text: "Use pnpm", category: "constraint", scope: "project", supports: ["F1"] }], skipped: [] };
  expect(await call("memory", batch)).not.toContain("rejected:");
  expect(h.memory.store.getKnowledge(1)).not.toBeNull();
  expect(h.memory.store.listRuns(1).at(-1)).toMatchObject({ kind: "manual", rangeFrom: "S1/T2", request: JSON.stringify(batch) });
  expect(h.memory.store.listToolCalls(2)).toHaveLength(1);
  for (const kind of ["verified", "flagged", "clear"]) {
    await h.commands.get("trace").handler(`mark K1 ${kind}`, h.ctx);
    expect(h.notices.at(-1)).not.toContain("rejected:");
  }
  const before = h.memory.store.listRuns(1);
  await h.commands.get("trace").handler("", h.ctx);
  expect(h.memory.store.listRuns(1)).toEqual(before);
  expect(h.requests).toHaveLength(0);
});


test("subagent runs receive the same four definitions registered for the main agent: name, description, schema", async () => {
  const h = host({ "noting.forkModeDefault": false, "noting.triggerTokens": 30 });
  const original = h.ctx.modelRegistry.complete.bind(h.ctx.modelRegistry);
  vi.spyOn(h.ctx.modelRegistry, "complete").mockImplementation(async (model, conversation, options) => {
    expect(conversation.tools).toHaveLength(4);
    for (const definition of conversation.tools!) {
      const registered = h.tools.get(definition.name);
      expect([definition.description, definition.parameters]).toEqual([registered.description, registered.parameters]);
      expect("execute" in definition).toBe(false); // the model sees metadata only
    }
    return original(model, conversation, options);
  });
  h.provider(async c => notingFact(c));
  await h.turn();
  expect(h.memory.store.listRuns(1)[0]!.outcome).toBe("success");
});

test("rejected manual writes throw for Pi to record one failed raw tool call", async () => {
  const h = host(); await h.prompt(); await h.answer();
  const input = { facts: [{ invalid: true }] };
  let error: Error | undefined;
  try { await h.tools.get("note").execute("bad", input, undefined, undefined, h.ctx); }
  catch (caught) { error = caught as Error; }
  expect(error?.message).toContain("rejected:");
  expect(h.memory.store.listToolCalls(1)).toHaveLength(0);
  await h.emit("tool_result", { toolName: "note", input, content: [{ type: "text", text: error!.message }], isError: true });
  expect(h.memory.store.listToolCalls(1)).toEqual([expect.objectContaining({ name: "note", status: "failure" })]);
  expect(h.memory.store.listSessionFacts(1)).toHaveLength(0);
  expect(h.memory.store.listRuns(1)).toEqual([expect.objectContaining({ kind: "manual", outcome: "bounced" })]);
});


test("main trace can fetch historical rejected tool evidence without becoming a failed call", async () => {
  const h = host(); await h.prompt(); await h.answer();
  await h.emit("tool_result", { toolName: "read", input: {}, content: [{ type: "text", text: "rejected: previous operation" }], isError: true });
  const input = { address: "T1", tool: 1, full: true };
  const result = await h.tools.get("trace").execute("read-old", input, undefined, undefined, h.ctx);
  expect(result.content[0].text).toContain("rejected: previous operation");
  await h.emit("tool_result", { toolName: "trace", input, ...result, isError: false });
  expect(h.memory.store.listToolCalls(1).map(c => c.status)).toEqual(["failure", "success"]);
});

test("18:39: two memory submissions in one reply cannot skip the checklist; the second commits only after the feedback was sent", async () => {
  const h = host({ "noting.triggerTokens": 30, "consolidation.triggerTokens": 1 });
  h.provider(async c => notingFact(c)); await h.turn();
  const double = { ...consolidationReply(), content: [consolidationReply().content[0]!, { ...consolidationReply().content[0]!, id: "memory-2" }] } as Reply;
  h.provider(async c => c.messages.some(m => m.role === "toolResult") ? consolidationReply() : double);
  await h.answer("next completed source"); await h.emit("agent_settled"); await h.drain();
  // The request after the double reply: user, assistant (two calls), two results, then the checklist.
  const second = h.conversations.find(c => c.messages.length === 5)!.messages;
  expect(second.map(m => m.role)).toEqual(["user", "assistant", "toolResult", "toolResult", "user"]);
  const results = second.filter(m => m.role === "toolResult") as { content: { text: string }[] }[];
  expect(results[0]!.content[0]!.text).toContain("feedback");
  expect(results[1]!.content[0]!.text).toContain("rejected: the review feedback has not been read yet");
  const run = h.memory.store.listRuns(1).filter(r => r.kind === "consolidation")[0]!;
  expect(run.outcome).toBe("success");
  const calls = JSON.parse(run.response!).toolCalls.map((c: { result: string }) => c.result.slice(0, 40));
  expect(calls).toHaveLength(3); // feedback, rejected, committed: the commit came from the request after the checklist
  expect(calls[2]).toContain("committed");
});

test("maxToolRounds is a budget: unlimited by default, and a run over an explicit budget fails without committing", async () => {
  const unlimited = host({ "noting.triggerTokens": 30, "noting.forkModeDefault": false });
  let calls = 0;
  const looping = (c: Parameters<typeof notingFact>[0]) => c.messages.filter(m => m.role === "toolResult").length < 20
    ? { ...reply(""), stopReason: "toolUse" as const, content: [{ type: "toolCall" as const, id: `t${++calls}`, name: "trace", arguments: { address: "T1" } }] } : notingFact(c);
  unlimited.provider(async c => looping(c)); await unlimited.turn();
  expect(unlimited.memory.store.listRuns(1)[0]!.outcome).toBe("success");
  expect(unlimited.conversations.length).toBeGreaterThan(20);
  const capped = host({ "noting.triggerTokens": 30, "noting.forkModeDefault": false, "noting.maxToolRounds": 2 });
  capped.provider(async c => looping(c)); await capped.turn();
  const run = capped.memory.store.listRuns(1)[0]!;
  expect(run.outcome).toBe("failure"); expect(JSON.parse(run.response!).problems[0]).toContain("tool rounds exceeded (2)");
  expect(capped.memory.store.listSourceEntries(1).some(e => capped.memory.store.entryNoted(e.id))).toBe(false);
});

// 29d supersedes the ruling this test pinned ("a queued user message mid-run does not lose the
// confirmation of what the prompt injected and delivered"): there is no confirmation left to lose,
// because what a prompt supplied is stated on the entry Pi persisted for it rather than on a
// settle-time acknowledgement. The steering path is kept as the negative.
test("29d: a queued user message mid-run finds no receipt to carry and no confirmation to lose", async () => {
  const h = host({ "noting.triggerTokens": 30 });
  h.provider(async c => notingFact(c));
  await h.turn(); // noting of T1 commits F1
  expect((await h.prompt("two"))?.message?.content ?? "").not.toContain("<noted>");
  await h.emit("message_start", { message: { role: "user", content: "steer: keep going", timestamp: Date.now() } }); // queued message replaces the turn
  await h.answer(); await h.emit("agent_settled"); await h.drain();
  expect(h.memory.store.db.prepare("SELECT COUNT(*) AS n FROM pending_deliveries").get()).toEqual({ n: 0 });
  expect(h.memory.store.listSessionFacts(1)).toHaveLength(1); // the commit itself is untouched
});

test("a run that committed and then hit a provider failure is reported as a warning, not an error, and stays success", async () => {
  const h = host({ "noting.triggerTokens": 30 });
  h.provider(async c => { if (c.messages.some(m => m.role === "toolResult")) throw new Error("offline after commit"); return notingFact(c); }, { autoStop: false });
  await h.turn();
  const run = h.memory.store.listRuns(1)[0]!;
  expect(run.outcome).toBe("success"); expect(h.memory.store.listSessionFacts(1)).toHaveLength(1);
  expect(h.notices.some(n => n.includes("committed with problems") && n.includes("after commit"))).toBe(true);
  expect(h.notices.some(n => n.startsWith("Error:"))).toBe(false);
});

test("16b: Pi marks and post-tree injection use the restored head, while explicit commit marks remain unrestricted", async () => {
  const h = host();
  await h.turn();
  const write = (head: number, branch: string, op: "create" | "update", text: string) => {
    const tools = h.memory.tools({ kind: "manual", sessionId: 1, currentTurnId: head, branch });
    const fact = JSON.parse(tools[2]!.execute({ facts: [{ category: "decision", actor: "user", text, source: [`T${head}#user`] }] })).factIds[0];
    if (op === "update") tools[0]!.execute({ address: "K1@1" });
    expect(tools[3]!.execute({ operations: [{ op, topics: [], ...(op === "update" ? { id: "K1@1" } : {}), text, category: "constraint", scope: "project", supports: [`F${fact}`], reason: `${op} from the ${branch} path` }], skipped: [] })).not.toContain("rejected:");
  };
  write(1, "main", "create", "Root rule");
  const root = [...h.entries];
  await h.prompt("C rule"); await h.answer();
  write(2, "main", "update", "C rule");
  const c = [...h.entries];
  h.entries.splice(0, h.entries.length, ...root); await h.emit("session_tree");
  await h.prompt("D rule"); await h.answer();
  write(3, h.entries.filter(e => e.type === "custom").at(-1).data.branch, "update", "D rule");
  await h.commands.get("trace").handler("mark K1 verified", h.ctx);
  expect(h.notices.at(-1)).toBe("K1@3: verified");
  h.entries.splice(0, h.entries.length, ...c); await h.emit("session_tree");
  await h.commands.get("trace").handler("mark K1 flagged", h.ctx);
  expect(h.notices.at(-1)).toBe("K1@2: flagged");
  await h.commands.get("trace").handler("mark K1@3 clear", h.ctx);
  expect(h.notices.at(-1)).toBe("K1@3: clear");
  await expect(h.commands.get("trace").handler("mark K1@57 verified", h.ctx)).rejects.toThrow("does not exist");
  // The restored branch and head are what select the knowledge, which is the ruling here. 29d moved
  // where that shows: this restored context already carries an injection baseline, so the prompt
  // offers nothing, and the selection is read through the same call the handler would make.
  const restored = h.entries.filter(e => e.type === "custom").at(-1).data;
  const injected = h.memory.injection({ sessionId: 1, headTurnId: restored.head, branch: restored.branch }).text;
  expect(injected).toContain("[K1@2]"); expect(injected).not.toContain("[K1@3]");
  expect((await h.prompt("Continue C"))?.message).toBeUndefined();
  const carry = await h.emit("session_before_tree");
  expect(carry.summary.summary).toBe(h.memory.branchSummary(1, h.entries.filter(e => e.type === "custom").at(-1).data.branch, 4));
  expect(carry.summary.summary).toMatch(/^<branch_carry>\nthis is knowledge from another branch;/);
});

test("a Pi fork continues the same session on a new branch that inherits the source watermarks, so shared turns are recorded once", async () => {
  const h = host({ "noting.triggerTokens": 30 });
  h.provider(async c => notingFact(c));
  await h.turn(); // T1 recorded on main
  expect(h.memory.store.sourcePath(1, "main", 1).length).toBeGreaterThan(0);
  expect(h.memory.store.sourcePath(1, "main", 1).every(e => h.memory.store.entryNoted(e.id))).toBe(true);
  h.ctx.sessionManager.getSessionId = () => "forked"; // pi --fork: same copied path, new Pi session id
  await h.emit("session_start");
  const branch = h.entries.at(-1)?.data?.branch ?? h.memory.store.listRuns(1).at(-1)!.branch;
  await h.turn(); // one turn on the fork
  const run = h.memory.store.listRuns(1).at(-1)!;
  expect(run.branch).not.toBe("main");
  expect(run.rangeFrom).toBe("S1/T2"); // not S1/T1 again
  expect(h.memory.store.listSessionFacts(1).filter(f => f.text === "用 pnpm，不要 npm")).toHaveLength(2); // T1 once, T2 once
  expect(h.memory.store.sourcePath(1, run.branch!, 2).length).toBeGreaterThan(0);
  expect(h.memory.store.sourcePath(1, run.branch!, 2).every(e => h.memory.store.entryNoted(e.id))).toBe(true);
  void branch;
});

test("the plugin's spend is a footer status item updated after every run, and the tree-switch noting's usage rides on the branch summary", async () => {
  const h = host({ "noting.triggerTokens": 30 });
  h.provider(async c => notingFact(c));
  await h.turn();
  // 24a: idle; nothing left to note, one applicable fact, that fact still to consolidate, no knowledge yet.
  expect(h.statuses.get("trace-memory")).toMatch(/^🧠 <dim>○<\/dim> <dim>notes: 0->1 memory: 1->0 cost: \$\d+\.\d{2}<\/dim>$/);
  const spend = h.memory.spend(1);
  expect(spend.runs).toEqual({ noting: 1, consolidation: 0, dreaming: 0, manual: 0 });
  expect(spend.input + spend.output).toBeGreaterThan(0);
  await h.prompt("more"); await h.answer();
  const result = await h.emit("session_before_tree");
  expect(result.summary.usage).toBeUndefined(); // 17b removes tree-switch extraction and its usage attribution
});

test("the state entry pointing at a new turn is written only after Pi persisted the user message, so a rewind before that message drops it", async () => {
  const h = host();
  await h.turn();
  const before = h.entries.filter(e => e.type === "custom").length;
  await h.prompt("second");
  // 17a: source identity and its Turn are both reconciled after native persistence.
  expect(h.memory.store.listTurns(1)).toHaveLength(1);
  expect(h.entries.filter(e => e.type === "custom")).toHaveLength(before);
  await h.answer();
  expect(h.entries.filter(e => e.type === "custom").at(-1)!.data.head).toBe(2);
});

test("a branch forked from an earlier point inherits the nearest recorded ancestor as its watermark", async () => {
  const h = host({ "noting.triggerTokens": 30 });
  h.provider(async c => notingFact(c));
  await h.turn(); // T1 recorded
  const atT1 = [...h.entries];
  await h.turn(); await h.drain(); // T2 recorded on main; main's watermark is now T2
  expect(h.memory.store.sourcePath(1, "main", 2).length).toBeGreaterThan(0);
  expect(h.memory.store.sourcePath(1, "main", 2).every(e => h.memory.store.entryNoted(e.id))).toBe(true);
  h.entries.splice(0, h.entries.length, ...atT1); // the fork copies the path up to T1
  h.ctx.sessionManager.getSessionId = () => "forked";
  await h.emit("session_start");
  await h.turn(); // T3 on the fork, parent T1
  const run = h.memory.store.listRuns(1).at(-1)!;
  expect(run.rangeFrom).toBe("S1/T3"); // T1 is not recorded again
  expect(h.memory.store.getTurn(3)!.parentTurnId).toBe(1);
});

test("the footer indicator follows activity: accent while noting runs, error after a failed run, warning after a committed-with-problems run, dim idle", async () => {
  const h = host({ "noting.triggerTokens": 30 });
  let release!: (value: Reply) => void;
  h.provider(async () => new Promise(resolve => { release = resolve; }));
  await h.prompt(); await h.answer(); await h.emit("agent_settled"); await h.drain();
  expect(h.statuses.get("trace-memory")).toMatch(/^🧠 <accent>●<\/accent> /); // noting in flight
  release(notingFact(h.conversations[0]!)); await h.drain();
  expect(h.statuses.get("trace-memory")).toMatch(/^🧠 <dim>○<\/dim> /);
  h.provider(async () => { throw new Error("offline"); });
  await h.turn(); await h.drain();
  expect(h.statuses.get("trace-memory")).toMatch(/^🧠 <error>●<\/error> /);
  h.provider(async c => { if (c.messages.some(m => m.role === "toolResult")) throw new Error("offline after commit"); return notingFact(c); }, { autoStop: false });
  await h.turn(); await h.drain();
  expect(h.statuses.get("trace-memory")).toMatch(/^🧠 <warning>●<\/warning> /);
});

test("a fork sees consolidation progress exactly when every fact of that consolidation lies on its path", async () => {
  const h = host({ "noting.triggerTokens": 30, "consolidation.triggerTokens": 1, "consolidation.maxToolRounds": 4 });
  // The fake Consolidator submits once per round and stops after any rejection instead of resubmitting forever.
  h.provider(async c => !c.systemPrompt!.includes("### Second-round user message") ? notingFact(c)
    : c.messages.some(m => m.role === "toolResult" && m.toolName === "memory" && (m.content[0] as { text: string }).text.startsWith("rejected")) ? reply("stopped") : consolidationReply());
  await h.turn(); // T1 → F1
  const atT1 = [...h.entries];
  await h.turn(); await h.emit("agent_settled"); await h.drain(); // T2 -> F2; main consolidated F1 while T2 was still being recorded
  expect(h.memory.store.sourcePath(1, "main", 2).length).toBeGreaterThan(0);
  expect(h.memory.store.sourcePath(1, "main", 2).every(e => h.memory.store.entryNoted(e.id))).toBe(true);
  expect(h.memory.store.consolidatedOnPath(1, { sessionId: 1, headTurnId: 2 })).toBe(true);
  h.entries.splice(0, h.entries.length, ...atT1); h.ctx.sessionManager.getSessionId = () => "forked";
  await h.emit("session_start");
  await h.turn(); // T3 under T1
  const branch = h.memory.store.listRuns(1).at(-1)!.branch!;
  expect(h.memory.store.sourcePath(1, branch, 3).length).toBeGreaterThan(0);
  expect(h.memory.store.sourcePath(1, branch, 3).every(e => h.memory.store.entryNoted(e.id))).toBe(true);
  // main had consolidated only F1, which sits on T1 and so on this path: the progress counts here and F1 is not consolidated again.
  expect(h.memory.store.consolidatedOnPath(1, { sessionId: 1, headTurnId: 3 })).toBe(true);
  expect(h.memory.store.consolidationBatch(1, branch, 3).map(f => f.id)).not.toContain(1);
  expect(h.memory.store.listRuns(1).some(r => r.kind === "consolidation" && r.branch === branch && r.rangeFrom === "F1")).toBe(false);
  expect(h.memory.store.listBranchFacts(1, branch, 3).map(f => f.id)).toContain(1);
});

test("a dropped duplicate Consolidation trigger neither ends the running indicator nor changes the last outcome", async () => {
  const h = host({ "noting.triggerTokens": 30, "consolidation.triggerTokens": 1 });
  let release!: (value: Reply) => void, held = false;
  h.provider(async c => { if (!c.systemPrompt!.includes("### Second-round user message")) return notingFact(c);
    if (held) return consolidationReply(); held = true; return new Promise(resolve => { release = resolve; }); });
  await h.turn(); // F1 recorded
  await h.answer("next completed source"); await h.emit("agent_settled"); await h.drain(); // Consolidation starts and waits for the model
  expect(h.statuses.get("trace-memory")).toMatch(/^🧠 <success>●<\/success> /);
  await h.answer("tick"); await h.emit("agent_settled"); await h.drain(); // fresh completion, duplicate Consolidation drops at once
  expect(h.statuses.get("trace-memory")).toMatch(/^🧠 <success>●<\/success> /); // the first run is still in flight
  release(consolidationReply()); await h.drain();
  expect(h.statuses.get("trace-memory")).toMatch(/^🧠 <dim>○<\/dim> /);
});

test("a stream that dies mid-reply is a failure carrying the provider's error, commits nothing, and a later stream death after a commit is a problem on a success", async () => {
  const h = host({ "noting.triggerTokens": 30 });
  h.provider(async () => ({ ...reply("partial tex"), stopReason: "error", errorMessage: "stream reset by peer" }));
  await h.turn();
  let run = h.memory.store.listRuns(1)[0]!;
  expect(run.outcome).toBe("failure");
  expect(JSON.parse(run.response!).problems[0]).toContain("stream reset by peer");
  expect(h.memory.store.listSessionFacts(1)).toHaveLength(0);
  expect(h.memory.store.listSourceEntries(1).some(e => h.memory.store.entryNoted(e.id))).toBe(false);
  expect(h.statuses.get("trace-memory")).toMatch(/^🧠 <error>●<\/error> /);
  h.provider(async c => c.messages.some(m => m.role === "toolResult") ? { ...reply(""), stopReason: "error", errorMessage: "stream reset after commit" } : notingFact(c), { autoStop: false });
  await h.turn(); await h.drain();
  run = h.memory.store.listRuns(1).at(-1)!;
  expect(run.outcome).toBe("success");
  expect(JSON.parse(run.response!).problems[0]).toContain("stream reset after commit");
  const selected: { id: number }[] = JSON.parse(run.response!).entryAudit.entries;
  expect(selected.length).toBeGreaterThan(0);
  expect(selected.every(e => h.memory.store.entryNoted(e.id))).toBe(true);
  expect(h.memory.pendingEntries(1, "main", 2).every(e => !selected.some(s => s.id === e.id))).toBe(true);
});

test("consolidation progress does not count on a fork when a manual fact beyond the fork point was consolidated in the same run", async () => {
  const h = host({ "noting.triggerTokens": 1000000000 });
  h.provider(async c => notingFact(c));
  await h.turn(); // T1
  h.memory.store.commitNotingRun({ run: { kind: "noting", sessionId: 1, branch: "main", createdAt: "now", rangeFrom: "S1/T1", rangeTo: "S1/T1", outcome: "success" } as never,
    facts: [{ turnId: 1, category: "decision", actor: "user", text: "F1 on T1", source: ["T1#user"], createdAt: "now" }], entryIds: h.memory.store.sourcePath(1, "main", 1).map(e => e.id) });
  const atT1 = [...h.entries];
  await h.prompt("two"); await h.answer(); await h.emit("agent_settled"); // T2 exists, not recorded (threshold 5)
  h.memory.store.commitNotingRun({ run: { kind: "manual", sessionId: 1, branch: "main", createdAt: "now", rangeFrom: "S1/T2", rangeTo: "S1/T2", outcome: "success" } as never,
    facts: [{ turnId: 2, category: "decision", actor: "user", text: "F2 manual on T2", source: ["T2#user"], createdAt: "now" }] });
  expect(h.memory.store.commitConsolidationRun({ run: { kind: "consolidation", sessionId: 1, branch: "main", createdAt: "now" }, operations: [], consolidated: [1, 2] }).ok).toBe(true); // one run consumed F1 and F2 on main
  h.entries.splice(0, h.entries.length, ...atT1); h.ctx.sessionManager.getSessionId = () => "forked";
  await h.emit("session_start");
  const fork = h.entries.filter(e => e.type === "custom").at(-1)!.data;
  expect(fork).toBeDefined();
  expect(h.memory.pendingEntries(1, fork.branch, 1)).toEqual([]); // noting progress carries
  expect(h.memory.store.consolidatedOnPath(1, { sessionId: 1, headTurnId: 1 })).toBe(false); // F2 is off this path: F1 must be consolidated again
  expect(h.memory.store.consolidationBatch(1, fork.branch, 1).map(f => f.id)).toEqual([1]);
});

test("a transient provider error is retried with Pi's policy before the run is failed, and a retry never repeats a committed write", async () => {
  const h = host({ "noting.triggerTokens": 30 });
  let calls = 0;
  h.provider(async c => { calls++; if (calls === 1) return { ...reply(""), stopReason: "error", errorMessage: "fetch failed" }; return notingFact(c); });
  await h.turn();
  await new Promise(r => setTimeout(r, 50)); await h.drain(); // the retry backoff is a timer, not a microtask
  const run = h.memory.store.listRuns(1)[0]!;
  expect(run.outcome).toBe("success"); expect(calls).toBeGreaterThanOrEqual(2);
  expect(h.notices.some(n => n.includes("noting retry 1/1") && n.includes("fetch failed"))).toBe(true);
  expect(h.memory.store.listSessionFacts(1)).toHaveLength(1); // one commit despite the retry
  // A non-retryable error is not retried.
  calls = 0;
  h.provider(async () => { calls++; return { ...reply(""), stopReason: "error", errorMessage: "invalid_api_key" }; });
  await h.turn(); await new Promise(r => setTimeout(r, 50)); await h.drain();
  expect(h.memory.store.listRuns(1).at(-1)!.outcome).toBe("failure"); expect(calls).toBe(1);
});

test("a retry re-sends the same request: a stream error after a tool round does not duplicate the tool result, failed attempts count in usage and retries are recorded", async () => {
  const h = host({ "noting.triggerTokens": 30, "noting.forkModeDefault": false, retry: { baseDelayMs: 1 } });
  let calls = 0;
  h.provider(async c => {
    calls++;
    if (calls === 1) return { ...reply(""), stopReason: "toolUse", content: [{ type: "toolCall", id: "trace-1", name: "trace", arguments: { address: "T1" } }] };
    if (calls === 2) return { ...reply(""), stopReason: "error", errorMessage: "fetch failed" };
    return notingFact(c);
  }, { autoStop: true });
  await h.turn(); await new Promise(r => setTimeout(r, 40)); await h.drain();
  const failed = h.conversations[1]!, retried = h.conversations[2]!;
  expect(retried.messages).toEqual(failed.messages); // the same request, not a re-appended one
  expect(retried.messages.filter(m => m.role === "toolResult")).toHaveLength(1);
  const run = h.memory.store.listRuns(1)[0]!, response = JSON.parse(run.response!);
  expect(run.outcome).toBe("success");
  // Every attempt that reported usage counts; the attempt that died in transport reported none.
  expect(response.usage.input).toBe(usage.input * (h.conversations.length - 1));
  // Pi's own retry loop records the provider's error text as it arrived at the transport.
  expect(response.retries).toEqual([{ attempt: 1, error: expect.stringContaining("fetch failed") }]);
});

test("the footer shows the warning indicator while a retry waits", async () => {
  const h = host({ "noting.triggerTokens": 30, retry: { baseDelayMs: 60 } });
  let calls = 0;
  h.provider(async c => { calls++; if (calls === 1) return { ...reply(""), stopReason: "error", errorMessage: "fetch failed" }; return notingFact(c); });
  await h.turn(); // the first attempt failed, the retry is sleeping
  expect(h.statuses.get("trace-memory")).toMatch(/^🧠 <warning>●<\/warning> /);
  await new Promise(r => setTimeout(r, 120)); await h.drain();
  expect(h.statuses.get("trace-memory")).toMatch(/^🧠 <dim>○<\/dim> /);
  expect(h.memory.store.listRuns(1)[0]!.outcome).toBe("success");
});

const knowledgeReply = (): Reply => ({ ...reply(""), stopReason: "toolUse", content: [{ type: "toolCall", id: "memory-1", name: "memory",
  arguments: { operations: [{ op: "create", topics: [], reason: "Initial admission of this conclusion.", text: "Use pnpm, never npm", category: "constraint", scope: "project", supports: ["F1"] }], skipped: [] } }] });

test("2026-09-07 backfill by consumer — superseded 2026-09-08 and by 25b: the Consolidator subagent gets facts and knowledge changes and waits for no receipt it does not inherit", async () => {
  const h = host({ "noting.triggerTokens": 30, "consolidation.triggerTokens": 1, "noting.forkModeDefault": false, "consolidation.maxToolRounds": 4 });
  h.provider(async c => c.systemPrompt!.includes("### Second-round user message") ? knowledgeReply() : notingFact(c));
  await h.turn(); // Noting commits F1.
  h.provider(async c => c.systemPrompt!.includes("### Second-round user message") ? knowledgeReply() : reply("No new facts."));
  await h.answer("tick"); await h.emit("agent_settled"); await h.drain();
  // The batch is due right after F1 is committed. Before 25b a fork-mode Consolidator would have
  // waited for a receipt; a fresh context reads the pending facts from storage, so it does not.
  expect(h.memory.store.listRuns(1).filter(r => r.kind === "consolidation").map(r => r.mode)).toEqual(["subagent"]);
  expect(h.memory.store.listVisibleKnowledge(1, 1)).toHaveLength(1); // the Consolidation did commit
  // 29d: no receipt of either change reaches the conversation. The initial knowledge block is the one
  // automatic material left, and this conversation had no baseline yet, so it is offered once here --
  // and not again on the prompt after it.
  const carried = String((await h.prompt("second"))?.message?.content ?? "");
  expect(carried).not.toContain("<noted>");
  expect(carried).not.toContain("<consolidated>");
  expect(carried).toContain("<knowledge>");
  await h.answer(); await h.emit("agent_settled"); await h.drain();
  expect((await h.prompt("third"))?.message).toBeUndefined();
  expect(h.memory.trace("F1")).toContain("[F1]"); // the facts stay reachable by explicit read
});
