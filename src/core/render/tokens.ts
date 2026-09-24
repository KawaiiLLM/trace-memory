// Ticket 82: split out of `index.ts` unchanged (pure move, no behaviour change) so this estimator can
// be bundled on its own. `index.ts` re-exports everything here, so every existing import of `tokens` /
// `tokensJoined` / `JoinedTokens` from `render/index.ts` is unaffected. The reason to split: `index.ts`
// also imports `../store/index.ts` (for `node:sqlite` / `node:crypto`), which a `platform: "neutral"`
// esbuild bundle (the Claude Code preview's function-hooks module, ticket 82 requirement 1) cannot
// resolve — this file has no such import, so anything that only needs token estimation can bundle it
// without pulling the store in.

// Token estimate (no tokenizer dependency). Two weights over character classes cannot price both
// Chinese and English prose at once: the ruled 0.75/0.25 pair under-counted Chinese by 28% and
// over-counted English prose by 46%, and refitting the two constants left the Chinese shortfall at
// 23% (measurement 2026-09-07). So the text is split on whitespace and punctuation runs and each
// segment is priced by its own rule, the shape used by tokenx (github.com/johannschopplich/tokenx,
// MIT), whose ratios are calibrated against OpenAI's o200k_base. Every budget here uses this.
// Two rules are ours, both measured: runs are priced across letter/digit boundaries because this
// project's addresses (F42, T7, K1) are that shape in every line we budget. Long whitespace uses
// bounded estimates calibrated against o200k: 128 horizontal characters or 16 line breaks per token.
// Accuracy over the recorded corpora of this project's own text: 7.6% mean absolute error, at worst 15% under
// and 19% over. Over-counting is the safe
// direction for a budget. core/render/index.test.ts pins the bound against recorded true counts.
const PUNCTUATION = /[.,!?;(){}[\]<>:/\\|@#$%^&*+=`~_"-]/;
const SPLIT = new RegExp(`(\\s+|${PUNCTUATION.source}+)`);
const NON_ASCII = /[\u0080-￿]/;
const CJK = /[一-鿿㐀-䶿　-ヿ＀-￯⺀-⻿㇀-㇯㈀-㋿㌀-㏿가-힯ᄀ-ᇿ㄰-㆏ꥠ-꥿ힰ-퟿]/;
const DIGITS = /^\d+$/;
const LOWERCASE_WORD = /^[a-z]+$/;
const LETTERS_AND_DIGITS = /^(?=.*[a-z])(?=.*\d)[a-z\d]+$/i;
// Ratios in characters per token; a whole language is priced through the minority of its words that
// carry a diacritic, so each is fitted against running text rather than against the matched segments.
const SCRIPTS: { pattern: RegExp; charsPerToken: number }[] = [
  { pattern: /[äöüßẞ]/i, charsPerToken: 3 },
  { pattern: /[éèêëàâîïôûùüÿçœæáíóúñ]/i, charsPerToken: 4.5 },
  { pattern: /[ąćęłńóśźżěščřžýůúďťň]/i, charsPerToken: 2.5 },
  { pattern: /[а-яё]/i, charsPerToken: 6 },
  { pattern: /[ά-ώ]/i, charsPerToken: 3 },
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

// Both full-string estimation and the incremental counter price these same sub-runs. Pass the
// length rather than rebuilding a string when many empty views merge into one whitespace run.
function whitespaceRunTokens(length: number, newline: boolean, precedingPunctuation: boolean,
  indented: boolean, alone: boolean): number {
  if (newline) return Math.ceil((length - (precedingPunctuation ? 1 : 0)) / 16);
  return length > 1 || indented || alone ? Math.ceil(length / 128) : 0;
}

function whitespaceTokens(segment: string, previous: string, next: string): number {
  let count = 0, context = previous;
  const parts = segment.match(/\n+|[^\S\n]+/g)!;
  for (const part of parts) {
    const newline = part[0] === "\n";
    count += whitespaceRunTokens(part.length, newline, newline && PUNCTUATION.test(context.slice(-1)),
      !newline && context.endsWith("\n"), !newline && parts.length === 1 && !previous && !next);
    context = part;
  }
  return count;
}

function segmentTokens(segment: string, previous: string, next: string): number {
  if (/^\s+$/.test(segment)) return whitespaceTokens(segment, previous, next);
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
  const segments = text.split(SPLIT).filter(Boolean);
  for (const [index, segment] of segments.entries()) {
    total += segmentTokens(segment, previous, segments[index + 1] ?? "");
    previous = segment;
  }
  return total;
};

const wholeRun = (pattern: RegExp) => new RegExp(`^(?:${pattern.source})+$`);
const PUNCTUATION_RUN = wholeRun(PUNCTUATION);
// Split whitespace into the same sub-runs whitespaceTokens prices. Consecutive empty entry
// views then grow a length, not a string that must be scanned again at every opportunity.
const JOINED_SPLIT = new RegExp(`(\\n+|[^\\S\\n]+|${PUNCTUATION.source}+)`);
const segmentClass = (segment: string): 0 | 1 | 2 | 3 => segment[0] === "\n" ? 0
  : /^\s+$/.test(segment) ? 1 : PUNCTUATION_RUN.test(segment) ? 2 : 3;

interface TokenSegment {
  kind: 0 | 1 | 2 | 3;
  text: string;
  length: number;
  charge: number;
  previous?: TokenSegment;
  next?: TokenSegment;
}

/** Exact token count for an appended string with removable leading characters. Whitespace uses
 * the same newline/horizontal sub-run pricing as tokens(); all other segments match tokens().
 * Charges depend only on adjacent runs. Whitespace is stored as lengths, so empty-view separators
 * never trigger quadratic rescanning or retain an ever-growing string. */
export class JoinedTokens {
  #first?: TokenSegment;
  #last?: TokenSegment;
  #total = 0;
  #length = 0;
  #refresh(segment: TokenSegment | undefined): void {
    if (!segment) return;
    this.#total -= segment.charge;
    segment.charge = segment.kind <= 1
      ? whitespaceRunTokens(segment.length, segment.kind === 0, segment.previous?.kind === 2,
        segment.previous?.kind === 0, !segment.previous && !segment.next)
      : segmentTokens(segment.text, "", "");
    this.#total += segment.charge;
  }
  add(text: string): void {
    this.#length += text.length;
    for (const part of text.split(JOINED_SPLIT).filter(Boolean)) {
      const kind = segmentClass(part);
      if (this.#last?.kind === kind) {
        this.#last.length += part.length;
        if (kind >= 2) this.#last.text += part;
        this.#refresh(this.#last.previous);
        this.#refresh(this.#last);
      } else {
        const segment: TokenSegment = { kind, text: kind >= 2 ? part : "", length: part.length,
          charge: 0, previous: this.#last };
        if (this.#last) this.#last.next = segment;
        else this.#first = segment;
        this.#last = segment;
        this.#refresh(segment.previous);
        this.#refresh(segment);
      }
    }
  }
  removePrefix(length: number): void {
    if (!Number.isSafeInteger(length) || length < 0 || length > this.#length) throw new RangeError("invalid token prefix length");
    this.#length -= length;
    while (length && this.#first) {
      const segment = this.#first;
      if (length < segment.length) {
        this.#total -= segment.charge;
        segment.charge = 0;
        segment.length -= length;
        if (segment.kind >= 2) segment.text = segment.text.slice(length);
        length = 0;
        break;
      }
      length -= segment.length;
      this.#total -= segment.charge;
      this.#first = segment.next;
      if (this.#first) this.#first.previous = undefined;
      else this.#last = undefined;
    }
    this.#refresh(this.#first);
    this.#refresh(this.#first?.next);
  }
  get count(): number { return this.#total; }
}

/** Exact tokens of `parts.join(separator)`, tokenizing each part once instead of re-tokenizing the
 * whole growing prefix. See `JoinedTokens` for why this is exact, not merely additive. */
export function tokensJoined(parts: readonly string[], separator: string): number {
  const counter = new JoinedTokens();
  parts.forEach((part, index) => { if (index) counter.add(separator); counter.add(part); });
  return counter.count;
}
