#!/usr/bin/env node
// 102 ruling 15 / 108: a one-time, deploy-time step, not permanent product behaviour.
//
// The 108 fix (`CcTranscriptScan.selectedPath` placing every row of a parallel tool-call batch) changes
// the selected path of existing Claude Code sessions: entries that were real `source_entries` rows all
// along but sat off the stored path now belong on it. Deployed as-is, each would become ordinary
// pending Raw the next time its session's Noting runs, at real cost, for work already superseded by the
// conversation moving on. The maintainer ruled these historical entries are marked once as not needing
// Noting ("一次性把这些旧条目标成不用补"); anything a parallel batch writes after this step runs stays
// ordinary pending Raw, with no special-casing.
//
// What is marked is what the executor's restart would newly place because of the fix: it rebuilds each
// session's path at the transcript's current leaf. So an entry is marked when it is on that rebuilt path,
// not on the leaf's plain ancestry (which the restart places with or without the fix), not on the stored
// path, and already a row. A row the transcript holds but the executor never imported is created by
// the restart itself, after deployment, and stays ordinary pending Raw; it is counted, not marked.
//
// Every binding ends in one of three ways, all listed: compared (possibly with entries to mark);
// skipped, when there is nothing to reconcile (never imported, transcript gone, or a core session the
// restart would re-create from the transcript); or failed, when the script cannot tell what the restart
// would place or cannot mark it. Any failure writes nothing and exits non-zero, in a dry run too.
//
// Dry run (default) only counts. --apply marks entries the way Noting itself does: one manual run per
// session (Store.commitNotingRun, kind "manual", an empty fact batch) whose entryIds become noted_entries
// rows, the store's own idiom for "this entry is processed", here recording a skip instead of output.
// The run's response records ticket 102 and this reason for audit. Already-noted entries are never
// re-marked, so a second --apply finds nothing left to do. The whole --apply is one transaction.
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
import { CcTranscriptCursor, CcTranscriptScan, type CcNativeNode } from "../src/hosts/cc/transcript.ts";

const { values } = parseArgs({ options: {
  db: { type: "string" }, bindings: { type: "string" }, apply: { type: "boolean", default: false },
} });
if (!values.db || !values.bindings) throw new Error("usage: --db <copy of trace.db> --bindings <copy of stateDir/bindings> [--apply]");

const REASON = "102/108: the parallel tool-call batch path-selection fix newly places this entry on " +
  "the session's selected path. It existed, off-path, before the fix deployed, and the maintainer " +
  "ruled it marked once as not needing Noting; an entry a parallel batch writes after this step stays " +
  "ordinary pending Raw.";

interface SessionTarget { sessionId: number; branch: string; toMark: number[]; alreadyMarked: number; unimported: number }
type Outcome = { skip: string } | { fail: string } | { target: SessionTarget };
interface Binding { coreSessionId: number | null; selectedLeafUuid: string | null; nativeSessionId: string; transcriptPath: string; branch: string }

const ownsEntry = (node: CcNativeNode): boolean => !!node.sourceKind && node.sourceKind !== "compaction" && node.copyOf === undefined;

function reconcile(store: Store, file: string): Outcome {
  const binding = JSON.parse(readFileSync(join(values.bindings!, file), "utf8")) as Binding;
  const { coreSessionId: sessionId, nativeSessionId: native } = binding;
  if (sessionId === null) return { skip: "never imported: no core session" };
  if (binding.selectedLeafUuid === null) return { skip: "never imported: no selected path" };
  if (!store.getSession(sessionId)) {
    // 84: the executor drops the binding's session and imports the transcript afresh as new entries,
    // unless this database already holds a session for the native session, which it would adopt.
    const adopted = store.findSessionByHost(`cc:${native}`);
    return adopted ? { fail: `the binding names S${sessionId}, absent from this database; a restart would adopt S${adopted.id}` }
      : { skip: `core session S${sessionId} is not in this database; a restart imports the transcript afresh` };
  }
  const scan = new CcTranscriptCursor().scan(binding.transcriptPath, () => {});
  if (!(scan instanceof CcTranscriptScan)) return { skip: "the transcript is gone; a restart publishes nothing for this session" };
  const fixed = scan.selectedPath();
  if (fixed.problem || !fixed.leafUuid) return { fail: fixed.problem ?? "the transcript has no selected leaf" };
  const stored = store.selectedSourceEntryIds(sessionId, binding.branch);
  if (!stored) return { fail: `no stored path for branch ${binding.branch}` };
  const onStored = new Set(stored), plain = new Set<string>();
  for (let node = scan.node(fixed.leafUuid); node; node = node.parentUuid === null ? undefined : scan.node(node.parentUuid)) plain.add(node.uuid);
  const moved = fixed.leafUuid !== binding.selectedLeafUuid, placed: number[] = [];
  let unimported = 0;
  for (const node of fixed.nodes) if (ownsEntry(node) && !plain.has(node.uuid)) {
    const entry = store.findSourceEntry(sessionId, native, node.uuid);
    if (entry) { if (!onStored.has(entry.id)) placed.push(entry.id); }
    // At the binding's own leaf the executor imported every row up to it: a missing one means the
    // database and transcript copies disagree. Past it, the restart imports the row itself.
    else if (!moved) return { fail: `${node.uuid} is on the rebuilt path but has no entry; the database and transcript copies disagree` };
    else unimported++;
  }
  const noted = store.notedEntryIds(placed), toMark = placed.filter(id => !noted.has(id));
  if (toMark.length && !store.enabled(sessionId))
    return { fail: `S${sessionId} is disabled, and Noting's marker refuses a disabled session; ${toMark.length} entries left unmarked` };
  return { target: { sessionId, branch: binding.branch, toMark, alreadyMarked: noted.size, unimported } };
}

// Carries every session's failure so the caller can report them once the transaction has actually
// rolled back. `--experimental-strip-types` (this script's own shebang usage) does not support
// TypeScript parameter properties.
class Failed extends Error {
  failures: string[];
  constructor(failures: string[]) { super(`${failures.length} sessions could not be processed`); this.failures = failures; }
}
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

// Pure except for `store.commitNotingRun` under --apply, which is itself inside the caller's
// transaction. `skip` and "not imported yet" lines describe facts `reconcile` observed, true whether
// or not this run (or its transaction) goes on to succeed, so they print immediately. Marking a
// session not needing Noting is this run's actual write: that line is only true once the whole run
// (and, under --apply, its transaction) has actually succeeded, so it is returned rather than printed,
// and the caller prints it only after `store.transaction` returns -- never before, and never at all on
// a rollback.
function run(store: Store): string[] {
  const outcomes = readdirSync(values.bindings!).filter(file => file.endsWith(".json")).sort().map(file => {
    const name = file.slice(0, -".json".length);
    try { return { name, outcome: reconcile(store, file) }; }
    catch (error) { return { name, outcome: { fail: message(error) } as Outcome }; }
  });
  const failures: string[] = [], targets: { name: string; target: SessionTarget }[] = [];
  let skipped = 0;
  for (const { name, outcome } of outcomes) {
    if ("skip" in outcome) { console.log(`skip ${name}: ${outcome.skip}`); skipped++; }
    else if ("fail" in outcome) failures.push(`${name}: ${outcome.fail}`);
    else targets.push({ name, target: outcome.target });
  }
  const withWork = targets.filter(({ target }) => target.toMark.length), total = withWork.reduce((sum, { target }) => sum + target.toMark.length, 0);
  for (const { name, target } of targets) if (target.unimported)
    console.log(`${name}: the transcript moved past the binding's leaf; ${target.unimported} rows the fix places are not imported yet ` +
      "and stay ordinary pending Raw");
  const resultLines: string[] = [];
  for (const { name, target } of withWork) {
    if (!values.apply) {
      resultLines.push(`${name}: ${target.toMark.length} entries would be marked not needing Noting` +
        (target.alreadyMarked ? ` (${target.alreadyMarked} already marked by an earlier --apply)` : ""));
      continue;
    }
    const result = store.commitNotingRun({ run: { kind: "manual", sessionId: target.sessionId, branch: target.branch,
      createdAt: new Date().toISOString(), model: "ticket-102-mark-parallel-backlog-noted",
      response: JSON.stringify({ ticket: 102, reason: REASON }) }, facts: [], entryIds: target.toMark });
    if (result.ok) resultLines.push(`${name}: marked ${target.toMark.length} entries not needing Noting (run ${result.runId})`);
    else failures.push(`${name}: ${result.problems.join("; ")}`);
  }
  if (failures.length) throw new Failed(failures);
  resultLines.push(`\n${targets.length} sessions compared, ${skipped} skipped.`);
  resultLines.push(values.apply ? `Marked ${total} entries across ${withWork.length} sessions not needing Noting.`
    : `Dry run: ${total} entries across ${withWork.length} sessions would be marked not needing Noting. Re-run with --apply to write.`);
  return resultLines;
}

const store = new Store(values.db);
if (!values.apply) store.db.exec("PRAGMA query_only = 1"); // dry run: belt against any write below
try {
  // --apply computes and writes in one transaction: a failure anywhere rolls every mark back, so the
  // result lines print only once `store.transaction` has returned, meaning the transaction committed.
  const resultLines = values.apply ? store.transaction(() => run(store)) : run(store);
  for (const line of resultLines) console.log(line);
} catch (error) {
  if (!(error instanceof Failed)) throw error;
  for (const failure of error.failures) console.error(`FAIL ${failure}`);
  console.error(`${error.failures.length} sessions could not be processed; nothing was written.`);
  process.exitCode = 1;
} finally { store.close(); }
