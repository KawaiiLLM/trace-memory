// 102 ruling 15 / 108: scripts/mark-parallel-backlog-noted.ts marks, once, exactly the entries the
// parallel-tool-call path-selection fix newly places on an existing session's selected path.
import { afterEach, expect, test } from "vitest";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../src/core/store/index.ts";
import { readBinding, recordSessionStart } from "../../src/hosts/cc/binding.ts";
import { resolveCcHostConfig, type ResolvedCcHostConfig } from "../../src/hosts/cc/config.ts";
import { CcImporter } from "../../src/hosts/cc/importer.ts";
import type { CcNativeRecord } from "../../src/hosts/cc/transcript.ts";

const repoRoot = join(import.meta.dirname, "../..");
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const time = (second: number) => `2026-09-28T00:00:${String(second % 60).padStart(2, "0")}.000Z`;
const line = (value: unknown) => `${JSON.stringify(value)}\n`;
let clock = 0;
const user = (uuid: string, parentUuid: string | null, promptId: string): CcNativeRecord => ({ uuid, parentUuid, type: "user",
  timestamp: time(++clock), promptSource: "typed", promptId, message: { role: "user", content: uuid } });
const assistant = (uuid: string, parentUuid: string): CcNativeRecord => ({ uuid, parentUuid, type: "assistant",
  timestamp: time(++clock), message: { role: "assistant", content: [{ type: "text", text: uuid }] } });
/** One parallel tool call, split into its own row as Claude Code 2.1.280 does, sharing `msgId` (its
 * native API message id) with the other calls of the same batch (108's fixture shape). */
const assistantToolUse = (uuid: string, parentUuid: string, msgId: string, callId: string): CcNativeRecord => ({ uuid, parentUuid, type: "assistant",
  timestamp: time(++clock), message: { id: msgId, role: "assistant", content: [{ type: "tool_use", id: callId, name: "Read", input: { file_path: uuid } }] } });
/** A parallel call's own result, parented under its call directly -- never under another result. */
const toolResultRow = (uuid: string, parentUuid: string, callId: string, content: string): CcNativeRecord => ({ uuid, parentUuid, type: "user",
  timestamp: time(++clock), message: { role: "user", content: [{ type: "tool_result", tool_use_id: callId, content }] } });

/** One imported CC session whose stored path is rolled back to what a pre-108 importer kept -- a
 * naive single-parent walk missing a parallel batch's other calls and their own results -- so the
 * database and bindings directory look exactly like the ones a deploy script would copy today. */
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "tm102-mark-")); dirs.push(dir);
  const transcriptPath = join(dir, "native.jsonl"), nativeSession = "native-102";
  const config = resolveCcHostConfig({ dbPath: join(dir, "m.sqlite"), stateDir: join(dir, "s"), baseline: "2025-01-01T00:00:00.000Z" });
  writeFileSync(transcriptPath, [user("u1", null, "p1"), assistant("a1", "u1")].map(line).join(""));
  const importer = new CcImporter(config, await recordSessionStart(config,
    { hook_event_name: "SessionStart", source: "startup", session_id: nativeSession, transcript_path: transcriptPath }, time(0)));
  await importer.reconcile();

  // The parallel batch: four calls sharing one native API message id, results written out of call
  // order and each parented under its own call -- 102 Part 2 / 108's real-transcript evidence shape.
  appendFileSync(transcriptPath, [user("u2", "a1", "p2"),
    assistantToolUse("call-1", "u2", "msg-batch", "toolu_1"), assistantToolUse("call-2", "call-1", "msg-batch", "toolu_2"),
    assistantToolUse("call-3", "call-2", "msg-batch", "toolu_3"), assistantToolUse("call-4", "call-3", "msg-batch", "toolu_4"),
    toolResultRow("res-3", "call-3", "toolu_3", "R3"), toolResultRow("res-1", "call-1", "toolu_1", "R1"),
    toolResultRow("res-4", "call-4", "toolu_4", "R4"), toolResultRow("res-2", "call-2", "toolu_2", "R2"),
  ].map(line).join(""));
  const imported = await importer.reconcile(); // this checkout has the 108 fix: already the FIXED path
  importer.close();

  const store = new Store(config.dbPath);
  const sessionId = imported.coreSessionId!;
  const binding = readBinding(config, nativeSession)!;
  const id = (uuid: string) => store.findSourceEntry(sessionId, nativeSession, uuid)!.id;
  const staleIds = ["u1", "a1", "u2", "call-1", "call-2", "res-2"].map(id); // the pre-108 naive walk
  const recovered = ["res-1", "call-3", "res-3", "call-4", "res-4"].map(id); // what 108 newly recovers

  // Roll the persisted path back to that pre-108 shape. Production's stored paths are exactly this
  // today; the operator script reads the fixed path straight from the transcript, never a stored one.
  store.selectSourcePath(sessionId, binding.branch, staleIds);
  const headTurnId = store.getSourceEntry(id("res-2"))!.turnId;
  store.close();

  return { dir, config, sessionId, branch: binding.branch, headTurnId, recovered, staleIds, id,
    bindingsDir: join(config.stateDir, "bindings"), transcriptPath, nativeSession };
}

function run(config: ResolvedCcHostConfig, bindingsDir: string, apply: boolean): string {
  return execFileSync(process.execPath, ["--experimental-strip-types", "scripts/mark-parallel-backlog-noted.ts",
    "--db", config.dbPath, "--bindings", bindingsDir, ...(apply ? ["--apply"] : [])], { cwd: repoRoot, encoding: "utf8" });
}

test("108 backlog: dry run changes nothing, --apply marks exactly the recovered entries once, a rebuilt path is not pending, and a later batch still is", async () => {
  const f = await fixture();
  const store = new Store(f.config.dbPath);
  try {
    for (const entryId of f.recovered) expect(store.entryNoted(entryId)).toBe(false);

    // Dry run: reports the backlog, writes nothing.
    const dry = run(f.config, f.bindingsDir, false);
    expect(dry).toContain(`${f.nativeSession}: ${f.recovered.length} entries would be marked`);
    expect(dry).toContain(`Dry run: ${f.recovered.length} entries across 1 sessions would be marked`);
    for (const entryId of f.recovered) expect(store.entryNoted(entryId)).toBe(false);

    // --apply marks exactly the recovered entries, nothing else.
    const applied = run(f.config, f.bindingsDir, true);
    expect(applied).toContain(`marked ${f.recovered.length} entries`);
    expect(applied).toContain(`Marked ${f.recovered.length} entries across 1 sessions`);
    for (const entryId of f.recovered) expect(store.entryNoted(entryId)).toBe(true);
    for (const entryId of f.staleIds) expect(store.entryNoted(entryId)).toBe(false);

    // A second --apply, path still stale, marks nothing more (the already-noted filter, not just an
    // empty diff): every recovered entry is still counted as "additional" but none is written again.
    const secondApply = run(f.config, f.bindingsDir, true);
    expect(secondApply).toContain("Marked 0 entries across 0 sessions");
    for (const entryId of f.recovered) expect(store.entryNoted(entryId)).toBe(true);
    expect(store.db.prepare("SELECT COUNT(*) n FROM noted_entries").get()!.n).toBe(f.recovered.length);

    // The deploy-time rebuild: a fresh CcImporter always performs one full selectedPath rebuild on
    // restart, publishing the fixed path. The recovered entries, already marked, are then not pending.
    const importer = new CcImporter(f.config, readBinding(f.config, f.nativeSession)!);
    await importer.reconcile();
    importer.close();
    let pending = new Set(store.pendingEntryIds(f.sessionId, f.branch, f.headTurnId));
    for (const entryId of f.recovered) expect(pending.has(entryId)).toBe(false);

    // A later parallel batch, written after the one-time step ran, is ordinary pending Raw.
    appendFileSync(f.transcriptPath, [
      user("u3", "res-2", "p3"),
      assistantToolUse("call-5", "u3", "msg-batch-2", "toolu_5"), assistantToolUse("call-6", "call-5", "msg-batch-2", "toolu_6"),
      toolResultRow("res-6", "call-6", "toolu_6", "R6"), toolResultRow("res-5", "call-5", "toolu_5", "R5"),
    ].map(line).join(""));
    const later = new CcImporter(f.config, readBinding(f.config, f.nativeSession)!);
    const relanded = await later.reconcile();
    later.close();
    const id = (uuid: string) => store.findSourceEntry(f.sessionId, f.nativeSession, uuid)!.id;
    const newHeadTurnId = store.getSourceEntry(id("res-5"))!.turnId;
    expect(relanded.coreSessionId).toBe(f.sessionId);
    const laterIds = ["u3", "call-5", "call-6", "res-5", "res-6"].map(id);
    pending = new Set(store.pendingEntryIds(f.sessionId, f.branch, newHeadTurnId));
    for (const entryId of laterIds) expect(pending.has(entryId)).toBe(true);
  } finally { store.close(); }
});
