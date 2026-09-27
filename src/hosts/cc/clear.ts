import { TraceMemory } from "../../core/api/index.ts";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ResolvedCcHostConfig } from "./config.ts";
import { coreHostOf, readBinding, recordSessionStart, renewNativeBinding, updateBinding, validateNativeSessionId, withCcBindingLock,
  type CcBindingLock, type CcHookInput, type CcSessionBinding } from "./binding.ts";
import { CcProjection } from "./importer.ts";
import { ccTruncationWarning, databaseIdentity, encodeCcInjection, ccSessionStartInjection, type CcHookOutput, type CcVisibleBinding } from "./injection.ts";
import { assignedNativeSession, currentNativeProcess, parsePid, processStartedAt } from "./native-session.ts";
import { ccSourceBlocks, readTranscriptCreatedAt } from "./transcript.ts";

export type CcClearResult = { handled: false } | { handled: true; output: CcHookOutput | null };

/** 63: `/clear` binds the new native session as another lineage of the SAME core session as the one
 * it was cleared from, with the applicable Pi-style compaction material as its SessionStart
 * injection. The parent is the session this Claude Code process served, named by 65's
 * `native-sessions/<CLAUDE_PID>.json` (still the previous SessionStart's record: SessionEnd never
 * rewrites it). Returns `{ handled: false }` when there is no such parent to link, so the caller
 * runs the ordinary new-session path unchanged. */
export async function ccHandleClear(config: ResolvedCcHostConfig, input: CcHookInput): Promise<CcClearResult> {
  const pid = parsePid(process.env.CLAUDE_PID);
  if (pid === null) return { handled: false };
  const record = assignedNativeSession(config, [{ pid, startedAt: processStartedAt(pid) }]);
  if (!record) return { handled: false };
  const parentBinding = readBinding(config, record.nativeSessionId);
  if (!parentBinding) return { handled: false };
  const childId = validateNativeSessionId(input.session_id);
  const nativeProcess = currentNativeProcess();
  const createdAt = readTranscriptCreatedAt(input.transcript_path);

  if (parentBinding.coreSessionId === null) {
    // A provisional parent has nothing to compact from; only its project and enrollment carry over.
    await recordSessionStart(config, input, createdAt);
    await updateBinding(config, childId, current => current && current.coreSessionId === null
      ? { ...current, projectId: parentBinding.projectId, enrollment: parentBinding.enrollment } : current!);
    return { handled: true, output: await ccSessionStartInjection(config, input) };
  }

  // Compaction is not replayable after linking the child: its selected Raw, Facts and warning are
  // frozen here. All slots serialize on the existing child binding mutex, never on a second lock.
  return withCcBindingLock(config, childId, locked => prepareBoundClear(config, input, parentBinding, childId,
    createdAt, nativeProcess, locked), 55_000);
}

async function prepareBoundClear(config: ResolvedCcHostConfig, input: CcHookInput, parentBinding: CcSessionBinding,
  childId: string, createdAt: string | null, nativeProcess: ReturnType<typeof currentNativeProcess>,
  locked: CcBindingLock): Promise<CcClearResult> {
  const existing = locked.read();
  const staged = join(config.stateDir, "session-start", `${childId}.clear.json`);
  if (existing?.clearedFrom) {
    // A crash after child publication but before staging is NOT a licence to recompact or inject
    // ordinary knowledge in place of the frozen material.
    let output: CcHookOutput | null;
    try { output = JSON.parse(readFileSync(staged, "utf8")) as CcHookOutput | null; }
    catch { throw new Error(`clear child ${childId} has no frozen compaction carrier`); }
    if (existing.dbPath !== config.dbPath || existing.transcriptPath !== input.transcript_path)
      throw new Error("clear child binding disagrees with configured database or transcript");
    locked.update(current => renewNativeBinding(current!, nativeProcess));
    return { handled: true, output };
  }
  if (existing) throw new Error(`clear child ${childId} is already bound without a frozen compaction`);
  const memory = TraceMemory(config.dbPath, async () => { throw new Error("CC clear Hook cannot run model work"); },
    config.coreConfig, undefined, entry => entry.nativeLineage === parentBinding.nativeSessionId ? ccSourceBlocks(entry) : undefined);
  try {
    const projection = new CcProjection(config, parentBinding, memory);
    const projected = await projection.synchronize();
    const synced = projection.currentBinding();
    if (projected.state === "not-ready")
      throw new Error(projected.problems.join("; ") || "parent native source projection is not ready");
    if (synced.coreSessionId === null) return { handled: false }; // became provisional under lock; ordinary new session
    const core = synced.coreSessionId;
    const at = new Date().toISOString();

    const linkChild = async (clearedFrom: NonNullable<CcSessionBinding["clearedFrom"]>, lastCompactionNotice: string | null): Promise<void> => {
      locked.update(current => {
        if (current) {
          if (current.dbPath !== config.dbPath || current.transcriptPath !== input.transcript_path)
            throw new Error("native Claude Code binding disagrees with its configured database or transcript path");
          return { ...renewNativeBinding(current, nativeProcess), lastCompactionNotice };
        }
        return {
          version: 1, nativeSessionId: childId, transcriptPath: input.transcript_path, dbPath: config.dbPath,
          nativeCreatedAt: createdAt, enrollment: synced.enrollment, coreSessionId: core, projectId: synced.projectId,
          // 64b: each native lineage owns an independent persisted source path. Reusing the
          // parent's branch would let the child overwrite the parent's retained foreground.
          branch: `cc:${childId}`, selectedLeafUuid: null, executor: null, lastClose: null,
          ...(nativeProcess ? { nativeProcess } : {}),
          ...(synced.cwd !== undefined ? { cwd: synced.cwd } : {}),
          coreHost: coreHostOf(synced), clearedFrom, lastCompactionNotice,
        };
      });
      await updateBinding(config, synced.nativeSessionId, current => current && current.transcriptPath === synced.transcriptPath
        ? { ...current, clearedInto: { nativeSessionId: childId, at } } : current!);
    };

    if (!memory.store.enabled(core)) {
      // Disabled: nothing to compact or inject, but the child still shares the same core session.
      const inheritedEntryIds = memory.store.selectedSourceEntryIds(core, synced.branch) ?? [];
      publishFrozenClear(staged, null);
      await linkChild({ nativeSessionId: synced.nativeSessionId, at, compactionTurnId: null, inheritedEntryIds }, null);
      return { handled: true, output: null };
    }

    if (!synced.selectedLeafUuid) throw new Error("parent Claude Code session has no selected native source to compact from");
    const entry = memory.store.findSourceEntry(core, synced.nativeSessionId, synced.selectedLeafUuid);
    const nativeTurn = memory.store.findNativeTurn(core, synced.nativeSessionId, synced.selectedLeafUuid);
    const headTurnId = entry?.turnId ?? nativeTurn?.turnId;
    if (!headTurnId) throw new Error("parent Claude Code selected native source has no persisted core Turn");

    // 73 "No fallback, in either host": compact truncates unprocessed material to fit rather than
    // asking for a delegation, so `/clear` never substitutes a knowledge-only injection for it.
    const compacted = memory.compact(core, synced.branch, headTurnId, [], true);
    if ("native" in compacted) throw new Error(`Trace Memory compact returned a native delegation unexpectedly: ${compacted.reason}`);
    const injection = { text: compacted.text, knowledgeCommitIds: compacted.supplied.knowledgeCommitIds,
      knowledgeTokens: compacted.supplied.knowledgeTokens, knowledgeStates: compacted.supplied.knowledgeStates,
      factIds: compacted.supplied.factIds, entryIds: compacted.supplied.entries.map(entry => entry.id),
      composition: compacted.composition };

    // 73 "Truncation is announced in the foreground": a top-level `systemMessage` beside
    // `hookSpecificOutput.additionalContext` — Claude Code 2.1.280 shows it to the user (capped at
    // 4,000 characters; this stays well under it).
    const systemMessage = ccTruncationWarning(compacted.truncated);
    const visibleBinding: CcVisibleBinding = { db: databaseIdentity(config.dbPath), nativeSession: childId, coreSession: core };
    const output: CcHookOutput | null = injection.text
      ? { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: encodeCcInjection(visibleBinding, injection) },
        transportItems: compacted.transportItems, transportKnowledgeAllowance: compacted.knowledgeAllowance,
        ...(systemMessage ? { systemMessage } : {}) }
      : systemMessage ? { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "" }, systemMessage } : null;
    publishFrozenClear(staged, output);
    const turn = memory.store.appendTurn({ sessionId: core, parentTurnId: headTurnId, kind: "compaction",
      assistantText: injection.text, startedAt: at, endedAt: at });
    const inheritedEntryIds = memory.store.selectedSourceEntryIds(core, synced.branch) ?? [];
    await linkChild({ nativeSessionId: synced.nativeSessionId, at, compactionTurnId: turn.id, inheritedEntryIds }, systemMessage ?? null);
    return { handled: true, output };
  } finally {
    // Mirrors ccSessionStartInjection: this Hook owns no executor or claim, so its Store closes directly.
    memory.store.close();
  }
}

export function readPreparedClear(config: ResolvedCcHostConfig, input: CcHookInput): CcHookOutput | null {
  const binding = readBinding(config, validateNativeSessionId(input.session_id));
  if (!binding?.clearedFrom || binding.dbPath !== config.dbPath || binding.transcriptPath !== input.transcript_path)
    throw new Error("prepared clear binding is unavailable or changed");
  const staged = join(config.stateDir, "session-start", `${input.session_id}.clear.json`);
  try { return JSON.parse(readFileSync(staged, "utf8")) as CcHookOutput | null; }
  catch { throw new Error(`clear child ${input.session_id} has no frozen compaction carrier`); }
}

function publishFrozenClear(path: string, output: CcHookOutput | null): void {
  if (existsSync(path)) throw new Error(`frozen clear carrier already exists at ${path}; refusing to repeat compaction`);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(output), { flag: "wx", mode: 0o600 });
  renameSync(temporary, path);
}
