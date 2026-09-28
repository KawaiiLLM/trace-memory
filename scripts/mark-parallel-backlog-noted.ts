#!/usr/bin/env node
// 102 ruling 15 / 108: a one-time, deploy-time step, not permanent product behaviour.
//
// The 108 fix (`CcTranscriptScan.walkAncestry` recovering a parallel tool-call batch's other calls
// and their own results) changes `selectedPath` for existing Claude Code sessions: entries that were
// real `source_entries` rows all along but sat off the stored path now belong on it. Deployed as-is,
// each would become ordinary pending Raw the next time its session's Noting runs, at real cost, for
// work already superseded by the conversation moving on. The maintainer ruled these historical
// entries are marked once as not needing Noting ("一次性把这些旧条目标成不用补"); anything a parallel
// batch writes after this step runs stays ordinary pending Raw, with no special-casing.
//
// Dry run (default) only counts, exactly as acceptance/count-parallel-backlog.mjs did (this script
// supersedes it). --apply marks entries the same way Noting itself does: one manual run per session
// (Store.commitNotingRun, kind "manual", an empty fact batch) whose entryIds become noted_entries
// rows -- the store's own idiom for "this entry is processed", now used to record a skip instead of
// output. The run's response records ticket 102 and this reason for audit. Already-noted entries are
// never re-marked, so a second --apply finds nothing left to do.
//
// Safety: run only against a disposable copy of the production database and its bindings directory,
// with every Noting/Dreaming writer against the real database stopped first -- this script takes no
// lock of its own beyond the one transaction --apply commits in.
//
// Usage:
//   node --experimental-strip-types scripts/mark-parallel-backlog-noted.ts \
//     --db <copy of trace.db> --bindings <copy of stateDir's bindings dir> [--apply]

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Store } from "../src/core/store/index.ts";
import { CcTranscriptCursor } from "../src/hosts/cc/transcript.ts";

const { values } = parseArgs({ options: {
  db: { type: "string" }, bindings: { type: "string" }, apply: { type: "boolean", default: false },
} });
if (!values.db || !values.bindings) throw new Error("usage: --db <copy of trace.db> --bindings <copy of stateDir/bindings> [--apply]");

const REASON = "102/108: the parallel tool-call batch path-selection fix newly places this entry on " +
  "the session's selected path. It existed, off-path, before the fix deployed, and the maintainer " +
  "ruled it marked once as not needing Noting; an entry a parallel batch writes after this step stays " +
  "ordinary pending Raw.";

interface SessionTarget { nativeSessionId: string; sessionId: number; branch: string; toMark: number[]; alreadyMarked: number }

function computeTargets(store: Store, bindingsDir: string): { targets: SessionTarget[]; sessions: number; skipped: number } {
  const targets: SessionTarget[] = [];
  let sessions = 0, skipped = 0;
  for (const file of readdirSync(bindingsDir)) {
    if (!file.endsWith(".json")) continue;
    let binding: { coreSessionId: number | null; selectedLeafUuid: string | null; nativeSessionId: string; transcriptPath: string; branch: string };
    try { binding = JSON.parse(readFileSync(join(bindingsDir, file), "utf8")); }
    catch { skipped++; continue; }
    if (binding.coreSessionId == null || binding.selectedLeafUuid == null) { skipped++; continue; } // never imported
    const session = store.getSession(binding.coreSessionId);
    if (!session) { skipped++; continue; } // binding outlived its core session in this copy
    let headTurnId: number | undefined;
    try { headTurnId = store.findSourceEntry(binding.coreSessionId, binding.nativeSessionId, binding.selectedLeafUuid)?.turnId
      ?? store.findNativeTurn(binding.coreSessionId, binding.nativeSessionId, binding.selectedLeafUuid)?.turnId; }
    catch { skipped++; continue; }
    if (headTurnId === undefined) { skipped++; continue; }
    const current = new Set(store.sourcePath(binding.coreSessionId, binding.branch, headTurnId).map(entry => entry.nativeId));
    let scan;
    try { scan = new CcTranscriptCursor().scan(binding.transcriptPath, () => {}); }
    catch (error) { console.error(`skip ${binding.nativeSessionId}: transcript unreadable in this copy: ${error}`); skipped++; continue; }
    if (scan.selectedLeafUuid !== binding.selectedLeafUuid) {
      // A transcript copied independently of the database may have moved past the binding's last-known
      // leaf; only compare what the binding itself recorded, as the counting script did.
      console.error(`skip ${binding.nativeSessionId}: transcript leaf differs from the binding's recorded leaf`);
      skipped++; continue;
    }
    const fixedPath = scan.selectedPath();
    if (fixedPath.problem) { console.error(`skip ${binding.nativeSessionId}: ${fixedPath.problem}`); skipped++; continue; }
    const fixed = fixedPath.nodes.filter(node => node.sourceKind && node.sourceKind !== "compaction" && node.copyOf === undefined);
    const additional = fixed.filter(node => !current.has(node.uuid));
    sessions++;
    if (!additional.length) continue;
    const additionalIds = additional.map(node => store.findSourceEntry(binding.coreSessionId!, binding.nativeSessionId, node.uuid)?.id);
    if (additionalIds.some(id => id === undefined))
      throw new Error(`${binding.nativeSessionId}: a newly-placed node has no source_entries row -- this copy is inconsistent`);
    const noted = store.notedEntryIds(additionalIds as number[]);
    const toMark = (additionalIds as number[]).filter(id => !noted.has(id));
    targets.push({ nativeSessionId: binding.nativeSessionId, sessionId: binding.coreSessionId, branch: binding.branch, toMark, alreadyMarked: noted.size });
  }
  return { targets, sessions, skipped };
}

const store = new Store(values.db);
if (!values.apply) store.db.exec("PRAGMA query_only = 1"); // dry run: belt against any write below
try {
  const { targets, sessions, skipped } = computeTargets(store, values.bindings);
  const withWork = targets.filter(t => t.toMark.length);
  const total = withWork.reduce((sum, t) => sum + t.toMark.length, 0);
  if (!values.apply) {
    for (const t of withWork) console.log(`${t.nativeSessionId}: ${t.toMark.length} entries would be marked not needing Noting` +
      (t.alreadyMarked ? ` (${t.alreadyMarked} already marked by an earlier --apply)` : ""));
    console.log(`\n${sessions} sessions compared, ${skipped} skipped.`);
    console.log(`Dry run: ${total} entries across ${withWork.length} sessions would be marked not needing Noting. Re-run with --apply to write.`);
  } else {
    store.transaction(() => {
      for (const t of withWork) {
        const result = store.commitNotingRun({ run: { kind: "manual", sessionId: t.sessionId, branch: t.branch,
          createdAt: new Date().toISOString(), model: "ticket-102-mark-parallel-backlog-noted",
          response: JSON.stringify({ ticket: 102, reason: REASON }) }, facts: [], entryIds: t.toMark });
        if (!result.ok) throw new Error(`${t.nativeSessionId}: ${result.problems.join("; ")}`);
        console.log(`${t.nativeSessionId}: marked ${t.toMark.length} entries not needing Noting (run ${result.runId})`);
      }
    });
    console.log(`\n${sessions} sessions compared, ${skipped} skipped.`);
    console.log(`Marked ${total} entries across ${withWork.length} sessions not needing Noting.`);
  }
} finally { store.close(); }
