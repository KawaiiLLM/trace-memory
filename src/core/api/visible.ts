// Ticket 29a "One derived view" (parent 29, "Lightweight visibility from native entries"): what memory
// material a selected native context actually holds, derived from that context alone.
//
// Two things put memory material into a conversation and survive in the session file: the message the
// host's `before_agent_start` handler returns (persisted as a `custom_message` entry with its
// `details`) and a custom compaction (its `CompactionResult.details` land on the compaction entry).
// Both carry the identities the renderer kept, so this module reads structure, never prose: an id that
// appears only inside rendered text creates no coverage, and a compaction Pi wrote on its own — whose
// `details` are Pi's own `{readFiles, modifiedFiles}`, never empty (26c proof) — proves nothing about
// what survived it.
//
// Nothing here reads the database. Applicability — which facts and commits exist and are lawful on
// this path — is a separate authority that must observe new commits even when the native leaf has not
// moved, so it is never folded into this view or into anything memoized with it.

/** One source entry a carrier supplied, with the representation it supplied. The pair is the identity:
 * `id` is this database's source entry, `nativeId` the host entry it was imported from.
 *
 * Ticket 30 "Visibility and fork": there is one bounded view, so every new writer emits
 * `view: "bounded"` and nothing chooses a tier. `tier` is what carriers written before that say — `1`
 * the old primary view, `2` the old tier-2 compact view — and both now count as visible Raw: a marked
 * compressed view is in context whether or not it was truncated, and the old tier-2 exclusion is
 * superseded. Stored carriers are never rewritten, so a legacy value is read, not relabelled. */
export interface SuppliedEntry { id: number; nativeId: string; view?: "bounded"; tier?: 1 | 2 }

/** What a renderer actually kept after budgeting — never what it considered. Identities dropped by a
 * budget are absent, so a carrier can only ever understate coverage (duplicates, never silent loss). */
export interface KnowledgeStateReceipt { fromCommit: number; toCommits: number[] }

export interface SuppliedMaterial {
  entries: SuppliedEntry[];
  /** Complete fact bodies supplied, by fact id. */
  factIds: number[];
  /** Exact knowledge bodies supplied, by commit id; a state notice never enters this list. */
  knowledgeCommitIds: number[];
  /** Fully rendered state notices. They establish neither body coverage nor a complete-read handle. */
  knowledgeStates?: KnowledgeStateReceipt[];
}

/** The identity a carrier is bound to, so another database's equal integers can never satisfy coverage
 * and one memory session's material is not read as another's. `session` is null on a carrier written
 * before the memory session id existed (the first prompt allocates it only at the first reply); such a
 * carrier is recognised afterwards through the Pi session id it was written under. */
export interface VisibleBinding { db: string; session: number | null; pi: string }

/** A carrier's payload, as it is persisted under `details.traceMemory`. */
export interface Carrier extends VisibleBinding {
  supplied: SuppliedMaterial;
  /** Legacy Ticket 31 carrier field. 34c emits no generation and never consults this value for
   * foreground eligibility; it remains parseable so old persisted carriers retain their material. */
  generation?: number;
}

/** The shape this module needs from a host's context entries — one entry of what Pi's
 * `buildContextEntries()` returns for the selected leaf. Core stays host-neutral: no SDK type is
 * imported here; the custom identity distinguishes our injections from other extensions. */
export interface ContextEntry { id: string; type: string; customType?: string; details?: unknown }

/** The visible material of one selected context. `raw` is keyed by native entry id: `source` is the
 * retained original conversation entry, `view` a bounded entry view a carrier supplied for an entry
 * the conversation itself no longer holds (30: a legacy tier-1 or tier-2 view is one of these). */
export interface VisibleView {
  raw: Map<string, "source" | "view">;
  /** Database source-entry identities stated by bounded carriers, paired with native identity. */
  rawEntryIds?: Map<number, string>;
  factIds: Set<number>;
  knowledgeCommitIds: Set<number>;
  /** Canonical identities of complete state notices, kept separate from exact body visibility. */
  knowledgeStates?: Set<string>;
  /** Legacy visibility metadata retained for worker/fixture compatibility. Foreground 34c eligibility
   * depends on exact bodies, state notices and evidence, never this initial-injection marker. */
  injection: boolean;
  /** Highest legacy Ticket 31 generation found. 34c foreground publication ignores it. */
  suppliedGeneration: number;
}

/** 29b "Same builder, different initial state": what the child a task will run in already holds when
 * it starts. It is the ONLY difference between a fork's material and a fresh child's — one builder per
 * phase reads this and subtracts, instead of two fixed layouts. `inheritedTokens` is the host's own
 * measure of that context (Pi's `getContextUsage`), which the freeze prices once; core never learns
 * how the number was obtained and never re-derives it from the view. */
export interface InitialContext { visible: VisibleView; inheritedTokens: number }

/** The view a fresh child starts from: it can see nothing. Its `inheritedTokens` is zero, but that
 * number is the freeze's own (the host's measure, frozen with the task), so it is paired there. */
export const noVisibility = (): VisibleView => ({ raw: new Map(), factIds: new Set(), knowledgeCommitIds: new Set(), injection: false, suppliedGeneration: 0 });

/** Stable persisted identity of one whole state notice. */
export const knowledgeStateKey = (state: KnowledgeStateReceipt): string =>
  `${state.fromCommit}>${state.toCommits.join(",")}`;

/** The carrier this entry holds for this binding, or nothing. Fails closed on every mismatch: a
 * foreign database, another memory session, a pre-allocation carrier from a different Pi session, and
 * a missing or malformed payload (an older version's, or a native compaction's own details). */
const carrierOf = (entry: ContextEntry, binding: VisibleBinding): Carrier | undefined => {
  if (entry.type !== "compaction" && !(entry.type === "custom_message" && entry.customType === "trace-memory")) return;
  const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
  const positiveId = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
  const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
  if (!object(entry.details)) return;
  const carrier = entry.details.traceMemory;
  if (!object(carrier) || !object(carrier.supplied)) return;
  if (!text(carrier.db) || !text(carrier.pi) || !(carrier.session === null || positiveId(carrier.session))) return;
  if (carrier.generation !== undefined && (!Number.isSafeInteger(carrier.generation) || Number(carrier.generation) < 0
      || entry.type !== "custom_message")) return;
  const supplied = carrier.supplied;
  if (!Array.isArray(supplied.entries) || !Array.isArray(supplied.factIds) || !Array.isArray(supplied.knowledgeCommitIds)
      || (supplied.knowledgeStates !== undefined && !Array.isArray(supplied.knowledgeStates))) return;
  if (!Array.from(supplied.factIds).every(positiveId) || !Array.from(supplied.knowledgeCommitIds).every(positiveId)) return;
  if (!Array.from(supplied.entries).every(item => object(item) && positiveId(item.id) && text(item.nativeId)
      && ((item.view === "bounded" && item.tier === undefined)
        || (item.view === undefined && (item.tier === 1 || item.tier === 2))))
      || !Array.from(supplied.knowledgeStates ?? []).every(state => object(state) && positiveId(state.fromCommit)
        && Array.isArray(state.toCommits) && state.toCommits.length > 0 && state.toCommits.every(positiveId))) return;
  if (carrier.db !== binding.db) return;
  const bound = binding.session !== null && carrier.session === binding.session;
  const beforeAllocation = carrier.session === null && carrier.pi === binding.pi;
  return bound || beforeAllocation ? carrier as unknown as Carrier : undefined;
};

/** The visible view of one selected context, computed from that context and nothing else (29a case 8:
 * a rewind, a branch and a step forward each get their own view, never an accumulated set from an
 * abandoned path). Entries arrive in Pi's own order — a compaction first, then what it kept, then what
 * came after — so a retained original entry overrides the bounded view a carrier supplied for it, and
 * an entry the context no longer holds keeps only what a carrier states. */
export function visibleView(entries: readonly ContextEntry[], binding: VisibleBinding): VisibleView {
  const raw = new Map<string, "source" | "view">(), rawEntryIds = new Map<number, string>();
  const factIds = new Set<number>(), knowledgeCommitIds = new Set<number>(), knowledgeStates = new Set<string>();
  let injection = false, suppliedGeneration = 0;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || typeof entry.id !== "string" || !entry.id.trim()) continue;
    // An ordinary retained conversation entry is the strongest evidence there is, and the only kind
    // that needs no metadata. Our own injections are `custom_message`, so they are never Raw sources.
    if (entry.type === "message") { raw.set(entry.id, "source"); continue; }
    const carrier = carrierOf(entry, binding);
    if (!carrier) continue; // a free summary, a native compaction, a foreign carrier: nothing at all
    const supplied = carrier.supplied;
    if (entry.type === "custom_message") injection = true; // legacy marker; 34c uses supplied identities
    // Preserve legacy carrier metadata for readers outside foreground publication.
    if (carrier.pi === binding.pi && typeof carrier.generation === "number" && carrier.generation > suppliedGeneration)
      suppliedGeneration = carrier.generation;
    // 30 "No richness gate": every marked compressed view counts, whatever budget produced it — the
    // one bounded representation, or either legacy tier. A carrier whose entry declares neither is
    // not one of ours and establishes nothing.
    for (const item of supplied.entries ?? []) {
      const marked = item.view === "bounded" || item.tier === 1 || item.tier === 2;
      if (marked && !raw.has(item.nativeId)) raw.set(item.nativeId, "view");
      if (marked) rawEntryIds.set(item.id, item.nativeId);
    }
    for (const id of supplied.factIds ?? []) factIds.add(id);
    for (const id of supplied.knowledgeCommitIds ?? []) knowledgeCommitIds.add(id);
    for (const state of supplied.knowledgeStates ?? []) knowledgeStates.add(knowledgeStateKey(state));
  }
  return { raw, ...(rawEntryIds.size ? { rawEntryIds } : {}), factIds, knowledgeCommitIds,
    ...(knowledgeStates.size ? { knowledgeStates } : {}), injection, suppliedGeneration };
}
