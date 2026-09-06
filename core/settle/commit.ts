import type { SettleOutput } from "../model/index.ts";
import type { EntryOperationInput, RunInput, Store } from "../store/index.ts";
import { tokens } from "../render/index.ts";
import type { freezeSettle, NearPair } from "./index.ts";

export type SettleDiagnostic =
  | { kind: "unsupported_numbers"; entry: string; numbers: string[] }
  | { kind: "over_200_tokens"; entry: string; tokens: number }
  | { kind: "unanswered_near"; pairs: NearPair[] }
  | { kind: "lost_citations"; facts: string[] };

// Compare whole numeric lexemes, including grouped thousands and decimal fractions.
const numbers = (text: string) => text.match(/\d+(?:,\d{3})*(?:\.\d+)?/g) ?? [];

export function commitFinal(store: Store, frozen: ReturnType<typeof freezeSettle>, output: SettleOutput,
  run: RunInput, unansweredNear: NearPair[]) {
  const problems: string[] = [], diagnostics: SettleDiagnostic[] = [];
  const evidence = new Map(frozen.facts.map((f) => [f.id, f]));
  const end = frozen.rangeFacts.at(-1)!.id;
  const reads = new Map(frozen.entries.map(({ entry, revision }) => [entry.id, revision]));
  const touched = new Set<number>(), handles = new Set<string>();
  const id = (address: string) => {
    const value = Number(address.slice(1));
    if (!/^[EF][1-9]\d*$/.test(address) || !Number.isSafeInteger(value)) problems.push(`invalid address: ${address}`);
    return value;
  };
  const facts = (addresses: string[]) => addresses.map((address) => {
    const value = id(address);
    if (!evidence.has(value) || value > end) problems.push(`${address}: not an available fact of this project (range or earlier)`);
    return value;
  });
  const target = (address: string) => {
    const entryId = id(address), read = reads.get(entryId);
    if (!read) problems.push(`${address}: entry was not read as visible and active`);
    if (touched.has(entryId)) problems.push(`${address}: duplicate operation target`);
    touched.add(entryId);
    return { entryId, expectedRevision: read?.rev ?? 0 };
  };
  const content = (value: Omit<SettleOutput["new"][number], "handle">) => ({ text: value.text, scope: value.scope,
    category: value.category, supports: facts(value.supports), createdAt: run.createdAt });
  const operations: EntryOperationInput[] = [];
  for (const value of output.new) {
    if (!/^\$e[1-9]\d*$/.test(value.handle) || !Number.isSafeInteger(Number(value.handle.slice(2))) || handles.has(value.handle)) {
      problems.push(`${value.handle}: invalid or duplicate candidate handle`);
    }
    handles.add(value.handle);
    operations.push({ op: "new", handle: value.handle, author: run.model ?? "session", ...content(value) });
  }
  for (const value of output.edit) operations.push({ op: "edit", ...target(value.id), ...content(value), because: facts(value.because) });
  for (const value of output.merge) {
    const into = target(value.into);
    if (!value.absorb.length) problems.push(`${value.into}: merge must absorb at least one entry`);
    operations.push({ op: "merge", intoEntryId: into.entryId, intoExpectedRevision: into.expectedRevision,
      absorb: value.absorb.map(target), ...content(value), because: facts(value.because) });
  }
  for (const value of output.delete) operations.push({ op: "archive", ...target(value.id), because: facts(value.because), createdAt: run.createdAt });
  const declined = new Set(facts(output.not_admitted.map((value) => value.id)));
  for (const ack of output.near_ack) {
    if (!reads.has(id(ack.entry))) problems.push(`${ack.entry}: NEAR acknowledgement names an unread entry`);
  }
  // Remove all affected snapshots before adding replacements; archives and absorbed entries cite nothing.
  const resulting = new Set(frozen.entries.filter(({ entry }) => !touched.has(entry.id)).flatMap(({ revision }) => revision.supports));
  for (const op of operations) {
    if (op.op === "archive") continue;
    if (op.scope === "session" && op.op !== "new") {
      const entryId = op.op === "merge" ? op.intoEntryId : op.entryId;
      const creation = store.getEntryRevision(entryId, 1);
      if (!creation?.runId || store.getRun(creation.runId)?.sessionId !== frozen.sessionId) continue;
    }
    for (const fact of op.supports) resulting.add(fact);
  }
  const uncited = frozen.rangeFacts.filter((f) => (f.actor === "user" || f.category === "question") && !resulting.has(f.id) && !declined.has(f.id));
  if (uncited.length) problems.push(`uncited facts: ${uncited.map((f) => `F${f.id}`).join(", ")}`);
  const response = JSON.parse(run.response!);
  if (problems.length) {
    const runId = store.recordRun({ ...run, outcome: "failure", response: JSON.stringify({ ...response, problems }) }).id;
    return { outcome: "bounced" as const, runId, problems };
  }
  for (const op of operations) {
    if (op.op === "archive") continue;
    const entry = op.op === "new" ? op.handle : `E${op.op === "merge" ? op.intoEntryId : op.entryId}`;
    const cited = new Set(op.supports.flatMap((id) => {
      const fact = evidence.get(id)!;
      return numbers(`${fact.text}\n${fact.quote ?? ""}`);
    }));
    const unsupported = [...new Set(numbers(op.text))].filter((n) => !cited.has(n));
    if (unsupported.length) diagnostics.push({ kind: "unsupported_numbers", entry, numbers: unsupported });
    if (tokens(op.text) > 200) diagnostics.push({ kind: "over_200_tokens", entry, tokens: tokens(op.text) });
  }
  if (unansweredNear.length) diagnostics.push({ kind: "unanswered_near", pairs: unansweredNear });
  const result = store.commitSettleRun({ run, operations,
    watermark: { sessionId: frozen.sessionId, branch: frozen.branch, lastSettledFact: end },
    finalizeResponse: ({ committed, rejected }) => {
      const actual = new Set(store.listVisibleEntries(frozen.sessionId, frozen.projectId).flatMap(({ revision }) => revision.supports));
      const lost = [...new Set(rejected.flatMap(({ op }) => op.op === "archive" ? [] : op.supports))].filter((id) => resulting.has(id) && !actual.has(id));
      if (lost.length) diagnostics.push({ kind: "lost_citations", facts: lost.map((id) => `F${id}`) });
      return JSON.stringify({ ...response, committed, rejected, diagnostics });
    } });
  if (!result.ok) return { outcome: "failure" as const, runId: result.runId, problems: result.problems };
  return { outcome: "success" as const, runId: result.runId, committed: result.committed, rejected: result.rejected, diagnostics };
}
