#!/usr/bin/env node
// 176: stop executors and back up first. Native transcripts and original bindings are read-only.
// Each session's correction, ordinary rescan, and historical queued-entry processing marks commit
// together. A failed session rolls back; a rerun safely continues already-committed sessions.
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { TraceMemory, type SourceInput } from "../src/core/api/index.ts";
import { sourceAddresses, sourceDigest } from "../src/core/store/index.ts";
import { CcProjection } from "../src/hosts/cc/importer.ts";
import { resolveCcHostConfig } from "../src/hosts/cc/config.ts";
import { validateNativeSessionId, type CcSessionBinding } from "../src/hosts/cc/binding.ts";
import { CcTranscriptCursor, CcTranscriptScan, ccHumanUser, ccResultText, ccSourceBlocks } from "../src/hosts/cc/transcript.ts";

export interface CcMigrationReport {
  sessionId: number; nativeSessionId: string; state: "migrated" | "transcript-gone";
  reroled: number; inserted: Record<string, number>; factsRewritten: number; factRolesRewritten: number;
  otherEntriesInserted: number; marked: number; existingAddressesChanged: number;
  branch: string; headTurnId: number | null;
}

/** Uses only a disposable binding, never the installed binding or any executor lifecycle API. */
export async function migrateCcSession(memory: TraceMemory, original: CcSessionBinding, apply = true): Promise<CcMigrationReport> {
  const store = memory.store, sessionId = original.coreSessionId;
  if (store.db.isTransaction) throw new Error("CC migration requires its own transaction");
  if (sessionId === null || !store.getSession(sessionId)) throw new Error("migration requires an existing CC session");
  if (!store.getSession(sessionId)!.host.startsWith("cc:")) throw new Error(`S${sessionId} is not a CC session`);
  const report: CcMigrationReport = { sessionId, nativeSessionId: original.nativeSessionId, state: "migrated",
    reroled: 0, inserted: {}, factsRewritten: 0, factRolesRewritten: 0, otherEntriesInserted: 0,
    marked: 0, existingAddressesChanged: 0, branch: original.branch, headTurnId: null };
  const scratch = mkdtempSync(join(tmpdir(), "tm-cc-queued-migration-"));
  const config = resolveCcHostConfig({ dbPath: original.dbPath, stateDir: scratch });
  const binding = { ...original, executor: null };
  mkdirSync(join(scratch, "bindings"));
  writeFileSync(join(scratch, "bindings", `${binding.nativeSessionId}.json`), JSON.stringify(binding));
  const corrected = new Map<number, { turn: number; ordinal: number }>();
  const queued = new Map<string, string>();
  try {
    // Deliberately holds the write lock across the cooperative scan: deployment has no executors.
    // Store's nested writes use savepoints, so no inserted entry can become visible before its mark.
    store.db.exec("BEGIN IMMEDIATE");
    store.db.prepare(`CREATE TEMP TABLE cc_queued_before AS SELECT id, turn_id, entry_ordinal, native_lineage, native_id
      FROM source_entries WHERE session_id = ?`).run(sessionId);
    const choice = store.db.prepare("SELECT enrollment_choice FROM sessions WHERE id = ?").get(sessionId)!.enrollment_choice ?? null;
    store.db.prepare("UPDATE sessions SET enrollment_choice = 1 WHERE id = ?").run(sessionId);
    const scan = new CcTranscriptCursor().scan(binding.transcriptPath, (record, source, raw) => {
      if (!source || source.kind === "compaction") return;
      if (source.kind === "queued") queued.set(source.nativeId, String((record.attachment?.origin as { kind?: unknown } | undefined)?.kind ?? "none"));
      if (source.kind !== "user" || source.role !== "observation") return;
      const known = store.findSourceEntry(sessionId, binding.nativeSessionId, source.nativeId);
      if (!known || known.role === "observation") return;
      if (known.role !== "user") throw new Error(`unexpected role for ${source.nativeId}: ${known.role}`);
      const { slug: _oldSlug, ...oldNative } = JSON.parse(known.raw);
      const { slug: _newSlug, ...newNative } = record;
      if (JSON.stringify(oldNative) !== JSON.stringify(newNative)) throw new Error(`native source ${source.nativeId} changed before correction`);
      const { id, entryOrdinal, blocks: _blocks, ...oldInput } = known;
      const input: SourceInput = { ...oldInput, role: source.role, text: source.text, raw,
        ...(source.label ? { label: source.label } : {}) };
      const blocks = ccSourceBlocks(input);
      store.db.prepare("UPDATE source_entry_raw SET content = ?, blocks = ? WHERE entry_id = ?")
        .run(JSON.stringify(input), blocks ? JSON.stringify(blocks) : "null", id);
      store.db.prepare("UPDATE source_entries SET addresses = ?, digest = ? WHERE id = ?")
        .run(JSON.stringify(sourceAddresses({ ...input, id, entryOrdinal, blocks })), sourceDigest(raw), id);
      corrected.set(id, { turn: known.turnId, ordinal: entryOrdinal });
      report.reroled++;
    });
    if (!(scan instanceof CcTranscriptScan)) {
      report.state = "transcript-gone";
      store.db.exec("ROLLBACK");
      return report;
    }
    if (scan.problems.length) throw new Error(scan.problems.join("; "));
    const facts = corrected.size ? store.db.prepare(`SELECT DISTINCT f.id, f.source, f.source_roles FROM facts f
      JOIN fact_sources fs ON fs.fact_id = f.id WHERE fs.entry_id IN (SELECT value FROM json_each(?))`)
      .all(JSON.stringify([...corrected.keys()])) : [];
    const addresses = new Map([...corrected.values()].flatMap(({ turn, ordinal }) => [
      [`T${turn}#E${ordinal}`, `T${turn}#E${ordinal}`], [`T${turn}#user`, `T${turn}#E${ordinal}`],
    ]));
    for (const row of facts) {
      const sources: string[] = JSON.parse(String(row.source));
      const roles: { role: string; harness?: string }[] | null = row.source_roles === null ? null : JSON.parse(String(row.source_roles));
      let changedSource = false, changedRole = false;
      const next = sources.map((address, index) => {
        const target = addresses.get(address.replace(/@(user|assistant|observation)$/u, ""));
        if (!target) return address;
        if (roles && roles[index]?.role !== "observation") { roles[index] = { role: "observation" }; changedRole = true; }
        const value = /@(user|assistant|observation)$/u.test(address) || /#user$/u.test(address) ? `${target}@observation` : target;
        changedSource ||= value !== address;
        return value;
      });
      if (changedSource || changedRole) store.db.prepare("UPDATE facts SET source = ?, source_roles = ? WHERE id = ?")
        .run(JSON.stringify(next), roles ? JSON.stringify(roles) : null, Number(row.id));
      if (changedSource) report.factsRewritten++;
      if (changedRole) report.factRolesRewritten++;
    }
    const projection = new CcProjection(config, binding, memory);
    const result = await projection.synchronize();
    if (result.state !== "ready") throw new Error(`S${sessionId}: ${result.state}: ${result.problems.join("; ")}`);
    report.branch = result.branch; report.headTurnId = result.headTurnId;
    const historical = result.appendedEntryIds.filter(id => {
      const entry = store.getSourceEntry(id)!;
      const origin = queued.get(entry.nativeId);
      if (origin === undefined) { report.otherEntriesInserted++; return false; }
      report.inserted[origin] = (report.inserted[origin] ?? 0) + 1;
      return true;
    });
    if (historical.length) {
      const marked = store.commitNotingRun({ run: { kind: "manual", sessionId, branch: result.branch,
        createdAt: new Date().toISOString(), model: "ticket-176-queued-backfill",
        response: JSON.stringify({ ticket: 176, reason: "Historical absorbed messages: all origins backfilled as already extracted; no N dispatch." }) },
        facts: [], entryIds: historical });
      if (!marked.ok) throw new Error(marked.problems.join("; "));
      report.marked = historical.length;
    }
    report.existingAddressesChanged = Number(store.db.prepare(`SELECT COUNT(*) AS n FROM cc_queued_before b
      LEFT JOIN source_entries e ON e.id = b.id WHERE e.id IS NULL OR e.turn_id != b.turn_id OR e.entry_ordinal != b.entry_ordinal
      OR e.native_lineage != b.native_lineage OR e.native_id != b.native_id`).get()!.n);
    if (report.existingAddressesChanged) throw new Error("migration moved an existing native identity or T#E address");
    store.db.prepare("UPDATE sessions SET enrollment_choice = ? WHERE id = ?").run(choice, sessionId);
    store.db.exec(apply ? "COMMIT" : "ROLLBACK");
    return report;
  } catch (error) {
    if (store.db.isTransaction) store.db.exec("ROLLBACK");
    throw error;
  } finally {
    store.db.exec("DROP TABLE IF EXISTS temp.cc_queued_before");
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Bindings may have been pruned or may name an old project directory. Recover only native placement
 * metadata from the database; the ordinary projection still validates every native identity. */
export function migrationBinding(memory: TraceMemory, sessionId: number, nativeSessionId: string,
  dbPath: string, transcriptsRoot: string, existing?: CcSessionBinding): CcSessionBinding | null {
  validateNativeSessionId(nativeSessionId);
  if (existing && existsSync(existing.transcriptPath)) return { ...existing, dbPath };
  const matches = existsSync(transcriptsRoot) ? readdirSync(transcriptsRoot, { withFileTypes: true })
    .filter(item => item.isDirectory()).map(item => join(transcriptsRoot, item.name, `${nativeSessionId}.jsonl`))
    .filter(path => existsSync(path)) : [];
  if (matches.length > 1) throw new Error(`multiple transcripts for ${nativeSessionId}: ${matches.join(", ")}`);
  if (!matches.length) return null;
  if (existing) return { ...existing, dbPath, transcriptPath: matches[0]! };
  const store = memory.store, session = store.getSession(sessionId)!;
  const cursor = store.db.prepare("SELECT branch FROM session_lineage_cursors WHERE session_id=? AND lineage=?").get(sessionId, nativeSessionId);
  const branch = String(cursor?.branch ?? store.currentPath(sessionId).branch ?? `cc:${nativeSessionId}`);
  const entries = store.listSourceEntries(sessionId, undefined, branch);
  const firstOwn = entries.findIndex(entry => entry.nativeLineage === nativeSessionId);
  const inherited = firstOwn < 0 ? [] : entries.slice(0, firstOwn);
  const root = store.db.prepare(`SELECT t.parent_turn_id FROM native_turns n JOIN turns t ON t.id=n.turn_id
    WHERE n.session_id=? AND n.native_lineage=? ORDER BY t.id LIMIT 1`).get(sessionId, nativeSessionId);
  const parent = root?.parent_turn_id == null ? null : store.getTurn(Number(root.parent_turn_id));
  return { version: 1, nativeSessionId, dbPath, transcriptPath: matches[0]!, nativeCreatedAt: session.startedAt,
    enrollment: store.enrollment(sessionId), coreSessionId: sessionId, projectId: session.projectId,
    branch, selectedLeafUuid: entries.at(-1)?.nativeLineage === nativeSessionId ? entries.at(-1)!.nativeId : null,
    executor: null, lastClose: null, coreHost: session.host,
    ...(parent?.kind === "compaction" && session.host !== `cc:${nativeSessionId}` ? { clearedFrom: {
      nativeSessionId: inherited.at(-1)?.nativeLineage ?? session.host.slice(3), at: session.startedAt,
      compactionTurnId: parent.id, inheritedEntryIds: inherited.map(entry => entry.id),
    } } : {}) };
}

async function main() {
  const { values } = parseArgs({ options: { db: { type: "string" }, bindings: { type: "string" },
    "transcripts-root": { type: "string", default: join(homedir(), ".claude", "projects") },
    sessions: { type: "string" }, apply: { type: "boolean", default: false } } });
  if (!values.db || !values.bindings) throw new Error("usage: --db <database> --bindings <stateDir/bindings> [--transcripts-root <CC projects>] [--sessions 140,173] [--apply]");
  const dbPath = resolve(values.db);
  if (!existsSync(dbPath)) throw new Error(`no database at ${dbPath}`);
  const requested = values.sessions === undefined ? null : new Set(values.sessions.split(",").map(Number));
  const bindings = new Map<string, CcSessionBinding>();
  for (const file of readdirSync(values.bindings).filter(file => file.endsWith(".json"))) {
    const binding = JSON.parse(readFileSync(join(values.bindings, file), "utf8")) as CcSessionBinding;
    if (binding.coreSessionId !== null) bindings.set(`${binding.coreSessionId}:${binding.nativeSessionId}`, { ...binding, dbPath });
  }
  const memory = TraceMemory(dbPath, async () => { throw new Error("maintenance must never dispatch N or D"); }, {}, ccResultText, ccSourceBlocks, ccHumanUser);
  let failed = 0;
  try {
    const targets = memory.store.db.prepare(`SELECT DISTINCT e.session_id, e.native_lineage FROM source_entries e
      JOIN sessions s ON s.id = e.session_id WHERE s.host LIKE 'cc:%' ORDER BY e.session_id, e.native_lineage`).all();
    for (const row of targets) {
      const sessionId = Number(row.session_id);
      if (requested && !requested.has(sessionId)) continue;
      try {
        const binding = migrationBinding(memory, sessionId, String(row.native_lineage), dbPath, values["transcripts-root"]!,
          bindings.get(`${sessionId}:${row.native_lineage}`));
        console.log(JSON.stringify({ apply: values.apply, ...(binding ? await migrateCcSession(memory, binding, values.apply)
          : { sessionId, nativeSessionId: row.native_lineage, state: "transcript-gone", unchanged: true }) }));
      } catch (error) { failed++; console.error(`FAIL S${sessionId} ${row.native_lineage}: ${error instanceof Error ? error.stack : error}`); }
    }
  } finally { memory.close(); }
  if (failed) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
