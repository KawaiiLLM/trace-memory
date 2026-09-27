/** 97: foreground Knowledge delivery is a per-node attribute of the path, recorded at emission.
 *
 * A row is one emitted part. Its node is a Turn, a host node key that a later import binds to the
 * Turn it created (a prompt, or a compaction the import has not reached), or neither (the root of
 * the receiving context). A compaction's key also names the native record the compaction follows,
 * so the import can bind it without the host writing into its own transcript. `owner` is the
 * receiving context's session host (`sessions.host`, known before the core session is allocated).
 * Rows and bindings are append-only; nothing is rewritten.
 *
 * A node's delivered state is its parent's plus its own rows; a compaction Turn starts from nothing
 * but its own rows (its supplement). Versions and notices are sets; the Knowledge cost of every row
 * is summed, never deduplicated by version. The state is kept per node in the same cache as 88's
 * knowledge results (`DeliveryCache` below), advanced by the rows' and bindings' watermarks. */
export const DELIVERIES_SQL = `
CREATE TABLE IF NOT EXISTS knowledge_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner TEXT NOT NULL CHECK (length(owner) > 0),
  turn_id INTEGER REFERENCES turns(id),
  node_key TEXT CHECK (node_key IS NULL OR length(node_key) > 0),
  follows TEXT CHECK (follows IS NULL OR (node_key IS NOT NULL AND length(follows) > 0)),
  commits TEXT NOT NULL,
  states TEXT NOT NULL,
  knowledge_tokens INTEGER NOT NULL CHECK (knowledge_tokens >= 0),
  created_at TEXT NOT NULL,
  CHECK (turn_id IS NULL OR node_key IS NULL)
);
CREATE INDEX IF NOT EXISTS idx_knowledge_deliveries_owner ON knowledge_deliveries(owner, id);
CREATE TABLE IF NOT EXISTS delivery_nodes (
  node_key TEXT PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  turn_id INTEGER NOT NULL REFERENCES turns(id)
);
`;

/** What one emitted part carried: exact body versions, canonical state-notice keys, and its own
 * render-time Knowledge cost. */
export interface DeliveryPart { knowledgeCommitIds: readonly number[]; knowledgeStates: readonly string[]; knowledgeTokens: number }

/** Where a publication is recorded: a Turn, a node key, or neither (the root). `follows` marks the
 * key as a compaction not yet imported and names the native record it follows. */
export interface DeliveryTarget { owner: string; turnId?: number | null; nodeKey?: string | null; follows?: string | null }

/** A node after the head Turn that the import has not reached: a prompt's key, or a compaction and
 * the key of its supplement, if one was recorded. */
export interface PendingNode { key: string | null; compaction?: boolean }

/** The node whose delivered state is read: the owner's Turn head, followed by pending nodes. */
export interface DeliveryNode { owner: string; sessionId: number | null; branch?: string; headTurnId: number | null;
  pending?: readonly PendingNode[] }

export interface DeliveredState { knowledgeCommitIds: Set<number>; knowledgeStates: Set<string>; knowledgeTokens: number }

export interface DeliveryRow { id: number; owner: string; turnId: number | null; nodeKey: string | null;
  commits: number[]; states: string[]; tokens: number }

/** One owner's rows by node. A key's rows stay under `byKey` after the key is bound to a Turn. */
export interface OwnerDeliveries { root: DeliveryRow[]; byTurn: Map<number, DeliveryRow[]>;
  byKey: Map<string, DeliveryRow[]>; bound: Map<string, number> }

/** 88's per-node cache, delivery part: each computed Turn's state with the parent it was derived
 * from, and the loaded owners' rows, at the rows' and bindings' watermarks. */
export interface DeliveryCache { row: number; node: number; owners: Map<string, OwnerDeliveries>;
  nodes: Map<number, { state: DeliveredState; parent: number | null; compaction: boolean }> }

export const STATE_KEY = /^[1-9]\d*>[1-9]\d*(?:,[1-9]\d*)*$/;

export const noDelivery = (): DeliveredState => ({ knowledgeCommitIds: new Set(), knowledgeStates: new Set(), knowledgeTokens: 0 });

/** A state plus some rows. States are shared between nodes, so this copies; without rows it
 * returns the same state. */
export function withRows(state: DeliveredState, rows: readonly DeliveryRow[] | undefined): DeliveredState {
  if (!rows?.length) return state;
  const next = { knowledgeCommitIds: new Set(state.knowledgeCommitIds), knowledgeStates: new Set(state.knowledgeStates),
    knowledgeTokens: state.knowledgeTokens };
  for (const row of rows) {
    for (const id of row.commits) next.knowledgeCommitIds.add(id);
    for (const key of row.states) next.knowledgeStates.add(key);
    next.knowledgeTokens += row.tokens;
  }
  return next;
}

const push = <K>(map: Map<K, DeliveryRow[]>, key: K, rows: readonly DeliveryRow[]) => map.set(key, [...map.get(key) ?? [], ...rows]);

/** Place new rows and key bindings on an owner's nodes (mutating it). Returns the Turns whose own
 * rows changed and whether the root's did. */
export function placeDeliveries(owner: OwnerDeliveries, rows: readonly DeliveryRow[], bindings: ReadonlyMap<string, number>):
  { turns: Set<number>; root: boolean } {
  const turns = new Set<number>();
  let root = false;
  for (const [key, turn] of bindings) if (!owner.bound.has(key)) {
    owner.bound.set(key, turn);
    const keyed = owner.byKey.get(key);
    if (keyed) { push(owner.byTurn, turn, keyed); turns.add(turn); }
  }
  for (const row of rows) {
    if (row.nodeKey !== null) {
      push(owner.byKey, row.nodeKey, [row]);
      const turn = owner.bound.get(row.nodeKey);
      if (turn !== undefined) { push(owner.byTurn, turn, [row]); turns.add(turn); }
    } else if (row.turnId !== null) { push(owner.byTurn, row.turnId, [row]); turns.add(row.turnId); }
    else { owner.root = [...owner.root, row]; root = true; }
  }
  return { turns, root };
}

/** Drop every cached node state derived from a changed Turn or root. A child Turn's id is always
 * greater than its parent's; a compaction does not derive from its parent. */
export function dropStale(nodes: DeliveryCache["nodes"], turns: ReadonlySet<number>, root: boolean): void {
  if (!turns.size && !root) return;
  const stale = new Set<number>();
  for (const id of [...nodes.keys()].sort((a, b) => a - b)) {
    const node = nodes.get(id)!;
    if (turns.has(id) || !node.compaction && (node.parent === null ? root : stale.has(node.parent))) stale.add(id);
  }
  for (const id of stale) nodes.delete(id);
}
