import { writeFileSync } from "node:fs";
import type { DreamingAgentInput, RunAgentResult } from "../../src/core/api/index.ts";
import { REQUEST } from "./noter.ts";

/** A scripted Dreamer (ticket 144, stage 4): the stand-in for the model behind `runAgent` in tests that run the real Dreaming
 * tasks. Like a host, it calls `check`, writes the file `check` names, meets the stop hook after every pass and follows the next
 * batch it is handed. The test states only WHAT each batch file holds, by category: file text, or a list of texts when the
 * first attempt is expected to fail the check and the repair should say something else. A category with no entry writes `## none`. */
export interface DreamerScript {
  /** The curate batch files by category. */
  curate?: Partial<Record<string, string | readonly string[] | ((message: string) => string)>>;
  /** Result of the curate conversation (a failure, a cancellation); absent: success. */
  curateResult?: Partial<RunAgentResult>;
  /** Run instead of the scripted conversation, with the input (a runner that hangs or ignores abort). */
  instead?: (input: DreamingAgentInput) => Promise<RunAgentResult> | RunAgentResult;
}

const FILE = /File: (\S+?\.md)/;
const CATEGORY = /category (\w+)/;

export function scriptedDreamer(script: DreamerScript = {}) {
  script.curate ??= {}; // a test may fill in a batch after the run is built
  const inputs: DreamingAgentInput[] = [], messages: string[] = [], reports: string[] = [], attempts = new Map<string, number>();
  const agent = async (raw: unknown): Promise<RunAgentResult> => {
    const input = raw as DreamingAgentInput;
    inputs.push(input);
    if (script.instead) return script.instead(input);
    if (input.task !== "curate") throw new Error(`the scripted Dreamer has no script for ${input.task}`);
    input.reportRequest(REQUEST);
    let report = String(await input.tools.find(tool => tool.name === "check")!.execute({}));
    reports.push(report);
    for (let turn = 0; turn < 50; turn++) {
      const category = CATEGORY.exec(report)![1]!, file = FILE.exec(report)![1]!;
      const planned = script.curate?.[category];
      const attempt = attempts.get(category) ?? 0;
      attempts.set(category, attempt + 1);
      const text = typeof planned === "function" ? planned(report) : typeof planned === "string" ? planned
        : (planned ?? ["## none\n"])[Math.min(attempt, (planned ?? ["## none\n"]).length - 1)]!;
      writeFileSync(file, text);
      const message = input.passEnd();
      if (message === undefined) break;
      messages.push(message);
      report = message;
    }
    return { outcome: "success", output: "Done.", request: REQUEST, usage: { tokens: 12 }, ...script.curateResult } as RunAgentResult;
  };
  return { agent, inputs, messages, reports, script };
}
