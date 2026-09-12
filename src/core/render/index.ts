import { KNOWLEDGE_CATEGORIES } from "../model/index.ts";
import type { KnowledgeRevision, KnowledgeMark, Fact, FactRelation, ToolCall, Turn } from "../model/index.ts";
import { sourceAddresses } from "../store/index.ts";
import { entryAddress, fragmentAddress, sourceBlocks, blockText } from "../model/source.ts";
import type { Selector } from "../model/address.ts";
import type { SourceEntry, KnowledgeWithRevision } from "../store/index.ts";

export interface TurnOptions { tool?: number; full?: boolean; part?: "user" | "assistant" | `t${number}`; selector?: Selector; blocks?: boolean }
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

/** Ticket 30 "One bounded Raw entry view": the three numbers of the one profile. `E` is the most one
 * entry is worth, `C` the most one tool-call part is worth and `R` the most one tool-result part is
 * worth. `C` and `R` are independent allowances, never a combined budget split in half (23c's `B`):
 * room a short call leaves does not enlarge a result, or the other way round. They are configuration,
 * static per installation and never adjusted per batch — views stay immutable and versioned, and an
 * over-full batch is handled by selecting fewer entries. */
export interface EntryProfile { entryTokens: number; toolInputTokens: number; toolResultTokens: number }
/** Ticket 23 "Host contract": one stored tool result as core renders it. The host unwraps its own
 * envelope; core never inspects envelope fields. `details` is the structured data the host dropped,
 * serialized, so this view can state its size — it is never rendered whole except as the fallback for
 * a result with no text at all. */
export interface ResultText { text: string; details?: string }
export type ResultExtractor = (result: string) => ResultText;
/** The default extractor: the stored result string as is. A host with an envelope registers its own. */
export const rawResultText: ResultExtractor = (result) => ({ text: result });

export const ENTRY_VIEW_VERSION = "33-v1-entry-addresses";
// One marker family, Pi's own (`core/compaction/utils.js`: `[... N more characters truncated]`). Every
// omission in a view is this line — a text part, an argument value, a result text, the whole-part floor
// of a sealed call — and the honesty clause "the omitted middle was not inspected" is stated once in
// the Noter prompt instead of being repeated in every marker (23c ruling 3). The run audit's omission
// detection reads this family; `[<type> omitted]` for a non-text block is the host's and is unchanged.
const truncated = (characters: number) => `[... ${characters} characters truncated]`;
const detailsTruncated = (characters: number) => `[... ${characters} characters of details truncated]`;

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

/** One part of an entry: its smallest honest rendering, the rendering it has when no budget cuts it,
 * and its rendering under an allocation. A part is never empty (it always carries its label line) and
 * never shorter than `floor`. `whole` is what a rendering is compared against to know whether the part
 * was cut, which is what earns a call its omission receipt in an explicit `trace` (23b). */
interface Part { floor: string; whole: string; minimum: number; render(cap: number): string }

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

// A `\uXXXX` escape of a surrogate is only half a code point; the pair counts as one unit.
const HIGH_ESCAPE = /^\\u[Dd][89ABab]/, LOW_ESCAPE = /^\\u[Dd][C-Fc-f]/;
/** The units a head or a tail is measured in: whole code points, never half a surrogate pair, and —
 * inside JSON text (`json`) — whole escape sequences, so a cut never splits `\"`, `\\`, `\n` or
 * `\uXXXX` either (23c ruling 2, GPT review 2026-09-09). */
function units(text: string, json: boolean): string[] {
  const list: string[] = [];
  for (let index = 0; index < text.length; ) {
    let length = 1;
    if (json && text[index] === "\\" && index + 1 < text.length) {
      length = text[index + 1] === "u" ? Math.min(6, text.length - index) : 2;
      if (length === 6 && HIGH_ESCAPE.test(text.slice(index, index + 6)) && LOW_ESCAPE.test(text.slice(index + 6, index + 12))) length = 12;
    } else if (text.codePointAt(index)! > 0xFFFF) length = 2;
    list.push(text.slice(index, index + length));
    index += length;
  }
  return list;
}

/** Code points without building an array: the floors below are the only thing the unbounded path
 * renders itself, and it may not split a stored string into characters to do it (23c ruling 4). */
function codePoints(text: string): number {
  let count = 0;
  for (let index = 0; index < text.length; index++, count++) {
    const code = text.charCodeAt(index);
    if (code >= 0xD800 && code < 0xDC00 && index + 1 < text.length && (text.charCodeAt(index + 1) & 0xFC00) === 0xDC00) index++;
  }
  return count;
}

/** One value split into its cut units, with the character count of any run of them available in
 * constant time. `fit` probes a cut many times, so counting what a probe leaves out must not walk it:
 * every unit is one code point unless the value is JSON text, where one escape sequence is one unit of
 * several characters, and only then is a prefix sum built. */
interface Cut { list: string[]; characters: number; between(head: number, tail: number): number }
function cutUnits(text: string, json: boolean): Cut {
  const list = units(text, json);
  if (!json) return { list, characters: list.length, between: (head, tail) => list.length - head - tail };
  const prefix = new Array<number>(list.length + 1);
  prefix[0] = 0;
  for (let index = 0; index < list.length; index++) prefix[index + 1] = prefix[index]! + codePoints(list[index]!);
  return { list, characters: prefix[list.length]!, between: (head, tail) => prefix[list.length - tail]! - prefix[head]! };
}

/** The head and the tail of `kept` units in equal halves, and how many characters stand between them. */
function halves(cut: Cut, kept: number): { head: string; tail: string; omitted: number } {
  const head = Math.ceil(kept / 2), tail = kept - head;
  return { head: cut.list.slice(0, head).join(""), tail: tail ? cut.list.slice(cut.list.length - tail).join("") : "",
    omitted: cut.between(head, tail) };
}

/** Pi's line shape with our address as the label: the label, a colon, and the body on the same line,
 * continuing on the following lines as stored (`core/compaction/utils.js`'s `[User]: …`). */
const bodyLine = (label: string, body: string) => body ? `${label}: ${body}` : `${label}:`;
/** Natural text: the text as stored, cut head and tail in equal halves when it must yield. Text is
 * not exempt by rule, only by size (23). */
const textFloor = (label: string, body: string) => body ? `${label}:\n${truncated(codePoints(body))}` : bodyLine(label, body);
function textPart(label: string, body: string): Part {
  const cut = cutUnits(body, false);
  const whole = bodyLine(label, body), floor = textFloor(label, body);
  const excerpt = (kept: number) => {
    if (kept >= cut.list.length) return whole;
    if (kept === 0) return floor;
    const { head, tail, omitted } = halves(cut, kept);
    return [bodyLine(label, head), truncated(omitted), tail].filter((line) => line !== "").join("\n");
  };
  return { floor, whole, minimum: tokens(floor),
    render: (cap) => tokens(whole) <= cap ? whole : excerpt(fit(excerpt, cut.list.length, cap)) };
}

/** One argument of a tool call as it renders (23c ruling 1): `key=<JSON>`, in stored key order, so a
 * value's boundary is never ambiguous. A key that is not a plain identifier is JSON-quoted, so
 * `{"a=\"x\", b": 1}` can never read as two arguments. `quoted` marks a string value: it is cut on its
 * raw code points and each half is JSON-encoded separately, so no escape sequence is ever split.
 * `json` marks a value rendered as its compact JSON text: cutting that text leaves something that is
 * no longer valid JSON, but it is marked as such, and the cut still falls outside every escape
 * sequence and surrogate pair of the strings nested in it. A payload that is not a JSON object is one
 * nameless item, the stored text as it is. */
interface Item { name: string; text: string; json: boolean; quoted: boolean }
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const encode = (item: Item, text: string) => item.name + (item.quoted ? JSON.stringify(text) : text);
function items(input: string): Item[] {
  const values = object(input);
  if (values) return Object.keys(values).map((key) => {
    const name = `${IDENTIFIER.test(key) ? key : JSON.stringify(key)}=`, value = values[key];
    return typeof value === "string" ? { name, text: value, json: false, quoted: true }
      : { name, text: JSON.stringify(value) ?? "null", json: true, quoted: false };
  });
  // A payload that is valid JSON but not an object (review 2026-09-09): a root string is cut on its
  // raw code points and re-encoded like any string value; an array, number, boolean or null is its
  // compact JSON text with escape-safe cut units. Only text that is not JSON at all is raw.
  const root = parsed(input);
  if (root !== undefined) return typeof root === "string" ? [{ name: "", text: root, json: false, quoted: true }]
    : [{ name: "", text: JSON.stringify(root) ?? "null", json: true, quoted: false }];
  return input ? [{ name: "", text: input, json: false, quoted: false }] : [];
}
/** The stored payload parsed as JSON, or undefined when it is not JSON (an empty payload included). */
function parsed(text: string): unknown {
  if (!text) return undefined;
  try { return JSON.parse(text); } catch { return undefined; }
}
const argumentsWhole = (label: string, list: Item[]): string =>
  `${label}(${list.map((item) => encode(item, item.text)).join(", ")})`;
/** The whole-part floor of a sealed or starved call: what was called, and one marker for everything
 * its arguments left out (23c ruling 3). */
const argumentsFloor = (label: string, list: Item[]): string => list.length
  ? `${label}(...)\n${truncated(list.reduce((total, item) => total + codePoints(item.text), 0))}`
  : argumentsWhole(label, list);

/** A tool call: one line, `[T<n>#t<k>] <name>(<key>=<JSON>, <key>=<JSON>)`. A value that fits its fair
 * share of the part's budget is rendered whole; one that does not is cut head and tail in equal halves
 * with the marker between, so a target path after a long content string still appears. */
function argumentsPart(label: string, input: string): Part {
  const list = items(input);
  const parts = list.map((item) => ({ item, units: cutUnits(item.text, item.json) }));
  const cut = (part: typeof parts[number], kept: number) => {
    if (kept >= part.units.list.length) return encode(part.item, part.item.text);
    const { head, tail, omitted } = halves(part.units, kept);
    return encode(part.item, head) + truncated(omitted) + (tail ? (part.item.quoted ? JSON.stringify(tail) : tail) : "");
  };
  const whole = argumentsWhole(label, list), floor = argumentsFloor(label, list);
  return { floor, whole, minimum: tokens(floor), render(cap) {
    if (tokens(whole) <= cap) return whole;
    const costs = parts.map((part) => tokens(cut(part, part.units.list.length)));
    // The frame — the label, its brackets and one separator per argument — is charged with the part.
    const shares = fairShares(cap - tokens(`${label}()`) - parts.length, costs);
    const view = `${label}(${parts.map((part, index) => cut(part, shares[index]! >= costs[index]! ? part.units.list.length
      : fit((kept) => cut(part, kept), part.units.list.length, shares[index]!))).join(", ")})`;
    return tokens(view) <= cap ? view : floor;
  } };
}

/** A tool result: the label line with the call's status, and the host-extracted text cut head and
 * tail. Structured data the host dropped is marked with its size; when the text is empty, the head of
 * that data's compact JSON stands in for the marker, so a tool that answers only structurally is not
 * shown as blank (23). */
const structuralResult = (result: ResultText) => !result.text && (result.details ?? "") !== "";
/** The whole rendering of one result part, the unbounded path's own line and the budgeted path's
 * uncut answer: one shape, so `full` and a view under a budget never disagree about the bytes. */
function resultWhole(label: string, result: ResultText): string {
  const details = result.details ?? "", structural = structuralResult(result);
  return [bodyLine(label, structural ? details : result.text),
    ...(details && !structural ? [detailsTruncated(codePoints(details))] : [])].join("\n");
}
function resultFloor(label: string, result: ResultText): string {
  const details = result.details ?? "", structural = structuralResult(result);
  const text = structural ? details : result.text;
  if (!text) return resultWhole(label, result);
  return [structural ? bodyLine(label, truncated(codePoints(text))) : `${label}:\n${truncated(codePoints(text))}`,
    ...(details && !structural ? [detailsTruncated(codePoints(details))] : [])].join("\n");
}
function resultPart(label: string, result: ResultText): Part {
  const details = result.details ?? "", structural = structuralResult(result);
  const marker = details && !structural ? [detailsTruncated(codePoints(details))] : [];
  const cut = cutUnits(structural ? details : result.text, structural);
  const whole = resultWhole(label, result), floor = resultFloor(label, result);
  const view = (kept: number) => {
    if (kept >= cut.list.length) return whole;
    if (kept === 0) return floor;
    // Structural data stands in for the text: the head of its compact JSON, and no tail to speak of.
    if (structural) return bodyLine(label, cut.list.slice(0, kept).join("") + truncated(cut.between(kept, 0)));
    const { head, tail, omitted } = halves(cut, kept);
    return [bodyLine(label, head), truncated(omitted), tail, ...marker].filter((line) => line !== "").join("\n");
  };
  return { floor, whole, minimum: tokens(floor),
    render: (cap) => tokens(whole) <= cap ? whole : view(fit(view, cut.list.length, cap)) };
}

export { sourceAddresses };

/** A user message without text (an image, say) still shows as a source with a marker; an assistant
 * entry with no text of its own (thinking only) shows no natural-text part at all. */
const speaks = (entry: SourceEntry) => Boolean(entry.text) || entry.role === "user";
/** Legacy display addresses, not source membership metadata or new-fact authority. An image-only
 * user message remains readable with a placeholder at #user but is not evidence. Thinking-only entries
 * have no legacy text projection; explicit @thinking reads use persisted blocks instead. */
export const displayedAddresses = (entry: SourceEntry): string[] => [
  ...(speaks(entry) ? [`T${entry.turnId}#${entry.role === "user" ? "user" : "assistant"}`] : []),
  ...entry.calls.map((call) => `T${entry.turnId}#t${call.ordinal}`),
];

/** How one part of an entry is treated by the caller that asked for the entry (23b `trace` assembly).
 * `render` is the ordinary budgeted rendering; `floor` seals a part at its label line and its omission
 * marker, whatever its size, which is what an unselected call keeps; `drop` leaves it out entirely,
 * which is what a read of one source part (`T7#t3`) does to the entry's other parts. */
export type PartChoice = "render" | "floor" | "drop";
/** A rendered entry, plus the ordinals of the tool calls whose part was not rendered whole. The
 * ordinals are what an explicit `trace` turns into its per-call omission receipts; every other
 * consumer of the view ignores them, and `receipts` stays empty because the entry view states its own
 * omissions in line, in the `[... N characters truncated]` family the run audit detects. */
export interface EntryView extends Rendered { omitted: number[] }

/** The parts of one entry in native block order, including interleaved text and calls the
 * caller keeps. Both paths below build them here, so the budgeted view and `full` speak the same
 * lines; only the budgeted path builds the `Part` machinery — and its character arrays — around them,
 * which is what makes `full` free of every budget device (23c ruling 4). */
function sourceParts(entry: SourceEntry, resultText: ResultExtractor, choose: (address: string) => PartChoice,
  selector?: Selector): { ordinal: number | null; choice: PartChoice; whole: () => string; floor: () => string; part: () => Part }[] {
  const sources: ReturnType<typeof sourceParts> = [];
  const blocks = sourceBlocks(entry);
  if (blocks.length && blocks.every(block => block.kind === "thinking") && selector?.kind !== "thinking"
    && !selector && choose(`T${entry.turnId}#assistant`) !== "drop") {
    const label = `[${entryAddress(entry)}] assistant`, body = "[thinking omitted]";
    sources.push({ ordinal: null, choice: "render", whole: () => bodyLine(label, body), floor: () => bodyLine(label, body), part: () => textPart(label, body) });
  }
  for (const block of blocks) {
    const tool = block.kind === "call" || block.kind === "result";
    if (block.kind === "thinking" && selector?.kind !== "thinking") continue;
    if (selector?.kind === "thinking" && block.kind !== "thinking") continue;
    if (selector?.kind === "call" && (!tool || block.call.callId !== selector.id)) continue;
    if (selector?.kind === "text" && block.kind !== "text" && block.kind !== "result") continue;
    const legacy = `T${entry.turnId}#${tool ? `t${block.call.ordinal}` : entry.role === "user" ? "user" : "assistant"}`;
    const choice = choose(legacy);
    if (choice === "drop") continue;
    const address = fragmentAddress(entry, block);
    const role = ` ${entry.role}`;
    if ("text" in block) {
      const label = `[${address}]${role}`, body = block.text;
      sources.push({ ordinal: null, choice, whole: () => bodyLine(label, body),
        floor: () => textFloor(label, body), part: () => textPart(label, body) });
    } else {
      const call = block.call, label = `[${address}] ${call.name}`;
      const result = () => selector?.kind === "text" ? { text: blockText(block) } : resultText(call.result ?? "");
      sources.push(block.kind === "result"
        ? { ordinal: call.ordinal, choice, whole: () => resultWhole(`${label} ${call.status}`, result()),
            floor: () => resultFloor(`${label} ${call.status}`, result()),
            part: () => resultPart(`${label} ${call.status}`, result()) }
        : { ordinal: call.ordinal, choice, whole: () => argumentsWhole(label, items(call.input ?? "")),
            floor: () => argumentsFloor(label, items(call.input ?? "")), part: () => argumentsPart(label, call.input ?? "") });
    }
  }
  return sources;
}

/** The unbounded path (23c ruling 4): the same parts, the same line format, no budget at all. It takes
 * no profile and calls no budget function — no cut, no allocation, no character-array split and no
 * token measurement — so a `full` read of a large result copies stored strings as the deleted evidence
 * path did. A sealed part still shows its floor, which is what `tool` selection asks of it. */
export function renderEntryWhole(entry: SourceEntry, resultText: ResultExtractor = rawResultText,
  choose: (address: string) => PartChoice = () => "render", selector?: Selector): EntryView {
  const sources = sourceParts(entry, resultText, choose, selector);
  return { receipts: [], content: sources.map((source) => source.choice === "floor" ? source.floor() : source.whole()).join("\n"),
    omitted: sources.filter((source) => source.ordinal !== null && source.choice === "floor").map((source) => source.ordinal!) };
}

/** One immutable view of one source entry (ticket 23, one profile since 30), used by Noting material,
 * compaction, branch carry and the explicit `trace` assembly. An entry is a list of parts: at most one
 * ordered text/call/result blocks. Exact labels include opaque call IDs, while native message
 * identity and lineage stay in storage and in the run's entry audit. The
 * addresses the Noter cites are the ones the labels carry. Allocation is staged (30 "Rendering
 * contract"): each tool part is capped first by its own allowance, `C` for a call and `R` for a result,
 * neither borrowed from the other; if the entry is still over `E`, result payloads give way first,
 * then call arguments, each shared fairly down to their label-plus-marker minimum, and only then does
 * the text part yield. Nothing is emitted shorter than a part's minimum and no budget is exceeded to
 * make room: when even the minima cannot fit `E`, the capacity error leaves the entry pending. */
export function renderEntry(entry: SourceEntry, profile: EntryProfile, resultText: ResultExtractor = rawResultText,
  choose: (address: string) => PartChoice = () => "render", selector?: Selector, perBlock = false): EntryView {
  const sources = sourceParts(entry, resultText, choose, selector);
  if (!sources.length) return { content: "", receipts: [], omitted: [] };
  const ordinals = sources.map((source) => source.ordinal);
  const isResult = entry.role === "toolResult";
  // A sealed part is rendered at its floor whatever the allocation would allow: an unselected call
  // keeps its label line and its omission marker even when its payload would have fitted.
  const parts = sources.map((source, index) => {
    const part = source.part();
    // Each following part owns its leading separator, inside C/R as well as the whole-entry E.
    const separator = index ? "\n" : "";
    const floor = separator + part.floor, whole = separator + part.whole;
    return { floor, whole, minimum: tokens(floor), render: (cap: number) => source.choice === "floor" ? floor
      : separator + part.render(Math.max(0, cap - tokens(separator))) };
  });
  const toolCap = isResult ? profile.toolResultTokens : profile.toolInputTokens;
  const caps = sources.map(source => source.ordinal === null ? profile.entryTokens : Math.min(toolCap, perBlock ? profile.entryTokens : Infinity));
  const capacity = () => new Error("entry view capacity cannot hold source labels and omission markers");
  // Verified before returning, with the entry against `E` below: no tool part exceeds its own cap.
  for (const [index, part] of parts.entries()) if (Math.min(part.minimum, tokens(part.whole)) > caps[index]!) throw capacity();
  if (perBlock) {
    const rendered = parts.map((part, index) => part.render(caps[index]!));
    if (rendered.some((text, index) => tokens(text) > caps[index]!)) throw capacity();
    return { content: rendered.join(""), receipts: [], omitted: ordinals.filter((ordinal, index) => ordinal !== null && rendered[index] !== parts[index]!.whole) as number[] };
  }
  // The order the entry cap takes room back in (30): results, then calls, then natural text. Parts of
  // equal priority share their stage's allowance through the same per-part allocator as before, and a
  // stage only moves once the one before it is at its floor.
  const stage = (index: number) => ordinals[index] === null ? 2 : isResult ? 0 : 1;
  const cap = profile.entryTokens;
  const maximum = parts.reduce((sum, part) => sum + tokens(part.whole) + part.minimum, 0);
  const rooms = [profile.toolResultTokens, profile.toolInputTokens, cap].map(room => Math.min(room, maximum));
  const build = (room: readonly number[]) => parts.map((part, index) => part.render(Math.min(caps[index]!, room[stage(index)]!)));
  let rendered = build(rooms), content = rendered.join("");
  for (let level = 0; level < rooms.length && tokens(content) > cap; level++) {
    rooms[level] = fit((room) => build(rooms.map((value, index) => index === level ? room : value)).join(""), rooms[level]!, cap);
    rendered = build(rooms);
    content = rendered.join("");
  }
  if (tokens(content) > cap) throw capacity();
  return { content, receipts: [],
    omitted: ordinals.filter((ordinal, index) => ordinal !== null && rendered[index] !== parts[index]!.whole) as number[] };
}

/** Ticket 23 "`trace` assembly": an explicit read of a Turn without `full` is that Turn's selected
 * source entries, in path order, each rendered by the entry renderer under the caller's profile. Several
 * assistant messages in one Turn therefore each show, a call with several native result occurrences
 * shows each occurrence, and a sibling branch's entries never appear — the caller's branch selected the
 * entries this assembles (`Store.listSourceEntries`). `tool` selects which call's parts are rendered
 * within their budgets; every other call keeps its label line, its omission marker and the receipt that
 * fetches it whole, which is the metadata 22c preserved. A `#user`, `#assistant` or `#t<n>` suffix
 * reads that one source part and drops the rest. `full` is the same assembly through the unbounded
 * path and the raw extractor (23c ruling 4): the same labels, the stored arguments, result text and
 * `details` uncut. Each selected native occurrence remains its own entry; compression never changes
 * membership. An unbound read can still include both fork results of a shared call. */
export function renderTrace(turn: Turn, entries: SourceEntry[], profile: EntryProfile, options: TurnOptions = {},
  resultText: ResultExtractor = rawResultText): Rendered {
  const part = options.part;
  // A legacy summary is readable, but has no native entry or source address. Never route it
  // through Raw rendering, which would fabricate a citable-looking identity.
  if (turn.kind === "compaction" && turn.assistantText !== null && !options.selector && !options.blocks
    && (!part || part === "assistant")) return { content: renderSemantic(
      `[T${turn.id}] compaction summary (not Raw evidence): `, turn.assistantText, "", options.full ? Infinity : profile.entryTokens), receipts: [] };
  // The check agrees with the parts the assembly displays, not with what a fact may cite (finding 3).
  if (part && !entries.some((entry) => displayedAddresses(entry).includes(`T${turn.id}#${part}`))) throw new Error(`source T${turn.id}#${part} does not exist`);
  const choose = (address: string): PartChoice => {
    const suffix = address.slice(address.indexOf("#") + 1);
    if (part) return suffix === part ? "render" : "drop";
    return options.tool === undefined || !/^t\d+$/.test(suffix) || suffix === `t${options.tool}` ? "render" : "floor";
  };
  const lines = part || options.blocks || options.selector ? [] : [`[S${turn.sessionId}/T${turn.id}] ${turn.startedAt} [${turn.kind}]`];
  const omitted = new Set<string>();
  for (const entry of entries) {
    const view = options.full ? renderEntryWhole(entry, resultText, choose, options.selector) : renderEntry(entry, profile, resultText, choose, options.selector, options.blocks);
    if (view.content) lines.push(view.content);
    for (const ordinal of view.omitted) {
      const call = entry.calls.find(call => call.ordinal === ordinal)!;
      omitted.add(fragmentAddress(entry, { kind: entry.role === "toolResult" ? "result" : "call", call }));
    }
  }
  const receipts = omitted.size ? [`T${turn.id}: ${omitted.size} omitted calls (including partial calls)`,
    ...[...omitted].map(address => `expand: trace(${JSON.stringify({ address, itemBudget: null, toolCallBudget: null, toolResultBudget: null })})`)] : [];
  return { content: lines.join("\n"), receipts };
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
    `[... ${last - first} lines, ${[...omitted].length} characters truncated]`, // 23c ruling 3: one marker family
    lines.slice(last).join("")].filter(Boolean).join("\n");
}

/** The stored payload as a JSON object, or null when it is not one — `{}` is an object with nothing
 * in it, and renders as `<name>()`, while a payload that is not JSON at all renders as `<name>(<raw>)`. */
function object(text: string | null): Record<string, unknown> | null {
  try { const value = JSON.parse(text ?? "null"); return value && typeof value === "object" && !Array.isArray(value) ? value : null; }
  catch { return null; }
}
const string = (value: unknown): string => typeof value === "string" ? value : value == null ? "" : JSON.stringify(value);

/** Identity mapping only, never another Raw preview. Fragment labels share persisted source
 * authority with rendering and citations; repeated text blocks need only one index address. */
export function renderEntryIndex(entry: SourceEntry): string {
  const addresses = [...new Set(sourceBlocks(entry).filter(block => block.kind !== "thinking")
    .map(block => fragmentAddress(entry, block)))];
  return `[${entryAddress(entry)}] ${entry.role}: ${addresses.join(", ")}`;
}

/** How a stored run mode reads (ticket 19 "Historical truth"). New work records `fork` (inherited
 * native context) or `subagent` (fresh context). `branch` is the pre-rename spelling and, because
 * the rename came with the cutover, every run that carries it was executed by the deleted
 * request-copy runner, not by an `AgentSession`: the read side says so instead of relabelling it.
 * Stored values are never rewritten — no migration, no bulk update, no rewrite on open or on read. */
export const runMode = (mode: string | null): string =>
  mode === "branch" ? "legacy request-copy execution (branch)" : mode ?? "?";

/** A run record as a human summary; `full` adds the tool rounds and previews of the raw request and response. */
export function renderRun(run: { id: number; kind: string; outcome: string; sessionId: number | null; branch: string | null; rangeFrom: string | null; rangeTo: string | null; model: string | null; mode: string | null; request: string | null; response: string | null; origin?: { readonly sessionId: number; readonly entryIds: readonly number[] } | null; createdAt: string },
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
    `  trigger origin: ${run.origin ? `S${run.origin.sessionId}/E[${run.origin.entryIds.join(",")}]` : "unknown"}`,
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

/** Trace-only content ceiling. Automatic facts/knowledge leave this unbounded; identity and
 * evidence metadata are never truncated to make a semantic body appear complete. */
export function renderSemantic(prefix: string, body: string, suffix: string, cap = Infinity, frame: (text: string) => string = text => text): string {
  const whole = frame(prefix + body + suffix);
  if (tokens(whole) <= cap) return whole;
  const cut = cutUnits(body, false);
  const build = (kept: number) => {
    const { head, tail, omitted } = halves(cut, kept);
    return frame(prefix + [head, truncated(omitted), tail].filter(Boolean).join("\n") + suffix);
  };
  if (tokens(build(0)) > cap) throw new Error("semantic item capacity cannot hold identity and evidence metadata");
  return build(fit(build, cut.list.length, cap));
}
export function renderFact(fact: Fact, relations: FactRelation[], cap = Infinity, frame: (text: string) => string = text => text): string {
  const edges = relations.map((r) => r.fromFact === fact.id
    ? `${r.kind} F${r.toFact} ${r.strength}` : `inbound ${r.kind} F${r.fromFact} ${r.strength}`);
  return renderSemantic(`[F${fact.id}] ${fact.createdAt} [${fact.category}/${fact.actor}] ${fact.category === "event" && fact.status ? `${fact.status}: ` : ""}`, fact.text,
    `${edges.length ? ` · ${edges.join(" · ")}` : ""}\n` + [...(fact.quote === null ? [] : [`  quote: ${JSON.stringify(fact.quote)}`]),
      `  source: ${fact.source.join(", ")}`].join("\n"), cap, frame);
}

// 21b: the labels ride the metadata line, beside the evidence, so they are never read as conclusion
// prose. One representation for every consumer, the knowledge budget and the search index.
// Labels are shown as a JSON array (review 2026-09-08): a joined list cannot tell ["a, b"] from ["a", "b"].
const topicList = (topics: string[]): string => topics.length ? ` · topics: ${JSON.stringify(topics)}` : "";
export function renderKnowledge({ knowledge, revision: r }: KnowledgeWithRevision, marks: KnowledgeMark[] = []): string {
  const supportLabel = r.supportSemantics === "change" ? "change supports" : "supports";
  return `[K${knowledge.id}@${r.id}] [${r.category}/${r.scope}] ${r.text}${marks.length ? ` · ${marks.map((m) => m.kind).join(", ")}` : ""}\n  ${supportLabel}: ${r.supports.map((id) => `F${id}`).join(", ") || "none"}${topicList(r.topics)}`;
}

const factAddresses = (ids: number[]): string => ids.map((id) => `F${id}`).join(", ") || "none";
// 21a: commit history carries the authored message; the compact automatic knowledge line does not.
const commitLine = (r: KnowledgeRevision): string =>
  `  K${r.knowledgeId}@${r.id} ${r.op} ${r.createdAt} ${r.supportSemantics === "change" ? "change supports" : "supports"}: ${factAddresses(r.supports)} reason: ${r.reason}`;
export const renderCommitHistory = (revisions: KnowledgeRevision[]): string =>
  revisions.length ? `Commits:\n${revisions.map(commitLine).join("\n")}` : "Commits: none";

export function renderKnowledgeTrace(value: KnowledgeWithRevision, marks: KnowledgeMark[], parents: KnowledgeRevision[], children: KnowledgeRevision[], cap = Infinity,
  effectiveGrounds: number[] = value.revision.supports): string {
  const addresses = (commits: KnowledgeRevision[]) => commits.map(r => `K${r.knowledgeId}@${r.id}`).join(", ") || "none";
  const direct = new Set(value.revision.supports), inherited = effectiveGrounds.filter(id => !direct.has(id));
  const whole = [renderKnowledge(value, marks.filter(m => m.commitId === value.revision.id)),
    ...(value.revision.actorRole ? [`  actor: ${value.revision.actorRole}; run R${value.revision.runId}; ${!value.revision.supports.length ? "maintenance judgment; " : ""}reason: ${value.revision.reason}`] : []),
    ...(value.revision.supportSemantics === "change" ? [`  inherited lineage supports: ${factAddresses(inherited)}`] : []),
    `  parents: ${addresses(parents)}`, `  children: ${addresses(children)}`, commitLine(value.revision)].join("\n");
  const prefix = `[K${value.knowledge.id}@${value.revision.id}] [${value.revision.category}/${value.revision.scope}] `;
  return renderSemantic(prefix, value.revision.text, whole.slice(prefix.length + value.revision.text.length), cap);
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

export function renderKnowledgeDiff(a: KnowledgeRevision, b: KnowledgeRevision, revisions: KnowledgeRevision[], cap = Infinity): string {
  const text = diffText(a.text, b.text), prefix = `[K${a.knowledgeId}@${a.id}..K${b.knowledgeId}@${b.id}]\n  text: `;
  const whole = [prefix + text,
    `  change supports added: ${factAddresses([...new Set(b.supports)].filter((id) => !a.supports.includes(id)))}`,
    `  change supports removed: ${factAddresses([...new Set(a.supports)].filter((id) => !b.supports.includes(id)))}`,
    ...(a.category === b.category ? [] : [`  category: ${a.category} -> ${b.category}`]),
    ...(a.scope === b.scope ? [] : [`  scope: ${a.scope} -> ${b.scope}`]),
    ...(a.reason === b.reason ? [] : [`  reason: ${a.reason} -> ${b.reason}`]),
    ...(JSON.stringify(a.topics) === JSON.stringify(b.topics) ? [] : [`  topics: ${JSON.stringify(a.topics)} -> ${JSON.stringify(b.topics)}`]),
    renderCommitHistory(revisions)].join("\n");
  return renderSemantic(prefix, text, whole.slice(prefix.length + text.length), cap);
}

export interface NegationStep { fact: Fact; relations: FactRelation[]; depth: number; terminal: boolean }
export function renderNegationWalk(steps: NegationStep[], cap = Infinity): string {
  return steps.map(({ fact, relations, depth, terminal }, index) => renderFact(fact, relations, cap, text =>
    (index ? "\n" : "") + text.split("\n").map(line => "  ".repeat(depth) + line).join("\n")
      + (terminal ? `\n${"  ".repeat(depth + 1)}no later strong negation recorded` : ""))).join("");
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

/** Whole knowledge items within the caller's cap, including category tags and emitted receipts.
 * Required exact versions cannot be omitted. Optional items follow relevance, then category/time/id;
 * compaction may omit their receipts too rather than spend required overflow on optional framing.
 * No item is rewritten to fit, and omitted items remain stored and traceable. */
export function budgetKnowledge(knowledge: KnowledgeWithRevision[], cap: number, line: (knowledge: KnowledgeWithRevision) => string = renderKnowledge,
  budget = "Knowledge capacity", required?: ReadonlySet<number>,
  priority?: (a: KnowledgeWithRevision, b: KnowledgeWithRevision) => number) {
  // Relevance selects optional whole items before the stable category/time/id tie-break.
  // Required exact versions are retained independently; category grouping is presentation only.
  const ordered = [...knowledge].sort((a, b) => (priority?.(a, b) ?? 0)
    || KNOWLEDGE_CATEGORIES.indexOf(a.revision.category) - KNOWLEDGE_CATEGORIES.indexOf(b.revision.category)
    || a.revision.createdAt.localeCompare(b.revision.createdAt) || a.knowledge.id - b.knowledge.id)
    .map(value => ({ category: value.revision.category, text: line(value), id: value.knowledge.id, commit: value.revision.id }));
  // Compact protects exact unprocessed versions while preserving the same optional priority and
  // renderer. Other consumers retain the original whole-prefix selection and receipt floor.
  const optional = ordered.filter(item => !required?.has(item.commit));
  const sizes = new Map(ordered.map(item => [item.commit, tokens(item.text) + 1]));
  const categoryCosts = new Map(KNOWLEDGE_CATEGORIES.map(category => [category, charge([xmlBlock(category, "")])]));
  const ranks = new Map(optional.map((item, index) => [item.commit, index]));
  const selected = (kept: number) => ordered.filter(item => required?.has(item.commit) || ranks.get(item.commit)! < kept);
  const receipts = (kept: number) => KNOWLEDGE_CATEGORIES.flatMap((category) => {
    const omitted = optional.slice(kept).filter((item) => item.category === category);
    return omitted.length ? [`omitted ${omitted.length} ${category} knowledge; expand: ${expandList(omitted.map((item) => `K${item.id}`))}`] : [];
  });
  const bodyCost = (kept: number) => { const items = selected(kept); return items.length
    ? tokens(xmlBlock("knowledge", "")) + items.reduce((sum, item) => sum + sizes.get(item.commit)!, 0)
      + [...new Set(items.map(item => item.category))].reduce((sum, category) => sum + categoryCosts.get(category)!, 0) : 0; };
  // Optional omission framing cannot spend required overflow. If it cannot fit, omit it too.
  const emittedReceipts = (kept: number) => required && bodyCost(kept) + charge(receipts(kept))
    + (receipts(kept).length ? charge(["Receipts:"]) : 0) > cap ? [] : receipts(kept);
  const cost = (kept: number) => bodyCost(kept) + charge(emittedReceipts(kept))
    + (emittedReceipts(kept).length ? charge(["Receipts:"]) : 0); // the heading `finish` adds is emitted too
  let kept = 0;
  while (kept < optional.length && cost(kept + 1) <= cap) kept++;
  // Omitting another item can lengthen a receipt: recheck the selected optional prefix.
  // Without a required set, the receipt itself is the floor and cannot be dropped to fit.
  while (kept > 0 && cost(kept) > cap) kept--;
  // Required bodies and emitted receipts must fit too; report capacity rather than emit oversize.
  if (cost(kept) > cap) throw new Error(`Knowledge capacity: the omission receipt alone (${cost(kept)} tokens) exceeds ${budget} (${cap})`);
  return { groups: KNOWLEDGE_CATEGORIES.map((category) => ({ category,
    text: selected(kept).filter((item) => item.category === category).map((item) => item.text).join("\n") })),
    receipts: emittedReceipts(kept),
    // 28a "Lending": what this block actually charges, by the same accounting the cap was applied
    // with. The compaction allocator compares it against the other two windows, so it may not
    // re-measure the rendered text with a second, slightly different sum.
    cost: cost(kept),
    // 29a "Renderers return what they kept": the exact commits this block carries, in render order.
    // What the cap above cut is receipted, never listed here — a carrier states what was supplied.
    commits: KNOWLEDGE_CATEGORIES.flatMap(category => selected(kept)
      .filter(item => item.category === category).map(item => item.commit)) };
}

/** Turn start times for the facts being displayed, read once without loading Turn bodies. */
export type FactTurns = ReadonlyMap<number, string>;
const factGroupHeader = (turnId: number, turns: FactTurns): string => {
  const time = turns.get(turnId);
  if (time === undefined) throw new Error(`missing Turn T${turnId} for fact rendering`);
  return `[T${turnId}] ${time} (selected facts)`;
};

/** One representation for injected facts: chronological Turn groups, then ascending fact ids.
 * Group by the owning Turn, not each citation: a multi-Turn fact appears once with all sources.
 * Each returned item is still one complete fact; the first in a group carries its heading so callers
 * can keep counting facts and charging the strings they actually send. No complete-Turn claim. */
export function factGroupLayout<T extends Pick<Fact, "id" | "turnId">>(facts: readonly T[], turns: FactTurns): { fact: T; header: string }[] {
  const groups = new Map<number, T[]>();
  for (const fact of facts) {
    const group = groups.get(fact.turnId);
    if (group) group.push(fact); else groups.set(fact.turnId, [fact]);
  }
  const ordered = [...groups].map(([id, group]) => ({ id, group, header: factGroupHeader(id, turns), time: Date.parse(turns.get(id)!) }));
  // Native times are ISO timestamps; legacy/unknown times stay explicit and sort last, by Turn id.
  ordered.sort((a, b) => (Number.isFinite(a.time) ? a.time : Infinity) - (Number.isFinite(b.time) ? b.time : Infinity) || a.id - b.id);
  return ordered.flatMap(({ group, header }) => group.sort((a, b) => a.id - b.id)
    .map((fact, index) => ({ fact, header: index === 0 ? `${header}\n` : "" })));
}
export function renderFactGroups(facts: readonly Fact[], line: (fact: Fact, frame: (text: string) => string) => string, turns: FactTurns, preview = false): string[] {
  return factGroupLayout(facts, turns).map(({ fact, header }, index) => preview
    // The enclosing list emits the separator; measure it with its owning item before removing it.
    ? line(fact, text => (index ? "\n" : "") + header + text).slice(index ? 1 : 0)
    : header + line(fact, text => text));
}

/** Selection follows the caller's history priority, not display order. Charge each group heading
 * once as well as every whole fact; only then reorder the selected subset for presentation. */
export function budgetFacts(facts: Fact[], line: (fact: Fact) => string, remaining: number, turns: FactTurns) {
  let used = 0;
  const selected: Fact[] = [], seen = new Set<number>(), lines = new Map<number, string>();
  for (const fact of facts) {
    const text = line(fact);
    const heading = seen.has(fact.turnId) ? 0 : tokens(`${factGroupHeader(fact.turnId, turns)}\n`);
    const cost = tokens(text) + 1 + heading;
    if (used + cost > remaining) break;
    selected.push(fact); lines.set(fact.id, text); seen.add(fact.turnId); used += cost;
  }
  let recent = renderFactGroups(selected, fact => lines.get(fact.id)!, turns);
  // Verify the actual grouped strings too: framing is never free, nor may a different joined
  // representation rely solely on an independently summed estimate. Trim only the priority tail.
  while (selected.length && charge(recent) > remaining) {
    selected.pop(); recent = renderFactGroups(selected, fact => lines.get(fact.id)!, turns);
  }
  const dropped = facts.length - selected.length;
  // 29a: `factIds` is read after the trim loop above, so it is what this block really carries.
  return { recent, factIds: selected.map((f) => f.id),
    receipts: dropped ? [`omitted ${dropped} older facts; expand: ${expandList(facts.slice(selected.length).map((f) => `F${f.id}`))}`] : [] };
}

// Tags delimit blocks for the model; the lines inside are trace lines byte for byte, never escaped.
export const xmlBlock = (tag: string, text: string): string => `<${tag}>\n${text}\n</${tag}>`;
export const renderKnowledgeBlock = (groups: { category: string; text: string }[]): string => {
  const blocks = groups.filter((g) => g.text).map((g) => xmlBlock(g.category, g.text));
  return blocks.length ? `<knowledge>\n${blocks.join("\n")}\n</knowledge>` : ""; // nothing to inject: no block at all
};
export const listingLine = (text: string): string => text.replaceAll("\n", " ⏎ ");
