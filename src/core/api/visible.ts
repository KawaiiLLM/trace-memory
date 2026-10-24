/** One source entry a host persisted as supplied material, with the representation it supplied. The
 * pair is the identity: `id` is this database's source entry, `nativeId` the host entry it was
 * imported from. `source` in the derived view means the original host entry is retained; `view`
 * means a bounded representation supplied by a recognized host envelope is retained.
 *
 * Ticket 30 "Visibility": there is one bounded view, so every new writer emits
 * `view: "bounded"` and nothing chooses a tier. `tier` is what envelopes written before that say —
 * `1` the old primary view, `2` the old tier-2 compact view — and both count as visible Raw. */
export interface SuppliedEntry { id: number; nativeId: string; view?: "bounded"; tier?: 1 | 2 }

/** What a renderer actually kept after budgeting — never what it considered. Identities dropped by a
 * budget are absent, so a persisted envelope can only understate coverage (duplicates, never silent
 * loss). */
export interface KnowledgeStateReceipt { fromCommit: number; toCommits: number[] }

export interface SuppliedMaterial {
  entries: SuppliedEntry[];
  /** Complete fact bodies supplied, by fact id. */
  factIds: number[];
  /** Exact knowledge bodies supplied, by commit id; a state notice never enters this list. */
  knowledgeCommitIds: number[];
  /** Fully rendered state notices. They establish neither body coverage nor a complete-read handle. */
  knowledgeStates?: KnowledgeStateReceipt[];
  /** Versions supplied as a title only (144 §7.4). A title is not body visibility. */
  knowledgeTitleCommitIds?: number[];
  /** Base-only Knowledge rendering, including notices/framing but excluding the reading guide and both pools. */
  knowledgeTokens?: number;
  /** Independent temporary body and pointer charges (165). */
  temporaryTokens?: number;
  pointerTokens?: number;
}

/** The host-neutral visible material of one selected context. `raw` is keyed by native entry id:
 * `source` is a retained original conversation entry; `view` is a bounded entry representation a
 * host's envelope supplied for an entry the conversation itself no longer holds. A recognized legacy
 * tier-1 or tier-2 representation is one of these bounded views. */
export interface VisibleView {
  raw: Map<string, "source" | "view">;
  /** Database source-entry identities stated by bounded envelopes, paired with native identity. */
  rawEntryIds?: Map<number, string>;
  factIds: Set<number>;
  knowledgeCommitIds: Set<number>;
  /** Canonical identities of complete state notices already shown, kept separate from exact body visibility. */
  knowledgeStates?: Set<string>;
  /** 97: the delivered publications' summed render-time Knowledge cost. Only unaccounted API views omit it. */
  knowledgeTokens?: number;
  /** Versions already delivered as titles; body and pointer charges remain independent. */
  knowledgeTitleCommitIds?: Set<number>;
  temporaryTokens?: number;
  pointerTokens?: number;
  /** Legacy visibility metadata retained for worker/fixture compatibility. Foreground eligibility
   * depends on exact bodies and state notices, never this initial-injection marker. */
  injection: boolean;
  /** Highest legacy Ticket 31 generation found. Foreground publication ignores it. */
  suppliedGeneration: number;
}

/** The view a context starts from: it can see nothing. */
export const noVisibility = (): VisibleView => ({ raw: new Map(), factIds: new Set(), knowledgeCommitIds: new Set(), injection: false, suppliedGeneration: 0 });

/** Stable persisted identity of one whole state notice. */
export const knowledgeStateKey = (state: KnowledgeStateReceipt): string =>
  `${state.fromCommit}>${state.toCommits.join(",")}`;

/** 97: a node's recorded delivered state, in the shape the foreground selector subtracts. */
export const deliveredView = (state: { knowledgeCommitIds: Set<number>; knowledgeTitleCommitIds: Set<number>; knowledgeStates: Set<string>;
  knowledgeTokens: number; temporaryTokens: number; pointerTokens?: number }): VisibleView =>
  ({ ...noVisibility(), knowledgeCommitIds: new Set(state.knowledgeCommitIds), knowledgeTitleCommitIds: new Set(state.knowledgeTitleCommitIds),
    knowledgeStates: new Set(state.knowledgeStates), knowledgeTokens: state.knowledgeTokens, temporaryTokens: state.temporaryTokens, pointerTokens: state.pointerTokens ?? 0 });
