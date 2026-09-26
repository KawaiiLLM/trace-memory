import { knowledgeStateKey, noVisibility, type SuppliedMaterial, type VisibleView } from "../../core/api/visible.ts";
import { memoryBodyHash } from "../../core/render/material.ts";
import { legacyKnowledgeTokens } from "../../core/render/retained-knowledge.ts";

/** The identity a Pi envelope is bound to, so another database's equal integers can never satisfy
 * coverage and one memory session's material is not read as another's. `session` is null before the
 * first reply allocates the memory session; that envelope is recognized through its Pi session id. */
export interface VisibleBinding { db: string; session: number | null; pi: string }

/** Pi's payload persisted under `details.traceMemory`. */
export interface Carrier extends VisibleBinding {
  supplied: SuppliedMaterial;
  /** Binds new accounting metadata to the exact retained text. Legacy carriers omit both. */
  knowledgeHash?: string;
  /** Legacy Ticket 31 field. New foreground eligibility never consults it; old persisted envelopes
   * retain their material and legacy worker metadata. */
  generation?: number;
}

/** The shape needed from one entry returned by Pi's `buildContextEntries()`. */
export interface ContextEntry { id: string; parentId?: string | null; type: string; customType?: string; details?: unknown;
  content?: unknown; summary?: string }

export const knowledgeAccountingHash = (text: string, cost: number): string => memoryBodyHash(JSON.stringify([cost, text]));
const carrierText = (entry: ContextEntry): string => {
  if (entry.type === "compaction" && typeof entry.summary === "string") return entry.summary;
  if (typeof entry.content === "string") return entry.content;
  if (Array.isArray(entry.content) && entry.content.every(block => block?.type === "text" && typeof block.text === "string"))
    return entry.content.map(block => block.text).join("\n");
  throw new Error("Trace Memory: retained memory carrier has no complete text payload");
};

/** The Pi envelope this entry holds for this binding, or nothing. Fails closed on every mismatch. */
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
  if (!bound && !beforeAllocation) return;
  if (Object.hasOwn(supplied, "knowledgeTokens") || Object.hasOwn(carrier, "knowledgeHash")) {
    if (!Number.isSafeInteger(supplied.knowledgeTokens) || Number(supplied.knowledgeTokens) < 0
        || carrier.knowledgeHash !== knowledgeAccountingHash(carrierText(entry), supplied.knowledgeTokens as number))
      throw new Error("Trace Memory: invalid retained Knowledge accounting metadata or payload");
  }
  return carrier as unknown as Carrier;
};

/** Derive visible material from Pi's selected context and nothing else. Entries arrive in Pi order,
 * so a retained original entry overrides a bounded representation supplied for the same native id. */
export function visibleView(entries: readonly ContextEntry[], binding: VisibleBinding): VisibleView {
  const view = noVisibility();
  view.knowledgeTokens = 0;
  return collectVisibleView(view, entries, binding);
}

/** Validate the whole appended delta before touching the borrowed memo. A later malformed carrier
 * must not leave an earlier valid carrier charged twice on retry. Work is proportional to the delta,
 * not the retained history; task admission still freezes its one independent copy. */
export function extendVisibleView(view: VisibleView, entries: readonly ContextEntry[], binding: VisibleBinding): VisibleView {
  const delta = visibleView(entries, binding);
  for (const [id, representation] of delta.raw)
    if (representation === "source" || !view.raw.has(id)) view.raw.set(id, representation);
  for (const [id, native] of delta.rawEntryIds ?? []) (view.rawEntryIds ??= new Map()).set(id, native);
  for (const id of delta.factIds) view.factIds.add(id);
  for (const id of delta.knowledgeCommitIds) view.knowledgeCommitIds.add(id);
  for (const state of delta.knowledgeStates ?? []) (view.knowledgeStates ??= new Set()).add(state);
  view.knowledgeTokens = (view.knowledgeTokens ?? 0) + delta.knowledgeTokens!;
  view.injection ||= delta.injection;
  view.suppliedGeneration = Math.max(view.suppliedGeneration, delta.suppliedGeneration);
  return view;
}

function collectVisibleView(view: VisibleView, entries: readonly ContextEntry[], binding: VisibleBinding): VisibleView {
  const { raw, factIds, knowledgeCommitIds } = view;
  const rawEntryIds = view.rawEntryIds ?? new Map<number, string>();
  const knowledgeStates = view.knowledgeStates ?? new Set<string>();
  let { injection, suppliedGeneration } = view;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || typeof entry.id !== "string" || !entry.id.trim()) continue;
    if (entry.type === "message") { raw.set(entry.id, "source"); continue; }
    const carrier = carrierOf(entry, binding);
    if (!carrier) continue;
    const supplied = carrier.supplied;
    view.knowledgeTokens = (view.knowledgeTokens ?? 0) + (supplied.knowledgeTokens ?? legacyKnowledgeTokens(carrierText(entry)));
    if (entry.type === "custom_message") injection = true;
    if (carrier.pi === binding.pi && typeof carrier.generation === "number" && carrier.generation > suppliedGeneration)
      suppliedGeneration = carrier.generation;
    for (const item of supplied.entries ?? []) {
      const marked = item.view === "bounded" || item.tier === 1 || item.tier === 2;
      if (marked && !raw.has(item.nativeId)) raw.set(item.nativeId, "view");
      if (marked) rawEntryIds.set(item.id, item.nativeId);
    }
    for (const id of supplied.factIds ?? []) factIds.add(id);
    for (const id of supplied.knowledgeCommitIds ?? []) knowledgeCommitIds.add(id);
    for (const state of supplied.knowledgeStates ?? []) knowledgeStates.add(knowledgeStateKey(state));
  }
  Object.assign(view, { ...(rawEntryIds.size ? { rawEntryIds } : {}),
    ...(knowledgeStates.size ? { knowledgeStates } : {}), injection, suppliedGeneration });
  return view;
}
