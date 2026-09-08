import { KNOWLEDGE_CATEGORIES } from "../model/index.ts";
import type { KnowledgeRevision, KnowledgeMark, Fact, FactRelation, ToolCall, Turn } from "../model/index.ts";
import type { SourceEntry, KnowledgeWithRevision } from "../store/index.ts";
import type { TraceMemoryConfig } from "../api/index.ts";

type Budgets = TraceMemoryConfig["render"];
export interface TurnOptions { tool?: number; full?: boolean; part?: "user" | "assistant" | `t${number}` }
export interface Rendered { content: string; receipts: string[] }

// Token estimate (no tokenizer dependency). Two weights over character classes cannot price both
// Chinese and English prose at once: the ruled 0.75/0.25 pair under-counted Chinese by 28% and
// over-counted English prose by 46%, and refitting the two constants left the Chinese shortfall at
// 23% (measurement 2026-09-07). So the text is split on whitespace and punctuation runs and each
// segment is priced by its own rule, the shape used by tokenx (github.com/johannschopplich/tokenx,
// MIT), whose ratios are calibrated against OpenAI's o200k_base. Every budget here uses this.
// Two rules are ours, both measured: runs are priced across letter/digit boundaries because this
// project's addresses (F42, T7, K1) are that shape in every line we budget, and a run of horizontal
// whitespace costs the one token o200k holds for it. Accuracy over 20 corpora of this project's own
// text: 7.2% mean absolute error, at worst 15% under and 19% over. Over-counting is the safe
// direction for a budget. core/render/index.test.ts pins the bound against recorded true counts.
const PUNCTUATION = /[.,!?;(){}[\]<>:/\\|@#$%^&*+=`~_"-]/;
const SPLIT = new RegExp(`(\\s+|${PUNCTUATION.source}+)`);
const INDENT = /\n[^\S\n]/;
const SPACE_RUN = /[^\S\n]{2,}/;
const NON_ASCII = /[\u0080-\uFFFF]/;
const CJK = /[\u4E00-\u9FFF\u3400-\u4DBF\u3000-\u30FF\uFF00-\uFFEF\u2E80-\u2EFF\u31C0-\u31EF\u3200-\u32FF\u3300-\u33FF\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F\uA960-\uA97F\uD7B0-\uD7FF]/;
const DIGITS = /^\d+$/;
const LOWERCASE_WORD = /^[a-z]+$/;
const LETTERS_AND_DIGITS = /^(?=.*[a-z])(?=.*\d)[a-z\d]+$/i;
// Ratios in characters per token; a whole language is priced through the minority of its words that
// carry a diacritic, so each is fitted against running text rather than against the matched segments.
const SCRIPTS: { pattern: RegExp; charsPerToken: number }[] = [
  { pattern: /[äöüßẞ]/i, charsPerToken: 3 },
  { pattern: /[éèêëàâîïôûùüÿçœæáíóúñ]/i, charsPerToken: 4.5 },
  { pattern: /[ąćęłńóśźżěščřžýůúďťň]/i, charsPerToken: 2.5 },
  { pattern: /[\u0430-\u044F\u0451]/i, charsPerToken: 6 },
  { pattern: /[\u03AC-\u03CE]/i, charsPerToken: 3 },
  // Anchored to pure pictographic runs: symbols like ™ are Extended_Pictographic too, and an
  // unanchored match would misprice the word they are attached to.
  { pattern: /^\p{Extended_Pictographic}[\p{Extended_Pictographic}\p{Emoji_Component}]*$/u, charsPerToken: 0.9 },
];
const HANZI_CHARS_PER_TOKEN = 1.15, KANA_CHARS_PER_TOKEN = 1.4, HANGUL_CHARS_PER_TOKEN = 1.65;
const DEFAULT_CHARS_PER_TOKEN = 7, PUNCTUATION_CHARS_PER_TOKEN = 6;
const SHORT_SEGMENT = 3, MERGED_WORD = 8;

const isHangul = (code: number) => (code >= 0xAC00 && code <= 0xD7AF) || (code >= 0x1100 && code <= 0x11FF)
  || (code >= 0x3130 && code <= 0x318F) || (code >= 0xA960 && code <= 0xA97F) || (code >= 0xD7B0 && code <= 0xD7FF);

// One rounding for the whole segment: rounding each script on its own would charge a token for every
// script boundary in mixed CJK text.
function cjkTokens(segment: string): number {
  let kana = 0, hangul = 0, hanzi = 0;
  for (const character of segment) {
    const code = character.codePointAt(0)!;
    if (code >= 0x3040 && code <= 0x30FF) kana++;
    else if (isHangul(code)) hangul++;
    else hanzi++;
  }
  return Math.ceil(hanzi / HANZI_CHARS_PER_TOKEN + kana / KANA_CHARS_PER_TOKEN + hangul / HANGUL_CHARS_PER_TOKEN);
}

function runTokens(run: string): number {
  if (DIGITS.test(run)) return Math.ceil(run.length / 3); // o200k chunks digit runs by three
  if (run.length <= SHORT_SEGMENT) return 1;
  // Common lowercase words up to eight characters merge into one token; the lowercase gate keeps
  // capitalised compounds and scripts without a rule of their own at the default ratio.
  if (run.length <= MERGED_WORD && LOWERCASE_WORD.test(run)) return 1;
  if (PUNCTUATION.test(run)) return Math.ceil(run.length / PUNCTUATION_CHARS_PER_TOKEN);
  return Math.ceil(run.length / DEFAULT_CHARS_PER_TOKEN);
}

function segmentTokens(segment: string, previous: string): number {
  if (/^\s+$/.test(segment)) {
    let count = 0;
    // A line break stands on its own after a word but merges into a preceding punctuation token.
    if (segment.includes("\n")) count += PUNCTUATION.test(previous.slice(-1)) ? 0 : 1;
    // o200k holds one token for a run of spaces of any length, so indentation costs one whatever its
    // width. A lone space between words merges into the word that follows and costs nothing.
    if (INDENT.test(segment) || SPACE_RUN.test(segment)) count += 1;
    return count;
  }
  if (NON_ASCII.test(segment)) {
    for (const { pattern, charsPerToken } of SCRIPTS) {
      if (pattern.test(segment)) return Math.ceil([...segment].length / charsPerToken);
    }
    if (CJK.test(segment)) return cjkTokens(segment);
  }
  // o200k breaks at letter/digit boundaries, and this project's own addresses (F42, T7, K1, R12) are
  // exactly that shape, in every fact line, knowledge line and source index we budget. Charging one
  // token for the whole short segment under-counted a rendered fact line by 16% (measured 2026-09-07);
  // pricing each run on its own follows the tokenizer instead.
  if (LETTERS_AND_DIGITS.test(segment)) {
    let total = 0;
    for (const run of segment.match(/\d+|\D+/g)!) total += runTokens(run);
    return total;
  }
  return runTokens(segment);
}

export const tokens = (text: string): number => {
  let total = 0, previous = "";
  for (const segment of text.split(SPLIT)) {
    if (!segment) continue;
    total += segmentTokens(segment, previous);
    previous = segment;
  }
  return total;
};

export const ENTRY_VIEW_VERSION = "17a-v1-fixed-halves";

const excerptText = (label: string, chars: string[], kept: number): string => {
  const head = Math.ceil(kept / 2), tail = Math.floor(kept / 2);
  return `${label}\n${chars.slice(0, head).join("")}\n[omitted ${chars.length - kept} characters; middle not inspected]\n${tail ? chars.slice(-tail).join("") : ""}`;
};

/** Count the entire excerpt, including its immutable source label and honest omission marker. */
function entryExcerpt(label: string, body: string, cap: number): string {
  const full = `${label}\n${body}`;
  if (tokens(full) <= cap) return full;
  const chars = [...body];
  const excerpt = (kept: number) => excerptText(label, chars, kept);
  if (tokens(excerpt(0)) > cap) throw new Error("entry view capacity cannot hold source labels and omission markers");
  let low = 0, high = chars.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (tokens(excerpt(mid)) <= cap) low = mid; else high = mid - 1;
  }
  return excerpt(low);
}

export { sourceAddresses } from "../store/index.ts";

/** One immutable view for all automatically supplied Raw. Each call reserves half for each occurrence. */
export function renderEntry(entry: SourceEntry, budgets: Budgets): Rendered {
  const header = `[S${entry.sessionId}/T${entry.turnId}] [entry ${JSON.stringify([entry.nativeLineage, entry.nativeId])}]`;
  const parts: { label: string; body: string; cap: number }[] = [];
  // A user message without text (an image, say) still shows as a source with a marker; it has no citable address.
  if (entry.text || entry.role === "user") parts.push({ label: `[Source entry id: T${entry.turnId}#${entry.role === "user" ? "user" : "assistant"}]`,
    body: entry.text || "[non-text content omitted]", cap: budgets.entryTokens });
  for (const call of entry.calls) {
    const result = entry.role === "toolResult";
    const cap = result ? Math.floor((budgets.toolCallTokens - 2) / 2) : Math.ceil((budgets.toolCallTokens - 2) / 2);
    parts.push({ label: `[T${entry.turnId}#t${call.ordinal}] tool=${call.name} call=${call.callId} status=${call.status} ${result ? "result" : "arguments"}:`,
      body: result ? call.result ?? "" : call.input ?? "", cap });
  }
  let views = parts.map(p => entryExcerpt(p.label, p.body, p.cap));
  const minima = parts.map(p => {
    const chars = [...p.body];
    return Math.min(tokens(`${p.label}\n${p.body}`), Math.max(tokens(excerptText(p.label, chars, 0)), tokens(excerptText(p.label, chars, Math.min(8, chars.length)))));
  });
  const content = () => [header, ...views].join("\n");
  // ponytail: redistribute by the largest fragment; a linear priority queue is enough for one entry.
  while (tokens(content()) > budgets.entryTokens) {
    const available = views.map((v, i) => tokens(v) - minima[i]!);
    const index = available.indexOf(Math.max(...available));
    if (available[index]! <= 0) throw new Error("entry view capacity cannot hold source labels and omission markers");
    const part = parts[index]!;
    part.cap = Math.max(minima[index]!, tokens(views[index]!) - Math.min(Math.ceil(available[index]! / 2), Math.max(1, tokens(content()) - budgets.entryTokens)));
    views[index] = entryExcerpt(part.label, part.body, part.cap);
  }
  return { content: content(), receipts: [] };
}

/** Ticket 20 "Try secondary views" (20c): the compact-only, lossier view of one entry. It is reached
 * only when the primary views of every pending entry together exceed the shared Raw ceiling, and it
 * never replaces the primary view anywhere else — Noter input, token counters and trace keep using
 * `renderEntry`. The work is deterministic and local: no model call, no summarization loop.
 *
 * Kept: the entry's own header with its source address and native identity, the user/assistant
 * boundary, the non-text placeholder, and one line per tool fragment carrying the tool name, its
 * occurrence address `T<id>#t<n>`, its call id and its status — the minimum identity a reader needs
 * to trace the fragment back to the untouched original. Dropped: tool arguments and results
 * entirely, and everything of the user/assistant text beyond a bounded excerpt, marked with the same
 * omission wording the primary view uses.
 *
 * Versioned because a reader must be able to tell which truncation rule produced the text in front
 * of it. The excerpt budgets below are an implementation choice, not a user ruling (confirmation
 * 2026-09-08): one documented constant set, versioned with the view and exercised by the tier tests. */
export const SECONDARY_VIEW_VERSION = "20c-v1-bounded-excerpts";
/** Excerpt token budget per role, counting the source label and the omission marker inside it. The
 * user side keeps more than the assistant side: it is the instruction the rest of the work answers. */
export const SECONDARY_EXCERPT_TOKENS: Readonly<Record<"user" | "assistant", number>> = { user: 120, assistant: 60 };

export function renderEntrySecondary(entry: SourceEntry): string {
  const lines = [`[S${entry.sessionId}/T${entry.turnId}] [entry ${JSON.stringify([entry.nativeLineage, entry.nativeId])}] [compact-only view ${SECONDARY_VIEW_VERSION}]`];
  // A user message without text (an image, say) keeps its boundary and its placeholder, as in the primary view.
  if (entry.text || entry.role === "user") {
    const role = entry.role === "user" ? "user" : "assistant";
    lines.push(entryExcerpt(`[Source entry id: T${entry.turnId}#${role}]`, entry.text || "[non-text content omitted]", SECONDARY_EXCERPT_TOKENS[role]));
  }
  for (const call of entry.calls) lines.push(`[T${entry.turnId}#t${call.ordinal}] tool=${call.name} call=${call.callId} status=${call.status} [${entry.role === "toolResult" ? "result" : "arguments"} omitted]`);
  return lines.join("\n");
}

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
      } else if (options.full) {
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

/** How a stored run mode reads (ticket 19 "Historical truth"). New work records `fork` (inherited
 * native context) or `subagent` (fresh context). `branch` is the pre-rename spelling and, because
 * the rename came with the cutover, every run that carries it was executed by the deleted
 * request-copy runner, not by an `AgentSession`: the read side says so instead of relabelling it.
 * Stored values are never rewritten — no migration, no bulk update, no rewrite on open or on read. */
export const runMode = (mode: string | null): string =>
  mode === "branch" ? "legacy request-copy execution (branch)" : mode ?? "?";

/** A run record as a human summary; `full` adds the tool rounds and previews of the raw request and response. */
export function renderRun(run: { id: number; kind: string; outcome: string; sessionId: number | null; branch: string | null; rangeFrom: string | null; rangeTo: string | null; model: string | null; mode: string | null; request: string | null; response: string | null; createdAt: string },
  factIds: number[], commits: { knowledgeId: number; id: number; op: string; reason: string }[], full = false): string {
  let response: Record<string, unknown> = {};
  try { response = JSON.parse(run.response ?? "{}") ?? {}; } catch { response = {}; }
  const usage = (response.usage ?? null) as { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } } | null;
  const calls = (Array.isArray(response.toolCalls) ? response.toolCalls : []) as { name: string; input?: unknown; result?: string }[];
  const counts = new Map<string, number>(); for (const c of calls) counts.set(c.name, (counts.get(c.name) ?? 0) + 1);
  const problems = (Array.isArray(response.problems) ? response.problems as string[] : [])
    .concat(Array.isArray(response.results) ? (response.results as unknown[]).filter((r): r is string => typeof r === "string" && r.startsWith("rejected:")) : [])
    .concat(typeof run.response === "string" && run.response.startsWith("rejected:") ? [run.response] : []);
  if (!problems.length && run.outcome !== "success") problems.push(`no problem text recorded; response: ${cut(run.response ?? "", 40, 0)}`);
  const lines = [`R${run.id} ${run.kind} ${run.outcome} ${run.createdAt}`,
    `  S${run.sessionId ?? "?"} / branch ${run.branch ?? "?"}  ${run.rangeFrom ?? "?"}..${run.rangeTo ?? "?"}`,
    `  model ${run.model ?? "?"}  mode ${runMode(run.mode)}`,
    `  created: ${[...factIds.map((id) => `F${id}`), ...commits.map((c) => `K${c.knowledgeId}@${c.id} (${c.op}: ${c.reason})`)].join(", ") || "nothing"}`,
    response.usageStatus === "unknown" ? "  usage: unknown  cost unknown"
      : `  usage: ${usage ? `in ${usage.input ?? 0} out ${usage.output ?? 0} cacheRead ${usage.cacheRead ?? 0} cacheWrite ${usage.cacheWrite ?? 0}` : "none"}  cost $${(usage?.cost?.total ?? 0).toFixed(4)}${response.usageStatus === "partial" ? " (known usage only; remaining cost unknown)" : ""}`,
    `  tools: ${[...counts].map(([n, k]) => `${n} ×${k}`).join(", ") || "none"}`,
    `  problems: ${problems.length ? problems.join("; ") : "none"}`];
  if (full) {
    for (const [i, c] of calls.entries()) lines.push(`  tool ${i + 1} ${c.name}`, `    input: ${cut(string(c.input), 120, 40)}`, `    result: ${cut(String(c.result ?? ""), 120, 40)}`);
    lines.push(`  request (preview, ${(run.request ?? "").length} characters):`, cut(run.request ?? "", 200, 80),
      `  response (preview, ${(run.response ?? "").length} characters):`, cut(run.response ?? "", 200, 80));
  } else if (calls.length || run.request) lines.push(`  (trace R${run.id} with full for tool rounds and raw request/response previews)`);
  return lines.join("\n");
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
// 21a: commit history carries the authored message; the compact automatic knowledge line does not.
const commitLine = (r: KnowledgeRevision): string =>
  `  K${r.knowledgeId}@${r.id} ${r.op} ${r.createdAt} supports: ${factAddresses(r.supports)} reason: ${r.reason}`;
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
    ...(a.reason === b.reason ? [] : [`  reason: ${a.reason} -> ${b.reason}`]),
    renderCommitHistory(revisions)].join("\n");
}

export interface NegationStep { fact: Fact; relations: FactRelation[]; depth: number; terminal: boolean }
export function renderNegationWalk(steps: NegationStep[]): string {
  return steps.flatMap(({ fact, relations, depth, terminal }) => [
    ...renderFact(fact, relations).split("\n").map((line) => "  ".repeat(depth) + line),
    ...(terminal ? ["  ".repeat(depth + 1) + "no later strong negation recorded"] : []),
  ]).join("\n");
}

// A block joins its parts with one separator and the estimator prices that separator at one token, so
// ticket 20's "Boundary accounting" is this: every emitted component, its own label and its joining
// separator are charged once, to the budget of the block that emits it. The leading part is charged a
// separator it does not have; over-counting is the safe direction for a budget, as it is for `tokens`.
export const charge = (parts: string[]): number => parts.reduce((total, part) => total + tokens(part) + 1, 0);
/** Ticket 20 "Budgeted receipts": a receipt names what it left out without becoming the unbounded
 * enumeration that would defeat the cap it is charged against. */
const EXPAND_LIMIT = 8;
export const expandList = (addresses: string[]): string => addresses.length <= EXPAND_LIMIT ? addresses.join(", ")
  : `${addresses.slice(0, EXPAND_LIMIT).join(", ")} and ${addresses.length - EXPAND_LIMIT} more up to ${addresses.at(-1)}`;

/** The knowledge block within its hard cap (ticket 20 "Knowledge hard cap", confirmed 2026-09-08).
 * Category priority and the deterministic within-category order are unchanged; the exemption that let
 * constraints, open items and disputes exceed the budget is gone. Items are retained whole, in that
 * order, while the rendered block, its category tags and its own omission receipts fit the cap. An
 * omitted item is named, never rewritten to fit, and remains stored and traceable. */
export function budgetKnowledge(knowledge: KnowledgeWithRevision[], cap: number, line: (knowledge: KnowledgeWithRevision) => string = renderKnowledge) {
  const ordered = KNOWLEDGE_CATEGORIES.flatMap((category) => knowledge
    .filter((e) => e.revision.category === category)
    .sort((a, b) => a.revision.createdAt.localeCompare(b.revision.createdAt) || a.knowledge.id - b.knowledge.id)
    .map((value) => ({ category, text: line(value), id: value.knowledge.id })));
  const sizes = ordered.map((item) => tokens(item.text) + 1);
  const receipts = (kept: number) => KNOWLEDGE_CATEGORIES.flatMap((category) => {
    const omitted = ordered.slice(kept).filter((item) => item.category === category);
    return omitted.length ? [`omitted ${omitted.length} ${category} knowledge; expand: ${expandList(omitted.map((item) => `K${item.id}`))}`] : [];
  });
  const cost = (kept: number) => (kept ? tokens(xmlBlock("knowledge", "")) + sizes.slice(0, kept).reduce((a, b) => a + b, 0)
    + charge([...new Set(ordered.slice(0, kept).map((item) => item.category))].map((category) => xmlBlock(category, ""))) : 0)
    + charge(receipts(kept));
  let kept = 0;
  while (kept < ordered.length && cost(kept + 1) <= cap) kept++;
  // Omitting one more item can lengthen a receipt: recheck the prefix the loop stopped on. The floor
  // is the receipt itself, which is never dropped to fit — nothing else would say the item exists.
  while (kept > 0 && cost(kept) > cap) kept--;
  // A hard cap is hard for its receipt too (review 2026-09-08): when even the bounded receipt of the
  // omitted items does not fit, that is a capacity problem to report, not oversized material to emit.
  if (cost(kept) > cap) throw new Error(`Knowledge capacity: the omission receipt alone (${cost(kept)} tokens) exceeds render.knowledgeBlockTokens (${cap})`);
  return { groups: KNOWLEDGE_CATEGORIES.map((category) => ({ category,
    text: ordered.slice(0, kept).filter((item) => item.category === category).map((item) => item.text).join("\n") })),
    receipts: receipts(kept) };
}

/** Historical facts fill whatever episodic space the selected current material and the mandatory cues
 * left over (ticket 20 "Shared episodic space"), in the existing freshness order, whole lines only. */
export function budgetFacts(facts: Fact[], line: (fact: Fact) => string, remaining: number) {
  let used = 0, dropped = 0;
  const recent: string[] = [];
  for (const fact of facts) {
    const text = line(fact);
    if (dropped || used + tokens(text) + 1 > remaining) { dropped++; continue; }
    recent.push(text); used += tokens(text) + 1;
  }
  return { recent, receipts: dropped ? [`omitted ${dropped} older facts; expand: ${expandList(facts.slice(-dropped).map((f) => `F${f.id}`))}`] : [] };
}

// Tags delimit blocks for the model; the lines inside are trace lines byte for byte, never escaped.
export const xmlBlock = (tag: string, text: string): string => `<${tag}>\n${text}\n</${tag}>`;
export const renderKnowledgeBlock = (groups: { category: string; text: string }[]): string => {
  const blocks = groups.filter((g) => g.text).map((g) => xmlBlock(g.category, g.text));
  return blocks.length ? `<knowledge>\n${blocks.join("\n")}\n</knowledge>` : ""; // nothing to inject: no block at all
};
export const listingLine = (text: string): string => text.replaceAll("\n", " ⏎ ");
