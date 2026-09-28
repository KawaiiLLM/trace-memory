import { afterEach, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { TraceMemory, noVisibility, type Injection } from "../../src/core/api/index.ts";
import { Store } from "../../src/core/store/index.ts";
import { knowledge, legacyFacts } from "../support/seed.ts";
import { bindingMutexPath, bindingPath, recordSessionStart, readBinding, updateBinding } from "../../src/hosts/cc/binding.ts";
import { resolveCcHostConfig } from "../../src/hosts/cc/config.ts";
import { ccSessionStartInjection, decodeCcInjection, encodeCcInjection, handleCcHook, readCompleteTranscript } from "../../src/hosts/cc/index.ts";
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

const compactBoundary = (uuid: string, tail: string, second: number): CcNativeRecord[] => [
  { uuid, parentUuid: null, logicalParentUuid: tail, type: "system", subtype: "compact_boundary", timestamp: time(second),
    compactMetadata: { preservedSegment: { headUuid: tail, tailUuid: tail },
      preservedMessages: { anchorUuid: `${uuid}-summary`, uuids: [tail] } } },
  { uuid: `${uuid}-summary`, parentUuid: uuid, type: "user", isCompactSummary: true },
];

// Native-derived shape, sanitized. The attachments are deliberately synthetic, matching the approved
// real-transcript + synthetic-attachment rewind gate rather than claiming native Hook delivery.
test("66 carries exact Fact and Raw membership while decoding legacy carriers", () => {
  const binding = { db: "/d", nativeSession: "n", coreSession: 1 };
  const body = { text: "whole item", knowledgeCommitIds: [8], factIds: [13], entryIds: [21] };
  const encoded = encodeCcInjection(binding, body);
  expect(decodeCcInjection(encoded, binding)).toMatchObject({ commits: [8], factIds: [13], entryIds: [21] });
  const legacy = encodeCcInjection(binding, { text: "legacy", knowledgeCommitIds: [8] });
  expect(decodeCcInjection(legacy, binding)).toMatchObject({ commits: [8], factIds: [], entryIds: [] });
  expect(decodeCcInjection(encoded.replace('"f":[13]', '"f":[13,13]'), binding)).toBeNull();
  expect(decodeCcInjection(encoded.replace('"e":[21]', '"e":[0]'), binding)).toBeNull();
  expect(decodeCcInjection(encoded.replace("whole item", "altered item"), binding)).toBeNull();
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

test("43d injection Hook preserves a pre-existing closed session", async () => {
  const f = await hookFixture();
  const binding = readBinding(f.config, f.nativeSession)!;
  const store = new Store(f.config.dbPath);
  const closedAt = time(7);
  store.closeSession(binding.coreSessionId!, closedAt);
  appendFileSync(f.transcriptPath, compactBoundary("closed-compact", "a", 8).map(line).join(""));
  try {
    expect(await handleCcHook(f.config, { hook_event_name: "SessionStart", source: "compact",
      session_id: f.nativeSession, transcript_path: f.transcriptPath })).toBeNull();
    expect((await handleCcHook(f.config, { hook_event_name: "SessionStart", source: "resume",
      session_id: f.nativeSession, transcript_path: f.transcriptPath }))?.hookSpecificOutput.additionalContext).toContain("hook knowledge");
    expect(store.getSession(binding.coreSessionId!)!.closedAt).toBe(closedAt);
  } finally { store.close(); }
});

test("43d complete transcript reader accepts exact duplicate identities and reports changed bodies", () => {
  const dir = mkdtempSync(join(tmpdir(), "tm43d-identity-")); dirs.push(dir);
  const path = join(dir, "identity.jsonl"), same = attachment("same", "a", "same body");
  writeFileSync(path, `${line(user("u", null, "u"))}${line(assistant("a", "u", "a"))}${line(same)}${line(same)}${line({ ...same, slug: "native-copy" })}`);
  expect(readCompleteTranscript(path).problem).toBeUndefined();
  appendFileSync(path, line({ ...same, slug: "native-copy", attachment: { ...(same.attachment as object), content: ["changed body"] } }));
  expect(readCompleteTranscript(path).problem).toBe("native transcript UUID same changed within the completed file");
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
  // 97: the Hook reads the allocation from the database; with no imported Turn there is nothing to deliver.
  expect(await pending).toBeNull();
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

test("43d injection Hook teardown performs no executor invalidation on disabled, enabled, or error paths", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tm43d-read-close-")); dirs.push(dir);
  const config = resolveCcHostConfig({ dbPath: join(dir, "m.sqlite"), stateDir: join(dir, "s"), baseline: "2025-01-01T00:00:00.000Z" });
  const invalidate = vi.spyOn(Store.prototype, "invalidateExecutor");
  expect(await handleCcHook(config, { hook_event_name: "SessionStart", source: "startup", session_id: "read-close",
    transcript_path: join(dir, "missing.jsonl") })).toBeNull();

  const enabled = await hookFixture();
  invalidate.mockClear();
  const output = await handleCcHook(enabled.config, { hook_event_name: "SessionStart", source: "compact",
    session_id: enabled.nativeSession, transcript_path: enabled.transcriptPath });
  expect(output).toBeNull();
  expect((await handleCcHook(enabled.config, { hook_event_name: "SessionStart", source: "resume",
    session_id: enabled.nativeSession, transcript_path: enabled.transcriptPath }))?.hookSpecificOutput.additionalContext).toContain("hook knowledge");
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
  const entry = memory.appendEntry({ sessionId: session.id, turnId: turn.id, nativeLineage: "fixture", nativeId: "global-rule",
    role: "user", text: "global rule", raw: "global rule", calls: [] });
  const evidence = legacyFacts(memory.store, { kind: "noting", sessionId: session.id, createdAt: time(0) },
    [{ sources: [{ entry, address: `T${turn.id}#E${entry.entryOrdinal}` }], text: "global rule",
      category: "decision", actor: "user", createdAt: time(0) }]).facts[0]!;
  knowledge(memory.store, memory.store.knowledgePath(session.id, "main", turn.id), "global", "constraint",
    [evidence.id], "global knowledge before first reply", { run: { kind: "manual", createdAt: time(0) } });
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
  // A clear is an ordinary new session (102); keep the ambient CLAUDE_PID this process happens to run
  // under out of it (the prior startup Hooks above already published one).
  vi.stubEnv("CLAUDE_PID", "");
  expect(await handleCcHook(config, { hook_event_name: "SessionStart", source: "clear", session_id: cleared,
    transcript_path: join(dir, "clear-missing.jsonl") })).toBeNull();
  expect(readBinding(config, cleared)).toMatchObject({ nativeSessionId: cleared, coreSessionId: null, projectId: null });
});

test("73: SessionStart injection reads the resolved configuration, not the default", async () => {
  const build = async (allowanceOverride?: number) => {
    const dir = mkdtempSync(join(tmpdir(), "tm73-cfg-")); dirs.push(dir);
    const transcriptPath = join(dir, "t.jsonl"), nativeSession = "native-cfg";
    const config = resolveCcHostConfig({ dbPath: join(dir, "m.sqlite"), stateDir: join(dir, "s"), baseline: "2025-01-01T00:00:00.000Z",
      ...(allowanceOverride === undefined ? {} : { "compaction.sharedAllowanceTokens": allowanceOverride }) });
    const records = [user("u", null, "evidence"), assistant("a", "u", "answer")];
    writeFileSync(transcriptPath, records.map(line).join(""));
    const initial = await recordSessionStart(config, { hook_event_name: "SessionStart", source: "startup", session_id: nativeSession, transcript_path: transcriptPath }, time(1));
    const importer = new CcImporter(config, initial);
    const result = await importer.reconcile();
    const entry = importer.memory.store.findSourceEntry(result.coreSessionId!, nativeSession, "u")!;
    const noted = importer.memory.store.commitNotingRun({ run: { kind: "noting", sessionId: result.coreSessionId!, branch: result.branch, createdAt: time(4) },
      entryIds: [entry.id], facts: [{ turnId: entry.turnId, entryIds: [entry.id], category: "decision", actor: "user", text: "config fact",
        source: [`T${entry.turnId}#E${entry.entryOrdinal}`], createdAt: time(4) }] });
    if (!noted.ok) throw new Error(noted.problems.join("; "));
    // Sized to fit the default 20,000-token base plus the default 10,000-token allowance, but not a
    // base plus a 1-token allowance.
    const committed = importer.memory.store.commitConsolidationRun({ path: { sessionId: result.coreSessionId!, branch: result.branch, headTurnId: result.headTurnId! },
      run: { kind: "manual", sessionId: result.coreSessionId!, branch: result.branch, createdAt: time(5) }, operations: [{ op: "create", handle: "$k",
        author: "fixture", text: `config knowledge ${"word ".repeat(24_000)}`, category: "constraint", scope: "session", supports: [noted.facts[0]!.id], topics: [], reason: "fixture", createdAt: time(5) }] });
    if (!committed.ok) throw new Error(committed.problems.join("; "));
    importer.close();
    // `ccSessionStartInjection` directly, not `handleCcHook`: the latter re-resolves its config input
    // from scratch, and a flat override does not survive resolving an already-resolved config twice.
    const output = await ccSessionStartInjection(config, { hook_event_name: "SessionStart", source: "resume", session_id: nativeSession, transcript_path: transcriptPath });
    return output?.hookSpecificOutput.additionalContext;
  };
  expect(await build()).toContain("config knowledge"); // default allowance (10,000): fits
  expect(await build(1)).toBeUndefined(); // configured allowance (1): the same body no longer fits
});
