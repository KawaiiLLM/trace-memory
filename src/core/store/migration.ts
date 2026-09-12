import type { DatabaseSync } from "node:sqlite";

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
  const actions = !revisionColumns.includes("support_semantics") || !revisionColumns.includes("actor_role") || needsRebuild ||
    !runColumns.includes("origin_session_id") || !runColumns.includes("origin_entry_ids") ||
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
    const addOrigin = (table: string) => {
      const existing = columns(table);
      if (!existing.includes("origin_session_id")) db.exec(`ALTER TABLE ${table} ADD COLUMN origin_session_id INTEGER REFERENCES sessions(id)`);
      if (!existing.includes("origin_entry_ids")) db.exec(`ALTER TABLE ${table} ADD COLUMN origin_entry_ids TEXT`);
    };
    addOrigin("runs");
    if (taskColumns.length) addOrigin("task_executions");
    if (rangeColumns.length) addOrigin("dreaming_ranges");
    if (db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("Knowledge-lineage migration: foreign key violations");
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
    if (db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("Dreaming migration: foreign key violations");
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
