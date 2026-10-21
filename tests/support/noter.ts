import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { NotingAgentInput, RunAgentResult } from "../../src/core/api/index.ts";
import type { TraceMemory } from "../source-fixture.ts";
import { block } from "./workspace.ts";

/** A scripted Noter (ticket 144, Stage 3): the one stand-in for the model behind `runAgent` in tests that publish through the
 * real two-task run. Like a host, it calls `check`, writes the two workspace files named in `input.workspace`, runs the stop
 * hook once and returns. The test scripts WHAT the Noter writes, in the shapes the old `note` and `memory` calls took
 * (facts as `{title, sources, support?, negate?}`, operations as `memory` inputs) or as raw file text; this module turns those
 * into the blocks of the file format, so a test never spells the format unless the format is what it tests. */

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
  /** Task 2: the files it leaves behind, given what task 1 wrote. Absent: it leaves them unchanged. */
  verify?: (files: Files, input: NotingAgentInput) => Partial<Files> | void | Promise<Partial<Files> | void>;
  /** Task 2's own result (a failure, a cancellation); absent: success. */
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
  const relations = (kind: "support" | "negate", value?: readonly unknown[]) => value?.length
    ? { [kind]: value.map(item => Array.isArray(item) ? `${label(item[0])} ${item[1]}` : String(item)).join(", ") } : {};
  // A field the format does not have is written as it was given, for the test that expects the check to refuse it.
  return facts.map((fact, i) => { const { title, sources, support, negate, ...extra } = fact;
    return block(`fact f${i + 1}`, { title, ...relations("support", support), ...relations("negate", negate), ...Object.fromEntries(Object.entries(extra).map(([key, value]) => [key, String(value)])) }, sources); }).join("\n");
}

export function knowledgeFile(memory: TraceMemory, input: ToolOperation | readonly ToolOperation[] = []): string {
  const operations = (Array.isArray(input) ? input : [input]).filter(op => Object.keys(op).length);
  if (!operations.length) return "## none\n";
  const store = memory.store;
  return operations.map(op => {
    const common = { supports: list(op.supports), reason: op.reason as string | undefined };
    // A field the format does not have is written as it was given, for the test that expects the check to refuse it.
    const { op: _op, id: _id, title: _title, category: _category, scope: _scope, topics: _topics, supports: _supports, reason: _reason, text: _text, edits: _edits, ...extra } = op;
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

/** One task of a scripted run, as a host's model does it: call `check`, write the files, hit the stop hook once. Returns the
 * stop hook's follow-up message, if it had one (after the correction `output.fix` makes to it). */
export async function submit(input: NotingAgentInput, memory: TraceMemory, output: NoterOutput = {}): Promise<string | undefined> {
  await input.tools.find(tool => tool.name === "check")!.execute({});
  if (input.task === "write") put(input, { facts: factsFile(output.noteInput), knowledge: knowledgeFile(memory, output.memoryInput), ...output.files });
  else if (output.verify) put(input, await output.verify(filesOf(input), input));
  const message = input.passEnd();
  if (message) put(input, output.fix?.(message, filesOf(input)));
  return message;
}

/** A verify task that finds nothing to correct. */
export async function verifyUnchanged(raw: unknown, reply: Partial<RunAgentResult> = {}): Promise<RunAgentResult> {
  const input = raw as NotingAgentInput;
  const result = { outcome: "success", output: "verified", request: REQUEST, ...reply } as RunAgentResult;
  if (result.request !== undefined) input.reportRequest(result.request); else input.acknowledgeRequest();
  await input.tools.find(tool => tool.name === "check")!.execute({});
  input.passEnd();
  return result;
}

/** The `runAgent` of a test, with its queue. Each `memory.noting()` takes one script for its write task and none for its verify
 * task, which leaves the files as written unless that script says otherwise. A resumed run (verify only) takes the next script. */
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
    const input = raw as NotingAgentInput, dir = input.workspace.dir;
    inputs.push(input);
    if (input.task === "write") options.calls?.push(input);
    const output = input.task === "write" || !written.has(dir) ? await next(input) : written.get(dir)!;
    if (input.task === "write") written.set(dir, output);
    const { noteInput: _facts, memoryInput: _operations, files: _files, verify: _verify, verifyResult, fix: _fix, ...reply } = output;
    const result = { outcome: "success", output: "Done.", request: REQUEST, usage: { tokens: 12 }, ...reply,
      ...(input.task === "verify" ? verifyResult : {}) } as RunAgentResult;
    if (result.request !== undefined) input.reportRequest(result.request);
    if (result.outcome !== "success") { await input.tools.find(tool => tool.name === "check")!.execute({}); put(input, input.task === "write" ? { facts: factsFile(output.noteInput), knowledge: knowledgeFile(memory(), output.memoryInput), ...output.files } : undefined); return result; }
    const message = await submit(input, memory(), output);
    if (message) stopMessages.push(message);
    return result;
  };
  return { agent, inputs, stopMessages, script, written };
}

/** For a hand-written agent that only needs the run to pass: what a host's model does with nothing to record. Both tasks of the
 * run call it. A launch of another kind (a Dreamer) is left alone. */
export function submitEmpty(raw: unknown): void {
  const input = raw as NotingAgentInput;
  if (input.kind !== "noting") return;
  mkdirSync(input.workspace.dir, { recursive: true });
  input.tools.find(tool => tool.name === "check")!.execute({});
  writeFileSync(input.workspace.facts, "## none\n"); writeFileSync(input.workspace.knowledge, "## none\n");
  input.passEnd();
}
