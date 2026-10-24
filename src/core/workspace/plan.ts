// Reading a workspace file against the Store (ticket 144, Stage 2): which blocks a task may write, the fields each
// needs, the references that must resolve and the caps. `plan` builds, for every block, the Store operation
// `apply` will publish, so the check and the publication share one reading. Field validation and the caps are
// the memory tool's (`prepareMemory`), and fact validation is `note`'s (`factValidator`); this file adds only
// what the file format itself introduces.

import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { factValidator, frozenTurnIds, notingSources } from "../api/tools.ts";
import { prepareMemory, overLimit } from "../knowledge-write/prepare.ts";
import { isKnowledgeCategory, substantiveArchiveStatement, validateNotingFact, KNOWLEDGE_CATEGORIES, type KnowledgeRevision } from "../model/index.ts";
import { parseKnowledgeAddress, parseTurnAddress } from "../model/address.ts";
import { words, wordLimit } from "../render/index.ts";
import type { FactCommitInput, KnowledgeOperationInput, KnowledgePath, RunInput, Store } from "../store/index.ts";
import { describeBlock, parseBlocks, problem, type Block, type Section, type WorkspaceFile } from "./parse.ts";
import { allowedRoots } from "../dreaming/roots.ts";
import { codeAddress, resolveCodeLink } from "../dreaming/code-links.ts";

export type TaskKind = "noting-facts" | "noting-knowledge" | "curate";

/** The frozen batch a Noting task writes about: the same range and entries the Noter's tools are bound to. */
export interface NotingScope { sessionId: number; branch: string; range: { from: string; to: string }; entryIds?: readonly number[] }

export type WorkspaceTask =
  | { kind: "noting-facts"; scope: NotingScope; file: WorkspaceFile; checked?: boolean }
  /** `facts` is the run's facts file; its labels are what `supports:` may cite besides `F<id>`. */
  | { kind: "noting-knowledge"; scope: NotingScope; file: WorkspaceFile; facts: WorkspaceFile; checked?: boolean; allowFlags?: boolean }
  /** One pass can update, archive, merge and split, never create. */
  | { kind: "curate"; sessionId: number; path?: KnowledgePath; file: WorkspaceFile };

/** The host-measured length of one title or body in units, whether or not it is over its limit; the limit is the target plus 10% (145). */
export interface Length { block: string; field: "title" | "body"; count: number; target: number; limit: number }
const measured = (block: string, field: Length["field"], count: number, target: number): Length => ({ block, field, count, target, limit: wordLimit(target) });

export interface CheckResult { ok: boolean; problems: string[]; lengths: Length[] }

/** One block's Store operation, built when the file is read and again at publication with the fact ids known. */
export interface PlannedBlock {
  block: Block;
  /** `mapping` (label position to fact id) is given at publication and absent while checking. Problems are already formatted. */
  make(mapping?: ReadonlyMap<number, number>): { operation?: KnowledgeOperationInput; problems: string[] };
}

export interface Plan {
  problems: string[];
  lengths: Length[];
  facts: { block: Block; label: string; fact: FactCommitInput }[];
  knowledge: PlannedBlock[];
  flags: { knowledgeId: number; revisionId: number; reason: string }[];
  path?: KnowledgePath;
  sources?: ReturnType<typeof notingSources>;
}

const allowedOps = (task: WorkspaceTask): readonly string[] =>
  task.kind === "noting-facts" ? ["fact"] : task.kind === "noting-knowledge" ? ["create", "update", ...(task.allowFlags ? ["flag"] : [])] : task.kind === "curate" ? ["update", "archive", "merge", "split"] : [];

const FIELDS: Record<string, readonly string[]> = {
  fact: ["title", "objects", "negate", "caused_by", "verdict"],
  create: ["title", "category", "scope", "topics", "supports", "reason"],
  update: ["title", "category", "scope", "topics", "supports", "reason"],
  merge: ["absorb", "title", "category", "scope", "topics", "supports", "reason"],
  split: ["title", "category", "scope", "topics", "supports", "reason"],
  child: ["title", "category", "scope", "topics", "supports", "reason"],
  archive: ["kind", "reason"],
  flag: ["reason", "verdict"],
};
const REQUIRED: Record<string, readonly string[]> = {
  fact: ["title"],
  create: ["title", "category", "scope", "topics", "supports", "reason"],
  update: ["reason"], merge: ["absorb", "reason"], split: ["reason"],
  child: ["title", "category", "scope", "topics", "supports", "reason"],
  archive: ["kind", "reason"],
  flag: ["reason"],
};
const ARCHIVE_KINDS = ["invalid", "inadmissible"] as const;
/** Merging has one form; an archive that names a successor is the old, refused way to say it. */
const USE_MERGE = "to merge an item into another current item, write a `merge` block with `absorb:`";
const VERSION = /^K([1-9]\d*)@v([1-9]\d*)$/;
/** An address the evidence field takes only as `trace://...`: a fact, a version or a Raw turn written bare. */
export const BARE_ADDRESS = /^(?:F[1-9]\d*|K[1-9]\d*(?:@v[1-9]\d*|#\w+)?|S[1-9]\d*(?:\/\S*)?)$/;
export const list = (value: string | undefined): string[] => (value ?? "").split(",").map(item => item.trim()).filter(Boolean);

type Made = { operation?: KnowledgeOperationInput; problems: string[] };
interface Base { knowledgeId: number; ordinal: number; commit: number; revision: KnowledgeRevision }

export function plan(store: Store, task: WorkspaceTask): Plan {
  const out: Plan = { problems: [], lengths: [], facts: [], knowledge: [], flags: [] };
  const { file } = task;
  const parsed = parseBlocks(file);
  out.problems.push(...parsed.problems);
  const noting = task.kind === "noting-facts" || task.kind === "noting-knowledge";
  if (noting) for (const block of parsed.blocks) {
    const verdict = block.fields.get("verdict");
    if (verdict ? !/^(?:ok|(?:edited|reverted) — \S.*)$/.test(verdict.value) : task.checked)
      out.problems.push(problem(file, verdict?.line ?? block.line, describeBlock(block), "expected `verdict: ok`, `verdict: edited — <why>` or `verdict: reverted — <why>` under the block"));
  }
  // `## none` stands alone: one bare line, nothing beside it and nothing under it that apply would drop silently.
  const none = parsed.blocks.filter(block => block.op === "none");
  for (const block of none) {
    if (block.target || [...block.fields.keys()].some(key => !(noting && key === "verdict")) || block.body || block.children.length)
      out.problems.push(problem(file, block.line, describeBlock(block), "`## none` is the whole block: no target, fields, body or `###` sections"));
  }
  if (none.length && parsed.blocks.length > none.length)
    out.problems.push(problem(file, none[0]!.line, describeBlock(none[0]!), "`## none` must be the only block of the file"));
  else if (none.length > 1) out.problems.push(problem(file, none[1]!.line, describeBlock(none[1]!), "`## none` appears once"));
  const allowed = allowedOps(task);
  for (const block of parsed.blocks) if (block.op !== "none" && !allowed.includes(block.op))
    out.problems.push(problem(file, block.line, describeBlock(block), `\`## ${block.op}\` is not allowed in a ${task.kind} file; allowed: ${allowed.map(op => `\`${op}\``).join(", ")}, or \`## none\``));
  const blocks = parsed.blocks.filter(block => allowed.includes(block.op) && !(noting && block.fields.get("verdict")?.value.startsWith("reverted — ")));
  if (task.kind === "noting-facts") planFacts(store, task, blocks, out);
  else planKnowledge(store, task, blocks, out);
  return out;
}

/** The fields a section may and must carry. */
function checkFields(file: WorkspaceFile, section: Section, kind: string, where: string): string[] {
  const allowed = FIELDS[kind]!;
  return [
    ...[...section.fields].filter(([name]) => !allowed.includes(name)).map(([name, field]) =>
      problem(file, field.line, where, `field \`${name}\` is not allowed here; ${kind === "child" ? "a child" : `a \`${kind}\` block`} takes ${allowed.map(f => `\`${f}\``).join(", ")}${kind === "archive" && name === "successor" ? `; ${USE_MERGE}` : ""}`)),
    ...(REQUIRED[kind] ?? []).filter(name => !section.fields.has(name)).map(name => problem(file, section.line, where, `missing required field \`${name}\``)),
  ];
}

function planFacts(store: Store, task: Extract<WorkspaceTask, { kind: "noting-facts" }>, blocks: Block[], out: Plan) {
  const file = task.file;
  const path: KnowledgePath = { sessionId: task.scope.sessionId, headTurnId: Number(task.scope.range.to.split("/T")[1]), branch: task.scope.branch };
  const sources = notingSources(store, path, frozenTurnIds(store, task.scope.sessionId, task.scope.range), task.scope.entryIds);
  const validator = factValidator(store, { sessionId: task.scope.sessionId, noting: true, frozenIds: sources.frozenIds,
    sourceTurns: sources.sourceTurns, initialPath: sources.initialPath });
  out.path = path; out.sources = sources;
  const labels = new Map<string, Block>();
  // A relation may name an existing fact or an earlier label of this file; a label's position stands in for the `$n` handle.
  const position = new Map(blocks.map((block, i) => [block.target, i + 1] as const).reverse());
  for (const block of blocks) {
    const where = describeBlock(block);
    out.problems.push(...checkFields(file, block, "fact", where));
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(block.target)) out.problems.push(problem(file, block.line, where, "expected `## fact <label>` with a label such as `f1`, unique in the file"));
    else if (labels.has(block.target)) out.problems.push(problem(file, block.line, where, `label \`${block.target}\` is already used by ${describeBlock(labels.get(block.target)!)}`));
    else labels.set(block.target, block);
    const title = block.fields.get("title")?.value ?? "";
    // The body is one `[address] text` line per source, the form `note` takes; its length is the sum of its segments.
    const relations: Record<"caused_by" | "negate", string[][]> = { caused_by: [], negate: [] };
    for (const kind of ["caused_by", "negate"] as const) for (const item of list(block.fields.get(kind)?.value)) {
      const match = /^(\S+)\s+(strong|weak)$/.exec(item), target = match?.[1];
      const handle = !target ? undefined : /^F[1-9]\d*$/.test(target) ? target : position.has(target) ? `$${position.get(target)}` : undefined;
      if (handle) relations[kind].push([handle, match![2]!]);
      else out.problems.push(problem(file, block.fields.get(kind)!.line, where, `${kind}: \`${item}\` is not \`<F id or fact label> strong|weak\`; separate relations with commas`));
    }
    const raw = { title, sources: block.body, objects: list(block.fields.get("objects")?.value), ...relations };
    const syntax: string[] = [], shape = validateNotingFact("fact", raw, syntax);
    out.lengths.push(measured(where, "title", words(title), store.writing.titleWords));
    if (shape && !syntax.length)
      out.lengths.push(measured(where, "body", shape.sources.reduce((sum, source) => sum + words(source.text), 0), store.writing.bodyWords));
    if (!block.fields.has("title")) continue; // already reported as missing
    try { out.facts.push({ block, label: block.target, fact: validator.validate(raw, block.index, n => n < (position.get(block.target) ?? 0)) }); }
    // A relation target is reported under the label the file wrote, not the `$n` handle it stands for.
    catch (error) { out.problems.push(problem(file, block.line, where, (error instanceof Error ? error.message : String(error)).replace(/facts\[\d+\]\./g, "")
      .replace(/\$([1-9]\d*)/g, (handle, n) => blocks[Number(n) - 1]?.target ?? handle))); }
  }
}

function planKnowledge(store: Store, task: Exclude<WorkspaceTask, { kind: "noting-facts" }>, blocks: Block[], out: Plan) {
  const file = task.file, noting = task.kind === "noting-knowledge";
  const path: KnowledgePath = noting ? { sessionId: task.scope.sessionId, headTurnId: Number(task.scope.range.to.split("/T")[1]), branch: task.scope.branch }
    : task.path ?? store.knowledgePath(task.sessionId);
  out.path = path;
  const sessionId = path.sessionId;
  // The Noter may cite the facts file's labels; they are numbered by position, as the Noter's `$n` handles were.
  const factBlocks = noting ? parseBlocks(task.facts).blocks.filter(block => block.op === "fact" && !block.fields.get("verdict")?.value.startsWith("reverted — ")) : [];
  const labelOf = new Map(factBlocks.map((block, i) => [block.target, i + 1]));
  const localFacts = new Map(factBlocks.map((block, i) => {
    const bad: string[] = [], shape = validateNotingFact("fact", { title: block.fields.get("title")?.value ?? "", sources: block.body }, bad);
    return [i + 1, { text: shape && !bad.length ? shape.sources.map(source => source.text).join("\n") : "" }] as const;
  }));
  const run: RunInput = { kind: noting ? "noting" : "manual", sessionId, branch: path.branch ?? null, createdAt: new Date().toISOString() };
  const recorded = new Map<number, Block>();

  for (const block of blocks) {
    const where = describeBlock(block);
    const fmt = (line: number, message: string) => problem(file, line, where, message);
    const add = (...messages: string[]) => out.problems.push(...messages);
    const line = (name: string) => block.fields.get(name)?.line ?? block.line;
    const value = (section: Section, name: string) => section.fields.get(name)?.value;
    const missing = (section: Section, kind: string) => (REQUIRED[kind] ?? []).some(name => !section.fields.has(name));
    const fieldBlock = { ...block, fields: new Map([...block.fields].filter(([key]) => key !== "files" && !(noting && key === "verdict"))) };
    add(...checkFields(file, fieldBlock, block.op, where));
    if (noting && block.op !== "flag" && !block.fields.has("files")) add(fmt(block.line, "missing required field `files`"));
    const files = (section: Section): string[] | null | undefined => {
      const raw = value(section, "files");
      if (raw === undefined) return undefined;
      if (raw === "None") return null;
      const paths = list(raw);
      if (!paths.length) add(fmt(line("files"), "files: list code paths or write `None`"));
      const session = store.getSession(sessionId)!;
      const root = session.directory ?? session.startDirectory;
      return paths.map(path => {
        if (task.kind === "curate") {
          const resolved = resolveCodeLink(path, allowedRoots(store, sessionId));
          if ("reason" in resolved) { add(fmt(line("files"), `files: ${resolved.reason}`)); return path; }
          return resolved.path;
        }
        const link = codeAddress(path);
        if (!isAbsolute(link.path) && !root) { add(fmt(line("files"), `files: cannot resolve relative path \`${path}\`: session root is unknown`)); return path; }
        const absolute = isAbsolute(link.path) ? resolve(link.path) : resolve(root!, link.path);
        if (!existsSync(absolute)) add(fmt(line("files"), `files: path does not exist: ${absolute}`));
        return link.symbol === undefined ? absolute : `${absolute}#${link.symbol}`;
      });
    };
    const linkedFiles = files(block);

    const record = (knowledgeId: number, at: number) => {
      const earlier = recorded.get(knowledgeId);
      if (earlier) add(fmt(at, `K${knowledgeId} already has a record in this file (${describeBlock(earlier)}); a file holds at most one record per item, and an absorbed item counts`));
      else recorded.set(knowledgeId, block);
    };
    const base = (ref: string, at: number): Base | null => {
      const match = VERSION.exec(ref.trim());
      if (!match) { add(fmt(at, `\`${ref}\` is not a version address; expected \`K<id>@v<n>\``)); return null; }
      const knowledgeId = Number(match[1]), ordinal = Number(match[2]);
      try {
        const commit = store.resolveVersionOrdinal(knowledgeId, ordinal);
        return { knowledgeId, ordinal, commit, revision: store.getKnowledgeRevision(knowledgeId, commit)! };
      } catch { add(fmt(at, `${ref} does not exist`)); return null; }
    };
    const lengths = (section: Section, label: string) => {
      if (value(section, "title") !== undefined) out.lengths.push(measured(label, "title", words(value(section, "title")!), store.writing.titleWords));
      if (section.body) out.lengths.push(measured(label, "body", words(section.body), store.writing.bodyWords));
    };
    const body = (section: Section, label: string, what = "the complete body") => {
      if (!section.body) add(problem(file, section.line, label, `missing ${what} after the blank line`));
    };
    const tool = (ref: string, mapping?: ReadonlyMap<number, number>) => /^F/.test(ref) ? ref : mapping ? `F${mapping.get(labelOf.get(ref)!)}` : `$${labelOf.get(ref)!}`;
    const supports = (section: Section, label: string, mapping?: ReadonlyMap<number, number>): { refs?: string[]; problems: string[] } => {
      const refs = list(value(section, "supports"));
      const bad = refs.filter(ref => !/^F[1-9]\d*$/.test(ref) && !(noting && labelOf.has(ref)));
      return bad.length ? { problems: bad.map(ref => problem(file, section.fields.get("supports")!.line, label,
        noting ? `supports \`${ref}\` is neither an F<id> nor a fact label of the facts file` : `supports \`${ref}\` is not an F<id> (only the Noter has fact labels)`)) }
        : { refs: refs.map(ref => tool(ref, mapping)), problems: [] };
    };
    /** The memory tool's own validation of one update-like or create-like piece, as a Store operation. */
    const piece = (raw: Record<string, unknown>, label: string, at: number, prefix: string, mapping?: ReadonlyMap<number, number>, inherits = false): Made => {
      const result = prepareMemory(store, sessionId, { operations: [raw], skipped: [] }, run, path, undefined,
        mapping || !noting ? undefined : localFacts, undefined, inherits);
      const rejected = result.results[0]!;
      return rejected.startsWith("rejected: ") ? { problems: [problem(file, at, label, `${prefix}${rejected.slice("rejected: ".length)}`)] }
        : { operation: result.operations[0]!, problems: [] };
    };
    /** An update of `b` from the block's fields; what it omits is inherited, as `memory update` does. */
    const updateOf = (section: Section, b: Base, label: string, mapping?: ReadonlyMap<number, number>): Made => {
      if (missing(section, "update") || !section.body) return { problems: [] };
      const cited = supports(section, label, mapping);
      if (!cited.refs) return { problems: cited.problems };
      const category = value(section, "category"), scope = value(section, "scope"), topics = value(section, "topics"), title = value(section, "title");
      if (category === undefined && !isKnowledgeCategory(b.revision.category))
        return { problems: [problem(file, section.line, label, `category: the base \`${b.revision.category}\` is a legacy category; supply one of ${KNOWLEDGE_CATEGORIES.join(", ")}`)] };
      return piece({ op: "update", id: `K${b.knowledgeId}#${store.versionTag(b.knowledgeId, b.commit)}`, text: section.body,
        files: linkedFiles === undefined && !noting ? b.revision.files : linkedFiles,
        category: category ?? b.revision.category, scope: scope ?? b.revision.scope, topics: topics === undefined ? b.revision.topics : list(topics),
        supports: cited.refs, reason: value(section, "reason") ?? "", ...(title === undefined ? {} : { title }) }, label, section.line, "", mapping, !noting);
    };
    const createOf = (section: Section, kind: string, label: string, prefix: string, mapping?: ReadonlyMap<number, number>): Made => {
      if (missing(section, kind) || !section.body) return { problems: [] };
      const cited = supports(section, label, mapping);
      if (!cited.refs) return { problems: cited.problems };
      return piece({ op: "create", title: value(section, "title"), text: section.body, category: value(section, "category"), scope: value(section, "scope"),
        files: noting ? linkedFiles : files(section) ?? null,
        topics: list(value(section, "topics")), supports: cited.refs, reason: value(section, "reason") }, label, section.line, prefix, mapping);
    };
    const planned = (entry: Omit<PlannedBlock, "block">) => {
      out.knowledge.push({ block, ...entry });
      add(...entry.make().problems);
    };

    if (block.op === "flag") {
      if (!value(block, "reason")?.trim()) add(fmt(line("reason"), "a flag requires a nonempty reason"));
      // A flag sets status on the item's current visible version, so it names the item, not a base version.
      const current = /^K[1-9]\d*$/.test(block.target) ? store.currentKnowledge(path).find(item => item.knowledge.id === Number(block.target.slice(1)))?.revision : undefined;
      if (!current) add(fmt(block.line, `\`${block.target}\` is not a knowledge item visible to this session; a flag names \`K<id>\``));
      const target = current && { knowledgeId: current.knowledgeId, commit: current.id };
      if (target) {
        record(target.knowledgeId, block.line);
        out.flags.push({ knowledgeId: target.knowledgeId, revisionId: target.commit, reason: value(block, "reason") ?? "" });
      }
      if (block.body || block.children.length) add(fmt(block.line, "a flag takes only a reason line and its verdict"));
    } else if (block.op === "create") {
      lengths(block, where); body(block, where);
      if (block.children.length) add(fmt(block.line, "a `create` block has no `### child` sections"));
      planned({ make: mapping => createOf(block, "create", where, "", mapping) });
    } else if (block.op === "update" || block.op === "merge" || block.op === "split") {
      lengths(block, where); body(block, where);
      if (block.op !== "split" && block.children.length) add(fmt(block.line, `a \`${block.op}\` block has no \`### child\` sections`));
      if (block.op === "split" && !block.children.length) add(fmt(block.line, "a `split` block needs one or more `### child` sections"));
      block.children.forEach((child, i) => {
        const label = `${where} child ${i + 1}`;
        add(...checkFields(file, { ...child, fields: new Map([...child.fields].filter(([key]) => key !== "files")) }, "child", label));
        body(child, label, "the child's complete body");
        lengths(child, label);
      });
      const primary = base(block.target, block.line);
      if (!primary) continue;
      record(primary.knowledgeId, block.line);
      const absorbed: Base[] = [];
      if (block.op === "merge") {
        const refs = list(value(block, "absorb"));
        if (block.fields.has("absorb") && !refs.length) add(fmt(line("absorb"), "absorb is empty; list one or more other items as `K<id>@v<n>`"));
        for (const ref of refs) {
          const b = base(ref, line("absorb"));
          if (!b) continue;
          if (b.knowledgeId === primary.knowledgeId) { add(fmt(line("absorb"), `K${b.knowledgeId} cannot absorb itself`)); continue; }
          record(b.knowledgeId, line("absorb"));
          absorbed.push(b);
          for (const field of ["category", "scope"] as const) {
            const given = value(block, field);
            if (b.revision[field] !== primary.revision[field] || (given !== undefined && given !== primary.revision[field]))
              add(fmt(line("absorb"), `merged items share one ${field}: K${primary.knowledgeId}@v${primary.ordinal} is \`${primary.revision[field]}\`, K${b.knowledgeId}@v${b.ordinal} is \`${b.revision[field]}\`${given !== undefined && given !== primary.revision[field] ? `, the result says \`${given}\`` : ""}; change a category with an update in an earlier run first`));
          }
        }
      }
      planned({ make: mapping => {
        const head = updateOf(block, primary, where, mapping);
        if (head.operation?.op !== "update") return { problems: head.problems };
        const { op: _op, knowledgeId, baseCommit, ...content } = head.operation;
        if (block.op === "update") return { operation: head.operation, problems: [] };
        if (block.op === "merge") return { problems: [], operation: { ...content, op: "merge", intoKnowledgeId: knowledgeId, intoBaseCommit: baseCommit,
          absorb: absorbed.map(b => ({ knowledgeId: b.knowledgeId, baseCommit: b.commit })) } };
        const children: Extract<KnowledgeOperationInput, { op: "split" }>["children"] = [], found: string[] = [];
        block.children.forEach((child, i) => {
          const made = createOf(child, "child", `${where} child ${i + 1}`, `child ${i + 1}: `, mapping);
          if (made.operation?.op !== "create") { found.push(...made.problems); return; }
          const c = made.operation;
          children.push({ title: c.title, text: c.text, category: c.category, topics: c.topics, files: c.files ?? null, scope: c.scope, supports: c.supports, reason: c.reason });
        });
        return found.length || children.length !== block.children.length ? { problems: found }
          : { problems: [], operation: { ...content, op: "split", knowledgeId, baseCommit, children } };
      } });
    } else if (block.op === "archive") {
      lengths(block, where);
      if (!block.body) add(fmt(block.line, "missing the archive explanation after the blank line"));
      else if (!substantiveArchiveStatement(block.body)) add(fmt(block.line, "the archive explanation must state the grounds and the evidence, not a bare status"));
      else if (words(block.body) > wordLimit(store.writing.bodyWords)) add(fmt(block.line, overLimit("body", words(block.body), store.writing.bodyWords)));
      const kind = value(block, "kind");
      if (kind !== undefined && !ARCHIVE_KINDS.includes(kind as never))
        add(fmt(line("kind"), `kind must be ${ARCHIVE_KINDS.join(" | ")}, got \`${kind}\`${kind === "merged" ? `; ${USE_MERGE}` : ""}`));
      const target = base(block.target, block.line);
      if (!target) continue;
      record(target.knowledgeId, block.line);
      planned({
        make: () => ({ problems: [], operation: { op: "archive", knowledgeId: target.knowledgeId, baseCommit: target.commit, kind: (kind ?? "invalid") as "invalid",
          files: target.revision.files,
          text: block.body, supports: [], reason: value(block, "reason") ?? "", createdAt: new Date().toISOString() } }) });
    }
  }

  // Publication applies a Noter's operation against the live graph, where a stale update becomes a create.
  if (noting) for (const entry of out.knowledge) {
    const { operation } = entry.make();
    if (!operation) continue;
    try { store.normalizeNotingOperation(operation, path); }
    catch (error) {
      const text = error instanceof Error && "describe" in error
        ? (error as unknown as { describe(address: (id: number, commit: number) => string): string }).describe((id, commit) => `K${id}@v${store.versionOrdinal(id, commit)}`)
        : error instanceof Error ? error.message : String(error);
      out.problems.push(problem(file, entry.block.line, describeBlock(entry.block), text));
    }
  }
}

/** Why a `trace://` evidence address does not resolve, or null when it does. */
export function traceProblem(store: Store, address: string): string | null {
  const rest = address.slice("trace://".length);
  const fact = /^F([1-9]\d*)$/.exec(rest);
  if (fact) return store.getFact(Number(fact[1])) ? null : "no such fact";
  if (rest.startsWith("K")) {
    let parsed: ReturnType<typeof parseKnowledgeAddress>;
    try { parsed = parseKnowledgeAddress(rest); } catch (error) { return error instanceof Error ? error.message : String(error); }
    if (!parsed) return "not a knowledge address";
    if (!store.getKnowledge(parsed.id)) return "no such knowledge item";
    try {
      if (parsed.tag) store.resolveVersionTag(parsed.id, parsed.tag);
      else if (parsed.ordinal && parsed.from) store.resolveVersionOrdinal(parsed.id, parsed.from);
    } catch { return "no such version"; }
    return null;
  }
  const layer = /^(raw|facts|knowledge|compact)\/S([1-9]\d*)(?:\/(.+))?$/.exec(rest);
  if (!layer) return "not a trace address";
  if (!store.getSession(Number(layer[2]))) return "no such session";
  if (!layer[3]) return null;
  let turn: ReturnType<typeof parseTurnAddress>;
  try { turn = parseTurnAddress(layer[3]); } catch (error) { return error instanceof Error ? error.message : String(error); }
  if (!turn) return "not a turn address";
  if (store.getTurn(turn.turn)?.sessionId !== Number(layer[2])) return "no such turn in that session";
  for (const entry of turn.entries ?? []) for (const ordinal of [entry.from, entry.to ?? entry.from])
    if (!store.db.prepare("SELECT 1 FROM source_entries WHERE turn_id = ? AND entry_ordinal = ?").get(turn.turn, ordinal)) return `no entry E${ordinal} in that turn`;
  return null;
}

/** 144 stage 5 §4.5: the limits in force now against one compiled operation (title and body of what it writes, an archive's explanation,
 * each split child), in units (145). `plan` reports the same counts as `Length`; apply refuses an operation over them, per operation. */
export function overCaps(store: Store, operation: KnowledgeOperationInput): string[] {
  const { titleWords, bodyWords } = store.writing;
  const out: string[] = [];
  const check = (what: string, text: string | undefined, target: number) => { const count = words(text ?? ""); if (count > wordLimit(target)) out.push(overLimit(what, count, target)); };
  if (operation.op !== "archive") { check("title", operation.title, titleWords); check("body", operation.text, bodyWords); }
  else check("body", operation.text, bodyWords);
  if (operation.op === "split") operation.children.forEach((child, i) => { check(`child ${i + 1} title`, child.title, titleWords); check(`child ${i + 1} body`, child.text, bodyWords); });
  return out;
}
