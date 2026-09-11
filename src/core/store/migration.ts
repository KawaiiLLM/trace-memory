import type { DatabaseSync } from "node:sqlite";

/** Rebuild real CHECK constraints, preserving ids, sequences, indexes and audit references.
 * Foreign keys must be disabled before BEGIN; rename-first would retarget incoming references. */
export function migrateDreaming(db: DatabaseSync): void {
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
  if (db.isTransaction) throw new Error("Dreaming migration requires its own transaction");
  const foreignKeys = Number(db.prepare("PRAGMA foreign_keys").get()!.foreign_keys);
  let began = false, failed = false;
  try {
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec("BEGIN IMMEDIATE");
    began = true;
    for (const { name, sql } of tables) {
      const objects = db.prepare("SELECT sql FROM sqlite_master WHERE tbl_name = ? AND type IN ('index','trigger') AND sql IS NOT NULL").all(name);
      const sequence = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = ?").get(name);
      db.exec(sql.replace(new RegExp(`CREATE TABLE (?:IF NOT EXISTS )?"?${name}"?`, "i"), `CREATE TABLE ${name}_32b`));
      db.exec(`INSERT INTO ${name}_32b SELECT * FROM ${name}; DROP TABLE ${name}; ALTER TABLE ${name}_32b RENAME TO ${name}`);
      if (sequence) db.prepare("UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = ?").run(sequence.seq!, name);
      for (const object of objects) db.exec(String(object.sql));
    }
    if (db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("Dreaming migration: foreign key violations");
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
