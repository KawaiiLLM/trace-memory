import type { EntryLink, EntryRevision, Fact, FactRelation, ToolCall, Turn } from "../model/index";
import type { EntryWithRevision } from "../store/index";
import type { TraceMemoryConfig } from "../api/index";

type Budgets = TraceMemoryConfig["render"];
export interface TurnOptions { tool?: number; full?: boolean; cap?: number }
export interface Rendered { content: string; receipts: string[] }

// Approximate tokens as ceil(UTF-16 code units / 4); omission counts use those same code units.
export const tokens = (text: string): number => Math.ceil(text.length / 4);

function cut(text: string, head: number, tail: number): string {
  if (tokens(text) <= head + tail) return text;
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  let first = 0, last = lines.length, used = 0;
  while (first < last && used + lines[first]!.length <= head * 4) used += lines[first++]!.length;
  used = 0;
  while (last > first && used + lines[last - 1]!.length <= tail * 4) used += lines[--last]!.length;
  const omitted = lines.slice(first, last).join("");
  return [lines.slice(0, first).join(""),
    `[omitted ${last - first} lines, ${omitted.length} characters]`,
    lines.slice(last).join("")].filter(Boolean).join("\n");
}

function object(text: string | null): Record<string, unknown> {
  try { const value = JSON.parse(text ?? "null"); return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
  catch { return {}; }
}
const string = (value: unknown): string => typeof value === "string" ? value : value == null ? "" : JSON.stringify(value);

export function renderTurn(turn: Turn, calls: ToolCall[], budgets: Budgets, options: TurnOptions = {}): Rendered {
  const lines = [`[S${turn.sessionId}/T${turn.id}] ${turn.startedAt} [${turn.kind}]`];
  const receipts: string[] = [];
  if (turn.userPrompt !== null) lines.push(`[Source entry id: T${turn.id}#user]\n${turn.userPrompt}`);
  let omittedCalls = 0;
  for (const call of calls) {
    const input = object(call.input), result = object(call.result);
    const selected = options.tool === undefined || options.tool === call.ordinal;
    let omitted = !selected;
    const body: string[] = [];
    const field = (label: string, text: string, head: number, tail: number) => {
      if (!text) return;
      const capHead = options.cap === undefined ? head : Math.floor(options.cap * head / (head + tail || 1));
      const capTail = options.cap === undefined ? tail : options.cap - capHead;
      const preview = options.full && options.cap === undefined ? text
        : cut(text, capHead, capTail);
      if (preview !== text) omitted = true;
      body.push(`${label}:\n${preview}`);
    };
    if (selected) {
      const read = /^(read|read_file|search|grep|glob)$/i.test(call.name);
      const memoryWrite = /(?:^|__)(?:note|settle|mark|remember|forget)$/i.test(call.name);
      if ((read || memoryWrite) && !options.full) {
        const path = string(input.path ?? input.file_path ?? input.pattern ?? call.input);
        body.push(read ? `${call.name} ${path}` : `receipt: ${call.name} ${call.status}`);
        const count = (call.result ?? "").length + (memoryWrite ? (call.input ?? "").length : 0);
        if (count) { body.push(`[omitted ${count} characters of ${memoryWrite ? "input/result" : "result"}]`); omitted = true; }
      } else if (options.full && (read || memoryWrite)) {
        field("input", call.input ?? "", budgets.commandTokens, 0);
        field("result", call.result ?? "", budgets.reportHeadTokens, budgets.reportTailTokens);
      } else {
        field("command", string(input.command ?? input.cmd ?? call.input), budgets.commandTokens, 0);
        if ("stdout" in result || "stderr" in result) {
          field("stdout", string(result.stdout), budgets.stdoutHeadTokens, budgets.stdoutTailTokens);
          field("stderr", string(result.stderr), 0, budgets.stderrTailTokens);
        } else field("report", call.result ?? "", budgets.reportHeadTokens, budgets.reportTailTokens);
      }
    } else body.push(`[omitted ${(call.input ?? "").length + (call.result ?? "").length} characters of input/result]`);
    lines.push(`[T${turn.id}#t${call.ordinal}] tool=${call.name} status=${call.status} omitted=${omitted}`, ...body);
    if (omitted) {
      omittedCalls++;
      receipts.push(`expand: T${turn.id} tool=${call.ordinal} full`);
    }
  }
  if (turn.assistantText !== null) lines.push(`[Source entry id: T${turn.id}#assistant]\n${turn.assistantText}`);
  if (omittedCalls) receipts.unshift(`T${turn.id}: ${omittedCalls} omitted calls (including partial calls)`);
  return { content: lines.join("\n"), receipts };
}

export function finish(rendered: Rendered): string {
  return rendered.content + (rendered.receipts.length ? `\n\nReceipts:\n${rendered.receipts.join("\n")}` : "");
}

export function renderFact(fact: Fact, relations: FactRelation[]): string {
  const edges = relations.map((r) => r.fromFact === fact.id
    ? `${r.kind} F${r.toFact} ${r.strength}` : `inbound ${r.kind} F${r.fromFact} ${r.strength}`);
  return [`[F${fact.id}] ${fact.createdAt} [${fact.category}/${fact.actor}] ${fact.text}${edges.length ? ` · ${edges.join(" · ")}` : ""}`,
    ...(fact.quote === null ? [] : [`  quote: ${JSON.stringify(fact.quote)}`]),
    `  source: ${fact.source.join(", ")}`].join("\n");
}

export function renderEntry({ entry, revision: r }: EntryWithRevision): string {
  return `[E${entry.id}@${r.rev}] [${r.category}/${r.scope}] ${r.text}\n  supports: ${r.supports.map((id) => `F${id}`).join(", ")}`;
}

const factAddresses = (ids: number[]): string => ids.map((id) => `F${id}`).join(", ") || "none";
const revisionLine = (r: EntryRevision): string =>
  `  E${r.entryId}@${r.rev} ${r.op} ${r.createdAt} because: ${factAddresses(r.because ?? [])}`;
const revisionSummary = (revisions: EntryRevision[]): string =>
  revisions.length ? `Revisions:\n${revisions.map(revisionLine).join("\n")}` : "Revisions: none";

export function renderEntryTrace(value: EntryWithRevision, revisions?: EntryRevision[], links: EntryLink[] = []): string {
  return [renderEntry(value), ...(revisions ? [
    `  status: ${value.entry.status}`,
    ...links.map((l) => `  ${l.kind}: E${l.toEntry}@${l.toRev} (from E${l.fromEntry}@${l.fromRev})`),
    revisionSummary(revisions),
  ] : [revisionLine(value.revision)])].join("\n");
}

// Lossless lexical tokens: Han characters, other words/numbers, whitespace runs, punctuation.
// Unlike whitespace splitting, this exposes edits inside unspaced Chinese memory content.
function diffText(before: string, after: string): string {
  const split = (text: string) => text.match(/\p{Script=Han}|[\p{L}\p{N}\p{M}_]+|\s+|[^\s]/gu) ?? [];
  // Exclude Han from the word alternative so a Latin prefix cannot swallow a Han suffix.
  const tokenize = (text: string) => split(text).flatMap((part) =>
    part.match(/\p{Script=Han}|[^\p{Script=Han}]+/gu) ?? []);
  const a = tokenize(before), b = tokenize(after);
  const lengths = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lengths[i]![j] = a[i] === b[j] ? 1 + lengths[i + 1]![j + 1]!
        : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!);
    }
  }
  const spans: { kind: "same" | "remove" | "add"; text: string }[] = [];
  const append = (kind: "same" | "remove" | "add", text: string) => {
    if (spans.at(-1)?.kind === kind) spans.at(-1)!.text += text;
    else spans.push({ kind, text });
  };
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { append("same", a[i++]!); j++; }
    else if (i < a.length && (j === b.length || lengths[i + 1]![j]! >= lengths[i]![j + 1]!)) append("remove", a[i++]!);
    else append("add", b[j++]!);
  }
  return spans.map(({ kind, text }) => kind === "same" ? text : kind === "remove" ? `[-${text}-]` : `{+${text}+}`).join("");
}

export function renderEntryDiff(a: EntryRevision, b: EntryRevision, revisions: EntryRevision[]): string {
  return [`[E${a.entryId}@${a.rev}..${b.rev}]`, `  text: ${diffText(a.text, b.text)}`,
    `  supports added: ${factAddresses([...new Set(b.supports)].filter((id) => !a.supports.includes(id)))}`,
    `  supports removed: ${factAddresses([...new Set(a.supports)].filter((id) => !b.supports.includes(id)))}`,
    ...(a.category === b.category ? [] : [`  category: ${a.category} -> ${b.category}`]),
    ...(a.scope === b.scope ? [] : [`  scope: ${a.scope} -> ${b.scope}`]),
    revisionSummary(revisions)].join("\n");
}

export interface NegationStep { fact: Fact; relations: FactRelation[]; depth: number; terminal: boolean }
export function renderNegationWalk(steps: NegationStep[]): string {
  return steps.flatMap(({ fact, relations, depth, terminal }) => [
    ...renderFact(fact, relations).split("\n").map((line) => "  ".repeat(depth) + line),
    ...(terminal ? ["  ".repeat(depth + 1) + "no later strong negation recorded"] : []),
  ]).join("\n");
}
