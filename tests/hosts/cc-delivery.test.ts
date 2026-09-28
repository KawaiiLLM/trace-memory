// 97: Claude Code delivery is recorded at emission and read back per node; hooks never rescan the transcript.
import { afterEach, expect, test, vi } from "vitest";
import { appendFileSync, closeSync, mkdtempSync, openSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../src/core/store/index.ts";
import { entry, knowledge, knowledgeBatch, legacyFacts, session } from "../support/seed.ts";
import { readBinding, recordSessionStart } from "../../src/hosts/cc/binding.ts";
import { resolveCcHostConfig } from "../../src/hosts/cc/config.ts";
import { CcImporter } from "../../src/hosts/cc/importer.ts";
import { ccCompaction, ccDeltaInjection, ccSessionStartInjection, databaseIdentity, decodeCcInjection, encodeCcInjection } from "../../src/hosts/cc/injection.ts";
import { sliceCcInjection } from "../../src/hosts/cc/slices.ts";
import { CC_AUTO_CONTINUE_SUFFIX, COMPACTION_SUMMARY_PREFIX, COMPACTION_SUMMARY_SUFFIX, ccStripAutoContinue, classifySourceRecord, type CcNativeRecord } from "../../src/hosts/cc/transcript.ts";
import { readCcMenu } from "../../src/hosts/cc/menu.ts";

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const time = (second: number) => `2026-09-28T00:00:${String(second % 60).padStart(2, "0")}.000Z`;
const line = (value: unknown) => `${JSON.stringify(value)}\n`;
let clock = 0;
const user = (uuid: string, parentUuid: string | null, promptId: string): CcNativeRecord => ({ uuid, parentUuid, type: "user",
  timestamp: time(++clock), promptSource: "typed", promptId, message: { role: "user", content: uuid } });
const assistant = (uuid: string, parentUuid: string): CcNativeRecord => ({ uuid, parentUuid, type: "assistant",
  timestamp: time(++clock), message: { role: "assistant", content: [{ type: "text", text: uuid }] } });
/** 108: one parallel tool call, split into its own row as Claude Code 2.1.280 does, sharing `msgId`
 * (its native API message id) with the other calls of the same batch. */
const assistantToolUse = (uuid: string, parentUuid: string, msgId: string, callId: string): CcNativeRecord => ({ uuid, parentUuid, type: "assistant",
  timestamp: time(++clock), message: { id: msgId, role: "assistant", content: [{ type: "tool_use", id: callId, name: "Read", input: { file_path: uuid } }] } });
/** 108: a parallel call's own result, parented under its call directly — never under another result,
 * as a real pinned-CC-2.1.280 transcript does (ticket 102's Part 2 evidence). */
const toolResultRow = (uuid: string, parentUuid: string, callId: string, content: string): CcNativeRecord => ({ uuid, parentUuid, type: "user",
  timestamp: time(++clock), message: { role: "user", content: [{ type: "tool_result", tool_use_id: callId, content }] } });
const attachment = (uuid: string, parentUuid: string, content: string): CcNativeRecord => ({ uuid, parentUuid, type: "attachment",
  timestamp: time(++clock), attachment: { type: "hook_additional_context", hookEvent: "UserPromptSubmit", content: [content] } });

/** An imported native session (the executor's work), one supporting fact and global knowledge. */
async function fixture(texts = ["Use pnpm."], settings: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "tm97-cc-")); dirs.push(dir);
  const transcriptPath = join(dir, "native.jsonl"), nativeSession = "native-97";
  const config = resolveCcHostConfig({ dbPath: join(dir, "m.sqlite"), stateDir: join(dir, "s"), baseline: "2025-01-01T00:00:00.000Z", ...settings });
  writeFileSync(transcriptPath, [user("u1", null, "p1"), assistant("a1", "u1")].map(line).join(""));
  let importer = new CcImporter(config, await recordSessionStart(config, { hook_event_name: "SessionStart", source: "startup",
    session_id: nativeSession, transcript_path: transcriptPath }, time(0)));
  const imported = await importer.reconcile();
  const store = new Store(config.dbPath), sessionId = imported.coreSessionId!;
  // Global knowledge grounded in another session, so it applies on every branch of this one.
  const seed = session(store, store.getSession(sessionId)!.projectId, "fixture");
  const seedTurn = store.appendTurn({ sessionId: seed.id, kind: "turn", userPrompt: "rule", startedAt: time(0) });
  const source = entry(store, seed.id, seedTurn.id, "rule", "user", "rule");
  const fact = legacyFacts(store, { kind: "manual", sessionId: seed.id, createdAt: time(0) }, [{ sources: [{ entry: source,
    address: `T${seedTurn.id}#E${source.entryOrdinal}` }], text: "rule", category: "decision", actor: "user", createdAt: time(0) }]).facts[0]!;
  const path = { sessionId: seed.id, headTurnId: seedTurn.id };
  const versions = knowledgeBatch(store, path, texts.map(text => ({ scope: "global" as const, category: "constraint" as const,
    supports: [fact.id], text })), { kind: "manual", createdAt: time(0) }).committed;
  const input = { session_id: nativeSession, transcript_path: transcriptPath };
  const visible = () => ({ db: databaseIdentity(config.dbPath), nativeSession, coreSession: readBinding(config, nativeSession)!.coreSessionId });
  const slicer = (output: Parameters<typeof sliceCcInjection>[1] extends never ? never : any, binding: Parameters<typeof sliceCcInjection>[0]) =>
    sliceCcInjection(binding, output?.transportItems ?? [], undefined, output?.transportKnowledgeAllowance);
  const decode = (outputs: readonly ({ hookSpecificOutput: { additionalContext: string } } | null)[]) => outputs
    .filter(output => output?.hookSpecificOutput.additionalContext).map(output => decodeCcInjection(output!.hookSpecificOutput.additionalContext, visible())!);
  const commits = (outputs: Parameters<typeof decode>[0]) => decode(outputs).flatMap(header => header.commits);
  return {
    dir, config, store, sessionId, fact, path, versions, input, transcriptPath, nativeSession, visible, decode, commits,
    /** Claude Code writes records; the executor imports them. */
    append: async (...records: CcNativeRecord[]) => { appendFileSync(transcriptPath, records.map(line).join("")); return importer.reconcile(); },
    write: (...records: CcNativeRecord[]) => appendFileSync(transcriptPath, records.map(line).join("")),
    restartExecutor: async () => { importer.close(); importer = new CcImporter(config, readBinding(config, nativeSession)!); await importer.reconcile(); },
    prompt: (promptId: string) => ccDeltaInjection(config, input, { kind: "prompt", promptId }, slicer),
    compact: () => ccDeltaInjection(config, input, { kind: "compact" }, slicer),
    /** 102: Trace Memory's compaction, waiting for the row `trigger`. `auto` (requirement 14) is the
     * caller's own manual/auto event trigger, distinct from the row. */
    build: (trigger: string, auto?: boolean) => ccCompaction(config, { session_id: nativeSession, trigger, auto }),
    sessionStart: (source: "compact" | "resume") => ccSessionStartInjection(config, { hook_event_name: "SessionStart", source, ...input }),
    resume: () => ccSessionStartInjection(config, { hook_event_name: "SessionStart", source: "resume", ...input }),
    delivered: (headTurnId: number) => store.deliveredKnowledge({ owner: `cc:${nativeSession}`, sessionId, branch: readBinding(config, nativeSession)!.branch, headTurnId }),
    turnOf: (uuid: string) => store.findSourceEntry(sessionId, nativeSession, uuid)!.turnId,
    close: () => { importer.close(); store.close(); },
  };
}

test("97 a prompt's delivery belongs to its own node: a rewind before it and a re-edit of it deliver again; its branch does not", async () => {
  const f = await fixture();
  try {
    const [rule] = f.versions.map(item => item.commit);
    expect(f.commits(await f.prompt("p2"))).toEqual([rule]); // delivered with prompt p2
    await f.append(user("u2", "a1", "p2"), assistant("a2", "u2"));
    expect(f.commits(await f.prompt("p3"))).toEqual([]); // p2's Turn owns it
    await f.append(user("u3", "a2", "p3"), assistant("a3", "u3"));
    expect([...f.delivered(f.turnOf("u3")).knowledgeCommitIds]).toEqual([rule]);

    // Re-edit p2: a sibling Turn under the same parent does not inherit p2's delivery.
    await f.append(user("u2-edit", "a1", "p2e"), assistant("a2-edit", "u2-edit"));
    expect(f.delivered(f.turnOf("u2-edit")).knowledgeCommitIds.size).toBe(0);
    expect(f.commits(await f.prompt("p4"))).toEqual([rule]);
    await f.append(user("u4", "a2-edit", "p4"), assistant("a4", "u4"));

    // Rewind before p2 altogether: a new root prompt holds nothing either.
    await f.append(user("u-root", null, "pr"), assistant("a-root", "u-root"));
    expect(f.delivered(f.turnOf("u-root")).knowledgeCommitIds.size).toBe(0);
    expect(f.commits(await f.prompt("p5"))).toEqual([rule]);
    await f.append(user("u5", "a-root", "p5"), assistant("a5", "u5"));

    // Back onto the first branch: its own deliveries stand, and nothing is delivered again.
    await f.append(user("u6", "a3", "p6"), assistant("a6", "u6"));
    expect([...f.delivered(f.turnOf("u6")).knowledgeCommitIds]).toEqual([rule]);
    expect(f.commits(await f.prompt("p7"))).toEqual([]);
  } finally { f.close(); }
});

test("97 a delivery survives a restart and an import that has not caught up; a part Claude Code persisted to a file still counts", async () => {
  const f = await fixture();
  try {
    const [rule] = f.versions.map(item => item.commit);
    const first = await f.prompt("p2");
    expect(f.commits(first)).toEqual([rule]);
    // Claude Code wrote the prompt, but the executor has not imported it: the tail shows the prompt.
    f.write(user("u2", "a1", "p2"), attachment("h2", "u2",
      "<persisted-output>\nOutput too large (12KB). Full output saved to: /tmp/hook.txt\n\nPreview (first 2KB):\nTRACE\n...\n</persisted-output>"),
      assistant("a2", "h2"));
    expect(f.commits(await f.prompt("p3"))).toEqual([]);
    await f.restartExecutor();
    expect(f.commits(await f.prompt("p3"))).toEqual([]);
    expect((await f.resume())).toBeNull();
    // A new version is the only thing missing after all of that.
    const added = knowledge(f.store, f.path, "global", "constraint", [f.fact.id], "Run vitest.", { run: { kind: "manual", createdAt: time(0) } }).commit;
    expect(f.commits(await f.prompt("p3"))).toEqual([added]);
  } finally { f.close(); }
});

/** What Claude Code writes after its compaction hooks return: the boundary, then the summary. */
const boundary = (uuid: string, logicalParentUuid: string, trigger = "manual"): CcNativeRecord[] => [
  { uuid, parentUuid: null, logicalParentUuid, type: "system", subtype: "compact_boundary", timestamp: time(++clock),
    compactMetadata: { trigger, preTokens: 1000 } } as CcNativeRecord,
  { uuid: `${uuid}-summary`, parentUuid: uuid, type: "user", isCompactSummary: true, timestamp: time(++clock),
    message: { role: "user", content: "summary" } } as CcNativeRecord];

test("97 a compaction's supplement belongs to the compaction's own node: versions, notices and cost restart there", async () => {
  const f = await fixture(["Use pnpm.", "Run vitest."]);
  try {
    const [first, kept] = f.versions.map(item => item.commit) as [number, number];
    expect(f.commits(await f.prompt("p2"))).toEqual([first, kept]);
    await f.append(user("u2", "a1", "p2"), assistant("a2", "u2"));
    const archived = f.store.commitConsolidationRun({ path: f.path, run: { kind: "manual", sessionId: f.path.sessionId, createdAt: time(0) },
      operations: [{ op: "archive", kind: "budget", knowledgeId: f.versions[0]!.knowledgeId, baseCommit: first, supports: [f.fact.id], reason: "withdrawn", createdAt: time(0) }] });
    if (!archived.ok) throw new Error(archived.problems.join());
    const archive = archived.committed[0]!.commit;
    const notice = f.decode(await f.prompt("p3"));
    expect(notice.flatMap(header => header.commits)).toEqual([]);
    expect(notice.flatMap(header => header.states)).toEqual([{ fromCommit: first, toCommits: [archive] }]);
    await f.append(user("u3", "a2", "p3"), assistant("a3", "u3"));
    expect(f.decode(await f.prompt("p4"))).toEqual([]); // the notice is not repeated
    await f.append(user("u4", "a3", "p4"), assistant("a4", "u4"));
    const before = f.delivered(f.turnOf("u4"));
    expect(before.knowledgeStates).toEqual(new Set([`${first}>${archive}`]));
    const added = knowledge(f.store, f.path, "global", "constraint", [f.fact.id], "Review before release.", { run: { kind: "manual", createdAt: time(0) } }).commit;

    const supplement = f.decode(await f.compact());
    expect(supplement.flatMap(header => header.commits)).toEqual([kept, added]);
    expect(supplement.flatMap(header => header.states)).toEqual([]);
    const cost = supplement.reduce((sum, header) => sum + header.knowledgeTokens!, 0);
    // The node before the compaction is not changed by it, before or after the import.
    expect(f.delivered(f.turnOf("u4"))).toEqual(before);
    f.write(...boundary("cb", "a4")); // written by Claude Code, not yet imported
    expect(f.decode(await f.prompt("p5"))).toEqual([]);
    await f.restartExecutor();
    const compaction = f.store.findNativeTurn(f.sessionId, f.nativeSession, "cb")!.turnId;
    expect(f.delivered(compaction)).toEqual({ knowledgeCommitIds: new Set([kept, added]), knowledgeStates: new Set(), knowledgeTokens: cost });
    expect(f.delivered(f.turnOf("u4"))).toEqual(before);
    expect(f.decode(await f.prompt("p5"))).toEqual([]);
    // A branch from before the compaction, rewinding to that node, still misses what came later.
    await f.append(user("u5-alt", "a4", "p5-alt"), assistant("a5-alt", "u5-alt"));
    expect(f.commits(await f.prompt("p6"))).toEqual([added]);
  } finally { f.close(); }
});

test("97 a compaction whose supplement failed still starts empty, where its boundary is", async () => {
  const f = await fixture();
  try {
    const [rule] = f.versions.map(item => item.commit);
    expect(f.commits(await f.prompt("p2"))).toEqual([rule]);
    await f.append(user("u2", "a1", "p2"), assistant("a2", "u2"));
    vi.spyOn(Store.prototype, "deliveryWatermark").mockImplementationOnce(() => { throw new Error("injected render failure"); });
    await expect(f.compact()).rejects.toThrow("injected render failure");
    expect([...f.delivered(f.turnOf("u2")).knowledgeCommitIds]).toEqual([rule]);
    f.write(...boundary("cb", "a2"));
    expect(f.commits(await f.prompt("p3"))).toEqual([rule]);
  } finally { f.close(); }
});

test("97 an automatic compaction that interrupts a reply is on the path of the prompts after it", async () => {
  const f = await fixture();
  try {
    const [rule] = f.versions.map(item => item.commit);
    expect(f.commits(await f.prompt("p2"))).toEqual([rule]);
    await f.append(user("u2", "a1", "p2"));
    const added = knowledge(f.store, f.path, "global", "constraint", [f.fact.id], "Review before release.", { run: { kind: "manual", createdAt: time(0) } }).commit;
    expect(f.commits(await f.compact())).toEqual([rule, added]);
    // The reply goes on after the boundary, under the same prompt.
    await f.append(...boundary("cb", "u2", "auto"), assistant("a2", "cb-summary"));
    expect(f.commits(await f.prompt("p3"))).toEqual([]);
    await f.append(user("u3", "a2", "p3"), assistant("a3", "u3"));
    const compaction = f.store.findNativeTurn(f.sessionId, f.nativeSession, "cb")!.turnId;
    expect(f.store.getTurn(f.turnOf("u3"))!.parentTurnId).toBe(compaction);
    expect(f.turnOf("a2")).toBe(f.turnOf("u2"));
    expect([...f.delivered(f.turnOf("u3")).knowledgeCommitIds]).toEqual([rule, added]);
    expect([...f.delivered(f.turnOf("u2")).knowledgeCommitIds]).toEqual([rule]);
  } finally { f.close(); }
});

test("a compaction that interrupts a tool call is on the path of the prompts after it, though the result names the call's original row", async () => {
  const f = await fixture();
  try {
    const [rule] = f.versions.map(item => item.commit);
    expect(f.commits(await f.prompt("p2"))).toEqual([rule]);
    const call: CcNativeRecord = { uuid: "call", parentUuid: "u2", type: "assistant", timestamp: time(++clock),
      message: { id: "msg-call", role: "assistant", content: [{ type: "tool_use", id: "call-1", name: "Bash", input: { command: "ls" } }] } };
    const result: CcNativeRecord = { uuid: "result", parentUuid: "call", type: "user", timestamp: time(++clock),
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "listing" }] } };
    await f.append(user("u2", "a1", "p2"), call, result);
    const added = knowledge(f.store, f.path, "global", "constraint", [f.fact.id], "Review before release.", { run: { kind: "manual", createdAt: time(0) } }).commit;
    expect(f.commits(await f.compact())).toEqual([rule, added]);
    // After the summary Claude Code writes the call again under a new uuid, then its result, naming the original call.
    await f.append(...boundary("cb", "result", "auto"), { ...call, uuid: "call-copy", parentUuid: "cb-summary" },
      { ...result, uuid: "result-copy", parentUuid: "call" }, assistant("a2", "result-copy"));
    expect(f.commits(await f.prompt("p3"))).toEqual([]);
    await f.append(user("u3", "a2", "p3"), assistant("a3", "u3"));
    // Both copies are the rows they repeat, not new entries.
    expect(["call-copy", "result-copy"].map(uuid => f.store.findSourceEntry(f.sessionId, f.nativeSession, uuid))).toEqual([null, null]);
    const compaction = f.store.findNativeTurn(f.sessionId, f.nativeSession, "cb")!.turnId;
    expect(f.store.getTurn(f.turnOf("u3"))!.parentTurnId).toBe(compaction);
    expect([...f.delivered(f.turnOf("u3")).knowledgeCommitIds]).toEqual([rule, added]);
    expect([...f.delivered(f.turnOf("u2")).knowledgeCommitIds]).toEqual([rule]);
  } finally { f.close(); }
});

test("97 a new root branch the import has not reached starts empty", async () => {
  const f = await fixture();
  try {
    const [rule] = f.versions.map(item => item.commit);
    expect(f.commits(await f.prompt("p2"))).toEqual([rule]);
    await f.append(user("u2", "a1", "p2"), assistant("a2", "u2"));
    // A branch started from the first prompt again: its chain starts in the unimported tail.
    f.write(user("root-2", null, "pr"), assistant("root-2-a", "root-2"));
    expect(f.commits(await f.prompt("p3"))).toEqual([rule]);
    // Once imported, the branch is its own path; p3 was never written, so it is not on it.
    await f.restartExecutor();
    expect(f.commits(await f.prompt("p4"))).toEqual([rule]);
  } finally { f.close(); }
});

test("97 hooks read the transcript only after the stored leaf", async () => {
  const f = await fixture();
  try {
    const [rule] = f.versions.map(item => item.commit);
    await f.append(user("u2", "a1", "p2"), assistant("a2", "u2"));
    const offset = readBinding(f.config, f.nativeSession)!.transcriptOffset!;
    expect(offset).toBeGreaterThan(0);
    // Everything before the stored offset becomes unreadable garbage of the same length.
    const descriptor = openSync(f.transcriptPath, "r+");
    try { writeSync(descriptor, Buffer.from(`${"{".repeat(offset - 1)}\n`), 0, offset, 0); } finally { closeSync(descriptor); }
    f.write(user("u3", "a2", "p3"));
    expect(f.commits(await f.prompt("p4"))).toEqual([rule]);
    f.write(user("u4", "u3", "p4"));
    expect(await f.resume()).toBeNull();
    expect(f.commits(await f.compact())).toEqual([rule]);
    const rows = f.store.db.prepare("SELECT node_key, turn_id, follows FROM knowledge_deliveries ORDER BY id").all() as
      { node_key: string; turn_id: null; follows: string | null }[];
    // The prompt delivery belongs to p4; the compaction to its own node, after the last record the tail shows.
    expect(rows).toEqual([{ node_key: "p4", turn_id: null, follows: null }, { node_key: expect.stringMatching(/^[0-9a-f-]{36}$/), turn_id: null, follows: "u4" }]);
  } finally { f.close(); }
});

test("97 transition: a context with no records gets one delivery within its budget; unchanged, later prompts deliver nothing", async () => {
  const f = await fixture(["First rule. " + "x".repeat(400), "Second rule. " + "y".repeat(400), "Third rule. " + "z".repeat(400)],
    { "compaction.sharedAllowanceTokens": 1 });
  try {
    // Carriers written before 97 are never read: one here claims every version.
    const old = encodeCcInjection(f.visible(), { text: "legacy", knowledgeCommitIds: f.versions.map(item => item.commit) });
    await f.append(attachment("legacy", "a1", old));
    f.store.setKnowledgeBudget("global", 300); f.store.setKnowledgeBudget("project", 0); f.store.setKnowledgeBudget("session", 0);
    const first = f.decode(await f.prompt("p2"));
    expect(first.flatMap(header => header.commits).length).toBeGreaterThan(0);
    expect(first.flatMap(header => header.commits).length).toBeLessThan(3);
    expect(first.reduce((sum, header) => sum + header.knowledgeTokens!, 0)).toBeLessThanOrEqual(300);
    await f.append(user("u2", "legacy", "p2"), assistant("a2", "u2"));
    expect(f.decode(await f.prompt("p3"))).toEqual([]);
    expect(await f.resume()).toBeNull();
  } finally { f.close(); }
});

/** What Claude Code writes after the `session.compact` hook answered: the boundary, then the block as an
 * ordinary user row (no summary flag), under the prompt that triggered it (102 probe transcripts). */
const installedBlock = (uuid: string, logicalParentUuid: string, text: string, promptId: string): CcNativeRecord[] => [
  { uuid, parentUuid: null, logicalParentUuid, type: "system", subtype: "compact_boundary", timestamp: time(++clock),
    compactMetadata: { trigger: "auto", preTokens: 1000 } } as CcNativeRecord,
  { uuid: `${uuid}-block`, parentUuid: uuid, type: "user", promptId, timestamp: time(++clock), message: { role: "user", content: text } } as CcNativeRecord];
/** 102 (ruled): the returned compaction is its carrier in Pi's compaction framing; the carrier inside.
 * Requirement 14: an optional trailing auto-continue sentence, outside the framing, is stripped first
 * so this stays a structural check of the framing, not of that sentence. */
const carrierIn = (text: string): string => {
  const framed = ccStripAutoContinue(text);
  expect(framed.startsWith(COMPACTION_SUMMARY_PREFIX)).toBe(true);
  expect(framed.endsWith(COMPACTION_SUMMARY_SUFFIX)).toBe(true);
  return framed.slice(COMPACTION_SUMMARY_PREFIX.length, -COMPACTION_SUMMARY_SUFFIX.length);
};

test("102 a Trace Memory compaction's node holds exactly what its block emitted; the hooks add nothing after it", async () => {
  const f = await fixture(["Use pnpm.", "Run vitest."]);
  try {
    const [first, kept] = f.versions.map(item => item.commit) as [number, number];
    expect(f.commits(await f.prompt("p2"))).toEqual([first, kept]);
    await f.append(user("u2", "a1", "p2"), assistant("a2", "u2"));
    const archived = f.store.commitConsolidationRun({ path: f.path, run: { kind: "manual", sessionId: f.path.sessionId, createdAt: time(0) },
      operations: [{ op: "archive", knowledgeId: f.versions[0]!.knowledgeId, baseCommit: first, supports: [f.fact.id], reason: "withdrawn", createdAt: time(0) }] });
    if (!archived.ok) throw new Error(archived.problems.join());
    expect(f.decode(await f.prompt("p3")).flatMap(header => header.states)).toEqual([{ fromCommit: first, toCommits: [archived.committed[0]!.commit] }]);
    await f.append(user("u3", "a2", "p3")); // an automatic compaction at this prompt; the executor has imported it
    const built = await f.build("u3");
    const header = decodeCcInjection(carrierIn(built!.text), f.visible())!;
    expect(header.commits).toEqual([kept]);
    expect(header.states).toEqual([]); // the compaction starts from nothing delivered: no notice for what it never saw
    expect(built!.warning).toBeUndefined();
    await f.append(...installedBlock("cb", "u3", built!.text, "p3"), assistant("a3", "cb-block"));
    const compaction = f.store.findNativeTurn(f.sessionId, f.nativeSession, "cb")!.turnId;
    expect(f.delivered(compaction)).toEqual({ knowledgeCommitIds: new Set(header.commits), knowledgeStates: new Set(), knowledgeTokens: header.knowledgeTokens });
    expect(f.delivered(f.turnOf("u3")).knowledgeStates).toEqual(new Set([`${first}>${archived.committed[0]!.commit}`]));
    // SessionStart(compact) never injects; the next prompt and a resume find nothing missing.
    expect(await f.sessionStart("compact")).toBeNull();
    expect(f.decode(await f.prompt("p4"))).toEqual([]);
    expect(await f.sessionStart("resume")).toBeNull();
  } finally { f.close(); }
});

test("102 the build waits for its trigger to be written, imports it, and ends the block with it; the block is never Raw", async () => {
  const f = await fixture();
  try {
    await f.append(user("u2", "a1", "p2"), assistant("a2", "u2"));
    const call: CcNativeRecord = { uuid: "call", parentUuid: "a2", type: "assistant", timestamp: time(++clock),
      message: { id: "msg-call", role: "assistant", content: [{ type: "tool_use", id: "call-1", name: "Bash", input: { command: "ls" } }] } };
    const result: CcNativeRecord = { uuid: "result", parentUuid: "call", type: "user", timestamp: time(++clock), promptId: "p2",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "listing" }] } };
    // Claude Code holds the call and its result when the hook runs, and writes them moments later. No
    // executor imports them here, so the build does.
    const building = f.build("result");
    await new Promise(resolveLater => setTimeout(resolveLater, 100));
    f.write(call, result);
    const built = (await building)!;
    expect(decodeCcInjection(carrierIn(built.text), f.visible())).not.toBeNull();
    const raw = built.text.split("\n").filter(line => /^\[T\d+#E\d+@/.test(line));
    expect(raw.slice(-2).map(line => /@(\w+)\]/.exec(line)![1])).toEqual(["assistant", "observation"]);
    expect(raw.at(-2)).toContain("Bash(");
    expect(raw.at(-1)).toContain("listing");
    const [row] = installedBlock("cb", "result", built.text, "p2").slice(1);
    // Recognised by its framed envelope, even if Claude Code were to stamp the row as a prompt.
    expect(classifySourceRecord({ ...row!, promptSource: "typed" })).toBeNull();
    await f.append(...installedBlock("cb", "result", built.text, "p2"), assistant("a3", "cb-block"));
    expect(f.store.findSourceEntry(f.sessionId, f.nativeSession, "cb-block")).toBeNull();
    expect(f.turnOf("a3")).toBe(f.turnOf("u2")); // the reply goes on in the Turn the compaction interrupted
  } finally { f.close(); }
});

test("102 an unbound or disabled session passes through; a path that moves during the build fails it and records nothing", async () => {
  const f = await fixture();
  try {
    expect(await ccCompaction(f.config, { session_id: "unbound-102", trigger: "a1" })).toBeNull();
    const rows = () => f.store.db.prepare("SELECT COUNT(*) AS count FROM knowledge_deliveries").get() as { count: number };
    const before = rows().count;
    const snapshot = Store.prototype.readSnapshot;
    vi.spyOn(Store.prototype, "readSnapshot").mockImplementationOnce(function (this: Store, fn) {
      const value = snapshot.call(this, fn);
      f.write(user("u2", "a1", "p2")); // Claude Code writes a prompt while the block is rendered
      return value;
    });
    await expect(f.build("a1")).rejects.toThrow("changed while the compaction was built");
    expect(rows().count).toBe(before);
    f.store.setEnrollment(f.sessionId, false);
    expect(await f.build("u2")).toBeNull();
  } finally { f.close(); }
});

test("102 requirement 14: an automatic compaction's block ends with Claude Code's own continue sentence after the framing; a manual one never does", async () => {
  const f = await fixture();
  try {
    await f.append(user("u2", "a1", "p2"));
    const manual = (await f.build("u2"))!, auto = (await f.build("u2", true))!;
    expect(manual.text.endsWith(CC_AUTO_CONTINUE_SUFFIX)).toBe(false);
    expect(auto.text.endsWith(CC_AUTO_CONTINUE_SUFFIX)).toBe(true);
    // Unchanged: the carrier still decodes either way (classifier and `/trace` recognition).
    expect(decodeCcInjection(carrierIn(manual.text), f.visible())).not.toBeNull();
    expect(decodeCcInjection(carrierIn(auto.text), f.visible())).not.toBeNull();
  } finally { f.close(); }
});

test("108: several parallel calls' results, each parented under its own call rather than the previous result, all reach the compaction's Raw window", async () => {
  const f = await fixture();
  try {
    // The chain announcing four parallel calls, as a real pinned Claude Code 2.1.280 splits one
    // message (102 Part 2 evidence, /private/tmp/tm102-review.I2x7dw/pre-compaction.jsonl).
    await f.append(user("u2", "a1", "p2"),
      assistantToolUse("call-1", "u2", "msg-batch", "toolu_1"), assistantToolUse("call-2", "call-1", "msg-batch", "toolu_2"),
      assistantToolUse("call-3", "call-2", "msg-batch", "toolu_3"), assistantToolUse("call-4", "call-3", "msg-batch", "toolu_4"));
    // Completion (write) order differs from call order — as it did in the real evidence — and each
    // result parents under its own call, never the previous result. The second append exercises the
    // importer's incremental "continuous" extension (108 also fixed there, not only the full rebuild).
    await f.append(toolResultRow("res-3", "call-3", "toolu_3", "R3"), toolResultRow("res-1", "call-1", "toolu_1", "R1"));
    await f.append(toolResultRow("res-4", "call-4", "toolu_4", "R4"), toolResultRow("res-2", "call-2", "toolu_2", "R2"));
    const built = (await f.build("res-2"))!;
    for (const content of ["R1", "R2", "R3", "R4"]) expect(built.text).toContain(content);
  } finally { f.close(); }
});

test("102 /trace splits a compaction carrier by its compaction's recorded delivery; a carrier nothing recorded stays unavailable", async () => {
  const f = await fixture();
  try {
    await f.append(user("u2", "a1", "p2"));
    const built = (await f.build("u2"))!;
    // Claude Code hands the returned block, in its framing, to the model as a user message ending in a newline.
    const context = (text: string) => readCcMenu(f.config, f.nativeSession, undefined, 10, null,
      { session: f.nativeSession, messages: [{ role: "user", content: [{ type: "text", text: `${text}\n` }] }] }).context;
    const split = context(built.text);
    expect(split.presence).toBe("confirmed");
    expect(split.memory!.knowledge).toBeGreaterThan(0);
    expect(split.memory!.raw).toBeGreaterThan(0);
    expect(Object.values(split.memory!).reduce((sum, value) => sum + value, 0)).toBe(split.estimatedMessagesTokens);
    // Requirement 14: the same automatic compaction's block, with its trailing continue sentence, is
    // still recognised, and its Knowledge/facts/Raw accounting is unchanged — the sentence, like the
    // framing around it, is host framing outside those three, not a fourth memory bucket.
    const autoBuilt = (await f.build("u2", true))!;
    expect(autoBuilt.text.endsWith(CC_AUTO_CONTINUE_SUFFIX)).toBe(true);
    const autoSplit = context(autoBuilt.text);
    expect(autoSplit.presence).toBe("confirmed");
    expect(autoSplit.memory).toMatchObject({ knowledge: split.memory!.knowledge, facts: split.memory!.facts, raw: split.memory!.raw });
    expect(autoSplit.memory!.unclassified).toBeGreaterThan(split.memory!.unclassified); // the sentence's own tokens
    // 82's rule stands for a verified envelope whose Knowledge and cost no compaction recorded.
    const unrecorded = encodeCcInjection(f.visible(), { text: "<knowledge>\nnever delivered\n</knowledge>", knowledgeCommitIds: [], knowledgeTokens: 3 });
    expect(context(unrecorded)).toMatchObject({ presence: "unavailable", reason: "native function carrier provenance unavailable in Messages snapshot" });
  } finally { f.close(); }
});
