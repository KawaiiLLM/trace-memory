import { writeFileSync } from "node:fs";
import type { DreamingAgentInput, RunAgentResult } from "../../src/core/api/index.ts";
import type { DreamingTaskInput } from "../../src/core/dreaming/index.ts";
import type { RunAgent, TraceMemory } from "../source-fixture.ts";
import { REQUEST } from "./noter.ts";
import { workspaceBatch } from "./workspace.ts";

/** A scripted Dreamer (ticket 144, stage 4): the stand-in for the model behind `runAgent` in tests that run the real Dreaming
 * tasks. Like a host, it calls `check`, writes the file `check` names, meets the stop hook after every pass and follows the next
 * batch it is handed. The test states only WHAT each file holds: file text, or a list of texts when the first attempt is expected
 * to fail the check and the repair should say something else. A curate category or a verify file with no entry writes `## none`;
 * a classify pass with no entry scores every item 50. */
type Text = string | readonly string[] | ((message: string) => string);
export interface DreamerScript {
  /** The curate batch files by category. */
  curate?: Partial<Record<string, Text>>;
  /** Verify's file. */
  verify?: Text;
  /** Classify's file for each pass (1-based); `ids` are the pass's items. */
  classify?: (pass: number, ids: number[], message: string) => Text | undefined;
  /** Result of the curate conversation (a failure, a cancellation); absent: success. */
  curateResult?: Partial<RunAgentResult>;
  /** Run instead of the scripted conversation for one task (a runner that hangs, ignores abort, or records its input). */
  instead?: Partial<Record<"curate" | "verify" | "classify", (input: DreamingAgentInput) => Promise<RunAgentResult> | RunAgentResult>>;
}

const FILE: Record<string, RegExp> = { curate: /File: (\S+?\.md)/, verify: /Your file: (\S+?\.md)/, classify: /File: (\S+?\.md)/ };
const CATEGORY = /category (\w+)/;

export function scriptedDreamer(script: DreamerScript = {}) {
  script.curate ??= {}; // a test may fill in a batch after the run is built
  const inputs: DreamingAgentInput[] = [], messages: string[] = [], reports: string[] = [], attempts = new Map<string, number>();
  const pick = (key: string, planned: Text | undefined, report: string): string => {
    const attempt = attempts.get(key) ?? 0;
    attempts.set(key, attempt + 1);
    if (typeof planned === "function") return planned(report);
    if (typeof planned === "string") return planned;
    const list = planned ?? ["## none\n"];
    return list[Math.min(attempt, list.length - 1)]!;
  };
  const agent = async (raw: unknown): Promise<RunAgentResult> => {
    const input = raw as DreamingAgentInput;
    inputs.push(input);
    if (script.instead?.[input.task]) return script.instead[input.task]!(input);
    input.reportRequest(REQUEST);
    let report = String(await input.tools.find(tool => tool.name === "check")!.execute({}));
    reports.push(report);
    for (let turn = 0; turn < 50; turn++) {
      const file = FILE[input.task]!.exec(report)![1]!;
      const text = input.task === "curate" ? (() => { const category = CATEGORY.exec(report)![1]!; return pick(`curate:${category}`, script.curate?.[category], report); })()
        : input.task === "verify" ? pick("verify", script.verify, report)
        : (() => {
            const ids = [...(/Items: (.*)/.exec(report)?.[1] ?? "").matchAll(/K(\d+)/g)].map(match => Number(match[1]));
            const pass = Number(/pass (\d+)/.exec(report)?.[1] ?? 1);
            return pick(`classify:${pass}`, script.classify?.(pass, ids, report) ?? ids.map(id => `K${id} 50`).join("\n") + "\n", report);
          })();
      writeFileSync(file, text);
      const message = input.passEnd();
      if (message === undefined) break;
      messages.push(message);
      report = message;
    }
    return { outcome: "success", output: "Done.", request: REQUEST, usage: { tokens: 12 }, ...(input.task === "curate" ? script.curateResult : {}) } as RunAgentResult;
  };
  return { agent, inputs, messages, reports, script };
}

/** A session whose Dreamer is `scriptedDreamer`, due at the first check. `memories` collects what the test must close. A test swaps in
 * its own runner (one that waits, or ignores a stop) for the calls that follow with `next`. */
export function dreamerFixture(memories: TraceMemory[], script: DreamerScript = {}, dbPath?: string) {
  const dreamer = scriptedDreamer(script);
  const runners: RunAgent[] = [];
  const b = workspaceBatch({ agent: raw => (runners.shift() ?? dreamer.agent)(raw), dbPath });
  memories.push(b.memory);
  b.memory.config.dreaming.triggerTokens = 1;
  const target = { sessionId: b.session.id, branch: "main", headTurnId: b.path.headTurnId!, model: "scripted" };
  const dream = () => b.memory.dream(target);
  return { ...b, dreamer, target, dream, next: (agent: RunAgent) => { runners.push(agent); } };
}
export type DreamerFixture = ReturnType<typeof dreamerFixture>;

/** The curate model of a test that does something the scripted one does not: it calls `check`, writes the batch file `check` names
 * with `text`, and meets the stop hook once. Returns the hook's answer (the next batch, or undefined when the task is over). */
export async function writeCurateBatch(input: DreamingTaskInput, text: string): Promise<string | undefined> {
  const report = String(await input.tools.find(tool => tool.name === "check")!.execute({}));
  writeFileSync(FILE.curate!.exec(report)![1]!, text);
  return input.passEnd();
}
