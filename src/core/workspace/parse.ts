// The workspace file format (ticket 144, Stage 2): one Markdown block form for every file a Noting or
// Dreaming task writes. A block is a heading `## <op> [<target>]`, `key: value` lines, a blank line and a body
// that runs to the next `## ` heading. A `split` block also holds `### child` sections of the same shape.
// Parsing is purely syntactic; `check.ts` decides what each task may write.

export interface WorkspaceFile { name: string; text: string }

export interface Field { value: string; line: number }

/** The fields and body shared by a block and a split child. */
export interface Section { fields: Map<string, Field>; body: string; line: number }

export interface Block extends Section {
  /** 1-based position among the file's blocks. */
  index: number;
  op: string;
  /** The heading text after the operation, possibly empty. */
  target: string;
  children: Section[];
}

export interface Parsed { blocks: Block[]; problems: string[] }

const FIELD = /^([a-z][a-z_]*):[ \t]*(.*)$/;

/** `name:LINE: block N `## heading`: message`, so a reader can find the place and know what was expected. */
export const describeBlock = (block: Pick<Block, "index" | "op" | "target">): string =>
  `block ${block.index} \`## ${[block.op, block.target].filter(Boolean).join(" ")}\``;
export const problem = (file: WorkspaceFile, line: number, where: string, message: string): string =>
  `${file.name}:${line}: ${where}: ${message}`;

/** Split the lines of one section into fields (up to the first blank line) and the body after it. */
function section(file: WorkspaceFile, where: string, first: number, lines: string[], problems: string[]): Section {
  const fields = new Map<string, Field>();
  let last = lines.length - 1;
  while (last >= 0 && !lines[last]!.trim()) last--;
  const verdict = last < 0 ? null : /^verdict:[ \t]*(.*)$/.exec(lines[last]!);
  if (verdict) {
    fields.set("verdict", { value: verdict[1]!.trim(), line: first + last });
    lines = lines.slice(0, last);
  }
  let at = 0;
  for (; at < lines.length && lines[at]!.trim(); at++) {
    const match = FIELD.exec(lines[at]!);
    const line = first + at;
    if (!match) {
      problems.push(problem(file, line, where, `expected a \`key: value\` line or a blank line before the body, got "${lines[at]!.slice(0, 60)}"`));
      break;
    }
    if (fields.has(match[1]!)) problems.push(problem(file, line, where, `field \`${match[1]}\` is written twice`));
    else fields.set(match[1]!, { value: match[2]!.trim(), line });
  }
  const body = lines.slice(at).join("\n").trim();
  return { fields, body, line: first };
}

export function parseBlocks(file: WorkspaceFile): Parsed {
  const problems: string[] = [];
  const blocks: Block[] = [];
  const lines = file.text.split(/\r?\n/);
  // Each section is the run of lines between two headings; collect them first, then split fields from body.
  type Raw = { block: Block | null; heading: string; line: number; lines: string[]; child: boolean };
  const raws: Raw[] = [];
  let current: Raw | undefined, owner: Block | null = null;
  lines.forEach((text, i) => {
    const line = i + 1;
    if (text.startsWith("## ") || text === "##") {
      const heading = text.slice(2).trim();
      const [op = "", ...rest] = heading.split(/\s+/);
      if (!op) { problems.push(problem(file, line, "heading", "expected `## <operation>`")); current = undefined; owner = null; return; }
      owner = { index: blocks.length + 1, op, target: rest.join(" "), fields: new Map(), body: "", line, children: [] };
      blocks.push(owner);
      current = { block: owner, heading, line: line + 1, lines: [], child: false };
      raws.push(current);
    } else if (text.startsWith("### ") || text === "###") {
      const name = text.slice(3).trim();
      if (!owner) { problems.push(problem(file, line, "heading", "a `###` section must follow a `## split` block")); return; }
      if (name !== "child") problems.push(problem(file, line, describeBlock(owner), `expected \`### child\`, got \`### ${name}\``));
      current = { block: owner, heading: name, line: line + 1, lines: [], child: true };
      raws.push(current);
    } else if (current) current.lines.push(text);
    else if (text.trim()) problems.push(problem(file, line, "start of file", "expected a `## <operation>` heading before any text"));
  });
  for (const raw of raws) {
    const where = describeBlock(raw.block!);
    const parsed = section(file, raw.child ? `${where} child` : where, raw.line, raw.lines, problems);
    if (raw.child) raw.block!.children.push(parsed);
    else Object.assign(raw.block!, { fields: parsed.fields, body: parsed.body });
  }
  if (!blocks.length && !problems.length)
    problems.push(problem(file, 1, "file", "empty file: write `## none` when there is nothing to write"));
  return { blocks, problems };
}

export interface ScoreLine { knowledgeId: number; score: number; line: number }

/** A classify file: no blocks, one `K<id> <score>` line per item, the score an integer from 1 to 100. */
export function parseScores(file: WorkspaceFile): { scores: ScoreLine[]; problems: string[] } {
  const scores: ScoreLine[] = [], problems: string[] = [];
  file.text.split(/\r?\n/).forEach((text, i) => {
    if (!text.trim()) return;
    const match = /^K([1-9]\d*)[ \t]+(\d+)$/.exec(text.trim());
    if (!match) { problems.push(problem(file, i + 1, "score line", `expected \`K<id> <score>\`, got "${text.trim().slice(0, 60)}"`)); return; }
    const score = Number(match[2]);
    if (score < 1 || score > 100) problems.push(problem(file, i + 1, `score line K${match[1]}`, `the score must be an integer from 1 to 100, got ${score}`));
    else scores.push({ knowledgeId: Number(match[1]), score, line: i + 1 });
  });
  return { scores, problems };
}
