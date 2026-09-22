import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { piSession, say } from "./native-fixture.ts";
import { dreamerRecoveryExtension } from "./recovery-fixture.ts";
import { TraceMemory } from "../../../src/core/api/index.ts";

const worker = (body: unknown) => JSON.stringify(body).includes("# Dreamer");

// Exercise persistence, not just the hook result: Pi accepts extension commands while compacting.
test("disabling memory during recovery delegates without persisting an empty custom replacement", async () => {
  const directory = mkdtempSync(join(tmpdir(), "trace-memory-compact-off-"));
  const f = await piSession({ extensions: [dreamerRecoveryExtension(join(directory, "trace.db")) as never], compaction: { enabled: false },
    env: { TRACE_MEMORY_CONFIG: JSON.stringify({ dbPath: join(directory, "trace.db"),
      "noting.triggerTokens": 1, "consolidation.triggerTokens": 1,
      "compaction.factsTokens": 1, "compaction.rawTokens": 1}) },
    prepare: ({ agentDir }) => writeFileSync(join(agentDir, "trace-memory-baseline.json"), JSON.stringify("2000-01-01T00:00:00.000Z")) });
  try {
    await f.session.prompt("/trace off");
    f.script(() => say("ANSWER_SENTINEL"));
    for (let i = 0; i < 10; i++) await f.session.prompt(`USER_SENTINEL_${i} ` + "word ".repeat(3000));
    f.sent.length = 0;
    await f.session.prompt("/trace on");
    const memory = TraceMemory(join(directory, "trace.db"), async () => { throw new Error("no worker expected"); });
    memory.setKnowledgeBudget("global", 0);
    memory.setKnowledgeBudget("project", 0);
    memory.setKnowledgeBudget("session", 0);
    memory.close();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    f.script(async body => { expect(worker(body)).toBe(false); await held; return say("NATIVE_FALLBACK_SENTINEL"); });
    const attempt = f.session.compact();
    await vi.waitFor(() => expect(f.sent).toHaveLength(2));
    await f.session.prompt("/trace off");
    release();
    await attempt;
    const entries = f.manager.getEntries().filter(entry => entry.type === "compaction");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.summary).toContain("NATIVE_FALLBACK_SENTINEL");
    expect(entries[0]!.details).not.toHaveProperty("traceMemory");
    expect(JSON.stringify(f.manager.buildSessionContext().messages)).toContain("NATIVE_FALLBACK_SENTINEL");
  } finally { f.dispose(); rmSync(directory, { recursive: true, force: true }); }
});
