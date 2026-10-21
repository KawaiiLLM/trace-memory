// Reading a workspace file against the Store (ticket 144, Stage 2): which blocks a task may write, the fields each
// needs, the references that must resolve and the caps. `plan` builds, for every block, the Store operation
// `apply` will publish, so the check and the publication share one reading. Field validation and the caps are
// the memory tool's (`prepareMemory`), and fact validation is `note`'s (`factValidator`); this file adds only
// what the file format itself introduces.

import { factValidator, frozenTurnIds, notingSources } from "../api/tools.ts";
import { prepareMemory } from "../knowledge-write/prepare.ts";
import { isKnowledgeCategory, substantiveArchiveStatement, validateNotingFact, KNOWLEDGE_CATEGORIES, type KnowledgeRevision } from "../model/index.ts";
import { parseKnowledgeAddress, parseTurnAddress } from "../model/address.ts";
import { tokens } from "../render/index.ts";
import type { FactCommitInput, KnowledgeOperationInput, KnowledgePath, RunInput, Store } from "../store/index.ts";
import { describeBlock, parseBlocks, parseScores, problem, type Block, type Section, type WorkspaceFile } from "./parse.ts";

export type TaskKind = "noting-facts" | "noting-knowledge" | "curate" | "verify" | "classify";

/** The frozen batch a Noting task writes about: the same range and entries the Noter's tools are bound to. */
export interface NotingScope { sessionId: number; branch: string; range: { from: string; to: string }; entryIds?: readonly number[] }

export type WorkspaceTask =
  | { kind: "noting-facts"; scope: NotingScope; file: WorkspaceFile }
  /** `facts` is the run's facts file; its labels are what `supports:` may cite besides `F<id>`. */
  | { kind: "noting-knowledge"; scope: NotingScope; file: WorkspaceFile; facts: WorkspaceFile }
  | { kind: "curate" | "verify"; sessionId: number; path?: KnowledgePath; file: WorkspaceFile }
  | { kind: "classify"; items: readonly number[]; file: WorkspaceFile };

/** The host-measured length of one title or body, whether or not it is over its limit. */
export interface Length { block: string; field: "title" | "body"; count: number; limit: number }

export interface CheckResult { ok: boolean; problems: string[]; lengths: Length[] }

/** One block's Store operation, built when the file is read and again at publication with the fact ids known. */
export interface PlannedBlock {
  block: Block;
  /** Every knowledge item the block records: the one it writes, and each one it absorbs. */
  items: number[];
  /** The base the block names (the primary of a merge or split). */
  revision?: KnowledgeRevision;
  /** The knowledge id a merged archive names as its successor. */
  successor?: number;
  /** `mapping` (label position to fact id) is given at publication and absent while checking. Problems are already formatted. */
  make(mapping?: ReadonlyMap<number, number>): { operation?: KnowledgeOperationInput; problems: string[] };
}

export interface Plan {
  problems: string[];
  lengths: Length[];
  facts: { block: Block; label: string; fact: FactCommitInput }[];
  knowledge: PlannedBlock[];
  path?: KnowledgePath;
  sources?: ReturnType<typeof notingSources>;
}

const ALLOWED: Record<TaskKind, readonly string[]> = {
  "noting-facts": ["fact"],
  "noting-knowledge": ["create", "update"],
  curate: ["create", "update", "merge", "split", "archive"],
  verify: ["update", "archive", "revert"],
  classify: [],
};

const FIELDS: Record<string, readonly string[]> = {
  fact: ["title"],
  create: ["title", "category", "scope", "topics", "supports", "reason"],
  update: ["title", "category", "scope", "topics", "supports", "reason"],
  merge: ["absorb", "title", "category", "scope", "topics", "supports", "reason"],
  split: ["title", "category", "scope", "topics", "supports", "reason"],
  child: ["title", "category", "scope", "topics", "supports", "reason"],
  archive: ["kind", "successor", "reason"],
  revert: ["reason"],
};
const REQUIRED: Record<string, readonly string[]> = {
  fact: ["title"],
  create: ["title", "category", "scope", "topics", "supports", "reason"],
  update: ["reason"], merge: ["absorb", "reason"], split: ["reason"],
  child: ["title", "category", "scope", "topics", "supports", "reason"],
  archive: ["kind", "reason"], revert: ["reason"],
};
const ARCHIVE_KINDS = ["merged", "invalid", "inadmissible"] as const;
const VERSION = /^K([1-9]\d*)@v([1-9]\d*)$/;
const list = (value: string | undefined): string[] => (value ?? "").split(",").map(item => item.trim()).filter(Boolean);

type Made = { operation?: KnowledgeOperationInput; problems: string[] };
interface Base { knowledgeId: number; ordinal: number; commit: number; revision: KnowledgeRevision }

export function plan(store: Store, task: WorkspaceTask): Plan {
  const out: Plan = { problems: [], lengths: [], facts: [], knowledge: [] };
  const { file } = task;
  if (task.kind === "classify") {
    const { scores, problems } = parseScores(file);
    out.problems.push(...problems);
    const wanted = new Set(task.items), seen = new Map<number, number>();
    for (const score of scores) {
      const where = `score line K${score.knowledgeId}`;
      if (!wanted.has(score.knowledgeId)) out.problems.push(problem(file, score.line, where, "that item is not in the set to score"));
      else if (seen.has(score.knowledgeId)) out.problems.push(problem(file, score.line, where, `scored twice (lines ${seen.get(score.knowledgeId)} and ${score.line})`));
      else seen.set(score.knowledgeId, score.line);
    }
    return out;
  }
  const parsed = parseBlocks(file);
  out.problems.push(...parsed.problems);
  const none = parsed.blocks.filter(block => block.op === "none");
  if (none.length && parsed.blocks.length > none.length)
    out.problems.push(problem(file, none[0]!.line, describeBlock(none[0]!), "`## none` must be the only block of the file"));
  const allowed = ALLOWED[task.kind];
  for (const block of parsed.blocks) if (block.op !== "none" && !allowed.includes(block.op))
    out.problems.push(problem(file, block.line, describeBlock(block), `\`## ${block.op}\` is not allowed in a ${task.kind} file; allowed: ${allowed.map(op => `\`${op}\``).join(", ")}, or \`## none\``));
  const blocks = parsed.blocks.filter(block => allowed.includes(block.op));
  if (task.kind === "noting-facts") planFacts(store, task, blocks, out);
  else planKnowledge(store, task, blocks, out);
  return out;
}

/** The fields a section may and must carry; verify files also carry `evidence:` on every block. */
function checkFields(file: WorkspaceFile, section: Section, kind: string, where: string, verify: boolean): string[] {
  const evidence = verify && kind !== "child" ? ["evidence"] : [];
  const allowed = [...FIELDS[kind]!, ...evidence];
  return [
    ...[...section.fields].filter(([name]) => !allowed.includes(name)).map(([name, field]) =>
      problem(file, field.line, where, `field \`${name}\` is not allowed here; ${kind === "child" ? "a child" : `a \`${kind}\` block`} takes ${allowed.map(f => `\`${f}\``).join(", ")}`)),
    ...[...REQUIRED[kind] ?? [], ...evidence].filter(name => !section.fields.has(name)).map(name => problem(file, section.line, where, `missing required field \`${name}\``)),
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
  for (const block of blocks) {
    const where = describeBlock(block);
    out.problems.push(...checkFields(file, block, "fact", where, false));
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(block.target)) out.problems.push(problem(file, block.line, where, "expected `## fact <label>` with a label such as `f1`, unique in the file"));
    else if (labels.has(block.target)) out.problems.push(problem(file, block.line, where, `label \`${block.target}\` is already used by ${describeBlock(labels.get(block.target)!)}`));
    else labels.set(block.target, block);
    const title = block.fields.get("title")?.value ?? "";
    // The body is one `[address] text` line per source, the form `note` takes; its length is the sum of its segments.
    const raw = { title, sources: block.body };
    const syntax: string[] = [], shape = validateNotingFact("fact", raw, syntax);
    out.lengths.push({ block: where, field: "title", count: tokens(title), limit: store.writing.titleTokens });
    if (shape && !syntax.length)
      out.lengths.push({ block: where, field: "body", count: shape.sources.reduce((sum, source) => sum + tokens(source.text), 0), limit: store.writing.bodyTokens });
    if (!block.fields.has("title")) continue; // already reported as missing
    try { out.facts.push({ block, label: block.target, fact: validator.validate(raw, block.index, () => false) }); }
    catch (error) { out.problems.push(problem(file, block.line, where, (error instanceof Error ? error.message : String(error)).replace(/facts\[\d+\]\./g, ""))); }
  }
}

function planKnowledge(store: Store, task: Exclude<WorkspaceTask, { kind: "noting-facts" | "classify" }>, blocks: Block[], out: Plan) {
  const file = task.file, noting = task.kind === "noting-knowledge", verify = task.kind === "verify";
  const path: KnowledgePath = noting ? { sessionId: task.scope.sessionId, headTurnId: Number(task.scope.range.to.split("/T")[1]), branch: task.scope.branch }
    : task.path ?? store.knowledgePath(task.sessionId);
  out.path = path;
  const sessionId = path.sessionId;
  // The Noter may cite the facts file's labels; they are numbered by position, as the Noter's `$n` handles were.
  const factBlocks = noting ? parseBlocks(task.facts).blocks.filter(block => block.op === "fact") : [];
  const labelOf = new Map(factBlocks.map((block, i) => [block.target, i + 1]));
  const localFacts = new Map(factBlocks.map((block, i) => {
    const bad: string[] = [], shape = validateNotingFact("fact", { title: block.fields.get("title")?.value ?? "", sources: block.body }, bad);
    return [i + 1, { text: shape && !bad.length ? shape.sources.map(source => source.text).join("\n") : "" }] as const;
  }));
  const run: RunInput = { kind: noting ? "noting" : "manual", sessionId, branch: path.branch ?? null, createdAt: new Date().toISOString() };
  const recorded = new Map<number, Block>();
  const updated = new Set<number>(); // items the file writes a new version of, for `successor:`
  const currentOf = (knowledgeId: number) => store.currentCommit(knowledgeId, path).find(revision => revision.op !== "archive");

  for (const block of blocks) {
    const where = describeBlock(block);
    const fmt = (line: number, message: string) => problem(file, line, where, message);
    const add = (...messages: string[]) => out.problems.push(...messages);
    const line = (name: string) => block.fields.get(name)?.line ?? block.line;
    const value = (section: Section, name: string) => section.fields.get(name)?.value;
    const missing = (section: Section, kind: string) => (REQUIRED[kind] ?? []).some(name => !section.fields.has(name));
    add(...checkFields(file, block, block.op, where, verify));

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
      if (value(section, "title") !== undefined) out.lengths.push({ block: label, field: "title", count: tokens(value(section, "title")!), limit: store.writing.titleTokens });
      if (section.body) out.lengths.push({ block: label, field: "body", count: tokens(section.body), limit: store.writing.bodyTokens });
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
      const result = prepareMemory(store, sessionId, { operations: [raw], skipped: [] }, run, path, undefined, undefined,
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
        category: category ?? b.revision.category, scope: scope ?? b.revision.scope, topics: topics === undefined ? b.revision.topics : list(topics),
        supports: cited.refs, reason: value(section, "reason") ?? "", ...(title === undefined ? {} : { title }) }, label, section.line, "", mapping, !noting);
    };
    const createOf = (section: Section, kind: string, label: string, prefix: string, mapping?: ReadonlyMap<number, number>): Made => {
      if (missing(section, kind) || !section.body) return { problems: [] };
      const cited = supports(section, label, mapping);
      if (!cited.refs) return { problems: cited.problems };
      return piece({ op: "create", title: value(section, "title"), text: section.body, category: value(section, "category"), scope: value(section, "scope"),
        topics: list(value(section, "topics")), supports: cited.refs, reason: value(section, "reason") }, label, section.line, prefix, mapping);
    };
    const planned = (entry: Omit<PlannedBlock, "block">) => {
      out.knowledge.push({ block, ...entry });
      add(...entry.make().problems);
    };

    if (verify) {
      const refs = list(value(block, "evidence"));
      if (block.fields.has("evidence") && !refs.length) add(fmt(line("evidence"), "evidence is empty; name the fact, Raw or repository address the change rests on"));
      // A trace address must resolve; any other value is a repository reference and is not resolved.
      for (const ref of refs) if (ref.startsWith("trace://")) {
        const bad = traceProblem(store, ref);
        if (bad) add(fmt(line("evidence"), `evidence \`${ref}\`: ${bad}`));
      }
    }

    if (block.op === "create") {
      lengths(block, where); body(block, where);
      if (block.children.length) add(fmt(block.line, "a `create` block has no `### child` sections"));
      planned({ items: [], make: mapping => createOf(block, "create", where, "", mapping) });
    } else if (block.op === "update" || block.op === "merge" || block.op === "split") {
      lengths(block, where); body(block, where);
      if (block.op !== "split" && block.children.length) add(fmt(block.line, `a \`${block.op}\` block has no \`### child\` sections`));
      if (block.op === "split" && !block.children.length) add(fmt(block.line, "a `split` block needs one or more `### child` sections"));
      block.children.forEach((child, i) => {
        const label = `${where} child ${i + 1}`;
        add(...checkFields(file, child, "child", label, false));
        body(child, label, "the child's complete body");
        lengths(child, label);
      });
      const primary = base(block.target, block.line);
      if (!primary) continue;
      record(primary.knowledgeId, block.line);
      updated.add(primary.knowledgeId);
      const items = [primary.knowledgeId];
      const absorbed: Base[] = [];
      if (block.op === "merge") {
        const refs = list(value(block, "absorb"));
        if (block.fields.has("absorb") && !refs.length) add(fmt(line("absorb"), "absorb is empty; list one or more other items as `K<id>@v<n>`"));
        for (const ref of refs) {
          const b = base(ref, line("absorb"));
          if (!b) continue;
          if (b.knowledgeId === primary.knowledgeId) { add(fmt(line("absorb"), `K${b.knowledgeId} cannot absorb itself`)); continue; }
          record(b.knowledgeId, line("absorb"));
          absorbed.push(b); items.push(b.knowledgeId);
          for (const field of ["category", "scope"] as const) {
            const given = value(block, field);
            if (b.revision[field] !== primary.revision[field] || (given !== undefined && given !== primary.revision[field]))
              add(fmt(line("absorb"), `merged items share one ${field}: K${primary.knowledgeId}@v${primary.ordinal} is \`${primary.revision[field]}\`, K${b.knowledgeId}@v${b.ordinal} is \`${b.revision[field]}\`${given !== undefined && given !== primary.revision[field] ? `, the result says \`${given}\`` : ""}; change a category with an update in an earlier run first`));
          }
        }
      }
      planned({ items, revision: primary.revision, make: mapping => {
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
          children.push({ title: c.title, text: c.text, category: c.category, topics: c.topics, scope: c.scope, supports: c.supports, reason: c.reason });
        });
        return found.length || children.length !== block.children.length ? { problems: found }
          : { problems: [], operation: { ...content, op: "split", knowledgeId, baseCommit, children } };
      } });
    } else if (block.op === "archive") {
      lengths(block, where);
      if (!block.body) add(fmt(block.line, "missing the archive explanation after the blank line"));
      else if (!substantiveArchiveStatement(block.body)) add(fmt(block.line, "the archive explanation must state the grounds and the evidence, not a bare status"));
      else if (tokens(block.body) > store.writing.bodyTokens) add(fmt(block.line, `body: ${tokens(block.body)} tokens, over the ${store.writing.bodyTokens}-token limit`));
      const kind = value(block, "kind"), successorText = value(block, "successor");
      if (kind !== undefined && !ARCHIVE_KINDS.includes(kind as never)) add(fmt(line("kind"), `kind must be ${ARCHIVE_KINDS.join(" | ")}, got \`${kind}\``));
      if (kind === "merged" && successorText === undefined) add(fmt(block.line, "a merged archive needs `successor: K<id>`"));
      if (kind !== undefined && kind !== "merged" && successorText !== undefined) add(fmt(line("successor"), "`successor:` belongs to `kind: merged` only"));
      const successorId = successorText === undefined ? undefined : /^K([1-9]\d*)$/.exec(successorText)?.[1];
      if (successorText !== undefined && successorId === undefined) add(fmt(line("successor"), `successor \`${successorText}\` is not an item id; expected \`K<id>\``));
      const target = base(block.target, block.line);
      if (!target) continue;
      record(target.knowledgeId, block.line);
      planned({ items: [target.knowledgeId], revision: target.revision, ...(successorId === undefined ? {} : { successor: Number(successorId) }),
        make: () => ({ problems: [], operation: { op: "archive", knowledgeId: target.knowledgeId, baseCommit: target.commit, kind: (kind ?? "invalid") as "merged",
          text: block.body, ...(successorId === undefined ? {} : { successor: Number(successorId) }), supports: [], reason: value(block, "reason") ?? "",
          createdAt: new Date().toISOString() } }) });
    } else if (block.op === "revert") {
      const match = /^(K[1-9]\d*@v[1-9]\d*)\s*->\s*(K[1-9]\d*@v[1-9]\d*)$/.exec(block.target);
      if (!match) { add(fmt(block.line, "expected `## revert K<id>@v<n> -> K<id>@v<m>`")); continue; }
      if (block.body) add(fmt(block.line, "a `revert` block has no body"));
      const from = base(match[1]!, block.line), to = base(match[2]!, block.line);
      if (!from || !to) continue;
      if (from.knowledgeId !== to.knowledgeId) { add(fmt(block.line, `a revert restores a version of the same item; K${from.knowledgeId} and K${to.knowledgeId} differ`)); continue; }
      if (to.ordinal >= from.ordinal) add(fmt(block.line, `a revert restores an earlier version; v${to.ordinal} is not earlier than v${from.ordinal}`));
      if (to.revision.title === null) add(fmt(block.line, `K${to.knowledgeId}@v${to.ordinal} has no title (it predates titles) and a new version needs one; write an \`update\` with a title instead`));
      record(from.knowledgeId, block.line);
      updated.add(from.knowledgeId);
      planned({ items: [from.knowledgeId], revision: from.revision, make: () => ({ problems: [], operation: { op: "update", knowledgeId: from.knowledgeId,
        baseCommit: from.commit, title: to.revision.title ?? undefined, text: to.revision.text, category: to.revision.category, scope: to.revision.scope,
        topics: to.revision.topics, supports: [], reason: value(block, "reason") ?? "", createdAt: new Date().toISOString() } }) });
    }
  }

  // A merged archive names an item that stays: a current one, or one this file writes a new version of.
  for (const entry of out.knowledge) if (entry.successor !== undefined) {
    const where = describeBlock(entry.block), at = entry.block.fields.get("successor")!.line;
    const successor = entry.successor, target = entry.items[0]!;
    const archivedHere = recorded.get(successor)?.op === "archive" ? recorded.get(successor) : undefined;
    const fail = (message: string) => out.problems.push(problem(file, at, where, message));
    if (successor === target) fail(`K${successor} cannot be its own successor`);
    else if (archivedHere) fail(`successor K${successor} is archived in this file (${describeBlock(archivedHere)})`);
    else if (!updated.has(successor) && !currentOf(successor)) fail(`successor K${successor} is not a current item and this file does not update it`);
    else {
      const there = currentOf(successor), here = entry.revision!;
      if (there && (there.category !== here.category || there.scope !== here.scope))
        fail(`merged items share one category and scope: K${target} is ${here.category}/${here.scope}, K${successor} is ${there.category}/${there.scope}`);
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
