import { expect, test } from "vitest";
import { host } from "./test-host.ts";
import { legacyFacts } from "../../support/seed.ts";

// Ticket 73, Pi reviews of c03010e and 8ac7be8: the truncation warning describes exactly the carrier
// Pi appended, and is given once it has been appended (`session_compact`). No callback runs between
// the final reprice and the carrier, and a compaction that is cancelled or never appended warns
// about nothing.
const OMITTED = "compaction omitted";

async function truncatingHost() {
  const h = host({ "noting.triggerTokens": 1_000_000, "compaction.rawTokens": 50, "compaction.sharedAllowanceTokens": 1 });
  for (let i = 0; i < 5; i++) { await h.prompt(`pending-${i} ${"word ".repeat(250)}`); await h.answer(); }
  const warnings: string[] = [];
  const notify = h.ctx.ui.notify.bind(h.ctx.ui);
  let onInfo = (_message: string) => {};
  h.ctx.ui.notify = ((message: string, level: "info" | "warning" | "error") => {
    notify(message, level);
    if (level === "warning" && message.includes(OMITTED)) warnings.push(message);
    if (level === "info") onInfo(message);
  }) as typeof h.ctx.ui.notify;
  const append = async (result: { compaction: { summary: string; details: unknown } }) => {
    const entry = { id: `compact-${h.entries.length}`, parentId: h.entries.at(-1)!.id, timestamp: "now", type: "compaction",
      summary: result.compaction.summary, firstKeptEntryId: "", tokensBefore: 100_000, details: result.compaction.details };
    h.entries.push(entry as never); h.allEntries.push(entry as never);
    await h.emit("session_compact", { compactionEntry: entry });
  };
  return { h, warnings, append, setOnInfo: (fn: (message: string) => void) => { onInfo = fn; } };
}

test("73: the truncation warning is given once Pi appends the carrier, not before", async () => {
  const { h, warnings, append } = await truncatingHost();
  try {
    const result = await h.emit("session_before_compact", { preparation: { tokensBefore: 100_000 } });
    expect(result.compaction).toBeDefined();
    expect(warnings).toEqual([]); // nothing is said while the compaction may still be cancelled
    await append(result);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("pending Raw");
  } finally { await h.dispose(); }
});

test("73: a compaction cancelled from a notification callback warns about nothing", async () => {
  const { h, warnings, setOnInfo } = await truncatingHost();
  try {
    const controller = new AbortController();
    setOnInfo(message => { if (message.includes("compaction preparing")) controller.abort(); });
    const result = await h.emit("session_before_compact", { preparation: { tokensBefore: 100_000 }, signal: controller.signal });
    expect(result).toEqual({ cancel: true });
    expect(warnings).toEqual([]);
  } finally { await h.dispose(); }
});

test("73: when the pending set changes during a callback, the warning follows the carrier Pi appends", async () => {
  const { h, warnings, append, setOnInfo } = await truncatingHost();
  try {
    // Another executor notes every pending entry while the preparing notice is shown: the first
    // allocation truncated pending Raw, the final one has nothing pending to truncate.
    setOnInfo(message => {
      if (!message.includes("compaction preparing")) return;
      const store = h.memory.store, sessionId = 1;
      const head = store.listTurns(sessionId).at(-1)!.id;
      const user = store.sourcePath(sessionId, "main", head).find(value => value.turnId === head && store.getSourceEntry(value.id)?.role === "user")!;
      legacyFacts(store, { kind: "manual", sessionId, branch: "main", createdAt: "2026-09-23T00:00:00Z" },
        [{ sources: [{ entry: user, address: `T${head}#E${user.entryOrdinal}` }], text: "noted elsewhere",
          category: "observation", actor: "user", createdAt: "2026-09-23T00:00:00Z" }],
        store.pendingEntryIds(sessionId, "main", head));
    });
    const result = await h.emit("session_before_compact", { preparation: { tokensBefore: 100_000 } });
    expect(result.compaction).toBeDefined();
    await append(result);
    expect(warnings).toEqual([]); // the appended carrier truncated nothing pending
  } finally { await h.dispose(); }
});
