import { expect, test } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixture, noteAndMemory, say, worker, submitted, noteBatch, settled } from "./native-fixture.ts";

const cases = ([undefined, false, true] as const).map(value => ({ key: "noting.forkModeDefault", value }));
cases.push({ key: "noting.branchModeDefault", value: true });

test.each(cases)("native Noter with saved $key=$value preserves user settings and executes the selected mode", async ({ key, value }) => {
  // General fixture: no hidden fork default. The actual user's settings are never read or written.
  const f = await fixture({ "noting.triggerTokens": 20 });
  try {
    const path = join(f.agentDir, "settings.json");
    const saved = { ...JSON.parse(readFileSync(path, "utf8")), "other-extension": { keep: true }, "trace-memory": {
      ...(value === undefined ? {} : { [key]: value }), notingModel: "fake/test-thinking", notingThinking: "high",
    } };
    writeFileSync(path, JSON.stringify(saved));
    const before = readFileSync(path, "utf8");
    await f.h.emit("session_start");
    f.h.ctx.hasUI = true;
    f.h.answers.push("Settings…", undefined);
    await f.h.commands.get("trace")!.handler("", f.h.ctx);
    const label = "Noter";
    const expected = value ? "fork" : "subagent";
    expect(f.h.dialogs.at(-1)!.options).toContain(`${label} mode: ${expected}`);
    f.h.ctx.hasUI = false;
    f.script(body => worker(body) ? submitted(body) ? say("Done.") : noteAndMemory("n", noteBatch) : say("好的。"));
    // Test configured execution against a stable parent, not a competing settled event.
    await f.turn(undefined, { settled: expected !== "fork" });
    const run = await settled(f, "noting"), audit = JSON.parse(run.response!);
    expect(run.outcome, run.response ?? "").toBe("success");
    expect(run.mode).toBe(expected);
    expect(audit.requestedMode).toBe(expected);
    expect(audit.fallbackReason).toBeUndefined();
    expect(run.model).toBe(value ? "fake/test" : "fake/test-thinking");
    expect(audit.thinking.effective).toBe(value ? "off" : "high");
    if (value) expect(audit.verification.passed).toBe(true);
    else {
      expect(audit.verification).toBeUndefined();
      const child = f.sent.find(body => worker(body, "Noting"))!;
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
