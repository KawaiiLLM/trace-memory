import { expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fixture, dreamerTurn, say, worker, type Body } from "./native-fixture.ts";
import { fact, knowledge } from "../../support/seed.ts";
import { fullCheckDryRun } from "../../../src/core/dreaming/clustering.ts";

test.each([false, true])("native Pi run (full check: %s) resumes groups then scores every target in a fresh conversation", async fullCheck => {
  const f = await fixture({ "noting.triggerTokens": 1e9, "dreaming.triggerOperations": 1e9, "dreaming.groupItems": 1, "dreaming.parallelGroups": 1 });
  let interrupt = true;
  const firsts: Body[] = [];
  try {
    f.script(() => say("Recorded.")); await f.turn("Keep both rules.");
    const store = f.h.memory.store, path = store.knowledgePath(1, "main", 1);
    const entry = store.getSourceEntry(store.sourcePath(1, "main", 1)[0]!.id)!;
    const support = fact(f.h.memory, path, "Two rules", [{ entry, text: "Keep both rules." }]);
    const items = ["First rule", "Second rule"].map(title => knowledge(store, path, "project", "constraint", [support.id], title, { operation: { title } }));
    f.script(body => {
      if (!worker(body, "Dreamer")) return say("Recorded.");
      if (!body.messages.some((message: Body) => message.role === "assistant")) firsts.push(body);
      return dreamerTurn(body, undefined, interrupt && JSON.stringify(body.messages).includes("Task: curate (group 2") ? "## bogus\n" : "## none\n");
    });
    await f.h.commands.get("trace")!.handler("full-check --dry-run", f.h.ctx);
    expect(JSON.parse(f.h.notices.at(-1)!)).toMatchObject({ count: 2, groups: null, modelCalls: 0 });
    await f.h.commands.get("trace")!.handler(fullCheck ? "full-check" : "dream", f.h.ctx);
    await vi.waitFor(() => expect(store.getClaim(1, "dreaming")).toBeNull(), { timeout: 10_000 });
    const saved = store.handoff(1, "dreaming")!.detail!;
    expect(saved.groups!.map(group => !!group.run)).toEqual([true, false]);
    expect(store.getKnowledge(items[0]!.knowledgeId)!.score).toBeNull();
    expect(store.getKnowledge(items[1]!.knowledgeId)!.score).toBeNull();
    if (fullCheck) expect(fullCheckDryRun(store, path).decisions).toHaveLength(1);
    interrupt = false;
    await f.h.commands.get("trace")!.handler(fullCheck ? "full-check" : "dream", f.h.ctx);
    await vi.waitFor(() => expect(store.handoff(1, "dreaming")).toBeNull(), { timeout: 10_000 });
    expect(items.map(item => store.getKnowledge(item.knowledgeId)!.score)).toEqual([75, 75]);
    expect(items.map(item => store.getKnowledge(item.knowledgeId)!.ratings)).toEqual([
      { consequence: 4, frequency: 4, current: 4 }, { consequence: 4, frequency: 4, current: 4 }]);
    expect(store.currentKnowledge(path).map(item => item.revision.files)).toEqual([null, null]);
    const runs = store.listRuns(1).filter(run => run.kind === "dreaming").map(run => JSON.parse(run.response!));
    expect(runs.filter(run => run.task === "clustering")).toHaveLength(1);
    expect(runs.filter(run => run.task === "group").map(run => run.group)).toEqual([1, 2]);
    if (fullCheck) expect(fullCheckDryRun(store, path).decisions).toHaveLength(2);
    expect(firsts).toHaveLength(6); // notes, clustering, two groups, group retry, separate scoring
    const scoring = firsts.find(body => JSON.stringify(body.messages).includes("<scoring_input>"))!;
    expect(JSON.stringify(scoring.messages)).not.toContain("Task: curate");
    expect(JSON.stringify(scoring.messages)).toContain("Curate verdict:");
    const logs = runs.flatMap(run => run.nativeLog ? [String(run.nativeLog)] : []);
    expect(logs.length).toBe(6);
    for (const log of logs) expect(readFileSync(log, "utf8")).toContain('"role":"assistant"');
  } finally { await f.dispose(); }
}, 30_000);
