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

/** Ticket 23 "One entry view, two budgets": the two numbers of one profile. `B` is the most one tool
 * call is worth, `E` the most one entry is worth. They are configuration, static per installation and
 * never adjusted per batch — views stay immutable and versioned, and an over-full batch is handled by
 * selecting fewer entries. */
export interface EntryProfile { toolCallTokens: number; entryTokens: number }
/** Ticket 23 "Host contract": one stored tool result as core renders it. The host unwraps its own
 * envelope; core never inspects envelope fields. `details` is the structured data the host dropped,
 * serialized, so this view can state its size — it is never rendered whole except as the fallback for
 * a result with no text at all. */
export interface ResultText { text: string; details?: string }
export type ResultExtractor = (result: string) => ResultText;
/** The default extractor: the stored result string as is. A host with an envelope registers its own. */
export const rawResultText: ResultExtractor = (result) => ({ text: result });

export const ENTRY_VIEW_VERSION = "23-v1-uniform-parts";
/** Arguments are rendered before their result exists and views are immutable, so the split inside `B`
 * is fixed. A quarter for arguments and three quarters for the result supersedes 17a's permanent
 * halves (user, 2026-09-09): measured argument needs are small, results are the volume. */
const ARGUMENTS_SHARE = 0.25;
// Every marker keeps the `[omitted … characters …]` wording the run audit already detects.
const omission = (characters: number) => `[omitted ${characters} characters]`;
const middleOmission = (characters: number) => `[omitted ${characters} characters; middle not inspected]`;

/** The largest `kept` whose rendering fits `cap`. Every probe is measured, so the answer is a
 * rendering that was seen to fit; doubling before bisecting keeps the probes near the kept size
 * instead of near the whole text, which is what a 300-token budget over a 100,000-character result
 * needs. How a cut position is found is the implementation's choice (23); the contract is the budget. */
function fit(build: (kept: number) => string, max: number, cap: number): number {
  if (max <= 0 || tokens(build(max)) <= cap) return max;
  let low = 0, high = 1;
  while (high < max && tokens(build(high)) <= cap) { low = high; high = Math.min(max, high * 2); }
  while (low < high - 1) {
    const mid = Math.floor((low + high) / 2);
    if (tokens(build(mid)) <= cap) low = mid; else high = mid;
  }
  return low;
}

/** One part of an entry: its smallest honest rendering, and its rendering under an allocation. A part
 * is never empty (it always carries its label line) and never shorter than `floor`. */
interface Part { floor: string; minimum: number; render(cap: number): string }

/** Equal shares of `total`, remainders to the earliest keys; one pass returns what a value shorter
 * than its share does not need to the others (23 budget contract). */
function fairShares(total: number, costs: number[]): number[] {
  const pool = Math.max(0, total);
  const cut = (available: number, count: number, index: number) => Math.floor(available / count) + (index < available % count ? 1 : 0);
  const equal = costs.map((_, index) => cut(pool, costs.length, index));
  const short = costs.filter((cost, index) => cost <= equal[index]!).length;
  if (!short || short === costs.length) return equal;
  const returned = costs.reduce((sum, cost, index) => sum + Math.max(0, equal[index]! - cost), 0);
  let rank = 0;
  return costs.map((cost, index) => cost <= equal[index]! ? cost : equal[index]! + cut(returned, costs.length - short, rank++));
}

/** The head and the tail of `kept` code points, in equal halves, around one honest marker. */
function halves(characters: string[], kept: number): string[] {
  const head = Math.ceil(kept / 2), tail = kept - head;
  return [characters.slice(0, head).join(""), middleOmission(characters.length - kept),
    tail ? characters.slice(-tail).join("") : ""].filter(line => line !== "");
}

/** Natural text: the text as stored, cut head and tail in equal halves when it must yield. Text is
 * not exempt by rule, only by size (23). */
function textPart(label: string, body: string): Part {
  const characters = [...body];
  const excerpt = (kept: number) => [label, ...halves(characters, kept)].join("\n");
  const whole = `${label}\n${body}`;
  return { floor: excerpt(0), minimum: tokens(excerpt(0)),
    render: (cap) => tokens(whole) <= cap ? whole : excerpt(fit(excerpt, characters.length, cap)) };
}

/** A tool call: the label line and one `key: value` line per top-level argument, each value cut at
 * its head under a fair share of the part's budget, so a target path after a long content string
 * still appears. Non-string values are compact JSON; a payload that is not an object is one line. */
function argumentsPart(label: string, input: string): Part {
  const values = object(input), keys = Object.keys(values);
  const items = keys.length ? keys.map((key) => ({ key: `${key}: `, characters: [...string(values[key])] }))
    : input ? [{ key: "", characters: [...input] }] : [];
  const size = items.reduce((total, item) => total + item.characters.length, 0);
  const line = (item: typeof items[number], kept: number) => item.key + item.characters.slice(0, kept).join("")
    + (kept < item.characters.length ? omission(item.characters.length - kept) : "");
  const whole = [label, ...items.map((item) => line(item, item.characters.length))].join("\n");
  const floor = items.length ? `${label}\n${omission(size)}` : label;
  return { floor, minimum: tokens(floor), render(cap) {
    if (tokens(whole) <= cap) return whole;
    const costs = items.map((item) => tokens(line(item, item.characters.length)));
    // One separator per emitted line is charged with the part, as the label line is.
    const shares = fairShares(cap - tokens(label) - items.length, costs);
    const view = [label, ...items.map((item, index) => shares[index]! >= costs[index]! ? line(item, item.characters.length)
      : line(item, fit((kept) => line(item, kept), item.characters.length, shares[index]!)))].join("\n");
    return tokens(view) <= cap ? view : floor;
  } };
}

/** A tool result: the label line with the call's status, and the host-extracted text cut head and
 * tail. Structured data the host dropped is marked with its size; when the text is empty, the head of
 * that data's compact JSON stands in for the marker, so a tool that answers only structurally is not
 * shown as blank (23). */
function resultPart(label: string, result: ResultText): Part {
  const details = result.details ?? "";
  const marker = details ? `[details omitted: ${[...details].length} characters]` : "";
  const structural = !result.text && details !== "";
  const characters = [...(structural ? details : result.text)];
  const body = (kept: number) => structural ? [characters.slice(0, kept).join("") + omission(characters.length - kept)] : halves(characters, kept);
  const view = (kept: number) => [label, ...(characters.length ? body(kept) : []), ...(structural ? [] : [marker])].filter(Boolean).join("\n");
  const whole = [label, structural ? details : result.text, structural ? "" : marker].filter(Boolean).join("\n");
  return { floor: view(0), minimum: tokens(view(0)),
    render: (cap) => tokens(whole) <= cap ? whole : view(fit(view, characters.length, cap)) };
}

export { sourceAddresses } from "../store/index.ts";

/** One immutable view of one source entry (ticket 23), used by Noting material, both compaction tiers
 * and branch carry. An entry is a list of parts: at most one natural-text part and one part per tool
 * call. No call id and no native-identity header enters the model-facing text — native identity and
 * lineage stay in storage and in the run's entry audit, and the addresses the Noter cites are the ones
 * the labels carry. Allocation is two-staged: `B` caps each tool part first; if the entry is still
 * over `E`, tool parts give way, shared fairly down to their label-plus-marker minimum; only when they
 * are all at the minimum does the text part yield. Nothing is emitted shorter than a part's minimum
 * and no budget is exceeded to make room: when even the minima cannot fit `E`, the capacity error
 * leaves the entry pending. */
export function renderEntry(entry: SourceEntry, profile: EntryProfile, resultText: ResultExtractor = rawResultText): Rendered {
  const parts: Part[] = [], caps: number[] = [];
  const isResult = entry.role === "toolResult";
  // A user message without text (an image, say) still shows as a source with a marker.
  const text = Boolean(entry.text) || entry.role === "user";
  if (text) { parts.push(textPart(`[Source entry id: T${entry.turnId}#${entry.role === "user" ? "user" : "assistant"}]`,
    entry.text || "[non-text content omitted]")); caps.push(profile.entryTokens); }
  const share = Math.floor(profile.toolCallTokens * (isResult ? 1 - ARGUMENTS_SHARE : ARGUMENTS_SHARE));
  for (const call of entry.calls) {
    const address = `[T${entry.turnId}#t${call.ordinal}] ${call.name}`;
    parts.push(isResult ? resultPart(`${address} ${call.status}`, resultText(call.result ?? "")) : argumentsPart(address, call.input ?? ""));
    caps.push(share);
  }
  const capacity = () => new Error("entry view capacity cannot hold source labels and omission markers");
  // Verified before returning, with the entry against `E` below: no tool part exceeds its share of `B`.
  for (let index = text ? 1 : 0; index < parts.length; index++) if (parts[index]!.minimum > caps[index]!) throw capacity();
  const build = (tool: number, room: number) => parts.map((part, index) =>
    part.render(text && index === 0 ? room : Math.min(caps[index]!, tool))).join("\n");
  const cap = profile.entryTokens;
  let content = build(share, cap);
  if (tokens(content) > cap) {
    content = build(fit((tool) => build(tool, cap), share, cap), cap);
    if (tokens(content) > cap) content = build(0, fit((room) => build(0, room), cap, cap));
    if (tokens(content) > cap) throw capacity();
  }
  return { content, receipts: [] };
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

// The stdout/stderr branch of the explicit Turn preview reads a Claude Code result shape Pi never
// produces, so its three budgets were never effective on Pi and stopped being settings (ticket 23,
// removed-settings table). They keep their 17a values as constants until 23b deletes the branch.
const STDOUT_HEAD_TOKENS = 60, STDOUT_TAIL_TOKENS = 120, STDERR_TAIL_TOKENS = 120;

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
          field("stdout", string(result.stdout), STDOUT_HEAD_TOKENS, STDOUT_TAIL_TOKENS);
          field("stderr", string(result.stderr), 0, STDERR_TAIL_TOKENS);
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

// 21b: the labels ride the metadata line, beside the evidence, so they are never read as conclusion
// prose. One representation for every consumer, the knowledge budget and the search index.
// Labels are shown as a JSON array (review 2026-09-08): a joined list cannot tell ["a, b"] from ["a", "b"].
const topicList = (topics: string[]): string => topics.length ? ` · topics: ${JSON.stringify(topics)}` : "";
export function renderKnowledge({ knowledge, revision: r }: KnowledgeWithRevision, marks: KnowledgeMark[] = []): string {
  return `[K${knowledge.id}@${r.id}] [${r.category}/${r.scope}] ${r.text}${marks.length ? ` · ${marks.map((m) => m.kind).join(", ")}` : ""}\n  supports: ${r.supports.map((id) => `F${id}`).join(", ")}${topicList(r.topics)}`;
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
    ...(JSON.stringify(a.topics) === JSON.stringify(b.topics) ? [] : [`  topics: ${JSON.stringify(a.topics)} -> ${JSON.stringify(b.topics)}`]),
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
    + charge(receipts(kept)) + (receipts(kept).length ? charge(["Receipts:"]) : 0); // the heading `finish` adds is emitted too
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
