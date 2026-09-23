import { afterEach, expect, test, vi } from "vitest";
import { host, reply } from "./test-host.ts";
import { Store } from "../../../src/core/store/index.ts";

const hosts: ReturnType<typeof host>[] = [];
afterEach(async () => { for (const h of hosts.splice(0)) await h.dispose(); });
async function fixture(turns = 80) {
  const h = host({ "noting.triggerTokens": 1_000_000_000, "consolidation.triggerTokens": 1_000_000_000 });
  hosts.push(h);
  for (let index = 0; index < turns; index++) {
    h.persist({ role: "user", content: `question ${index}`, timestamp: index + 1 });
    h.persist(reply(`answer ${index}`));
  }
  await h.emit("session_start");
  return h;
}
function append(h: ReturnType<typeof host>, name: string) {
  h.persist({ role: "user", content: name, timestamp: 1000 });
  h.persist(reply(`answer ${name}`));
}

test("80: a changed leaf traverses only its native suffix and publishes only its new source tail", async () => {
  const h = await fixture();
  const store = h.memory.store;
  const branch = vi.spyOn(h.ctx.sessionManager, "getBranch");
  const entry = vi.spyOn(h.ctx.sessionManager, "getEntry");
  const full = vi.spyOn(Store.prototype, "publishSourcePath");
  const delta = vi.spyOn(Store.prototype, "appendSourcePath");
  try {
    const before = store.selectedSourceEntryIds(1, "main")!;
    append(h, "first append");
    await h.emit("tool_execution_start");
    expect(branch).not.toHaveBeenCalled();
    expect(full).not.toHaveBeenCalled();
    expect(entry.mock.calls.length).toBeLessThanOrEqual(4); // Includes the persisted host state entry.
    expect(delta).toHaveBeenCalledTimes(1);
    expect(delta.mock.calls[0]![3]).toHaveLength(2);
    expect(store.selectedSourceEntryIds(1, "main")).toEqual([...before, ...delta.mock.calls[0]![3]]);
    entry.mockClear(); delta.mockClear();
    await h.emit("tool_execution_start");
    expect(entry).not.toHaveBeenCalled();
    expect(delta).not.toHaveBeenCalled();
    expect(h.requests).toEqual([]);
  } finally { branch.mockRestore(); entry.mockRestore(); full.mockRestore(); delta.mockRestore(); }
});

test("80: a rewritten same-length same-tail prefix forces authoritative native reconstruction", async () => {
  const h = await fixture(3);
  const store = h.memory.store, before = store.selectedSourceEntryIds(1, "main")!;
  store.selectSourcePath(1, "main", [before[1]!, before[0]!, ...before.slice(2)]);
  const full = vi.spyOn(Store.prototype, "publishSourcePath"), delta = vi.spyOn(Store.prototype, "appendSourcePath");
  const branch = vi.spyOn(h.ctx.sessionManager, "getBranch");
  try {
    append(h, "after rewrite");
    await h.emit("tool_execution_start");
    expect(branch).toHaveBeenCalledTimes(1);
    expect(full).toHaveBeenCalledTimes(1);
    expect(delta).not.toHaveBeenCalled();
    expect(store.selectedSourceEntryIds(1, "main")!.slice(0, before.length)).toEqual(before);
  } finally { full.mockRestore(); delta.mockRestore(); branch.mockRestore(); }
});

test("80: a rolled-back suffix cannot remain in the host's reconciled prefix", async () => {
  const h = await fixture(3);
  const store = h.memory.store, before = store.selectedSourceEntryIds(1, "main")!;
  const original = Store.prototype.appendSourcePath;
  const delta = vi.spyOn(Store.prototype, "appendSourcePath").mockImplementationOnce(function (this: Store, ...args) {
    original.apply(this, args);
    throw new Error("fail after path publication");
  });
  append(h, "retry after rollback");
  try {
    await expect(h.emit("tool_execution_start")).rejects.toThrow("fail after path publication");
    expect(store.selectedSourceEntryIds(1, "main")).toEqual(before);
    const full = vi.spyOn(Store.prototype, "publishSourcePath");
    try {
      await h.emit("tool_execution_start");
      expect(full).toHaveBeenCalledTimes(1);
      expect(store.selectedSourceEntryIds(1, "main")).toHaveLength(before.length + 2);
      expect(h.notices.filter(value => value.includes("missing native history"))).toEqual([]);
    } finally { full.mockRestore(); }
  } finally { delta.mockRestore(); }
});
