import { expect, test } from "vitest";
import { host } from "./test-host.ts";

// Ticket 73 (Pi review of c03010e): the truncation warning is a host callback, and a callback may
// cancel. It is given before the final reprice, so a cancellation from it ends the compaction.
test("73: a cancellation from the truncation warning's callback cancels the compaction", async () => {
  const h = host({ "noting.triggerTokens": 1_000_000, "compaction.rawTokens": 50,
    "compaction.sharedAllowanceTokens": 1 });
  try {
    for (let i = 0; i < 5; i++) {
      await h.prompt(`pending-${i} ${"word ".repeat(250)}`);
      await h.answer();
    }
    const controller = new AbortController();
    const originalNotify = h.ctx.ui.notify.bind(h.ctx.ui);
    let warningCalled = false;
    h.ctx.ui.notify = ((message: string, level: "info" | "warning" | "error") => {
      originalNotify(message, level);
      if (level === "warning" && message.includes("compaction omitted")) {
        warningCalled = true;
        controller.abort();
      }
    }) as typeof h.ctx.ui.notify;
    const result = await h.emit("session_before_compact", {
      preparation: { tokensBefore: 100_000 }, signal: controller.signal,
    });
    expect(warningCalled).toBe(true);
    expect(controller.signal.aborted).toBe(true);
    expect(result).toEqual({ cancel: true });
  } finally {
    await h.dispose();
  }
});
