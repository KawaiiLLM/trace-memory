// Ticket 144, Stage 3: the Noter's two tasks on a real Pi child AgentSession, with the provider stubbed at the wire. What is real:
// the child's tools (Pi's own write and edit, confined to the two workspace files), the stop check and its one follow-up, the
// hand-off between the tasks and publication. What is scripted: the model's replies. Set TM144_EVIDENCE to a directory to keep each
// variant's requests.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { call, fixture, say, worker, type Body } from "./native-fixture.ts";
import { factsFile, knowledgeFile } from "../../support/noter.ts";

const GOOD = [{ title: "Episode one", sources: "[T1#E1] 用 pnpm，不要 npm" }];
const BAD = [{ title: "Episode one", sources: "[T1#E99] 用 pnpm，不要 npm" }];
const create = { op: "create", title: "Fixture title", text: "Use pnpm, never npm", category: "constraint", scope: "session", topics: [], supports: ["$1"], reason: "The user chose pnpm." };
const variants = ["published", "corrected-at-stop", "unfixed"] as const;

/** The two files of the run's workspace, from the first `check` result's step-1 file (the knowledge file sits beside it). */
const filesIn = (body: Body) => {
  const found = /File: (\S+facts\.md)/.exec(JSON.stringify(body.messages));
  return found ? { facts: found[1]!, knowledge: found[1]!.replace(/facts\.md$/, "knowledge.md") } : undefined;
};
for (const variant of variants) test(`real Pi two-task Noter: ${variant}`, async () => {
  const f = await fixture({ "noting.triggerTokens": 1 });
  const workerBodies: Body[] = [];
  let conversations = 0;
  const outside = join(f.h.dir, "outside.txt");
  try {
    f.script(body => {
      if (!worker(body)) return say("好的。");
      const assistant = (body.messages ?? []).filter((m: Body) => m.role === "assistant").length;
      if (assistant === 0) conversations++;
      workerBodies.push(body);
      const files = filesIn(body)!, task = conversations;
      // `step` is the number of assistant turns this conversation has had; a follow-up message after the stop continues the count.
      // Each task has two steps: the stop after the facts file brings the knowledge step's message, the stop after that ends the task.
      const steps: (() => Response)[] = task === 1
        ? variant === "published" ? [
            () => call("check-1", "check", {}),
            () => call("outside", "write", { path: outside, content: "escape" }),
            () => call("write-facts", "write", { path: files.facts, content: factsFile(GOOD) }),
            () => say("done"),
            () => call("write-knowledge", "write", { path: files.knowledge, content: knowledgeFile(f.h.memory, create) }),
            () => say("done")]
          : variant === "corrected-at-stop" ? [
            () => call("check-1", "check", {}),
            () => call("write-facts", "write", { path: files.facts, content: factsFile(BAD) }),
            () => say("done"),                                                                       // the stop check fails: step 1's one repair
            () => call("fix", "edit", { path: files.facts, edits: [{ oldText: "T1#E99", newText: "T1#E1" }] }),
            () => say("fixed"),
            () => call("write-knowledge", "write", { path: files.knowledge, content: "## none\n" }),
            () => say("done")]
          : [() => call("check-1", "check", {}),
            () => call("write-facts", "write", { path: files.facts, content: factsFile(BAD) }),
            () => say("done"), () => say("still done")]
        : [() => call("check-2", "check", {}), () => call("read-1", "read", { path: files.facts }),
          () => call("edit-1", "edit", { path: files.facts, edits: [{ oldText: "title: Episode one", newText: "title: Episode one, verified" }] }), () => say("verified"),
          () => say("knowledge verified")];
      return (steps[assistant] ?? (() => say("done")))();
    });
    await f.turn();
    await vi.waitFor(() => expect(f.h.memory.store.listRuns(1).filter(run => run.kind === "noting").length).toBeGreaterThanOrEqual(variant === "unfixed" ? 1 : 2), { timeout: 8000 });
    const runs = f.h.memory.store.listRuns(1).filter(run => run.kind === "noting");
    const entries = f.h.memory.store.sourcePath(1, "main", 1);
    if (process.env.TM144_EVIDENCE) { mkdirSync(process.env.TM144_EVIDENCE, { recursive: true });
      writeFileSync(join(process.env.TM144_EVIDENCE, `pi-${variant}.requests.json`), JSON.stringify(workerBodies, null, 2) + "\n"); }
    expect(existsSync(outside)).toBe(false);
    expect(f.h.memory.store.db.prepare("SELECT count(*) AS n FROM task_handoffs").get()).toEqual({ n: 0 });
    if (variant === "unfixed") {
      expect(runs.map(run => run.outcome)).toEqual(["failure"]); // the second stop check failed; task 2 never ran
      expect(JSON.parse(runs[0]!.response!).problems.join(" ")).toContain("T1#E99");
      expect(f.h.memory.store.listSessionFacts(1)).toEqual([]);
      expect(entries.some(entry => f.h.memory.store.entryNoted(entry.id))).toBe(false);
      expect(workerBodies.filter(body => JSON.stringify(body.messages).includes("Your files do not pass the check")).length).toBeGreaterThan(0);
      return;
    }
    expect(runs.map(run => [run.outcome, JSON.parse(run.response!).task])).toEqual([["success", "write"], ["success", "verify"]]);
    expect(entries.every(entry => f.h.memory.store.entryNoted(entry.id))).toBe(true);
    const sent = workerBodies.map(body => JSON.stringify(body.messages));
    expect(sent.some(text => /Trace Memory: this task may (not create directories|use only its two workspace files)/.test(text))).toBe(variant === "published"); // the outside write was refused
    // Both tasks open with the same bytes: system prompt, tool definitions and task text.
    const firsts = workerBodies.filter(body => !(body.messages ?? []).some((m: Body) => m.role === "assistant"));
    expect(firsts).toHaveLength(2);
    expect(JSON.stringify(firsts[1]!.messages)).toBe(JSON.stringify(firsts[0]!.messages));
    expect(JSON.stringify(firsts[1]!.tools)).toBe(JSON.stringify(firsts[0]!.tools));
    expect(firsts[0]!.tools.map((tool: Body) => tool.function.name)).toEqual(["search", "check", "read", "write", "edit"]);
    if (variant === "published") {
      expect(f.h.memory.store.listSessionFacts(1).map(item => item.title)).toEqual(["Episode one, verified"]); // task 2's Edit is what is published
      expect(f.h.memory.store.currentKnowledge({ sessionId: 1, branch: "main", headTurnId: 1 })).toHaveLength(1);
    } else {
      expect(sent.some(text => text.includes("Your files do not pass the check"))).toBe(true);
      expect(f.h.memory.store.listSessionFacts(1).map(item => item.source)).toEqual([["T1#E1"]]);
    }
  } finally { await f.dispose(); }
}, 20_000);
