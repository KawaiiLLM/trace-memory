#!/usr/bin/env node
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { Store } from "../src/core/store/index.ts";

const input = process.argv[2];
if (!input || process.argv.length !== 3) {
  console.error("usage: node scripts/dry-run-64d-migration.ts <explicit-database-copy>");
  process.exit(2);
}
const path = resolve(input);
const preserved = ["facts", "knowledge", "knowledge_revisions", "knowledge_links", "fact_relations",
  "fact_sources", "sessions", "projects", "source_entries"];
const retired = ["processed_knowledge_versions", "settled_knowledge_events", "dreaming_completions",
  "dreaming_range_versions", "dreaming_family", "knowledge_placement_validations", "knowledge_marks", "knowledge_weights"];
const inspect = () => {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const exists = (name: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
    const counts = Object.fromEntries(preserved.map(name => [name, exists(name) ? Number(db.prepare(`SELECT count(*) n FROM ${name}`).get()!.n) : null]));
    const dropped = Object.fromEntries(retired.map(name => [name, exists(name)]));
    const policy = exists("knowledge_budget_policy") ? db.prepare(`SELECT global_tokens AS global, project_tokens AS project,
      session_tokens AS session FROM knowledge_budget_policy WHERE id = 1`).get() : null;
    const emptySupports = exists("knowledge_revisions") ? (db.prepare("SELECT id FROM knowledge_revisions WHERE supports = '[]' ORDER BY id").all() as { id: number }[]).map(row => row.id) : [];
    return { counts, dropped, policy, emptySupports };
  } finally { db.close(); }
};

const before = inspect();
const store = new Store(path);
let migration: typeof store.migration64d, measurements: unknown[], foreignKeyViolations: unknown[];
try {
  migration = store.migration64d;
  const sessions = store.db.prepare("SELECT id FROM sessions ORDER BY id").all() as { id: number }[];
  const cursors = store.db.prepare(`SELECT session_id,lineage,branch,head_turn_id FROM session_lineage_cursors
    ORDER BY session_id,lineage`).all() as { session_id: number; lineage: string; branch: string; head_turn_id: number }[];
  const bySession = new Map<number, typeof cursors>();
  for (const cursor of cursors) bySession.set(cursor.session_id, [...(bySession.get(cursor.session_id) ?? []), cursor]);
  const targets = sessions.flatMap(({ id }) => {
    const active = bySession.get(id) ?? [];
    if (active.length) return active.map(cursor => ({ sessionId: id, lineage: cursor.lineage, compatibility: false,
      path: { sessionId: id, branch: cursor.branch, headTurnId: cursor.head_turn_id } }));
    const branches = store.db.prepare("SELECT branch FROM source_paths WHERE session_id=? ORDER BY branch").all(id) as { branch: string }[];
    if (branches.length) return branches.map(({ branch }) => ({ sessionId: id, lineage: null, compatibility: true,
      path: store.knowledgePath(id, branch) }));
    const terminals = store.db.prepare(`SELECT t.id FROM turns t WHERE t.session_id=? AND NOT EXISTS
      (SELECT 1 FROM turns child WHERE child.parent_turn_id=t.id) ORDER BY t.id`).all(id) as { id: number }[];
    return terminals.map(turn => ({ sessionId: id, lineage: null, compatibility: true,
      path: { sessionId: id, headTurnId: turn.id } }));
  });
  measurements = targets.map(target => {
    const due = new Map(store.duePools(target.path).map(pool => [pool.pool, pool.reason]));
    return { sessionId: target.sessionId, lineage: target.lineage,
      mode: target.compatibility ? "cursorless-all-paths" : "cursor", path: target.path,
      pools: store.poolSizes(target.path).map(size => {
        const current = store.poolVersions(size.pool, target.path), pending = store.pendingVersions(size.pool, target.path);
        return { pool: size.pool, current: current.length, processed: current.length - pending.length,
          pending: pending.length, pendingTokens: pending.reduce((sum, value) => sum + value.tokens, 0),
          totalTokens: size.tokens, budget: size.budget, due: due.get(size.pool) ?? null };
      }) };
  });
  foreignKeyViolations = store.db.prepare("PRAGMA foreign_key_check").all();
} finally { store.close(); }
const after = inspect();
const preservedCountsEqual = Object.fromEntries(preserved.map(name => [name, before.counts[name] === after.counts[name]]));
const failures = [
  ...Object.entries(preservedCountsEqual).filter(([, equal]) => !equal).map(([name]) => `${name} row count changed`),
  ...Object.entries(after.dropped).filter(([, exists]) => exists).map(([name]) => `${name} still exists`),
  ...(foreignKeyViolations!.length ? ["foreign_key_check failed"] : []),
  ...(before.policy && before.policy.global === 4000 && before.policy.project === 10000 && before.policy.session === 1000 &&
      !(after.policy?.global === 4000 && after.policy?.project === 15000 && after.policy?.session === 1000)
    ? ["old-default budget was not migrated"] : []),
];
console.log(JSON.stringify({ databaseCopy: path, before, after, migration: migration!, measurements: measurements!,
  preservedCountsEqual, foreignKeyViolations: foreignKeyViolations!, failures }, null, 2));
if (failures.length) process.exitCode = 1;
