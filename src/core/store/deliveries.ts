/** 97: foreground Knowledge delivery is a per-node attribute of the path, recorded at emission.
 *
 * A row is one emitted part. Its node is a Turn, a host prompt key that a later import binds to the
 * Turn that prompt created, or neither (the root of the receiving context). `owner` is the receiving
 * context's session host (`sessions.host`, known before the core session is allocated), so rows
 * recorded before allocation belong to the session that host later names. Rows and prompt bindings
 * are append-only; nothing is rewritten.
 *
 * A node's delivered state is its parent's plus its own rows. A baseline row (a compaction's or a
 * clear's supplement, possibly empty) restarts it: the state is folded from the last baseline on the
 * path. Versions and notices are sets; the Knowledge cost of every row is summed, never
 * deduplicated by version. */
export const DELIVERIES_SQL = `
CREATE TABLE IF NOT EXISTS knowledge_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner TEXT NOT NULL CHECK (length(owner) > 0),
  turn_id INTEGER REFERENCES turns(id),
  prompt TEXT CHECK (prompt IS NULL OR length(prompt) > 0),
  baseline INTEGER NOT NULL CHECK (baseline IN (0,1)),
  commits TEXT NOT NULL,
  states TEXT NOT NULL,
  knowledge_tokens INTEGER NOT NULL CHECK (knowledge_tokens >= 0),
  created_at TEXT NOT NULL,
  CHECK (turn_id IS NULL OR prompt IS NULL)
);
CREATE INDEX IF NOT EXISTS idx_knowledge_deliveries_owner ON knowledge_deliveries(owner, id);
CREATE TABLE IF NOT EXISTS delivery_prompts (
  prompt TEXT PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  turn_id INTEGER NOT NULL REFERENCES turns(id)
);
`;

/** What one emitted part carried: exact body versions, canonical state-notice keys, and its own
 * render-time Knowledge cost. */
export interface DeliveryPart { knowledgeCommitIds: readonly number[]; knowledgeStates: readonly string[]; knowledgeTokens: number }

/** Where a publication is recorded. At most one of `turnId` and `prompt`; neither is the root. */
export interface DeliveryTarget { owner: string; turnId?: number | null; prompt?: string | null; baseline?: boolean }

/** The node whose delivered state is read: the owner's Turn head on the stored path, followed by
 * host prompts not yet imported as Turns, oldest first. */
export interface DeliveryNode { owner: string; sessionId: number | null; branch?: string; headTurnId: number | null; prompts?: readonly string[] }

export interface DeliveredState { knowledgeCommitIds: Set<number>; knowledgeStates: Set<string>; knowledgeTokens: number }

export interface DeliveryRow { id: number; turnId: number | null; prompt: string | null; baseline: boolean;
  commits: number[]; states: string[]; tokens: number }

export const STATE_KEY = /^[1-9]\d*>[1-9]\d*(?:,[1-9]\d*)*$/;

/** Place each row on the node's lineage (root, Turn ancestry root→head, then pending prompts) and
 * fold from the last baseline. `mapped` resolves prompt rows the import has bound to a Turn. */
export function foldDelivered(rows: readonly DeliveryRow[], ancestry: readonly number[], prompts: readonly string[],
  mapped: ReadonlyMap<string, number>): DeliveredState {
  const positions = new Map(ancestry.map((id, index) => [id, index]));
  const pending = new Map(prompts.map((prompt, index) => [prompt, ancestry.length + index]));
  const placed: { at: number; row: DeliveryRow }[] = [];
  for (const row of rows) {
    const at = row.turnId !== null ? positions.get(row.turnId)
      : row.prompt === null ? -1
      : positions.get(mapped.get(row.prompt) ?? 0) ?? pending.get(row.prompt);
    if (at !== undefined) placed.push({ at, row });
  }
  placed.sort((a, b) => a.at - b.at || a.row.id - b.row.id);
  let start = 0;
  for (let index = placed.length - 1; index >= 0; index--) if (placed[index]!.row.baseline) { start = index; break; }
  const state: DeliveredState = { knowledgeCommitIds: new Set(), knowledgeStates: new Set(), knowledgeTokens: 0 };
  for (const { row } of placed.slice(start)) {
    for (const id of row.commits) state.knowledgeCommitIds.add(id);
    for (const key of row.states) state.knowledgeStates.add(key);
    state.knowledgeTokens += row.tokens;
  }
  return state;
}
