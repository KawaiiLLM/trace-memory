// Ticket 29a "One derived view" (parent 29, "Lightweight visibility from native entries"): what memory
// material a selected native context actually holds, derived from that context alone.
//
// Two things put memory material into a conversation and survive in the session file: the message the
// host's `before_agent_start` handler returns (persisted as a `custom_message` entry with its
// `details`) and a custom compaction (its `CompactionResult.details` land on the compaction entry).
// Both carry the identities the renderer kept, so this module reads structure, never prose: an id that
// appears only inside rendered text creates no coverage, a tier-2 view establishes nothing a Noter may
// extract from, and a compaction Pi wrote on its own — whose `details` are Pi's own
// `{readFiles, modifiedFiles}`, never empty (26c proof) — proves nothing about what survived it.
//
// Nothing here reads the database. Applicability — which facts and commits exist and are lawful on
// this path — is a separate authority that must observe new commits even when the native leaf has not
// moved, so it is never folded into this view or into anything memoized with it.

/** One source entry a carrier supplied, with the representation it supplied: `1` is the primary entry
 * view (complete enough to extract from), `2` the tier-2 compact view (not). The pair is the identity:
 * `id` is this database's source entry, `nativeId` the host entry it was imported from. */
export interface SuppliedEntry { id: number; nativeId: string; tier: 1 | 2 }

/** What a renderer actually kept after budgeting — never what it considered. Identities dropped by a
 * budget are absent, so a carrier can only ever understate coverage (duplicates, never silent loss). */
export interface SuppliedMaterial {
  entries: SuppliedEntry[];
  /** Complete fact bodies supplied, by fact id. */
  factIds: number[];
  /** Exact knowledge commits supplied, by commit id; a bare knowledge id is not a version. */
  knowledgeCommitIds: number[];
}

/** The identity a carrier is bound to, so another database's equal integers can never satisfy coverage
 * and one memory session's material is not read as another's. `session` is null on a carrier written
 * before the memory session id existed (the first prompt allocates it only at the first reply); such a
 * carrier is recognised afterwards through the Pi session id it was written under. */
export interface VisibleBinding { db: string; session: number | null; pi: string }

/** A carrier's payload, as it is persisted under `details.traceMemory`. */
export interface Carrier extends VisibleBinding { supplied: SuppliedMaterial }

/** The shape this module needs from a host's context entries — one entry of what Pi's
 * `buildContextEntries()` returns for the selected leaf. Core stays host-neutral: no SDK type is
 * imported here, and only these three fields are read. */
export interface ContextEntry { id: string; type: string; details?: unknown }

/** The visible material of one selected context. `raw` is keyed by native entry id: `source` is the
 * retained original conversation entry, `tier1` a primary view a carrier supplied for an entry the
 * conversation itself no longer holds. */
export interface VisibleView {
  raw: Map<string, "source" | "tier1">;
  factIds: Set<number>;
  knowledgeCommitIds: Set<number>;
}

/** The carrier this entry holds for this binding, or nothing. Fails closed on every mismatch: a
 * foreign database, another memory session, a pre-allocation carrier from a different Pi session, and
 * a missing or malformed payload (an older version's, or a native compaction's own details). */
const carrierOf = (entry: ContextEntry, binding: VisibleBinding): SuppliedMaterial | undefined => {
  const carrier = (entry.details as { traceMemory?: Carrier } | null | undefined)?.traceMemory;
  if (!carrier || typeof carrier !== "object" || !carrier.supplied || typeof carrier.supplied !== "object") return;
  if (carrier.db !== binding.db) return;
  const bound = binding.session !== null && carrier.session === binding.session;
  const beforeAllocation = carrier.session === null && carrier.pi === binding.pi;
  return bound || beforeAllocation ? carrier.supplied : undefined;
};

/** The visible view of one selected context, computed from that context and nothing else (29a case 8:
 * a rewind, a branch and a step forward each get their own view, never an accumulated set from an
 * abandoned path). Entries arrive in Pi's own order — a compaction first, then what it kept, then what
 * came after — so a retained original entry overrides the tier-1 view a carrier supplied for it, and
 * an entry the context no longer holds keeps only what a carrier states. */
export function visibleView(entries: readonly ContextEntry[], binding: VisibleBinding): VisibleView {
  const raw = new Map<string, "source" | "tier1">();
  const factIds = new Set<number>(), knowledgeCommitIds = new Set<number>();
  for (const entry of entries) {
    // An ordinary retained conversation entry is the strongest evidence there is, and the only kind
    // that needs no metadata. Our own injections are `custom_message`, so they are never Raw sources.
    if (entry.type === "message") { raw.set(entry.id, "source"); continue; }
    const supplied = carrierOf(entry, binding);
    if (!supplied) continue; // a free summary, a native compaction, a foreign carrier: nothing at all
    for (const item of supplied.entries ?? []) if (item.tier === 1 && !raw.has(item.nativeId)) raw.set(item.nativeId, "tier1");
    for (const id of supplied.factIds ?? []) factIds.add(id);
    for (const id of supplied.knowledgeCommitIds ?? []) knowledgeCommitIds.add(id);
  }
  return { raw, factIds, knowledgeCommitIds };
}
