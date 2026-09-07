import { KNOWLEDGE_CATEGORIES } from "../model/index.ts";
import type { KnowledgeRevision, KnowledgeMark, Fact, FactRelation, ToolCall, Turn } from "../model/index.ts";
import type { KnowledgeWithRevision } from "../store/index.ts";
import type { TraceMemoryConfig } from "../api/index.ts";

type Budgets = TraceMemoryConfig["render"];
export interface TurnOptions { tool?: number; full?: boolean; part?: "user" | "assistant" | `t${number}` }
export interface Rendered { content: string; receipts: string[] }

// Token estimate (ruled, grilling Q12; no tokenizer dependency): 0.75 per CJK character, 0.25 per
// other character, counted in code points. Every budget in this module is measured with it.
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303f\uff00-\uffef]/u;
export const tokens = (text: string): number => {
  let cjk = 0, other = 0;
  for (const ch of text) if (CJK.test(ch)) cjk++; else other++;
  return Math.ceil(cjk * 0.75 + other * 0.25);
};

// Head and tail are token budgets; lines are kept whole, so a line over its budget is dropped.
function cut(text: string, head: number, tail: number): string {
  if (tokens(text) <= head + tail) return text;
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  let first = 0, last = lines.length, used = 0;
  while (first < last && used + tokens(lines[first]!) <= head) used += tokens(lines[first++]!);
  used = 0;
  while (last > first && used + tokens(lines[last - 1]!) <= tail) used += tokens(lines[--last]!);
  const omitted = lines.slice(first, last).join("");
  return [lines.slice(0, first).join(""),
    `[omitted ${last - first} lines, ${[...omitted].length} characters]`,
    lines.slice(last).join("")].filter(Boolean).join("\n");
}

function object(text: string | null): Record<string, unknown> {
  try { const value = JSON.parse(text ?? "null"); return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
  catch { return {}; }
}
const string = (value: unknown): string => typeof value === "string" ? value : value == null ? "" : JSON.stringify(value);

export function renderTurn(turn: Turn, calls: ToolCall[], budgets: Budgets, options: TurnOptions = {}): Rendered {
  const part = options.part;
  if (part && (part === "user" ? turn.userPrompt === null : part === "assistant" ? turn.assistantText === null
    : !calls.some((call) => `t${call.ordinal}` === part))) throw new Error(`source T${turn.id}#${part} does not exist`);
  const lines: string[] = part ? [] : [`[S${turn.sessionId}/T${turn.id}] ${turn.startedAt} [${turn.kind}]`];
  const receipts: string[] = [];
  if ((!part || part === "user") && turn.userPrompt !== null) lines.push(`[Source entry id: T${turn.id}#user]\n${turn.userPrompt}`);
  let omittedCalls = 0;
  for (const call of calls) {
    if (part && part !== `t${call.ordinal}`) continue;
    const input = object(call.input), result = object(call.result);
    const selected = options.tool === undefined || options.tool === call.ordinal;
    let omitted = !selected;
    const body: string[] = [];
    const field = (label: string, text: string, head: number, tail: number) => {
      if (!text) return;
      const preview = options.full ? text : cut(text, head, tail);
      if (preview !== text) omitted = true;
      body.push(`${label}:\n${preview}`);
    };
    if (selected) {
      const read = /^(read|read_file|search|grep|glob)$/i.test(call.name);
      const memoryWrite = /(?:^|__)(?:note|memory|mark|remember|forget)$/i.test(call.name);
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
      receipts.push(`expand: trace({"address":"T${turn.id}","tool":${call.ordinal},"full":true})`);
    }
  }
  if ((!part || part === "assistant") && turn.assistantText !== null) lines.push(`[Source entry id: T${turn.id}#assistant]\n${turn.assistantText}`);
  if (omittedCalls) receipts.unshift(`T${turn.id}: ${omittedCalls} omitted calls (including partial calls)`);
  return { content: lines.join("\n"), receipts };
}

export function renderSources(turn: Turn, calls: ToolCall[]): string {
  const preview = (text: string | null) => [...(text ?? "").replace(/\s+/gu, " ")].slice(0, 60).join("");
  return [
    ...(turn.userPrompt === null ? [] : [`T${turn.id}#user ${preview(turn.userPrompt)}`]),
    ...(turn.assistantText === null ? [] : [`T${turn.id}#assistant ${preview(turn.assistantText)}`]),
    ...calls.map((call) => `T${turn.id}#t${call.ordinal} tool=${call.name} ${preview(call.input)}`),
  ].join(" | ");
}

export function finish(rendered: Rendered): string {
  return rendered.content + (rendered.receipts.length ? `\n\nReceipts:\n${rendered.receipts.join("\n")}` : "");
}

export function renderFact(fact: Fact, relations: FactRelation[]): string {
  const edges = relations.map((r) => r.fromFact === fact.id
    ? `${r.kind} F${r.toFact} ${r.strength}` : `inbound ${r.kind} F${r.fromFact} ${r.strength}`);
  return [`[F${fact.id}] ${fact.createdAt} [${fact.category}/${fact.actor}] ${fact.category === "event" && fact.status ? `${fact.status}: ` : ""}${fact.text}${edges.length ? ` · ${edges.join(" · ")}` : ""}`,
    ...(fact.quote === null ? [] : [`  quote: ${JSON.stringify(fact.quote)}`]),
    `  source: ${fact.source.join(", ")}`].join("\n");
}

export function renderKnowledge({ knowledge, revision: r }: KnowledgeWithRevision, marks: KnowledgeMark[] = []): string {
  return `[K${knowledge.id}@${r.id}] [${r.category}/${r.scope}] ${r.text}${marks.length ? ` · ${marks.map((m) => m.kind).join(", ")}` : ""}\n  supports: ${r.supports.map((id) => `F${id}`).join(", ")}`;
}

const factAddresses = (ids: number[]): string => ids.map((id) => `F${id}`).join(", ") || "none";
const commitLine = (r: KnowledgeRevision): string =>
  `  K${r.knowledgeId}@${r.id} ${r.op} ${r.createdAt} because: ${factAddresses(r.because ?? [])}`;
export const renderCommitHistory = (revisions: KnowledgeRevision[]): string =>
  revisions.length ? `Commits:\n${revisions.map(commitLine).join("\n")}` : "Commits: none";

export function renderKnowledgeTrace(value: KnowledgeWithRevision, marks: KnowledgeMark[], parents: KnowledgeRevision[], children: KnowledgeRevision[]): string {
  const addresses = (commits: KnowledgeRevision[]) => commits.map(r => `K${r.knowledgeId}@${r.id}`).join(", ") || "none";
  return [renderKnowledge(value, marks.filter(m => m.commitId === value.revision.id)),
    `  parents: ${addresses(parents)}`, `  children: ${addresses(children)}`, commitLine(value.revision)].join("\n");
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

export function renderKnowledgeDiff(a: KnowledgeRevision, b: KnowledgeRevision, revisions: KnowledgeRevision[]): string {
  return [`[K${a.knowledgeId}@${a.id}..K${b.knowledgeId}@${b.id}]`, `  text: ${diffText(a.text, b.text)}`,
    `  supports added: ${factAddresses([...new Set(b.supports)].filter((id) => !a.supports.includes(id)))}`,
    `  supports removed: ${factAddresses([...new Set(a.supports)].filter((id) => !b.supports.includes(id)))}`,
    ...(a.category === b.category ? [] : [`  category: ${a.category} -> ${b.category}`]),
    ...(a.scope === b.scope ? [] : [`  scope: ${a.scope} -> ${b.scope}`]),
    renderCommitHistory(revisions)].join("\n");
}

export interface NegationStep { fact: Fact; relations: FactRelation[]; depth: number; terminal: boolean }
export function renderNegationWalk(steps: NegationStep[]): string {
  return steps.flatMap(({ fact, relations, depth, terminal }) => [
    ...renderFact(fact, relations).split("\n").map((line) => "  ".repeat(depth) + line),
    ...(terminal ? ["  ".repeat(depth + 1) + "no later strong negation recorded"] : []),
  ]).join("\n");
}

export function budgetKnowledge(knowledge: KnowledgeWithRevision[], cap: number, line: (knowledge: KnowledgeWithRevision) => string = renderKnowledge) {
  let used = 0, omitted = false;
  const groups: { category: string; text: string }[] = [], receipts: string[] = [];
  for (const category of KNOWLEDGE_CATEGORIES) {
    const group = knowledge.filter((e) => e.revision.category === category)
      .sort((a, b) => a.revision.createdAt.localeCompare(b.revision.createdAt) || a.knowledge.id - b.knowledge.id);
    const text = group.map((e) => line(e)).join("\n");
    if (KNOWLEDGE_CATEGORIES.indexOf(category) >= 3 && (omitted || used + tokens(text) > cap)) {
      omitted = true;
      if (group.length) receipts.push(`omitted ${group.length} ${category} knowledge; expand: ${group.map((e) => `K${e.knowledge.id}`).join(", ")}`);
    } else { groups.push({ category, text }); used += tokens(text); }
  }
  return { groups, receipts };
}

export function budgetFacts(base: string, facts: Fact[], line: (fact: Fact) => string, cap: number, label = "raw") {
  let used = tokens(base), dropped = 0;
  const recent: string[] = [], receipts: string[] = [];
  for (const fact of facts) {
    const text = line(fact);
    if (dropped || used + tokens(text) > cap) { dropped++; continue; }
    recent.push(text); used += tokens(text);
  }
  if (tokens(base) > cap) receipts.push(`${label} overage: ${tokens(base) - cap} tokens; all ${label === "raw" ? "unrecorded raw" : "range facts"} kept`);
  if (dropped) receipts.push(`omitted ${dropped} older facts; expand: ${facts.slice(-dropped).map((f) => `F${f.id}`).join(", ")}`);
  return { recent, receipts };
}

// Tags delimit blocks for the model; the lines inside are trace lines byte for byte, never escaped.
export const xmlBlock = (tag: string, text: string): string => `<${tag}>\n${text}\n</${tag}>`;
export const renderKnowledgeBlock = (groups: { category: string; text: string }[]): string => {
  const blocks = groups.filter((g) => g.text).map((g) => xmlBlock(g.category, g.text));
  return blocks.length ? `<knowledge>\n${blocks.join("\n")}\n</knowledge>` : ""; // nothing to inject: no block at all
};
export const listingLine = (text: string): string => text.replaceAll("\n", " ⏎ ");
