import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

// Revision identifiers are immutable. Never derive a tag from mutable body rendering or a reader's path.
function tagSequence(knowledgeId: number, commitId: number): string {
  let value = BigInt(`0x${createHash("sha256").update(`trace-knowledge-version:${knowledgeId}:${commitId}`).digest("hex")}`);
  let letters = "";
  while (value > 0n) { letters = String.fromCharCode(97 + Number(value % 26n)) + letters; value /= 26n; }
  return letters.padStart(55, "a");
}

export const VERSION_TAGS_SQL = `CREATE TABLE IF NOT EXISTS knowledge_version_tags (
  knowledge_id INTEGER NOT NULL,
  commit_id INTEGER NOT NULL UNIQUE,
  ordinal INTEGER NOT NULL,
  tag TEXT NOT NULL,
  PRIMARY KEY (knowledge_id, ordinal),
  UNIQUE (knowledge_id, tag),
  FOREIGN KEY (knowledge_id, commit_id) REFERENCES knowledge_revisions(knowledge_id, id)
)`;

/** Called within the existing Store write/upgrade transaction, in global commit order. */
export function assignVersionTag(db: DatabaseSync, knowledgeId: number, commitId: number): void {
  const ordinal = Number((db.prepare("SELECT COALESCE(MAX(ordinal), 0) AS last FROM knowledge_version_tags WHERE knowledge_id = ?")
    .get(knowledgeId) as { last: number }).last) + 1;
  const sequence = tagSequence(knowledgeId, commitId);
  const occupied = db.prepare("SELECT 1 FROM knowledge_version_tags WHERE knowledge_id = ? AND tag = ?");
  for (let length = 4; length <= sequence.length; length++) {
    const tag = sequence.slice(0, length);
    if (occupied.get(knowledgeId, tag)) continue;
    db.prepare("INSERT INTO knowledge_version_tags (knowledge_id, commit_id, ordinal, tag) VALUES (?, ?, ?, ?)")
      .run(knowledgeId, commitId, ordinal, tag);
    return;
  }
  throw new Error(`knowledge version tag space exhausted for K${knowledgeId}`);
}

export function migrateVersionTags(db: DatabaseSync): void {
  const existing = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='knowledge_version_tags'").get();
  if (existing) return;
  db.exec(VERSION_TAGS_SQL);
  // Exactly one upgrade pass, within Store's schema transaction. Never repair missing rows on reopen.
  for (const row of db.prepare("SELECT knowledge_id AS knowledgeId, id AS commitId FROM knowledge_revisions ORDER BY id")
    .iterate() as IterableIterator<{ knowledgeId: number; commitId: number }>)
    assignVersionTag(db, row.knowledgeId, row.commitId);
}
