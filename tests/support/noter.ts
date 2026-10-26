import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { NotingAgentInput, RunAgentResult } from "../../src/core/api/index.ts";
import type { TraceMemory } from "../source-fixture.ts";
import { block } from "./workspace.ts";
import { loadPrompt } from "../../src/core/prompts/load.ts";
import { canonicalToolNames, type ToolNames } from "../../src/core/prompts/tool-names.ts";
import { tokens } from "../../src/core/render/index.ts";

/** Script one batch's content; each stage calls check and writes only its owned deliverable. */

export type ToolFact = { title: string; sources: string; support?: readonly unknown[]; negate?: readonly unknown[]; [extra: string]: unknown };
export type ToolOperation = Record<string, unknown>;
export interface Files { facts: string; knowledge: string }

/** What one task of a scripted run does. Everything is optional: an empty script writes `## none` to both files. */
export interface NoterOutput extends Partial<RunAgentResult> {
  /** The facts the Noter records; `[]` and absent both mean none. Relation targets `$n` name the n-th fact of this list. */
  noteInput?: readonly ToolFact[];
  /** The knowledge operations (create or update); an empty call `{}` means none. `supports` may name `$n`. */
  memoryInput?: ToolOperation | readonly ToolOperation[];
  /** File text written as it is, instead of what the two fields above give. */
  files?: Partial<Files>;
  /** A check stage's edits; absent means it adds verdicts without changing content. */
  verify?: (files: Files, input: NotingAgentInput) => Partial<Files> | void | Promise<Partial<Files> | void>;
  /** A check stage's native result; absent means success. */
  verifyResult?: Partial<RunAgentResult>;
  /** What this task writes when the stop hook returns a follow-up message; absent: it writes nothing more. */
  fix?: (message: string, files: Files) => Partial<Files> | void;
}

export const REQUEST = { system: "actual host system", messages: [{ role: "user", content: "actual provider input" }], tools: [] };
const label = (target: unknown) => String(target).replace(/^\$/, "f");
const list = (value: unknown) => Array.isArray(value) ? value.map(label).join(", ") : undefined;
const defined = <T extends Record<string, unknown>>(fields: T) => Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));

export function factsFile(facts: readonly ToolFact[] = []): string {
  if (!facts.length) return "## none\n";
  const relations = (kind: "support" | "negate" | "caused_by", value?: readonly unknown[]) => value?.length
    ? { [kind]: value.map(item => Array.isArray(item) ? `${label(item[0])} ${item[1]}` : String(item)).join(", ") } : {};
  return facts.map((fact, i) => { const { title, sources, support, negate, caused_by, objects, ...extra } = fact;
    return block(`fact f${i + 1}`, { title, objects: Array.isArray(objects) ? objects.join(", ") : String(objects ?? ""),
      ...relations("support", support), ...relations("negate", negate), ...relations("caused_by", caused_by as readonly unknown[]),
      ...Object.fromEntries(Object.entries(extra).map(([key, value]) => [key, String(value)])) }, sources); }).join("\n");
}

export function knowledgeFile(memory: TraceMemory, input: ToolOperation | readonly ToolOperation[] = []): string {
  const operations = (Array.isArray(input) ? input : [input]).filter(op => Object.keys(op).length);
  if (!operations.length) return "## none\n";
  const store = memory.store;
  return operations.map(op => {
    const common = { supports: list(op.supports), reason: op.reason as string | undefined, files: op.files === null || op.files === undefined ? "None" : list(op.files) };
    // A field the format does not have is written as it was given, for the test that expects the check to refuse it.
    const { op: _op, id: _id, title: _title, category: _category, scope: _scope, topics: _topics, supports: _supports, reason: _reason, text: _text, edits: _edits, files: _files, ...extra } = op;
    const extras = Object.fromEntries(Object.entries(extra).map(([key, value]) => [key, String(value)]));
    if (op.op === "create") return block("create", { ...defined({ title: op.title as string, category: op.category as string, scope: op.scope as string,
      topics: list(op.topics) ?? "", ...common }), ...extras } as Record<string, string>, op.text as string);
    if (op.op !== "update") throw new Error(`the Noter writes create or update only, not ${String(op.op)}`);
    const match = /^K(\d+)#([a-z]+)$/.exec(String(op.id));
    // An id that is not an exact K#tag is written as it stands: the check refuses it.
    if (!match) return block(`update ${String(op.id)}`, { ...defined({ title: op.title as string | undefined, category: op.category as string | undefined, scope: op.scope as string | undefined,
      topics: op.topics === undefined ? undefined : list(op.topics), ...common }), ...extras } as Record<string, string>, op.text as string);
    const knowledgeId = Number(match[1]), commit = store.resolveVersionTag(knowledgeId, match[2]!);
    const base = store.getKnowledgeRevision(knowledgeId, commit)!;
    // A file carries the complete body; an `edits` update of the old tool is applied to its base here.
    const body = typeof op.text === "string" ? op.text : (op.edits as { old: string; new: string }[]).reduce((text, edit) => text.replace(edit.old, edit.new), base.text);
    return block(`update K${knowledgeId}@v${store.versionOrdinal(knowledgeId, commit)}`, defined({ title: op.title as string | undefined,
      category: op.category as string | undefined, scope: op.scope as string | undefined, topics: op.topics === undefined ? undefined : list(op.topics), ...common, ...extras }) as Record<string, string>, body);
  }).join("\n");
}

type Script = NoterOutput | ((input: NotingAgentInput) => NoterOutput | Promise<NoterOutput>);

const text = (path: string) => { try { return readFileSync(path, "utf8"); } catch { return ""; } };
const filesOf = (input: NotingAgentInput): Files => ({ facts: text(input.workspace.facts), knowledge: text(input.workspace.knowledge) });
const put = (input: NotingAgentInput, changes: Partial<Files> | void) => {
  mkdirSync(input.workspace.dir, { recursive: true });
  if (changes?.facts !== undefined) writeFileSync(input.workspace.facts, changes.facts);
  if (changes?.knowledge !== undefined) writeFileSync(input.workspace.knowledge, changes.knowledge);
};

export function withVerdicts(text: string): string {
  return text.split(/(?=^## )/m).filter(part => part.trim()).map(part =>
    /^verdict:/m.test(part) ? part : `${part.trimEnd()}\n\nverdict: ok\n`).join("\n");
}

const planned = new Map<string, Partial<Files>>();
export async function submit(input: NotingAgentInput, memory: TraceMemory, output: NoterOutput = {}, seen?: string[]): Promise<string | undefined> {
  await input.tools.find(tool => tool.name === "check")!.execute({});
  const files = { facts: factsFile(output.noteInput), knowledge: knowledgeFile(memory, output.memoryInput), ...output.files };
  if (input.task === "extract-facts") planned.set(input.executionId ?? input.workspace.dir, files);
  const which = input.task === "extract-facts" || input.task === "check-facts" ? "facts" : "knowledge";
  if (input.task === "extract-facts") put(input, { facts: files.facts });
  else if (input.task === "write-knowledge") put(input, { knowledge: output.files?.knowledge ?? (output.memoryInput === undefined ? planned.get(input.executionId ?? input.workspace.dir)?.knowledge ?? files.knowledge : files.knowledge) });
  else {
    const change = await output.verify?.(filesOf(input), input);
    put(input, { [which]: withVerdicts(change?.[which] ?? filesOf(input)[which]) });
  }
  let first: string | undefined;
  for (;;) {
    const message = input.passEnd();
    if (message === undefined) return first;
    first ??= message; seen?.push(message);
    const fixed = output.fix?.(message, filesOf(input))?.[which];
    if (fixed === undefined) return first;
    put(input, { [which]: fixed });
  }
}

/** Write the current step's file as `submit` would and return what `check` reports, without stopping: no repair is spent. A test that
 * enumerates several invalid inputs to one task uses this, or one run per input (a second failure is terminal). */
export async function probe(input: NotingAgentInput, memory: TraceMemory, output: NoterOutput = {}): Promise<string> {
  const files = input.task === "extract-facts" ? { facts: factsFile(output.noteInput), ...output.files } : output.files ?? {};
  put(input, files);
  return String(await input.tools.find(tool => tool.name === "check")!.execute({}));
}

/** Complete an unchanged check, or the scripted batch's knowledge-writing stage. */
export async function verifyUnchanged(raw: unknown, reply: Partial<RunAgentResult> = {}): Promise<RunAgentResult> {
  const input = raw as NotingAgentInput;
  const result = { outcome: "success", output: "verified", request: REQUEST, ...reply } as RunAgentResult;
  if (result.request !== undefined) input.reportRequest(result.request); else input.acknowledgeRequest();
  await input.tools.find(tool => tool.name === "check")!.execute({});
  const which = input.task === "check-facts" ? "facts" : "knowledge";
  put(input, { [which]: input.task === "write-knowledge" ? planned.get(input.executionId ?? input.workspace.dir)?.knowledge ?? "## none\n" : withVerdicts(filesOf(input)[which]) });
  while (input.passEnd() !== undefined);
  return result;
}

/** One queue item supplies a batch; resumed stages take a new script after a restart. */
export function scriptedNoter(memory: () => TraceMemory, script: Script[] = [], options: {
  /** Write-task inputs are pushed here, so a test indexes its Nth batch as it always did. */
  calls?: NotingAgentInput[];
  /** An exhausted queue writes `## none` instead of failing the test. */
  idle?: boolean;
} = {}) {
  const inputs: NotingAgentInput[] = [], written = new Map<string, NoterOutput>(), stopMessages: string[] = [];
  const next = async (input: NotingAgentInput): Promise<NoterOutput> => {
    const item = script.shift() ?? (options.idle ? {} : (() => { throw new Error("unexpected model call"); })());
    return typeof item === "function" ? item(input) : item;
  };
  const agent = async (raw: unknown): Promise<RunAgentResult> => {
    const input = raw as NotingAgentInput, dir = input.executionId ?? input.workspace.dir;
    inputs.push(input);
    if (input.task === "extract-facts") options.calls?.push(input);
    const output = input.task === "extract-facts" || !written.has(dir) ? await next(input) : written.get(dir)!;
    written.set(dir, output);
    const { noteInput: _facts, memoryInput: _operations, files: _files, verify: _verify, verifyResult, fix: _fix, ...reply } = output;
    const checking = input.task === "check-facts" || input.task === "check-knowledge";
    const result = { outcome: "success", output: "Done.", request: REQUEST, usage: { tokens: 12 }, ...reply,
      ...(checking ? verifyResult : {}) } as RunAgentResult;
    if (result.request !== undefined) input.reportRequest(result.request);
    if (result.outcome !== "success") { await input.tools.find(tool => tool.name === "check")!.execute({}); return result; }
    await submit(input, memory(), output, stopMessages);
    return result;
  };
  return { agent, inputs, stopMessages, script, written };
}

/** Complete the current stage with nothing to record; leave other worker kinds alone. */
export function submitEmpty(raw: unknown): void {
  const input = raw as NotingAgentInput;
  if (input.kind !== "noting") return;
  mkdirSync(input.workspace.dir, { recursive: true });
  input.tools.find(tool => tool.name === "check")!.execute({});
  const which = input.task === "extract-facts" || input.task === "check-facts" ? "facts" : "knowledge";
  writeFileSync(input.workspace[which], input.task.startsWith("check-") ? "## none\nverdict: ok\n" : "## none\n");
  while (input.passEnd() !== undefined);
}

/** The largest one-stage prompt is priced with the shared system instructions. */
export const largestTaskPromptTokens = (names: ToolNames = canonicalToolNames): number => {
  const files = ["tasks/noting-write-facts.md", "tasks/noting-write-knowledge.md", "tasks/noting-verify-facts.md", "tasks/noting-verify-knowledge.md"] as const;
  return Math.max(...files.map(file => tokens(loadPrompt(file, names))));
};
