// verify's change file and verdict file (ticket 144 stage 5 §4): curate keeps its proposals in its run records and applies nothing; verify
// gives every numbered proposal one verdict (confirm, edit or revert), and only then are the confirmed and edited operations applied.
// The change file is rebuilt from the kept proposals at every verify start, so it survives an executor restart.

import type { KnowledgeRevision } from "../model/index.ts";
import { knowledgeTitle } from "../render/index.ts";
import type { KnowledgeOperationInput, KnowledgePath, Store } from "../store/index.ts";
import { BARE_ADDRESS, list, plan, traceProblem, describeBlock, parseBlocks, problem, type Block, type Length, type Section, type WorkspaceFile } from "../workspace/index.ts";

/** One operation curate proposed, as its batch run recorded it at check time (the operation compiled then, so the change file never re-parses against a moved store). */
export interface Proposal { n: number; run: number; category: string; block: string; operation: Exclude<KnowledgeOperationInput, { op: "create" }> }
export interface Changes { text: string; blocks: number; lines: number; proposals: Proposal[] }

type Operation = Proposal["operation"];
const targetOf = (operation: Operation) => operation.op === "merge" ? { knowledgeId: operation.intoKnowledgeId, baseCommit: operation.intoBaseCommit }
  : { knowledgeId: operation.knowledgeId, baseCommit: operation.baseCommit };

export function buildChanges(store: Store, path: KnowledgePath, curateRuns: readonly number[]): Changes {
  const version = (r: { knowledgeId: number; id: number }) => `K${r.knowledgeId}@v${store.versionOrdinal(r.knowledgeId, r.id)}`;
  const at = (knowledgeId: number, commit: number) => `K${knowledgeId}@v${store.versionOrdinal(knowledgeId, commit)}`;
  const titled = (r: KnowledgeRevision) => `${knowledgeTitle(r, store.writing.titleTokens)}\n${r.text}`;
  const proposals: Proposal[] = [];
  for (const run of curateRuns) {
    const response = JSON.parse(store.getRun(run)?.response ?? "{}") as { category?: string; proposed?: { block: string; operation: Operation }[] };
    for (const entry of response.proposed ?? []) proposals.push({ n: proposals.length + 1, run, category: response.category ?? "", ...entry });
  }
  /** What the proposal writes as supports: its own, else the parents' (a Dreamer operation that cites none inherits them). */
  const supportsOf = (operation: Operation, base: KnowledgeRevision): number[] => operation.supports.length ? operation.supports
    : [...new Set([base, ...(operation.op === "merge" ? operation.absorb.map(item => store.getKnowledgeRevision(item.knowledgeId, item.baseCommit)!) : [])].flatMap(r => r.supports))];
  const live = new Map(store.liveKnowledge(path).map(revision => [revision.knowledgeId, revision]));
  const blocks = proposals.map(({ n, category, operation }) => {
    const target = targetOf(operation), base = store.getKnowledgeRevision(target.knowledgeId, target.baseCommit)!;
    const bases = operation.op === "merge" ? operation.absorb : [];
    /** Each item whose base is no longer the live version: the proposal's base stays what it was, the live version is shown beside it. */
    const staleItems = [target, ...bases].filter(item => live.get(item.knowledgeId)?.id !== item.baseCommit);
    const stale = staleItems.map(item => {
      const current = live.get(item.knowledgeId);
      return `current: ${current ? `${version(current)} (${current.actorRole ?? "unrecorded"})` : `K${item.knowledgeId} is no longer current`} — curate proposed from ${at(item.knowledgeId, item.baseCommit)}; this change will be refused at apply`;
    });
    /** The current text of an item: its base when still live, else the proposal's base and the live version, each with its own text. */
    const currentText = (item: { knowledgeId: number; baseCommit: number }, revision: KnowledgeRevision, label: string) => {
      const current = live.get(item.knowledgeId);
      if (current?.id === item.baseCommit) return [`${label}:`, titled(revision)];
      return [`proposal base ${version(revision)} text:`, titled(revision), "",
        ...(current ? [`current ${version(current)} text:`, titled(current)] : ["current: no live version"])];
    };
    const attribute = (name: string, from: string, to: string) => `${name}: ${from === to ? to : `${from} -> ${to}`}`;
    const head = [`## ${n} · ${operation.op} K${target.knowledgeId} · batch ${category}`, ...(stale.length ? stale : [`current: ${version(base)}`])];
    if (operation.op === "archive")
      return [...head, `archive: ${operation.kind}`, `reason: ${operation.reason}`, "", ...currentText(target, base, "current text"), "", "proposed explanation:", operation.text ?? ""].join("\n");
    const changed = (name: string, from: string, to: string | undefined) => to !== undefined && to !== from ? [`${name}: ${from} -> ${to}`] : [];
    const lines = [...head, attribute("category", base.category, operation.category),
      ...changed("scope", base.scope, operation.scope), ...changed("topics", JSON.stringify(base.topics), JSON.stringify(operation.topics)),
      ...changed("title", knowledgeTitle(base, store.writing.titleTokens), operation.title),
      attribute("supports", base.supports.map(f => `F${f}`).join(", "), supportsOf(operation, base).map(f => `F${f}`).join(", ")), `reason: ${operation.reason}`,
      "", ...currentText(target, base, "current text")];
    if (operation.op === "merge") for (const item of operation.absorb) {
      const revision = store.getKnowledgeRevision(item.knowledgeId, item.baseCommit)!;
      lines.push("", ...currentText(item, revision, `absorbed ${version(revision)} (archived into the primary if confirmed)`));
    }
    lines.push("", "proposed:", `${operation.title ?? knowledgeTitle(base, store.writing.titleTokens)}\n${operation.text ?? ""}`);
    // A child is written with its own category, topics, scope and supports, else the operation's (supports resolved as the store does).
    if (operation.op === "split") operation.children.forEach((child, i) => lines.push("", `proposed child ${i + 1}:`, `category: ${child.category}`,
      `scope: ${child.scope ?? operation.scope}`, `topics: ${JSON.stringify(child.topics)}`,
      `supports: ${(child.supports ?? supportsOf(operation, base)).map(f => `F${f}`).join(", ")}`, "", `${child.title ?? ""}\n${child.text}`));
    return lines.join("\n");
  });
  const text = blocks.join("\n\n") + (blocks.length ? "\n" : "");
  return { text, blocks: blocks.length, lines: text ? text.split("\n").length - 1 : 0, proposals };
}

/** The verdict a block gave a change, and the operation it leaves to apply (none for a revert). */
export interface Verdict { n: number; verdict: "confirm" | "edit" | "revert"; reason?: string; evidence?: string[]; operation?: Operation }

const VERDICT_FIELDS: Record<string, readonly string[]> = {
  confirm: ["reason"], revert: ["reason", "evidence"],
  edit: ["reason", "evidence", "title", "category", "scope", "topics", "supports", "absorb"],
};
const CHILD_FIELDS = ["title", "category", "scope", "topics", "supports", "reason"];
const EDIT_TARGET = /^(\d+)\s+(update|merge|split|archive)\s+(K[1-9]\d*@v[1-9]\d*)$/;

/** One function holds every rule about how an edit may differ from the change it corrects (Q12). Must equal the proposal: the operation
 * kind, its target, a merge's `absorb:` list and the number of a split's children. Free: the body, title, category, scope, topics and
 * cited facts of each item the change produces, subject to the operation's own check. An archive takes confirm or revert only. */
export function editMatchesChange(store: Store, proposal: Proposal, edit: { op: string; target: string; block: Block }): string[] {
  const { operation } = proposal, wanted = targetOf(operation);
  const problems: string[] = [];
  if (edit.op !== operation.op) problems.push(`change ${proposal.n} is a ${operation.op}; an edit cannot change an operation's kind (${edit.op})`);
  else if (operation.op === "archive") problems.push(`change ${proposal.n} is an archive; an archive takes only confirm or revert`);
  const name = `K${wanted.knowledgeId}@v${store.versionOrdinal(wanted.knowledgeId, wanted.baseCommit)}`;
  if (edit.target !== name) problems.push(`edit ${proposal.n} names ${edit.target}; change ${proposal.n} is on ${name}`);
  if (operation.op === "merge" && edit.block.fields.has("absorb")) {
    const proposed = operation.absorb.map(item => `K${item.knowledgeId}@v${store.versionOrdinal(item.knowledgeId, item.baseCommit)}`).sort().join(", ");
    if (list(edit.block.fields.get("absorb")!.value).sort().join(", ") !== proposed) problems.push(`absorb: an edit cannot change which items the merge absorbs; change ${proposal.n} absorbs ${proposed}`);
  }
  if (operation.op === "split" && edit.block.children.length !== operation.children.length)
    problems.push(`a split edit keeps the proposal's ${operation.children.length} children; it has ${edit.block.children.length}`);
  return problems;
}

/** The synthetic curate block an edit compiles as: the proposal's fields, overlaid by the fields the edit names (a field counts as named
 * when its line is present, even empty), with the edit's own complete body. */
function overlay(proposal: Proposal, edit: Block, at: (knowledgeId: number, commit: number) => string): string {
  const { operation } = proposal;
  const named = (section: Section, name: string, fallback: string | undefined) => section.fields.has(name) ? section.fields.get(name)!.value : fallback;
  const fields = (section: Section, from: { title?: string; category: string; scope?: string; topics: string[]; supports?: number[]; reason?: string }) => [
    ...(named(section, "title", from.title) === undefined ? [] : [`title: ${named(section, "title", from.title)}`]),
    `category: ${named(section, "category", from.category)}`, ...(from.scope === undefined && !section.fields.has("scope") ? [] : [`scope: ${named(section, "scope", from.scope)}`]),
    `topics: ${named(section, "topics", from.topics.join(", "))}`,
    ...(from.supports === undefined && !section.fields.has("supports") ? [] : [`supports: ${named(section, "supports", from.supports?.map(f => `F${f}`).join(", "))}`]),
    `reason: ${from.reason ?? ""}`];
  if (operation.op === "archive") throw new Error("an archive has no edit");
  const target = targetOf(operation);
  const head = [`## ${operation.op} ${at(target.knowledgeId, target.baseCommit)}`,
    ...(operation.op === "merge" ? [`absorb: ${operation.absorb.map(item => at(item.knowledgeId, item.baseCommit)).join(", ")}`] : []),
    ...fields(edit, operation), "", edit.body];
  const children = operation.op === "split" ? operation.children.map((child, i) => ["", "### child",
    ...fields(edit.children[i] ?? { fields: new Map(), body: "", line: 0 }, { ...child, scope: child.scope ?? operation.scope, supports: child.supports ?? operation.supports, reason: child.reason ?? operation.reason }),
    "", edit.children[i]?.body ?? ""].join("\n")) : [];
  return [head.join("\n"), ...children].join("\n");
}

/** The check of verify's file: one verdict for every numbered change, an edit that matches its change and passes the operation's own check,
 * evidence that resolves. Returns the final set of operations to apply, in change order. */
export function checkVerify(store: Store, path: KnowledgePath, file: WorkspaceFile, proposals: readonly Proposal[], resolveRepository: (reference: string) => string | null) {
  const problems: string[] = [], lengths: Length[] = [], verdicts: Verdict[] = [];
  const parsed = parseBlocks(file);
  problems.push(...parsed.problems);
  const at = (knowledgeId: number, commit: number) => `K${knowledgeId}@v${store.versionOrdinal(knowledgeId, commit)}`;
  const seen = new Map<number, Block>();
  for (const block of parsed.blocks) {
    const where = describeBlock(block), fmt = (line: number, message: string) => problem(file, line, where, message);
    if (!["confirm", "edit", "revert"].includes(block.op)) { problems.push(fmt(block.line, `\`## ${block.op}\` is not a verdict; write \`## confirm <n>\`, \`## edit <n> <op> <K@v>\` or \`## revert <n>\``)); continue; }
    const allowed = VERDICT_FIELDS[block.op]!;
    for (const [name, field] of block.fields) if (!allowed.includes(name)) problems.push(fmt(field.line, `field \`${name}\` is not allowed in a \`${block.op}\` block; it takes ${allowed.map(f => `\`${f}\``).join(", ")}`));
    const edit = block.op === "edit" ? EDIT_TARGET.exec(block.target) : null;
    const number = Number((block.op === "edit" ? edit?.[1] : /^\d+$/.exec(block.target)?.[0]) ?? NaN);
    if (!Number.isInteger(number)) { problems.push(fmt(block.line, block.op === "edit" ? "expected `## edit <n> <op> <K@v>`, such as `## edit 3 update K12@v3`" : `expected \`## ${block.op} <n>\``)); continue; }
    const proposal = proposals[number - 1];
    if (!proposal) { problems.push(fmt(block.line, `there is no change ${number}; the change file has ${proposals.length}`)); continue; }
    if (seen.has(number)) { problems.push(fmt(block.line, `change ${number} already has a verdict (${describeBlock(seen.get(number)!)}); one verdict for each change`)); continue; }
    seen.set(number, block);
    if (block.op !== "edit" && block.body) problems.push(fmt(block.line, `a \`${block.op}\` block has no body`));
    const refs = list(block.fields.get("evidence")?.value);
    if (block.op !== "confirm") {
      if (!block.fields.has("evidence")) problems.push(fmt(block.line, "missing required field `evidence`"));
      else if (!refs.length) problems.push(fmt(block.fields.get("evidence")!.line, "evidence is empty; name the fact, Raw or repository address the change rests on"));
      if (block.op === "revert" && !block.fields.has("reason")) problems.push(fmt(block.line, "missing required field `reason`"));
    }
    for (const ref of refs) {
      const bad = ref.startsWith("trace://") ? traceProblem(store, ref) : BARE_ADDRESS.test(ref) ? `write \`trace://${ref}\`` : resolveRepository(ref);
      if (bad) problems.push(fmt(block.fields.get("evidence")!.line, `evidence \`${ref}\`: ${bad}`));
    }
    const verdict: Verdict = { n: number, verdict: block.op as Verdict["verdict"], ...(block.fields.has("reason") ? { reason: block.fields.get("reason")!.value } : {}), ...(refs.length ? { evidence: refs } : {}) };
    if (block.op === "confirm") verdict.operation = proposal.operation;
    if (block.op === "edit") {
      const mismatch = editMatchesChange(store, proposal, { op: edit![2]!, target: edit![3]!, block });
      problems.push(...mismatch.map(message => fmt(block.line, message)));
      for (const child of block.children) for (const [name, field] of child.fields) if (!CHILD_FIELDS.includes(name))
        problems.push(fmt(field.line, `field \`${name}\` is not allowed in a child; it takes ${CHILD_FIELDS.map(f => `\`${f}\``).join(", ")}`));
      if (!mismatch.length) {
        if (!block.body) problems.push(fmt(block.line, "missing the complete body after the blank line"));
        else {
          const synthetic: WorkspaceFile = { name: "edit", text: overlay(proposal, block, at) };
          const compiled = plan(store, { kind: "curate", operation: proposal.operation.op as "update", sessionId: path.sessionId, path, file: synthetic });
          const strip = (message: string) => message.replace(/^[^:]*:\d+: block 1 `[^`]*`(?: child \d+)?: /, "");
          problems.push(...compiled.problems.map(message => fmt(block.line, `the edit does not pass the ${proposal.operation.op} check: ${strip(message)}`)));
          lengths.push(...compiled.lengths.map(length => ({ ...length, block: where })));
          if (!compiled.problems.length) verdict.operation = compiled.knowledge[0]!.make().operation as Operation;
        }
      }
    }
    verdicts.push(verdict);
  }
  const missing = proposals.filter(proposal => !seen.has(proposal.n)).map(proposal => proposal.n);
  if (missing.length) problems.push(problem(file, 1, "verify file", `no verdict for change ${missing.join(", ")}; every change gets exactly one \`confirm\`, \`edit\` or \`revert\``));
  return { ok: !problems.length, problems, lengths, verdicts: verdicts.sort((a, b) => a.n - b.n) };
}
