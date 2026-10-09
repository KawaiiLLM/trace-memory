import { expect, test } from "vitest";
import { host } from "./test-host.ts";
import { fact } from "../../support/seed.ts";

// 133 R1 supersedes pending-Raw warnings. Optional omissions still describe exactly the
// carrier Pi appended, and cancelled or unappended compactions warn about nothing.
const OMITTED = "compaction omitted";

async function truncatingHost() {
  const h = host({ "noting.triggerTokens": 1, "noting.forkModeDefault": false,
    "compaction.factsTokens": 1, "compaction.rawTokens": 1,
    "compaction.sharedAllowanceTokens": 1, "compaction.temporaryTokens": 1 });
  const sourceText = `fact source ${"word ".repeat(250)}`;
  await h.prompt(sourceText); await h.answer(); await h.drain();
  expect(h.memory.store.listRuns(1).at(-1)!.outcome).toBe("success");
  expect(h.memory.pendingEntries(1, "main", 1)).toEqual([]);
  const path = h.memory.store.knowledgePath(1, "main", 1);
  const source = h.memory.store.sourcePath(1, "main", 1).map(entry => h.memory.store.getSourceEntry(entry.id)!).find(entry => entry.role === "user")!;
  fact(h.memory, path, "Optional history", [{ entry: source, text: sourceText }]);
  const warnings: string[] = [];
  const notify = h.ctx.ui.notify.bind(h.ctx.ui);
  let onInfo = (_message: string) => {};
  h.ctx.ui.notify = ((message: string, level: "info" | "warning" | "error") => {
    notify(message, level);
    if (level === "warning" && message.includes(OMITTED)) warnings.push(message);
    if (level === "info") onInfo(message);
  }) as typeof h.ctx.ui.notify;
  const append = async (result: { compaction: { summary: string; details: unknown } }) => {
    const entry = h.compaction(result.compaction.summary);
    await h.emit("session_compact", { compactionEntry: entry });
  };
  return { h, warnings, append, setOnInfo: (fn: (message: string) => void) => { onInfo = fn; } };
}

test("133 R1: an optional capacity omission warns once Pi appends its carrier, not before", async () => {
  const { h, warnings, append } = await truncatingHost();
  try {
    const result = await h.emit("session_before_compact", { preparation: { tokensBefore: 100_000 } });
    expect(result.compaction).toBeDefined();
    expect(warnings).toEqual([]);
    await append(result);
    expect(warnings).toHaveLength(1);
    expect(h.memory.pendingEntries(1, "main", 1)).toEqual([]);
    expect(warnings[0]).not.toContain("pending Raw");
  } finally { await h.dispose(); }
});

test("133 R1: a compaction cancelled from a notification callback warns about nothing", async () => {
  const { h, warnings, setOnInfo } = await truncatingHost();
  try {
    const controller = new AbortController();
    setOnInfo(message => { if (message.includes("compaction preparing")) controller.abort(); });
    const result = await h.emit("session_before_compact", { preparation: { tokensBefore: 100_000 }, signal: controller.signal });
    expect(result).toEqual({ cancel: true });
    expect(warnings).toEqual([]);
  } finally { await h.dispose(); }
});

test("133 R1: an optional omission warning follows the final repriced carrier", async () => {
  const { h, warnings, append, setOnInfo } = await truncatingHost();
  try {
    h.memory.config.compaction.factsTokens = 10_000;
    setOnInfo(message => { if (message.includes("compaction preparing")) h.memory.config.compaction.factsTokens = 1; });
    const result = await h.emit("session_before_compact", { preparation: { tokensBefore: 100_000 } });
    expect(result.compaction).toBeDefined();
    await append(result);
    expect(warnings).toHaveLength(1);
    expect(result.compaction.summary).not.toContain("fact source");
  } finally { await h.dispose(); }
});
