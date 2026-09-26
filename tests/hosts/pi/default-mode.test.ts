import { expect, test } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixture, call, noteAndMemory, say, worker, submitted, toolResults, noteBatch, memoryBatch, settled } from "./native-fixture.ts";
import { recorded } from "../../source-fixture.ts";

const cases = (["noting", "consolidation"] as const).flatMap(phase =>
  ([undefined, false, true] as const).map(value => ({ phase, key: `${phase}.forkModeDefault`, value })));
cases.push({ phase: "noting", key: "noting.branchModeDefault", value: true });

test.each(cases)("native $phase with saved $key=$value preserves user settings and executes the selected mode", async ({ phase, key, value }) => {
  // General fixture: no hidden fork default. The actual user's settings are never read or written.
  const f = await fixture({ "noting.triggerTokens": phase === "noting" ? 20 : 1e9, "consolidation.triggerTokens": phase === "consolidation" ? 1 : 1e9 });
  try {
    const path = join(f.agentDir, "settings.json");
    const saved = { ...JSON.parse(readFileSync(path, "utf8")), "other-extension": { keep: true }, "trace-memory": {
      ...(value === undefined ? {} : { [key]: value }), [`${phase}Model`]: "fake/test-thinking", [`${phase}Thinking`]: "high",
    } };
    writeFileSync(path, JSON.stringify(saved));
    const before = readFileSync(path, "utf8");
    await f.h.emit("session_start");
    f.h.ctx.hasUI = true;
    f.h.answers.push("Settings…", undefined);
    await f.h.commands.get("trace")!.handler("", f.h.ctx);
    const label = phase === "noting" ? "Noter" : "Consolidator";
    const expected = value ? "fork" : "subagent";
    expect(f.h.dialogs.at(-1)!.options).toContain(`${label} mode: ${expected}`);
    f.h.ctx.hasUI = false;
    f.script(body => worker(body, "Consolidation")
      ? toolResults(body) >= 2 ? say("Integrated.") : call(`m${toolResults(body)}`, "memory", memoryBatch)
      : worker(body) ? submitted(body) ? say("Done.") : noteAndMemory("n", noteBatch) : say("好的。"));
    await f.turn();
    if (phase === "consolidation") {
      f.h.memory.tools({ kind: "manual", sessionId: 1, branch: "main", currentTurnId: 1 })
        .find(t => t.name === "note")!.execute(noteBatch);
      recorded(f.h.memory, 1, "main", 1);
      await f.turn("tick");
    }
    const run = await settled(f, phase), audit = JSON.parse(run.response!);
    expect(run.outcome, run.response ?? "").toBe("success");
    expect(run.mode).toBe(expected);
    expect(audit.requestedMode).toBe(expected);
    expect(audit.fallbackReason).toBeUndefined();
    expect(run.model).toBe(value ? "fake/test" : "fake/test-thinking");
    expect(audit.thinking.effective).toBe(value ? "off" : "high");
    if (value) expect(audit.verification.passed).toBe(true);
    else {
      expect(audit.verification).toBeUndefined();
      const child = f.sent.find(body => worker(body, phase === "noting" ? "Noting" : "Consolidation"))!;
      expect(child.tools.map((t: { function: { name: string } }) => t.function.name)).toEqual(["trace", "search", "note", "memory"]);
      expect(JSON.parse(readFileSync(audit.nativeLog, "utf8").split("\n")[0]!).parentSession).toBeUndefined();
    }
    await f.h.emit("session_start"); // reopen preserves explicit choices, including the alias
    f.h.ctx.hasUI = true;
    f.h.answers.push("Settings…", undefined);
    await f.h.commands.get("trace")!.handler("", f.h.ctx);
    expect(f.h.dialogs.at(-1)!.options).toContain(`${label} mode: ${expected}`);
    expect(readFileSync(path, "utf8")).toBe(before);
  } finally { await f.dispose(); }
});
