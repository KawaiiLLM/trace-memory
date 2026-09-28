import type { DatabaseSync } from "node:sqlite";

export interface Migration64dReport {
  legacySchema: boolean;
  backfilledRevisionIds: number[];
  remainingEmptyRevisionIds: number[];
  budgetBefore: { global: number; project: number; session: number } | null;
  budgetAfter: { global: number; project: number; session: number };
  budgetSource: "absent" | "old-default" | "custom" | "current";
  budgetWasCustom: boolean;
  seeded: { global: number; project: number; session: number };
}

/** Relax only the two historical CHECK-bearing tables. Store opens with foreign keys disabled
 * inside one immediate schema transaction and performs its complete FK check before COMMIT. */
export function migrateFactAndKnowledge92(db: DatabaseSync): void {
  if (!db.isTransaction) throw new Error("92 migration requires Store's schema transaction");
  const changes = [
    { table: "facts", update: (sql: string) => sql
      .replace(/category TEXT NOT NULL CHECK \(category IN /, "category TEXT CHECK (category IS NULL OR category IN ")
      .replace(/actor TEXT NOT NULL CHECK \(actor IN /, "actor TEXT CHECK (actor IS NULL OR actor IN ")
      .replace("CHECK ((status IS NOT NULL) = (category = 'event'))",
        "CHECK (category IS NULL AND status IS NULL OR category IS NOT NULL AND ((status IS NOT NULL) = (category = 'event')))"),
      target: "category IS NULL AND status IS NULL" },
    { table: "knowledge_revisions", update: (sql: string) => sql
      .replace("'constraint','open'", "'constraint','understanding','open'")
      .replace("'consolidation','dreaming','manual'", "'noting','consolidation','dreaming','manual'"),
      target: "'understanding'" },
  ];
  for (const { table, update, target } of changes) {
    const sql = String((db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as { sql: string }).sql);
    if (sql.includes(target)) continue;
    const next = update(sql);
    if (next === sql || !next.includes(target)) throw new Error(`92 migration refused unknown ${table} schema`);
    const objects = db.prepare("SELECT sql FROM sqlite_master WHERE tbl_name=? AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY name")
      .all(table) as { sql: string }[];
    const sequence = db.prepare("SELECT seq FROM sqlite_sequence WHERE name=?").get(table) as { seq: number } | undefined;
    const temporary = `${table}_92`;
    db.exec(next.replace(new RegExp(`CREATE TABLE (?:IF NOT EXISTS )?"?${table}"?`, "i"), `CREATE TABLE ${temporary}`));
    db.exec(`INSERT INTO ${temporary} SELECT * FROM ${table}; DROP TABLE ${table}; ALTER TABLE ${temporary} RENAME TO ${table}`);
    if (sequence) db.prepare("UPDATE sqlite_sequence SET seq=MAX(seq,?) WHERE name=?").run(sequence.seq, table);
    for (const object of objects) db.exec(object.sql);
  }
  if (!db.prepare("PRAGMA table_info(facts)").all().some(row => row.name === "source_roles"))
    db.exec("ALTER TABLE facts ADD COLUMN source_roles TEXT");
}

export function migrateArchiveKind99(db: DatabaseSync): void {
  if (!db.isTransaction) throw new Error("99 migration requires Store's schema transaction");
  if (!db.prepare("PRAGMA table_info(knowledge_revisions)").all().some(row => row.name === "archive_kind"))
    db.exec("ALTER TABLE knowledge_revisions ADD COLUMN archive_kind TEXT CHECK (archive_kind IS NULL OR archive_kind IN ('budget','invalid'))");
}

export function migrateFactSegments93(db: DatabaseSync): void {
  if (!db.isTransaction) throw new Error("93 migration requires Store's schema transaction");
  if (!db.prepare("PRAGMA table_info(facts)").all().some(row => row.name === "title"))
    db.exec("ALTER TABLE facts ADD COLUMN title TEXT");
  if (!db.prepare("PRAGMA table_info(fact_sources)").all().some(row => row.name === "segment_text"))
    db.exec("ALTER TABLE fact_sources ADD COLUMN segment_text TEXT");
}

const RETIRED_64D_TABLES = [
  "settled_knowledge_events", "processed_knowledge_versions", "dreaming_completions",
  "dreaming_range_versions", "knowledge_weights", "knowledge_marks",
  "knowledge_placement_validations", "dreaming_family",
] as const;

function tableExists(db: DatabaseSync, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

/** Apply the final knowledge-layer subtraction in Store's all-schema transaction. The callback
 * must use the shared stateless current-version resolver; it runs after supports are backfilled and
 * before legacy processing provenance is removed. */
export function migrateKnowledgeSubtraction(db: DatabaseSync,
  currentVersions: () => readonly { revisionId: number; pool: string }[],
  priorPolicy: { global: number; project: number; session: number } | null): Migration64dReport {
  if (!db.isTransaction) throw new Error("Knowledge subtraction requires an active transaction");
  const legacySchema = RETIRED_64D_TABLES.some(table => tableExists(db, table));
  const policyRow = db.prepare(`SELECT global_tokens, project_tokens, session_tokens
    FROM knowledge_budget_policy WHERE id = 1`).get() as Record<string, number> | undefined;
  if (!policyRow) throw new Error("Knowledge subtraction requires the budget policy row");
  const currentPolicy = { global: Number(policyRow.global_tokens), project: Number(policyRow.project_tokens), session: Number(policyRow.session_tokens) };
  const budgetBefore = priorPolicy;
  const oldDefault = priorPolicy?.global === 4_000 && priorPolicy.project === 10_000 && priorPolicy.session === 1_000;
  if (!legacySchema) return { legacySchema: false, backfilledRevisionIds: [], remainingEmptyRevisionIds: [],
    budgetBefore, budgetAfter: currentPolicy, budgetSource: priorPolicy ? "current" : "absent",
    budgetWasCustom: false, seeded: { global: 0, project: 0, session: 0 } };
  if (oldDefault) db.prepare(`UPDATE knowledge_budget_policy SET global_tokens = 4000,
    project_tokens = 15000, session_tokens = 1000 WHERE id = 1`).run();
  const resultingPolicy = db.prepare(`SELECT global_tokens, project_tokens, session_tokens
    FROM knowledge_budget_policy WHERE id = 1`).get() as Record<string, number>;
  const budgetAfter = { global: Number(resultingPolicy.global_tokens), project: Number(resultingPolicy.project_tokens), session: Number(resultingPolicy.session_tokens) };

  const backfilledRevisionIds: number[] = [];
  const rows = db.prepare("SELECT id, op, parent_id, supports FROM knowledge_revisions ORDER BY id").all() as
    { id: number; op: string; parent_id: number | null; supports: string }[];
  const supports = new Map<number, number[]>();
  const revisionIds = new Set(rows.map(row => Number(row.id)));
  const readSupports = (text: string, id: number) => {
    let value: unknown;
    try { value = JSON.parse(text); } catch { throw new Error(`K@${id}: malformed supports JSON`); }
    if (!Array.isArray(value) || value.some(item => !Number.isSafeInteger(item) || Number(item) <= 0))
      throw new Error(`K@${id}: malformed supports`);
    return [...new Set(value.map(Number))];
  };
  for (const row of rows) {
    const id = Number(row.id), existing = readSupports(row.supports, id);
    if (row.op === "create" && row.parent_id !== null) throw new Error(`K@${id}: create must not have a parent`);
    const parents: number[] = [];
    if (row.op !== "create") {
      if (row.parent_id == null || !revisionIds.has(Number(row.parent_id)) || Number(row.parent_id) >= id)
        throw new Error(`K@${id}: malformed ${row.op} parent`);
      parents.push(Number(row.parent_id));
    }
    if (row.op === "merge") {
      const links = db.prepare(`SELECT from_commit FROM knowledge_links
        WHERE kind = 'merged_into' AND to_commit = ? ORDER BY from_commit`).all(id) as { from_commit: number }[];
      if (!links.length) throw new Error(`K@${id}: merge has no absorbed-parent link`);
      for (const link of links) {
        const parent = Number(link.from_commit);
        if (!revisionIds.has(parent) || parent >= id || parents.includes(parent))
          throw new Error(`K@${id}: malformed merge parent link`);
        parents.push(parent);
      }
    }
    if (row.op === "split") {
      const links = db.prepare(`SELECT from_commit FROM knowledge_links
        WHERE kind = 'split_from' AND to_commit = ? ORDER BY from_commit`).all(id) as { from_commit: number }[];
      if (links.length !== 1 || Number(links[0]!.from_commit) !== Number(row.parent_id))
        throw new Error(`K@${id}: malformed split provenance`);
    }
    if (existing.length) { supports.set(id, existing); continue; }
    const inherited = [...new Set(parents.flatMap(parent => supports.get(parent) ?? (() => { throw new Error(`K@${id}: parent K@${parent} was not processed`); })()))];
    supports.set(id, inherited);
    if (inherited.length) {
      db.prepare("UPDATE knowledge_revisions SET supports = ? WHERE id = ?").run(JSON.stringify(inherited), id);
      backfilledRevisionIds.push(id);
    }
  }
  const remainingEmptyRevisionIds = rows.map(row => Number(row.id)).filter(id => !(supports.get(id)?.length));

  const selected = new Map(currentVersions().map(value => [value.revisionId, value.pool]));
  const seeded = { global: 0, project: 0, session: 0 };
  if (tableExists(db, "processed_knowledge_versions")) {
    for (const row of db.prepare("SELECT commit_id, run_id FROM processed_knowledge_versions ORDER BY commit_id").all() as
      { commit_id: number; run_id: number }[]) {
      const revisionId = Number(row.commit_id), pool = selected.get(revisionId);
      if (!pool) continue;
      db.prepare("INSERT OR IGNORE INTO knowledge_processed(pool, revision_id, run_id) VALUES (?, ?, ?)")
        .run(pool, revisionId, Number(row.run_id));
      if (pool === "global") seeded.global++;
      else if (pool.startsWith("project:")) seeded.project++;
      else if (pool.startsWith("session:")) seeded.session++;
      else throw new Error(`K@${revisionId}: invalid current owner pool ${pool}`);
    }
  }

  const retired = new Set<string>(RETIRED_64D_TABLES);
  for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()) {
    const name = String(row.name);
    if (retired.has(name)) continue;
    for (const key of db.prepare(`PRAGMA foreign_key_list(${JSON.stringify(name)})`).all()) {
      if (retired.has(String(key.table))) throw new Error(`Knowledge subtraction refused: ${name} references retired table ${String(key.table)}`);
    }
  }
  for (const table of RETIRED_64D_TABLES) if (tableExists(db, table)) db.exec(`DROP TABLE ${table}`);
  const budgetSource = priorPolicy === null ? "absent" : oldDefault ? "old-default" : "custom";
  return { legacySchema, backfilledRevisionIds, remainingEmptyRevisionIds, budgetBefore, budgetAfter,
    budgetSource, budgetWasCustom: budgetSource === "custom", seeded };
}

/** Upgrade the retained range audit from the pre-64c shape. Old unfinished ranges are terminal
 * audit rows, not retry work: close them without manufacturing a completing run. Rebuild is needed
 * because legacy anchor was NOT NULL and SQLite cannot relax it with ALTER COLUMN. */
export function migrateDreamingRanges64d(db: DatabaseSync): void {
  if (!db.isTransaction) throw new Error("Dreaming-range migration requires an active transaction");
  if (!tableExists(db, "dreaming_ranges")) return;
  const columns = new Set(db.prepare("PRAGMA table_info(dreaming_ranges)").all().map(row => String(row.name)));
  const sql = String((db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='dreaming_ranges'").get() as { sql: string }).sql);
  const required = ["pool", "claim_token", "closed_at", "pending_revisions"];
  const needsRebuild = required.some(column => !columns.has(column)) || /anchor\s+INTEGER\s+NOT\s+NULL/i.test(sql);
  if (!needsRebuild) {
    const index = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_dreaming_open_range'").get() as { sql: string } | undefined;
    if (!index || !/completed_run\s+IS\s+NULL\s+AND\s+closed_at\s+IS\s+NULL/i.test(index.sql))
      db.exec("DROP INDEX IF EXISTS idx_dreaming_open_range; CREATE UNIQUE INDEX idx_dreaming_open_range ON dreaming_ranges(session_id,branch) WHERE completed_run IS NULL AND closed_at IS NULL");
    return;
  }
  const allowedIncoming = new Set(["dreaming_range_events", "dreaming_range_versions", "dreaming_run_ranges", "dreaming_family"]);
  for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name <> 'dreaming_ranges' ORDER BY name").all()) {
    const name = String(row.name);
    if (db.prepare(`PRAGMA foreign_key_list(${JSON.stringify(name)})`).all().some(key => key.table === "dreaming_ranges") && !allowedIncoming.has(name))
      throw new Error(`Dreaming-range migration refused: referenced by ${name}`);
  }
  const objects = db.prepare(`SELECT name, sql FROM sqlite_master WHERE tbl_name='dreaming_ranges'
    AND type IN ('index','trigger') AND sql IS NOT NULL AND name <> 'idx_dreaming_open_range' ORDER BY name`).all() as { name: string; sql: string }[];
  const sequence = db.prepare("SELECT seq FROM sqlite_sequence WHERE name='dreaming_ranges'").get() as { seq: number } | undefined;
  db.exec(`DROP INDEX IF EXISTS idx_dreaming_open_range;
    CREATE TABLE dreaming_ranges_64d (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL REFERENCES sessions(id), branch TEXT NOT NULL,
      head_turn_id INTEGER NOT NULL REFERENCES turns(id), anchor INTEGER REFERENCES knowledge_revisions(id),
      completed_run INTEGER REFERENCES runs(id), origin_session_id INTEGER REFERENCES sessions(id), origin_entry_ids TEXT,
      pool TEXT, claim_token TEXT, closed_at TEXT, pending_revisions TEXT NOT NULL DEFAULT '[]'
    )`);
  const value = (column: string, fallback: string) => columns.has(column) ? column : fallback;
  db.exec(`INSERT INTO dreaming_ranges_64d
    (id,session_id,branch,head_turn_id,anchor,completed_run,origin_session_id,origin_entry_ids,pool,claim_token,closed_at,pending_revisions)
    SELECT id,session_id,branch,head_turn_id,anchor,completed_run,
      ${value("origin_session_id", "NULL")},${value("origin_entry_ids", "NULL")},${value("pool", "NULL")},${value("claim_token", "NULL")},
      CASE WHEN completed_run IS NULL THEN COALESCE(${value("closed_at", "NULL")}, strftime('%Y-%m-%dT%H:%M:%fZ','now')) ELSE ${value("closed_at", "NULL")} END,
      ${value("pending_revisions", "'[]'")} FROM dreaming_ranges;
    DROP TABLE dreaming_ranges;
    ALTER TABLE dreaming_ranges_64d RENAME TO dreaming_ranges;
    CREATE UNIQUE INDEX idx_dreaming_open_range ON dreaming_ranges(session_id,branch) WHERE completed_run IS NULL AND closed_at IS NULL`);
  if (sequence) db.prepare("UPDATE sqlite_sequence SET seq=MAX(seq,?) WHERE name='dreaming_ranges'").run(sequence.seq);
  for (const object of objects) db.exec(object.sql);
}

/** Remove the obsolete placement audit inside Store's all-schema upgrade transaction. The
 * audit is expected to be a leaf: refuse an unknown incoming foreign key rather than silently
 * damaging an extension table while foreign-key enforcement is suspended for schema rebuilds. */
export function dropPlacementAudits(db: DatabaseSync): void {
  const table = "knowledge_placement_validations";
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) return;
  if (!db.isTransaction) throw new Error("Placement-audit removal requires an active transaction");
  const incoming: string[] = [];
  for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name <> ? ORDER BY name").all(table)) {
    const name = String(row.name);
    if (db.prepare(`PRAGMA foreign_key_list(${JSON.stringify(name)})`).all().some(key => key.table === table)) incoming.push(name);
  }
  if (incoming.length) throw new Error(`Placement-audit removal refused: referenced by ${incoming.join(", ")}`);
  db.exec(`DROP TABLE ${table}`);
}

/** Ticket 34a is additive except for the immutable revision operation/actor CHECKs. Historical
 * supports deliberately receive `complete_result`; every new write supplies `change` explicitly.
 * `transactionOwned` is reserved for Store's all-schema upgrade transaction; direct callers retain
 * this migration's standalone transaction and foreign-key restoration contract. */
export function migrateKnowledgeLineage(db: DatabaseSync, transactionOwned = false): void {
  const revision = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'knowledge_revisions'").get() as { sql: string } | undefined;
  if (!revision) return;
  const columns = (name: string) => db.prepare(`PRAGMA table_info(${name})`).all().map(row => String(row.name));
  const revisionColumns = columns("knowledge_revisions");
  const runColumns = columns("runs");
  const taskColumns = columns("task_executions");
  const rangeColumns = columns("dreaming_ranges");
  const needsRebuild = !revision.sql.includes("'split'") || revision.sql.includes("actor_role = 'dreaming'");
  // 79: `runs.origin_entry_ids` moved to `run_bodies` (item 0); its absence on `runs` is the split's
  // own steady state, not a sign this pre-34a migration still owes the column. `origin_session_id`
  // alone is this table's completion signal now -- a database that has it, split or not, needs
  // nothing further from `addOrigin` below. `task_executions`/`dreaming_ranges` are untouched by the
  // split and keep both columns as before.
  const actions = !revisionColumns.includes("support_semantics") || !revisionColumns.includes("actor_role") || needsRebuild ||
    !runColumns.includes("origin_session_id") ||
    (taskColumns.length > 0 && (!taskColumns.includes("origin_session_id") || !taskColumns.includes("origin_entry_ids"))) ||
    (rangeColumns.length > 0 && (!rangeColumns.includes("origin_session_id") || !rangeColumns.includes("origin_entry_ids")));
  if (!actions) return;
  const apply = () => {
    const lockedRevisionColumns = columns("knowledge_revisions");
    if (!lockedRevisionColumns.includes("support_semantics")) db.exec("ALTER TABLE knowledge_revisions ADD COLUMN support_semantics TEXT NOT NULL DEFAULT 'complete_result' CHECK (support_semantics IN ('complete_result','change'))");
    if (!lockedRevisionColumns.includes("actor_role")) db.exec("ALTER TABLE knowledge_revisions ADD COLUMN actor_role TEXT CHECK(actor_role IS NULL OR actor_role IN ('consolidation','dreaming','manual'))");
    const sql = String((db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'knowledge_revisions'").get() as { sql: string }).sql);
    const migrated = sql.replace("('create','update','merge','archive')", "('create','update','merge','split','archive')")
      .replace("actor_role IS NULL OR actor_role = 'dreaming'", "actor_role IS NULL OR actor_role IN ('consolidation','dreaming','manual')");
    if (migrated !== sql) {
      const objects = db.prepare("SELECT sql FROM sqlite_master WHERE tbl_name = 'knowledge_revisions' AND type IN ('index','trigger') AND sql IS NOT NULL").all();
      const sequence = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'knowledge_revisions'").get();
      db.exec(migrated.replace(/CREATE TABLE (?:IF NOT EXISTS )?knowledge_revisions/i, "CREATE TABLE knowledge_revisions_34a"));
      db.exec("INSERT INTO knowledge_revisions_34a SELECT * FROM knowledge_revisions; DROP TABLE knowledge_revisions; ALTER TABLE knowledge_revisions_34a RENAME TO knowledge_revisions");
      if (sequence) db.prepare("UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = 'knowledge_revisions'").run(sequence.seq!);
      for (const object of objects) db.exec(String(object.sql));
    }
    const addOrigin = (table: string, entryIds = true) => {
      const existing = columns(table);
      if (!existing.includes("origin_session_id")) db.exec(`ALTER TABLE ${table} ADD COLUMN origin_session_id INTEGER REFERENCES sessions(id)`);
      if (entryIds && !existing.includes("origin_entry_ids")) db.exec(`ALTER TABLE ${table} ADD COLUMN origin_entry_ids TEXT`);
    };
    // 79: never add `origin_entry_ids` to `runs` here. A truly pre-34a `runs` (missing
    // origin_session_id too) gets that one column added in this table's pre-split shape; ticket 79's
    // split later in the same open is what gives it `origin_entry_ids`, on `run_bodies` (item 0). An
    // already-79-split `runs` needs neither: it already has `origin_session_id`, and its lack of
    // `origin_entry_ids` is the split's own steady state, never this migration's to fill back in.
    addOrigin("runs", false);
    if (taskColumns.length) addOrigin("task_executions");
    if (rangeColumns.length) addOrigin("dreaming_ranges");
    // Store validates the complete schema once before committing its enclosing upgrade.
    if (!transactionOwned && db.prepare("PRAGMA foreign_key_check").all().length)
      throw new Error("Knowledge-lineage migration: foreign key violations");
  };
  if (transactionOwned) {
    if (!db.isTransaction) throw new Error("Knowledge-lineage store migration requires an active transaction");
    apply();
    return;
  }
  if (db.isTransaction) throw new Error("Knowledge-lineage migration requires its own transaction");
  const foreignKeys = Number(db.prepare("PRAGMA foreign_keys").get()!.foreign_keys);
  let began = false, failed = false;
  try {
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec("BEGIN IMMEDIATE"); began = true;
    apply();
    db.exec("COMMIT");
  } catch (error) {
    failed = true;
    if (began && db.isTransaction) { try { db.exec("ROLLBACK"); } catch { /* Preserve the migration error. */ } }
    throw error;
  } finally {
    try { db.exec(`PRAGMA foreign_keys = ${foreignKeys}`); } catch (error) { if (!failed) throw error; }
  }
}

/** Rebuild real CHECK constraints, preserving ids, sequences, indexes and audit references.
 * Foreign keys must be disabled before BEGIN; rename-first would retarget incoming references.
 * `transactionOwned` has the same Store-only meaning as above. */
export function migrateDreaming(db: DatabaseSync, transactionOwned = false): void {
  const tables = ["task_claims", "runs", "task_executions"].flatMap(name => {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
    if (!row) return []; // execution tables are created after migrations on a new database
    const sql = String(row.sql);
    const updated = sql.includes("'dreaming'") ? sql : sql.replace("'consolidation'", "'consolidation','dreaming'");
    const migrated = name === "task_claims" || updated.includes("'conflict'") ? updated
      : updated.replace("'cancelled'", "'cancelled','conflict'");
    return migrated === sql ? [] : [{ name, sql: migrated }];
  });
  if (!tables.length) return;
  const apply = () => {
    for (const { name, sql } of tables) {
      const objects = db.prepare("SELECT sql FROM sqlite_master WHERE tbl_name = ? AND type IN ('index','trigger') AND sql IS NOT NULL").all(name);
      const sequence = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = ?").get(name);
      db.exec(sql.replace(new RegExp(`CREATE TABLE (?:IF NOT EXISTS )?"?${name}"?`, "i"), `CREATE TABLE ${name}_32b`));
      db.exec(`INSERT INTO ${name}_32b SELECT * FROM ${name}; DROP TABLE ${name}; ALTER TABLE ${name}_32b RENAME TO ${name}`);
      if (sequence) db.prepare("UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = ?").run(sequence.seq!, name);
      for (const object of objects) db.exec(String(object.sql));
    }
    if (!transactionOwned && db.prepare("PRAGMA foreign_key_check").all().length)
      throw new Error("Dreaming migration: foreign key violations");
  };
  if (transactionOwned) {
    if (!db.isTransaction) throw new Error("Dreaming store migration requires an active transaction");
    apply();
    return;
  }
  if (db.isTransaction) throw new Error("Dreaming migration requires its own transaction");
  const foreignKeys = Number(db.prepare("PRAGMA foreign_keys").get()!.foreign_keys);
  let began = false, failed = false;
  try {
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec("BEGIN IMMEDIATE");
    began = true;
    apply();
    db.exec("COMMIT");
  } catch (error) {
    failed = true;
    if (began && db.isTransaction) {
      try { db.exec("ROLLBACK"); } catch { /* Preserve the migration error. */ }
    }
    throw error;
  } finally {
    try { db.exec(`PRAGMA foreign_keys = ${foreignKeys}`); }
    catch (error) { if (!failed) throw error; }
  }
}
