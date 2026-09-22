import { TraceMemory, noVisibility, type Injection } from "../../core/api/index.ts";
import type { ResolvedCcHostConfig } from "./config.ts";
import { coreHostOf, readBinding, recordSessionStart, updateBinding, validateNativeSessionId, withCcBindingLock,
  type CcHookInput, type CcSessionBinding } from "./binding.ts";
import { CcProjection } from "./importer.ts";
import { databaseIdentity, encodeCcInjection, ccSessionStartInjection, type CcHookOutput, type CcVisibleBinding } from "./injection.ts";
import { assignedNativeSession, parsePid, processStartedAt } from "./native-session.ts";
import { ccSourceBlocks, nativeCreatedAt, readCompleteTranscript } from "./transcript.ts";

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
  const childSnapshot = readCompleteTranscript(input.transcript_path);
  const createdAt = childSnapshot.exists && !childSnapshot.problem ? nativeCreatedAt(childSnapshot.records) : null;

  if (parentBinding.coreSessionId === null) {
    // A provisional parent has nothing to compact from; only its project and enrollment carry over.
    await recordSessionStart(config, input, createdAt);
    await updateBinding(config, childId, current => current && current.coreSessionId === null
      ? { ...current, projectId: parentBinding.projectId, enrollment: parentBinding.enrollment } : current!);
    return { handled: true, output: await ccSessionStartInjection(config, input) };
  }

  const memory = TraceMemory(config.dbPath, async () => { throw new Error("CC clear Hook cannot run model work"); },
    {}, undefined, entry => entry.nativeLineage === parentBinding.nativeSessionId ? ccSourceBlocks(entry) : undefined);
  try {
    const projection = new CcProjection(config, parentBinding, memory);
    const projected = await projection.synchronize();
    const synced = projection.currentBinding();
    if (projected.state === "not-ready")
      throw new Error(projected.problems.join("; ") || "parent native source projection is not ready");
    if (synced.coreSessionId === null) return { handled: false }; // became provisional under lock; ordinary new session
    const core = synced.coreSessionId;
    const at = new Date().toISOString();

    const linkChild = async (clearedFrom: NonNullable<CcSessionBinding["clearedFrom"]>): Promise<void> => {
      await withCcBindingLock(config, childId, locked => locked.update(current => {
        if (current) {
          if (current.dbPath !== config.dbPath || current.transcriptPath !== input.transcript_path)
            throw new Error("native Claude Code binding disagrees with its configured database or transcript path");
          return current;
        }
        return {
          version: 1, nativeSessionId: childId, transcriptPath: input.transcript_path, dbPath: config.dbPath,
          nativeCreatedAt: createdAt, enrollment: synced.enrollment, coreSessionId: core, projectId: synced.projectId,
          // 64b: each native lineage owns an independent persisted source path. Reusing the
          // parent's branch would let the child overwrite the parent's retained foreground.
          branch: `cc:${childId}`, selectedLeafUuid: null, executor: null, lastClose: null,
          ...(synced.cwd !== undefined ? { cwd: synced.cwd } : {}),
          coreHost: coreHostOf(synced), clearedFrom,
        };
      }));
      await updateBinding(config, synced.nativeSessionId, current => current && current.transcriptPath === synced.transcriptPath
        ? { ...current, clearedInto: { nativeSessionId: childId, at } } : current!);
    };

    if (!memory.store.enabled(core)) {
      // Disabled: nothing to compact or inject, but the child still shares the same core session.
      const inheritedEntryIds = memory.store.selectedSourceEntryIds(core, synced.branch) ?? [];
      await linkChild({ nativeSessionId: synced.nativeSessionId, at, compactionTurnId: null, inheritedEntryIds });
      return { handled: true, output: null };
    }

    if (!synced.selectedLeafUuid) throw new Error("parent Claude Code session has no selected native source to compact from");
    const entry = memory.store.findSourceEntry(core, synced.nativeSessionId, synced.selectedLeafUuid);
    const nativeTurn = memory.store.findNativeTurn(core, synced.nativeSessionId, synced.selectedLeafUuid);
    const headTurnId = entry?.turnId ?? nativeTurn?.turnId;
    if (!headTurnId) throw new Error("parent Claude Code selected native source has no persisted core Turn");

    const compacted = memory.compact(core, synced.branch, headTurnId);
    const injection: Injection = "native" in compacted
      ? memory.injection({ sessionId: core, branch: synced.branch, headTurnId }, noVisibility())
      : { text: compacted.text, knowledgeCommitIds: compacted.supplied.knowledgeCommitIds, composition: compacted.composition };

    const turn = memory.store.appendTurn({ sessionId: core, parentTurnId: headTurnId, kind: "compaction",
      assistantText: injection.text, startedAt: at, endedAt: at });
    const inheritedEntryIds = memory.store.selectedSourceEntryIds(core, synced.branch) ?? [];
    await linkChild({ nativeSessionId: synced.nativeSessionId, at, compactionTurnId: turn.id, inheritedEntryIds });

    if (!injection.text) return { handled: true, output: null };
    const visibleBinding: CcVisibleBinding = { db: databaseIdentity(config.dbPath), nativeSession: childId, coreSession: core };
    return { handled: true, output: { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: encodeCcInjection(visibleBinding, injection) } } };
  } finally {
    // Mirrors ccSessionStartInjection: this Hook owns no executor or claim, so its Store closes directly.
    memory.store.close();
  }
}
