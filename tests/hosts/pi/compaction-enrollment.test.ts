import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { piSession, say, worker } from "./native-fixture.ts";
import extension from "../../../src/hosts/pi/index.ts";

// Exercise persistence, not just the hook result: Pi accepts extension commands while compacting.
test("disabling memory during recovery delegates without persisting an empty custom replacement", async () => {
  const directory = mkdtempSync(join(tmpdir(), "trace-memory-compact-off-"));
  const f = await piSession({ extensions: [extension as never], compaction: { enabled: false },
    env: { TRACE_MEMORY_CONFIG: JSON.stringify({ dbPath: join(directory, "trace.db"),
      "noting.triggerTokens": 1e9, "consolidation.triggerTokens": 1e9,
      "render.knowledgeBlockTokens": 1, "compaction.factsTokens": 1000, "compaction.rawTokens": 1, "compaction.overflowTokens": 50 }) },
    prepare: ({ agentDir }) => writeFileSync(join(agentDir, "trace-memory-baseline.json"), JSON.stringify("2000-01-01T00:00:00.000Z")) });
  try {
    f.script(() => say("ANSWER_SENTINEL"));
    await f.session.prompt("USER_SENTINEL " + "word ".repeat(3000));
    f.script((body, signal) => worker(body) ? new Promise<Response>((_, reject) => {
      const abort = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
    }) : say("NATIVE_FALLBACK_SENTINEL"));
    const attempt = f.session.compact();
    await vi.waitFor(() => expect(f.sent.some(body => worker(body))).toBe(true));
    await f.session.prompt("/trace off");
    await attempt;
    const entries = f.manager.getEntries().filter(entry => entry.type === "compaction");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.summary).toContain("NATIVE_FALLBACK_SENTINEL");
    expect(entries[0]!.details).not.toHaveProperty("traceMemory");
    expect(JSON.stringify(f.manager.buildSessionContext().messages)).toContain("NATIVE_FALLBACK_SENTINEL");
  } finally { f.dispose(); rmSync(directory, { recursive: true, force: true }); }
});
