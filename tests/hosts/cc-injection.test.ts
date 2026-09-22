import { afterEach, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { TraceMemory, noVisibility, type Injection } from "../../src/core/api/index.ts";
import { Store } from "../../src/core/store/index.ts";
import { bindingMutexPath, bindingPath, recordSessionStart, readBinding, updateBinding } from "../../src/hosts/cc/binding.ts";
import { resolveCcHostConfig } from "../../src/hosts/cc/config.ts";
import { ccSessionStartInjection, ccVisibleView, encodeCcInjection, handleCcHook, readCompleteTranscript,
  selectedCcVisibleRecords } from "../../src/hosts/cc/index.ts";
import { CcImporter } from "../../src/hosts/cc/importer.ts";
import type { CcNativeRecord } from "../../src/hosts/cc/transcript.ts";

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });
const time = (second: number) => `2026-09-18T00:00:${String(second).padStart(2, "0")}.000Z`;
const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const binding = { db: "/d", nativeSession: "native-A", coreSession: 7 };
const injection = (text: string, commits = [11], states: Injection["knowledgeStates"] = []): Injection =>
  ({ text, knowledgeCommitIds: commits, ...(states?.length ? { knowledgeStates: states } : {}) });
const attachment = (uuid: string, parentUuid: string | null, content: string, sessionId = "native-A"): CcNativeRecord => ({
  uuid, parentUuid, type: "attachment", isSidechain: false, sessionId, timestamp: time(9),
  attachment: { type: "hook_additional_context", hookEvent: "SessionStart", hookName: "SessionStart", content: [content] },
});
const user = (uuid: string, parentUuid: string | null, text: string): CcNativeRecord => ({ uuid, parentUuid, type: "user",
  timestamp: time(1), promptSource: "typed", message: { role: "user", content: text } });
const assistant = (uuid: string, parentUuid: string, text: string): CcNativeRecord => ({ uuid, parentUuid, type: "assistant",
  timestamp: time(2), message: { role: "assistant", content: [{ type: "text", text }] } });

// Native-derived shape, sanitized. The attachments are deliberately synthetic, matching the approved
// real-transcript + synthetic-attachment rewind gate rather than claiming native Hook delivery.
test("43d production codec follows the selected rewind sibling and rejects every incomplete or foreign representation", () => {
  const common = encodeCcInjection({ ...binding, coreSession: null }, injection("common", [10], [{ fromCommit: 20, toCommits: [21] }]));
  const old = encodeCcInjection(binding, injection("old sibling", [12]));
  const selected = encodeCcInjection(binding, injection("selected sibling", [13]));
  const unique = encodeCcInjection(binding, injection("unique mutation", [17]));
  const tamperedUnique = unique.replace("unique mutation", "unique mutatjon");
  expect([...tamperedUnique].filter((character, index) => character !== unique[index])).toHaveLength(1);
  const ids = { root: "1d187ddc-bf7d-4025-a2a2-643eee69a6f3", common: "524813cf-86a6-4eef-8ced-588c1eea7f33",
    branch: "af6a8f38-213b-404c-a475-80e90b79a488", oldUser: "2a0082e2-cfd0-480f-95dc-728e6f76f6e7",
    oldLeaf: "6ee9ef77-464d-49bd-a8e3-864f3d1a5b96", newUser: "b8b14254-b936-49f3-a938-84e634d05e82",
    newSource: "3e62a756-aafa-4bda-b799-e8cc17d5fabf", bridge: "20b67edb-2131-4166-9faa-4fb551acdc17",
    newLeaf: "4d1833f2-8785-4d21-981e-951f2ce47a4c" };
  const records: CcNativeRecord[] = [
    user(ids.root, null, "sanitized root"), assistant(ids.common, ids.root, "sanitized common reply"),
    { uuid: ids.branch, parentUuid: ids.common, type: "system", subtype: "turn_duration" },
    attachment("common-carrier", ids.branch, common),
    user(ids.oldUser, "common-carrier", "sanitized old branch"), assistant(ids.oldLeaf, ids.oldUser, "sanitized old reply"),
    attachment("old-carrier", ids.oldLeaf, old),
    user(ids.newUser, "common-carrier", "sanitized new branch"), assistant(ids.newSource, ids.newUser, "sanitized new reply"),
    attachment("preview", ids.newSource, "<persisted-output>\nPreview: TRACE MEMORY KNOWLEDGE K99"),
    attachment("header", "preview", selected.split("\n").slice(0, 2).join("\n")),
    attachment("mutation", "header", tamperedUnique),
    attachment("wrong-db", "mutation", encodeCcInjection({ ...binding, db: "/other" }, injection("foreign", [14]))),
    attachment("wrong-native", "wrong-db", encodeCcInjection({ ...binding, nativeSession: "native-B", coreSession: null }, injection("foreign", [15]))),
    attachment("wrong-core", "wrong-native", encodeCcInjection({ ...binding, coreSession: 8 }, injection("foreign", [16]))),
    { uuid: "stdout", parentUuid: "wrong-core", type: "attachment", attachment: { type: "hook_success", hookEvent: "SessionStart",
      stdout: JSON.stringify({ hookSpecificOutput: { additionalContext: selected } }) } },
    user("read-result", "stdout", "1\\tTRACE MEMORY KNOWLEDGE K88"),
    attachment("selected-carrier", "read-result", selected),
    { ...attachment(ids.bridge, ids.newSource, "native bridge"), logicalParentUuid: "selected-carrier" },
    assistant(ids.newLeaf, ids.bridge, "sanitized selected reply"),
  ];
  expect(selectedCcVisibleRecords(records).map(record => record.uuid)).not.toContain("old-carrier");
  const view = ccVisibleView(records, binding);
  expect([...view.knowledgeCommitIds].sort((a, b) => a - b)).toEqual([10, 13]);
  expect(view.knowledgeCommitIds).not.toContain(17);
  expect([...view.knowledgeStates!]).toEqual(["20>21"]);
  expect(view.factIds.size).toBe(0);
  expect([...view.raw.keys()]).toEqual([ids.root, ids.common, ids.newUser, ids.newSource, "read-result", ids.newLeaf]);

  const missing = structuredClone(records); missing.find(record => record.uuid === ids.newUser)!.parentUuid = "missing";
  expect(() => ccVisibleView(missing, binding)).toThrow("native lineage parent missing is missing");
  const cyclic = structuredClone(records); cyclic.find(record => record.uuid === ids.newUser)!.parentUuid = ids.newSource;
  expect(() => ccVisibleView(cyclic, binding)).toThrow("native lineage cycle");
});

test("43d retained visibility uses compact preservation plus the actual trailing attachment chain", () => {
  const before = encodeCcInjection(binding, injection("before", [30]));
  const after = encodeCcInjection(binding, injection("after", [31]));
  const records: CcNativeRecord[] = [
    user("u", null, "root"), assistant("a", "u", "answer"), attachment("preserved", "a", before),
    { uuid: "boundary", parentUuid: null, logicalParentUuid: "preserved", type: "system", subtype: "compact_boundary", timestamp: time(3),
      compactMetadata: { preservedSegment: { headUuid: "a", anchorUuid: "summary-anchor", tailUuid: "preserved" },
        preservedMessages: { anchorUuid: "summary-anchor", uuids: ["a", "preserved"] } } },
    { uuid: "summary-anchor", parentUuid: "boundary", type: "user", isCompactSummary: true },
    { uuid: "summary-tail", parentUuid: "preserved", type: "user", isCompactSummary: true },
    attachment("compact-carrier", "summary-tail", after),
  ];
  const visible = selectedCcVisibleRecords(records).map(record => record.uuid);
  expect(visible).toEqual(["a", "preserved", "boundary", "summary-tail", "compact-carrier"]);
  expect([...ccVisibleView(records, binding).knowledgeCommitIds].sort((a, b) => a - b)).toEqual([30, 31]);
  const broken = structuredClone(records);
  (broken.find(record => record.uuid === "boundary")!.compactMetadata as { preservedMessages: { uuids: string[] } }).preservedMessages.uuids.push("absent");
  expect(() => selectedCcVisibleRecords(broken)).toThrow("preserves missing record absent");
});

test("43d abandoned compact siblings and their delayed tails cannot donate coverage", () => {
  const common = encodeCcInjection(binding, injection("common", [10]));
  const old = encodeCcInjection(binding, injection("old", [20]));
  const selected = encodeCcInjection(binding, injection("selected", [30]));
  const delayed = encodeCcInjection(binding, injection("delayed old tail", [40]));
  const records: CcNativeRecord[] = [
    user("common-user", null, "common"), assistant("common-reply", "common-user", "common reply"),
    attachment("common-carrier", "common-reply", common), user("old-user", "common-carrier", "old"),
    assistant("old-reply", "old-user", "old reply"), attachment("old-carrier", "old-reply", old),
    { uuid: "old-boundary", parentUuid: null, logicalParentUuid: "old-carrier", type: "system", subtype: "compact_boundary",
      compactMetadata: { preservedMessages: { uuids: ["common-reply", "common-carrier", "old-user", "old-reply", "old-carrier"] } } },
    { uuid: "old-summary", parentUuid: "old-boundary", type: "user", isCompactSummary: true },
    user("new-user", "common-carrier", "new"), assistant("new-reply", "new-user", "new reply"),
    attachment("new-carrier", "new-reply", selected), attachment("delayed-old-carrier", "old-summary", delayed),
  ];
  expect([...ccVisibleView(records, binding).knowledgeCommitIds]).toEqual([10, 30]);
  expect(selectedCcVisibleRecords(records).map(record => record.uuid)).not.toContain("old-boundary");
  expect(selectedCcVisibleRecords(records).map(record => record.uuid)).not.toContain("delayed-old-carrier");
  const ambiguousDelayedTail = structuredClone(records);
  ambiguousDelayedTail.find(record => record.uuid === "delayed-old-carrier")!.parentUuid = "common-carrier";
  expect(() => selectedCcVisibleRecords(ambiguousDelayedTail)).toThrow("ambiguous Hook-carrier tails");
});

test.each(["manual", "auto"])("43d %s native preservation projection decodes the copied compact cycle", trigger => {
  const retained = encodeCcInjection(binding, injection("retained", [50]));
  const trailing = encodeCcInjection(binding, injection("trailing", [51]));
  const records: CcNativeRecord[] = [
    { uuid: "boundary", parentUuid: null, logicalParentUuid: "preserved-tail", type: "system", subtype: "compact_boundary",
      compactMetadata: { trigger, preservedSegment: { headUuid: "preserved-head", anchorUuid: "summary-anchor", tailUuid: "preserved-tail" },
        preservedMessages: { anchorUuid: "summary-anchor", uuids: ["preserved-head", "preserved-tail"], allUuids: ["preserved-head", "preserved-tail"] } } },
    { uuid: "summary-anchor", parentUuid: "boundary", type: "user", isCompactSummary: true },
    assistant("preserved-head", "summary-anchor", "preserved answer"), attachment("preserved-tail", "preserved-head", retained),
    user("live-user", "preserved-tail", "live"), assistant("live-reply", "live-user", "live reply"),
    attachment("trailing-carrier", "live-reply", trailing),
  ];
  expect([...ccVisibleView(records, binding).knowledgeCommitIds]).toEqual([50, 51]);
  expect(selectedCcVisibleRecords(records).map(record => record.uuid)).toEqual(records.map(record => record.uuid));
  const malformed = structuredClone(records);
  (malformed[0]!.compactMetadata as { preservedSegment: { tailUuid: string } }).preservedSegment.tailUuid = "other";
  expect(() => selectedCcVisibleRecords(malformed)).toThrow("native lineage cycle");
});

test("43d first ordinary source after manual compact keeps only preserved and post-boundary bodies", () => {
  const body = (commit: number) => encodeCcInjection(binding, injection(`body ${commit}`, [commit]));
  const records: CcNativeRecord[] = [
    user("old-user", null, "old"), assistant("old-reply", "old-user", "old reply"), attachment("old-carrier", "old-reply", body(10)),
    user("kept-user", "old-carrier", "kept"), assistant("kept-reply", "kept-user", "kept reply"),
    attachment("kept-carrier", "kept-reply", body(20)),
    { uuid: "manual-boundary", parentUuid: null, logicalParentUuid: "kept-carrier", type: "system", subtype: "compact_boundary",
      compactMetadata: { preservedSegment: { headUuid: "kept-reply", anchorUuid: "manual-anchor", tailUuid: "kept-carrier" },
        preservedMessages: { anchorUuid: "manual-anchor", uuids: ["kept-reply", "kept-carrier"] } } },
    { uuid: "manual-anchor", parentUuid: "manual-boundary", type: "user", isCompactSummary: true, promptId: "manual-prompt" },
    { uuid: "command-continuation", parentUuid: "kept-carrier", type: "user", isMeta: true, promptId: "manual-prompt",
      message: { role: "user", content: "sanitized native command continuation" } },
    attachment("compact-carrier", "command-continuation", body(21)),
    user("ordinary-user", "compact-carrier", "ordinary"), assistant("ordinary-reply", "ordinary-user", "ordinary reply"),
    attachment("resume-carrier", "ordinary-reply", body(22)),
  ];
  const commits = [...ccVisibleView(records, binding).knowledgeCommitIds].sort((a, b) => a - b);
  expect(commits).toEqual([20, 21, 22]);
  expect(commits).not.toContain(10);
});

test("43d repeated compactions replace rather than union retained pre-boundary bodies", () => {
  const body = (commit: number) => encodeCcInjection(binding, injection(`body ${commit}`, [commit]));
  const records: CcNativeRecord[] = [
    user("root", null, "root"), assistant("old-reply", "root", "old"), attachment("old-carrier", "old-reply", body(10)),
    { uuid: "boundary-1", parentUuid: null, logicalParentUuid: "old-carrier", type: "system", subtype: "compact_boundary",
      compactMetadata: { preservedSegment: { headUuid: "old-reply", anchorUuid: "anchor-1", tailUuid: "old-carrier" },
        preservedMessages: { anchorUuid: "anchor-1", uuids: ["old-reply", "old-carrier"] } } },
    { uuid: "anchor-1", parentUuid: "boundary-1", type: "user", isCompactSummary: true },
    attachment("compact-1", "anchor-1", body(11)), assistant("post-1", "compact-1", "post one"),
    attachment("resume-1", "post-1", body(20)),
    { uuid: "boundary-2", parentUuid: null, logicalParentUuid: "resume-1", type: "system", subtype: "compact_boundary",
      compactMetadata: { preservedSegment: { headUuid: "post-1", anchorUuid: "anchor-2", tailUuid: "resume-1" },
        preservedMessages: { anchorUuid: "anchor-2", uuids: ["post-1", "resume-1"] } } },
    { uuid: "anchor-2", parentUuid: "boundary-2", type: "user", isCompactSummary: true },
    attachment("compact-2", "anchor-2", body(21)), assistant("post-2", "compact-2", "post two"),
  ];
  const commits = [...ccVisibleView(records, binding).knowledgeCommitIds].sort((a, b) => a - b);
  expect(commits).toEqual([20, 21]);
  expect(commits).not.toContain(10);
  expect(commits).not.toContain(11);
});

test("43d host framing is bounded independently of the unmodified core block", () => {
  const commits = Array.from({ length: 150 }, (_, index) => index + 1);
  const block = "x".repeat(50_000);
  const encoded = encodeCcInjection({ db: "/d", nativeSession: "n", coreSession: 1 }, injection(block, commits));
  expect(encoded).toContain(block);
  expect(encoded.length - block.length).toBeLessThanOrEqual(300 + 12 * commits.length);
});

async function hookFixture() {
  const dir = mkdtempSync(join(tmpdir(), "tm43d-")); dirs.push(dir);
  const transcriptPath = join(dir, "t.jsonl"), nativeSession = "native-hook";
  const config = resolveCcHostConfig({ dbPath: join(dir, "m.sqlite"), stateDir: join(dir, "s"), baseline: "2025-01-01T00:00:00.000Z" });
  const records = [user("u", null, "evidence"), assistant("a", "u", "answer")];
  writeFileSync(transcriptPath, records.map(line).join(""));
  const initial = await recordSessionStart(config, { hook_event_name: "SessionStart", source: "startup", session_id: nativeSession, transcript_path: transcriptPath }, time(1));
  const importer = new CcImporter(config, initial);
  const result = await importer.reconcile();
  const entry = importer.memory.store.findSourceEntry(result.coreSessionId!, nativeSession, "u")!;
  const noted = importer.memory.store.commitNotingRun({ run: { kind: "noting", sessionId: result.coreSessionId!, branch: result.branch, createdAt: time(4) },
    entryIds: [entry.id], facts: [{ turnId: entry.turnId, entryIds: [entry.id], category: "decision", actor: "user", text: "hook fact",
      source: [`T${entry.turnId}#E${entry.entryOrdinal}`], createdAt: time(4) }] });
  if (!noted.ok) throw new Error(noted.problems.join("; "));
  const committed = importer.memory.store.commitConsolidationRun({ path: { sessionId: result.coreSessionId!, branch: result.branch, headTurnId: result.headTurnId! },
    run: { kind: "manual", sessionId: result.coreSessionId!, branch: result.branch, createdAt: time(5) }, operations: [{ op: "create", handle: "$k",
      author: "fixture", text: `hook knowledge ${"x".repeat(12_000)}`, category: "constraint", scope: "session", supports: [noted.facts[0]!.id], topics: [], reason: "fixture", createdAt: time(5) }] });
  if (!committed.ok) throw new Error(committed.problems.join("; "));
  importer.close();
  return { config, transcriptPath, nativeSession, records, commit: committed.committed[0]!.commit };
}

test("43d a one-character body change in the only retained Hook copy has zero coverage and resends", async () => {
  const altered = await hookFixture();
  const alteredInput = { hook_event_name: "SessionStart" as const, source: "resume" as const,
    session_id: altered.nativeSession, transcript_path: altered.transcriptPath };
  const first = await handleCcHook(altered.config, { ...alteredInput, source: "compact" });
  const complete = first!.hookSpecificOutput.additionalContext;
  const changed = complete.replace("hook knowledge", "hook knowledgf");
  expect([...changed].filter((character, index) => character !== complete[index])).toHaveLength(1);
  const retainedTranscript = (records: CcNativeRecord[], content: string, nativeSession: string): CcNativeRecord[] => [
    ...records, attachment("only-carrier", "a", content, nativeSession),
  ];
  writeFileSync(altered.transcriptPath, retainedTranscript(altered.records, changed, altered.nativeSession).map(line).join(""));

  const snapshot = readCompleteTranscript(altered.transcriptPath);
  expect(snapshot.problem).toBeUndefined();
  const stat = statSync(altered.config.dbPath);
  const coreSession = readBinding(altered.config, altered.nativeSession)!.coreSessionId;
  const view = ccVisibleView(snapshot.records, { db: `${stat.dev}:${stat.ino}`, nativeSession: altered.nativeSession, coreSession });
  expect([...view.knowledgeCommitIds]).toEqual([]);
  expect((await handleCcHook(altered.config, { ...alteredInput, source: "compact" }))?.hookSpecificOutput.additionalContext).toBe(complete);

  const valid = await hookFixture();
  const validInput = { ...alteredInput, session_id: valid.nativeSession, transcript_path: valid.transcriptPath };
  const validFirst = await handleCcHook(valid.config, { ...validInput, source: "compact" });
  writeFileSync(valid.transcriptPath, retainedTranscript(valid.records, validFirst!.hookSpecificOutput.additionalContext, valid.nativeSession).map(line).join(""));
  expect(await handleCcHook(valid.config, validInput)).toBeNull();
});

test("43d Hook-first and MCP-first compact projection are idempotent and preserve lifecycle state", async () => {
  const f = await hookFixture();
  const stale = new CcImporter(f.config, readBinding(f.config, f.nativeSession)!);
  try {
    const before = await stale.reconcile();
    const sessionId = before.coreSessionId!, store = stale.memory.store;
    const claim = store.acquireClaim({ sessionId, branch: before.branch, headTurnId: before.headTurnId! }, "noting", "live-executor");
    expect(claim).not.toBeNull();
    const claimBefore = store.getClaim(sessionId, "noting");
    const executor = { executorId: "live-executor", pid: process.pid, token: "live-token",
      socketPath: join(f.config.stateDir, "live.sock"), startedAt: time(5) };
    await updateBinding(f.config, f.nativeSession, current => ({ ...current!, executor }));
    const closedBefore = store.getSession(sessionId)!.closedAt;
    appendFileSync(f.transcriptPath, line({ uuid: "compact-one", parentUuid: null, logicalParentUuid: "a",
      type: "system", subtype: "compact_boundary", timestamp: time(6) }));
    const input = { hook_event_name: "SessionStart" as const, source: "compact" as const,
      session_id: f.nativeSession, transcript_path: f.transcriptPath };
    const first = await handleCcHook(f.config, input);
    expect(first?.hookSpecificOutput.additionalContext).toContain("hook knowledge");
    expect(readBinding(f.config, f.nativeSession)).toMatchObject({ selectedLeafUuid: "compact-one", executor });
    expect(store.getClaim(sessionId, "noting")).toEqual(claimBefore);
    expect(store.getSession(sessionId)!.closedAt).toBe(closedBefore);
    expect(store.findNativeTurn(sessionId, f.nativeSession, "compact-one")?.kind).toBe("compaction");

    const afterHook = store.listSourceEntries(sessionId).length;
    const caughtUp = await stale.reconcile();
    expect(caughtUp.appendedEntryIds).toEqual([]);
    expect(caughtUp).toMatchObject({ state: "ready", branch: readBinding(f.config, f.nativeSession)!.branch });
    expect(store.listSourceEntries(sessionId)).toHaveLength(afterHook);
    expect(store.db.prepare("SELECT COUNT(*) AS count FROM native_turns WHERE session_id = ? AND native_lineage = ? AND native_id = ?")
      .get(sessionId, f.nativeSession, "compact-one")).toEqual({ count: 1 });
    expect((await handleCcHook(f.config, input))?.hookSpecificOutput.additionalContext)
      .toBe(first!.hookSpecificOutput.additionalContext);

    appendFileSync(f.transcriptPath, line({ uuid: "compact-two", parentUuid: null, logicalParentUuid: "compact-one",
      type: "system", subtype: "compact_boundary", timestamp: time(7) }));
    const mcpFirst = await stale.reconcile();
    expect(mcpFirst.appendedEntryIds).toEqual([]);
    const durablePath = store.selectedSourceEntryIds(sessionId, mcpFirst.branch);
    const afterMcp = store.listSourceEntries(sessionId).length;
    const afterMcpHook = await handleCcHook(f.config, input);
    expect(afterMcpHook?.hookSpecificOutput.additionalContext).toBe(first!.hookSpecificOutput.additionalContext);
    expect(store.selectedSourceEntryIds(sessionId, readBinding(f.config, f.nativeSession)!.branch)).toEqual(durablePath);
    expect(store.listSourceEntries(sessionId)).toHaveLength(afterMcp);
    expect(store.getClaim(sessionId, "noting")).toEqual(claimBefore);
  } finally { stale.close(); }
});

test("43d Hook projection failure leaves committed records retryable without publishing a stale leaf", async () => {
  const f = await hookFixture();
  const before = readBinding(f.config, f.nativeSession)!;
  appendFileSync(f.transcriptPath, line({ uuid: "retry-compact", parentUuid: null, logicalParentUuid: "a",
    type: "system", subtype: "compact_boundary", timestamp: time(7) }));
  const select = Store.prototype.publishSourcePath; let failed = false;
  vi.spyOn(Store.prototype, "publishSourcePath").mockImplementation(function (this: Store,
    ...args: Parameters<Store["publishSourcePath"]>) {
    if (!failed) { failed = true; throw new Error("injected Hook projection failure"); }
    return select.apply(this, args);
  });
  const input = { hook_event_name: "SessionStart" as const, source: "compact" as const,
    session_id: f.nativeSession, transcript_path: f.transcriptPath };
  await expect(handleCcHook(f.config, input)).rejects.toThrow("injected Hook projection failure");
  expect(readBinding(f.config, f.nativeSession)!.selectedLeafUuid).toBe(before.selectedLeafUuid);
  const store = new Store(f.config.dbPath);
  expect(store.findNativeTurn(before.coreSessionId!, f.nativeSession, "retry-compact")?.kind).toBe("compaction");
  expect((await handleCcHook(f.config, input))?.hookSpecificOutput.additionalContext).toContain("hook knowledge");
  expect(readBinding(f.config, f.nativeSession)!.selectedLeafUuid).toBe("retry-compact");
  expect(store.db.prepare("SELECT COUNT(*) AS count FROM native_turns WHERE native_lineage = ? AND native_id = ?")
    .get(f.nativeSession, "retry-compact")).toEqual({ count: 1 });
  store.close();
});

test("43d Hook rejects an incomplete tail without moving the selected projection", async () => {
  const f = await hookFixture(), before = readBinding(f.config, f.nativeSession)!;
  appendFileSync(f.transcriptPath, '{"uuid":"incomplete"');
  await expect(handleCcHook(f.config, { hook_event_name: "SessionStart", source: "resume",
    session_id: f.nativeSession, transcript_path: f.transcriptPath })).rejects.toThrow("incomplete trailing bytes");
  expect(readBinding(f.config, f.nativeSession)!.selectedLeafUuid).toBe(before.selectedLeafUuid);
});

test("43d projection-only Hook preserves a pre-existing closed session", async () => {
  const f = await hookFixture();
  const binding = readBinding(f.config, f.nativeSession)!;
  const store = new Store(f.config.dbPath);
  const closedAt = time(7);
  store.closeSession(binding.coreSessionId!, closedAt);
  appendFileSync(f.transcriptPath, line({ uuid: "closed-compact", parentUuid: null, logicalParentUuid: "a",
    type: "system", subtype: "compact_boundary", timestamp: time(8) }));
  try {
    expect((await handleCcHook(f.config, { hook_event_name: "SessionStart", source: "compact",
      session_id: f.nativeSession, transcript_path: f.transcriptPath }))?.hookSpecificOutput.additionalContext).toContain("hook knowledge");
    expect(store.getSession(binding.coreSessionId!)!.closedAt).toBe(closedAt);
  } finally { store.close(); }
});

test("43d actual SessionStart Hook emits once, resume recognizes it, and compact intentionally reinjects", async () => {
  const f = await hookFixture();
  const input = { hook_event_name: "SessionStart" as const, source: "resume" as const, session_id: f.nativeSession, transcript_path: f.transcriptPath };
  const first = await handleCcHook(f.config, { ...input, source: "compact" });
  expect(first?.hookSpecificOutput.hookEventName).toBe("SessionStart");
  expect(first?.hookSpecificOutput.additionalContext).toContain("hook knowledge");
  expect(first!.hookSpecificOutput.additionalContext.length).toBeGreaterThan(10_000);
  appendFileSync(f.transcriptPath, line(attachment("carrier", "a", first!.hookSpecificOutput.additionalContext, f.nativeSession)));
  expect(await handleCcHook(f.config, input)).toBeNull();
  const compact = await handleCcHook(f.config, { ...input, source: "compact" });
  expect(compact?.hookSpecificOutput.additionalContext).toContain("hook knowledge");

  const memory = TraceMemory(f.config.dbPath, async () => { throw new Error("offline"); });
  memory.store.setEnrollment(readBinding(f.config, f.nativeSession)!.coreSessionId!, false); memory.close();
  expect(await handleCcHook(f.config, input)).toBeNull();
});

test("43d complete transcript reader accepts exact duplicate identities and reports changed bodies", () => {
  const dir = mkdtempSync(join(tmpdir(), "tm43d-identity-")); dirs.push(dir);
  const path = join(dir, "identity.jsonl"), same = attachment("same", "a", "same body");
  writeFileSync(path, `${line(user("u", null, "u"))}${line(assistant("a", "u", "a"))}${line(same)}${line(same)}${line({ ...same, slug: "native-copy" })}`);
  expect(readCompleteTranscript(path).problem).toBeUndefined();
  appendFileSync(path, line({ ...same, slug: "native-copy", attachment: { ...(same.attachment as object), content: ["changed body"] } }));
  expect(readCompleteTranscript(path).problem).toBe("native transcript UUID same changed within the completed file");
});

test("43d Hook keeps ancestry failure explicit and leaves the prior branch selected", async () => {
  const f = await hookFixture(), before = readBinding(f.config, f.nativeSession)!;
  appendFileSync(f.transcriptPath, line(assistant("broken-leaf", "absent", "broken")));
  await expect(handleCcHook(f.config, { hook_event_name: "SessionStart", source: "resume",
    session_id: f.nativeSession, transcript_path: f.transcriptPath })).rejects.toThrow("native lineage parent absent is missing");
  expect(readBinding(f.config, f.nativeSession)).toMatchObject({ selectedLeafUuid: before.selectedLeafUuid, branch: before.branch });
});

test("43d rejects a changed UUID body before it can donate coverage", async () => {
  const f = await hookFixture();
  const first = encodeCcInjection({ db: "unused", nativeSession: f.nativeSession, coreSession: null }, injection("unused", [1]));
  // Both records are valid Hook carriers; identity integrity, not envelope parsing, must reject the file.
  appendFileSync(f.transcriptPath, line(attachment("same-carrier", "a", first, f.nativeSession)));
  appendFileSync(f.transcriptPath, line(attachment("same-carrier", "a", `${first}\nchanged`, f.nativeSession)));
  await expect(handleCcHook(f.config, { hook_event_name: "SessionStart", source: "resume", session_id: f.nativeSession,
    transcript_path: f.transcriptPath })).rejects.toThrow("native transcript UUID same-carrier changed within the completed file");
});

test("43d locked bootstrap preserves a concurrent allocation and project assignment", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tm43d-race-")); dirs.push(dir);
  const config = resolveCcHostConfig({ dbPath: join(dir, "m.sqlite"), stateDir: join(dir, "s"), baseline: "2025-01-01T00:00:00.000Z" });
  const input = { hook_event_name: "SessionStart" as const, source: "startup" as const, session_id: "race-native",
    transcript_path: join(dir, "missing.jsonl") };
  await recordSessionStart(config, input, time(1));
  const memory = TraceMemory(config.dbPath, async () => { throw new Error("offline"); });
  const mutex = new DatabaseSync(bindingMutexPath(config, input.session_id), { timeout: 0 }); mutex.exec("BEGIN IMMEDIATE");
  const pending = ccSessionStartInjection(config, input);
  const project = memory.store.createProject({ name: "declared-during-race", declaredBy: "mark" });
  const session = memory.store.createSession({ host: `cc:${input.session_id}`, projectId: project.id, startedAt: time(1), firstReplyAt: time(2), enrollmentChoice: true });
  writeFileSync(bindingPath(config, input.session_id), `${JSON.stringify({ ...readBinding(config, input.session_id)!, coreSessionId: session.id, projectId: project.id })}\n`);
  mutex.exec("ROLLBACK"); mutex.close();
  await expect(pending).rejects.toThrow("native transcript is unavailable for an allocated Claude Code session");
  expect(readBinding(config, input.session_id)).toMatchObject({ coreSessionId: session.id, projectId: project.id });
  expect(memory.store.getSession(session.id)?.projectId).toBe(project.id);
  memory.close();
});

test("43d locked bootstrap observes concurrent off without creating a project", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tm43d-off-race-")); dirs.push(dir);
  const config = resolveCcHostConfig({ dbPath: join(dir, "m.sqlite"), stateDir: join(dir, "s"), baseline: "2025-01-01T00:00:00.000Z" });
  const input = { hook_event_name: "SessionStart" as const, source: "startup" as const, session_id: "off-race",
    transcript_path: join(dir, "missing.jsonl") };
  await recordSessionStart(config, input, time(1));
  const mutex = new DatabaseSync(bindingMutexPath(config, input.session_id), { timeout: 0 }); mutex.exec("BEGIN IMMEDIATE");
  const pending = ccSessionStartInjection(config, input);
  writeFileSync(bindingPath(config, input.session_id), `${JSON.stringify({ ...readBinding(config, input.session_id)!,
    enrollment: { defaultEnabled: true, choice: false } })}\n`);
  mutex.exec("ROLLBACK"); mutex.close();
  expect(await pending).toBeNull();
  const memory = TraceMemory(config.dbPath, async () => { throw new Error("offline"); });
  expect(memory.store.findProjectByName(`cc:${input.session_id}`)).toBeNull();
  expect(readBinding(config, input.session_id)).toMatchObject({ coreSessionId: null, projectId: null,
    enrollment: { choice: false } });
  memory.close();
});

test("43d refuses a bound project change instead of injecting for a guessed target", async () => {
  const f = await hookFixture();
  const memory = TraceMemory(f.config.dbPath, async () => { throw new Error("offline"); });
  const other = memory.store.createProject({ name: "other", declaredBy: "mark" }); memory.close();
  await updateBinding(f.config, f.nativeSession, current => ({ ...current!, projectId: other.id }));
  await expect(handleCcHook(f.config, { hook_event_name: "SessionStart", source: "resume", session_id: f.nativeSession,
    transcript_path: f.transcriptPath })).rejects.toThrow("core session or project disagrees");
});

test("43d projection-only Hook teardown performs no executor invalidation on disabled, enabled, or error paths", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tm43d-read-close-")); dirs.push(dir);
  const config = resolveCcHostConfig({ dbPath: join(dir, "m.sqlite"), stateDir: join(dir, "s"), baseline: "2025-01-01T00:00:00.000Z" });
  const invalidate = vi.spyOn(Store.prototype, "invalidateExecutor");
  expect(await handleCcHook(config, { hook_event_name: "SessionStart", source: "startup", session_id: "read-close",
    transcript_path: join(dir, "missing.jsonl") })).toBeNull();

  const enabled = await hookFixture();
  invalidate.mockClear();
  const output = await handleCcHook(enabled.config, { hook_event_name: "SessionStart", source: "compact",
    session_id: enabled.nativeSession, transcript_path: enabled.transcriptPath });
  expect(output?.hookSpecificOutput.additionalContext).toContain("hook knowledge");
  appendFileSync(enabled.transcriptPath, "{not-json}\n");
  await expect(handleCcHook(enabled.config, { hook_event_name: "SessionStart", source: "resume",
    session_id: enabled.nativeSession, transcript_path: enabled.transcriptPath })).rejects.toThrow("invalid completed transcript record");
  expect(invalidate).not.toHaveBeenCalled();
  const reopened = new Store(enabled.config.dbPath); reopened.close();
});

test("43d provisional first prompt injects global knowledge without allocating or reopening a session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tm43d-provisional-")); dirs.push(dir);
  const transcriptPath = join(dir, "native.jsonl"), nativeSession = "hook-provisional";
  const config = resolveCcHostConfig({ dbPath: join(dir, "m.sqlite"), stateDir: join(dir, "s"), baseline: "2025-01-01T00:00:00.000Z" });
  const memory = TraceMemory(config.dbPath, async () => { throw new Error("offline"); });
  const project = memory.store.createProject({ name: "seed", declaredBy: "mark" });
  const session = memory.store.createSession({ enrollmentChoice: true, host: "fixture", projectId: project.id,
    startedAt: time(0), firstReplyAt: time(0) });
  const turn = memory.store.appendTurn({ sessionId: session.id, kind: "turn", startedAt: time(0), userPrompt: "global rule" });
  const noted = memory.store.commitNotingRun({ run: { kind: "noting", sessionId: session.id, createdAt: time(0) },
    facts: [{ turnId: turn.id, category: "decision", actor: "user", text: "global rule",
      source: [`T${turn.id}#user`], createdAt: time(0) }] });
  if (!noted.ok) throw new Error(noted.problems.join("; "));
  const committed = memory.store.commitConsolidationRun({ run: { kind: "consolidation", sessionId: session.id, createdAt: time(0) },
    operations: [{ op: "create", topics: [], reason: "fixture", handle: "$global", author: "fixture",
      text: "global knowledge before first reply", supports: [noted.facts[0]!.id], createdAt: time(0),
      category: "constraint", scope: "global" }] });
  if (!committed.ok) throw new Error(committed.problems.join("; "));
  memory.store.close();
  writeFileSync(transcriptPath, line(user("first-user", null, "first prompt before any assistant reply")));
  const reopen = vi.spyOn(Store.prototype, "reopenSession");
  const output = await handleCcHook(config, { hook_event_name: "SessionStart", source: "startup",
    session_id: nativeSession, transcript_path: transcriptPath });
  expect(output?.hookSpecificOutput.additionalContext).toContain("global knowledge before first reply");
  const provisional = readBinding(config, nativeSession)!;
  expect(provisional).toMatchObject({ coreSessionId: null, projectId: expect.any(Number), selectedLeafUuid: null, executor: null });
  const store = new Store(config.dbPath);
  expect(store.findSessionByHost(`cc:${nativeSession}`)).toBeNull();
  expect(store.db.prepare("SELECT COUNT(*) AS count FROM task_claims").get()).toEqual({ count: 0 });
  expect(reopen).not.toHaveBeenCalled();
  store.close();
});

test("43d SessionStart allocates and projects without reopening or claiming the new core session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tm43d-allocation-")); dirs.push(dir);
  const transcriptPath = join(dir, "native.jsonl"), nativeSession = "hook-allocation";
  const config = resolveCcHostConfig({ dbPath: join(dir, "m.sqlite"), stateDir: join(dir, "s"), baseline: "2025-01-01T00:00:00.000Z" });
  writeFileSync(transcriptPath, [user("alloc-u", null, "allocate"), assistant("alloc-a", "alloc-u", "answer")].map(line).join(""));
  const reopen = vi.spyOn(Store.prototype, "reopenSession");
  expect(await handleCcHook(config, { hook_event_name: "SessionStart", source: "startup",
    session_id: nativeSession, transcript_path: transcriptPath })).toBeNull();
  const allocated = readBinding(config, nativeSession)!;
  expect(allocated).toMatchObject({ coreSessionId: expect.any(Number), selectedLeafUuid: "alloc-a", executor: null });
  const store = new Store(config.dbPath);
  expect(store.getSession(allocated.coreSessionId!)!.closedAt).toBeNull();
  expect(store.db.prepare("SELECT COUNT(*) AS count FROM task_claims WHERE session_id = ?").get(allocated.coreSessionId!))
    .toEqual({ count: 0 });
  expect(reopen).not.toHaveBeenCalled();
  store.close();
});

test("43d startup without a transcript stays disabled unless explicitly enrolled, then provisions only its project", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tm43d-p-")); dirs.push(dir);
  const config = resolveCcHostConfig({ dbPath: join(dir, "m.sqlite"), stateDir: join(dir, "s"), baseline: "2025-01-01T00:00:00.000Z" });
  const transcriptPath = join(dir, "missing.jsonl"), nativeSession = "provisional";
  const output = await handleCcHook(config, { hook_event_name: "SessionStart", source: "startup", session_id: nativeSession, transcript_path: transcriptPath });
  expect(output).toBeNull();
  expect(readBinding(config, nativeSession)).toMatchObject({ coreSessionId: null, projectId: null,
    enrollment: { defaultEnabled: false, choice: null }, executor: null });
  await updateBinding(config, nativeSession, current => ({ ...current!, enrollment: { ...current!.enrollment, choice: true } }));
  expect(await handleCcHook(config, { hook_event_name: "SessionStart", source: "startup", session_id: nativeSession, transcript_path: transcriptPath })).toBeNull();
  expect(readBinding(config, nativeSession)).toMatchObject({ coreSessionId: null, projectId: expect.any(Number), executor: null });
  const cleared = "provisional-clear";
  // 63: this clear has no bound parent to link, on purpose; force that regardless of the ambient
  // CLAUDE_PID this process happens to run under (the prior startup Hooks above already published one).
  vi.stubEnv("CLAUDE_PID", "");
  expect(await handleCcHook(config, { hook_event_name: "SessionStart", source: "clear", session_id: cleared,
    transcript_path: join(dir, "clear-missing.jsonl") })).toBeNull();
  expect(readBinding(config, cleared)).toMatchObject({ nativeSessionId: cleared, coreSessionId: null, projectId: null });
});
