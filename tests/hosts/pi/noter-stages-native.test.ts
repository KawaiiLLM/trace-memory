// Real Pi child sessions and tools, with only the provider wire scripted (155).
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { call, fixture, say, worker, type Body } from "./native-fixture.ts";
import { factsFile, knowledgeFile, withVerdicts } from "../../support/noter.ts";
const GOOD = [{ title: "Package manager", objects: ["pnpm"], sources: "[T1#E1] Use pnpm" }];
const create = { files: null, op: "create", title: "Package manager", text: "Use pnpm", category: "constraint", scope: "session", topics: [], supports: ["$1"], reason: "User ruling" };
for (const variant of ["published", "corrected-at-stop", "unfixed"] as const) test(`real Pi four-stage Noter: ${variant}`, async () => {
  const f = await fixture({ "noting.triggerTokens": 1 });
  const bodies: Body[] = [];
  let conversations = 0;
  const outside = join(f.h.dir, "outside.txt");
  try {
    f.script(body => {
      if (!worker(body)) return say("Okay.");
      const assistant = (body.messages ?? []).filter((m: Body) => m.role === "assistant").length;
      if (!assistant) conversations++;
      bodies.push(body);
      const found = /(?:File: |Inputs: )(\S+facts\.md)/.exec(JSON.stringify(body.messages));
      const facts = found?.[1] ?? "", knowledge = facts.replace(/facts\.md$/, "knowledge.md");
      const dir = facts.replace(/\/facts\.md$/, "");
      const writeFacts = (bad = false) => call("facts", "write", { path: facts, content: factsFile(GOOD).replace("T1#E1", bad ? "T1#E99" : "T1#E1") });
      const steps: (() => Response)[] = conversations === 1 ? variant === "unfixed"
        ? [() => call("check", "check", {}), () => writeFacts(true), () => say("done"), () => say("still done")]
        : [() => call("check", "check", {}), () => call("outside", "write", { path: outside, content: "escape" }), () => writeFacts(variant === "corrected-at-stop"), () => say("done"),
          ...(variant === "corrected-at-stop" ? [() => call("fix", "edit", { path: facts, edits: [{ oldText: "T1#E99", newText: "T1#E1" }] }), () => say("fixed")] : [])]
        : conversations === 2 ? [() => call("check", "check", {}), () => call("related", "read", { path: join(dir, "related-facts.md") }),
          () => call("checked-facts", "write", { path: facts, content: withVerdicts(factsFile([{ ...GOOD[0]!, title: "Package manager, verified" }])) }), () => say("verified")]
        : conversations === 3 ? [() => call("check", "check", {}), () => call("knowledge", "write", { path: knowledge, content: knowledgeFile(f.h.memory, create) }), () => say("done")]
        : [() => call("check", "check", {}), () => call("related", "read", { path: join(dir, "related-knowledge.md") }),
          () => call("checked-knowledge", "write", { path: knowledge, content: withVerdicts(knowledgeFile(f.h.memory, create)) }), () => say("verified")];
      return (steps[assistant] ?? (() => say("done")))();
    });
    await f.turn();
    await vi.waitFor(() => {
      if (variant === "unfixed") expect(f.h.memory.store.getClaim(1, "noting")).toBeNull();
      else expect(f.h.memory.progress(1, "main", 1).entries).toBe(0);
    }, { timeout: 8000 });
    const runs = f.h.memory.store.listRuns(1).filter(run => run.kind === "noting");
    expect(existsSync(outside)).toBe(false);
    expect(runs.map(run => JSON.parse(run.response!).task)).toEqual(variant === "unfixed" ? ["extract-facts"] : ["extract-facts", "check-facts", "write-knowledge", "check-knowledge"]);
    if (variant === "unfixed") {
      expect(runs.map(run => run.outcome)).toEqual(["failure"]);
      expect(JSON.parse(runs[0]!.response!).problems.join(" ")).toContain("T1#E99");
      expect(f.h.memory.store.listSessionFacts(1)).toEqual([]);
    } else {
      expect(runs.map(run => run.outcome)).toEqual(["success", "success", "success", "success"]);
      const firsts = bodies.filter(body => !(body.messages ?? []).some((m: Body) => m.role === "assistant"));
      expect(firsts).toHaveLength(4);
      for (const body of firsts.slice(1)) expect([body.messages, body.tools]).toEqual([firsts[0]!.messages, firsts[0]!.tools]);
      expect(f.h.memory.store.listSessionFacts(1).map(item => item.title)).toEqual(["Package manager, verified"]);
      expect(f.h.memory.store.currentKnowledge({ sessionId: 1, branch: "main", headTurnId: 1 }).map(item => item.revision.text)).toEqual(["Use pnpm"]);
      expect(runs.map(run => JSON.parse(run.response!).budget.steps)).toEqual([variant === "published" ? 4 : 6, 4, 3, 4]);
    }
    if (process.env.TM155_EVIDENCE) { mkdirSync(process.env.TM155_EVIDENCE, { recursive: true });
      writeFileSync(join(process.env.TM155_EVIDENCE, `pi-${variant}.json`), JSON.stringify({ bodies, runs }, null, 2)); }
  } finally { await f.dispose(); }
}, 20_000);
