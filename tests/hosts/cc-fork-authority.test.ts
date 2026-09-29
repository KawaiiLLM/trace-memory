import { describe, expect, it } from "vitest";
import { CcForkAuthority } from "../../src/hosts/cc/fork-authority.ts";
import type { NotingAgentInput } from "../../src/core/api/index.ts";

const task = (signal?: AbortSignal) => ({ signal }) as NotingAgentInput;

describe("CC native Noter authority", () => {
  it("waits for the already initiated spawn registration and grants only its native agent/call pair", async () => {
    const authority = new CcForkAuthority();
    const input = task();
    const terminal = authority.begin(input);
    const first = authority.call("agent-1", "call-1", "note");
    let completed = false;
    void first.then(() => { completed = true; });
    await Promise.resolve();
    expect(completed).toBe(false);
    authority.register("agent-1");
    expect(await first).toBe(true);
    expect(await authority.call("agent-2", "call-2", "memory")).toBe(false);
    expect(await authority.call("agent-1", "call-1", "note")).toBe(false);
    expect(authority.take("call-1", "memory")).toBe("retired");
    expect(authority.take("call-1", "note")).toBe(input);
    expect(authority.take("call-1", "note")).toBe("retired");
    expect(await authority.complete("agent-2", { outcome: "success", output: "wrong" })).toBe(false);
    expect(await authority.complete("agent-1", { outcome: "success", output: "done" })).toBe(true);
    expect(await terminal).toMatchObject({ outcome: "success", output: "done" });
  });

  it("cancellation revokes pending calls, refuses late registration and cannot settle success", async () => {
    const controller = new AbortController();
    const authority = new CcForkAuthority();
    const terminal = authority.begin(task(controller.signal));
    const pending = authority.call("agent-1", "call-3", "note");
    controller.abort();
    expect(await pending).toBe(false);
    expect(await terminal).toMatchObject({ outcome: "cancelled" });
    expect(authority.take("call-3", "note")).toBeNull();
    expect(() => authority.register("agent-1")).toThrow();
    expect(await authority.complete("agent-1", { outcome: "success", output: "late" })).toBe(false);
  });

  it("only a confirmed pre-registration refusal can ask Core for one fresh re-admission", async () => {
    const authority = new CcForkAuthority();
    const refused = authority.begin(task());
    authority.noStart("native fork gate is off", true);
    expect(await refused).toMatchObject({ outcome: "failure", refused: { reason: "native fork gate is off" } });
    expect(() => authority.register("late-agent")).toThrow();
    const uncertain = authority.begin(task());
    authority.noStart("spawn response was lost", false);
    expect(await uncertain).toMatchObject({ outcome: "failure", output: "spawn response was lost" });
    expect(await uncertain).not.toHaveProperty("refused");
  });

  it("cancels only the registered native agent on abort, never on a normal terminal", async () => {
    const stopped: string[] = [], authority = new CcForkAuthority(agent => stopped.push(agent));
    const unstarted = authority.begin(task()); authority.cancel(); await unstarted;
    expect(stopped).toEqual([]);
    const controller = new AbortController(), running = authority.begin(task(controller.signal));
    authority.register("native-one"); controller.abort();
    expect(await running).toMatchObject({ outcome: "cancelled" });
    expect(stopped).toEqual(["native-one"]);
    const successful = authority.begin(task()); authority.register("native-two");
    await authority.complete("native-two", { outcome: "success", output: "done" });
    await successful;
    expect(stopped).toEqual(["native-one"]);
  });

  it("keeps an early terminal tied to its exact registered agent and releases on no-start or abort", async () => {
    const authority = new CcForkAuthority();
    const result = authority.begin(task());
    const early = authority.complete("real", { outcome: "success", output: "done" });
    const wrong = authority.complete("other", { outcome: "success", output: "wrong" });
    authority.register("real");
    expect(await early).toBe(true);
    expect(await wrong).toBe(false);
    expect(await result).toMatchObject({ outcome: "success", output: "done" });
    const refused = authority.begin(task());
    const pending = authority.complete("unknown", { outcome: "success", output: "late" });
    authority.noStart("no agent", false);
    expect(await pending).toBe(false);
    expect((await refused).outcome).toBe("failure");
  });

  it("a new executor rejects stale and mismatched fork agents while its new registered task remains writable", async () => {
    const previous = new CcForkAuthority();
    const oldRun = previous.begin(task());
    previous.register("old-agent");
    expect(await previous.call("old-agent", "old-call", "note")).toBe(true);
    previous.cancel();
    expect((await oldRun).outcome).toBe("cancelled");
    expect(previous.take("old-call", "note")).toBe("retired");

    const restarted = new CcForkAuthority();
    const input = task(), currentRun = restarted.begin(input);
    restarted.register("new-agent");
    expect(await restarted.call("old-agent", "old-call", "note")).toBe(false);
    expect(await restarted.call("unknown-agent", "unknown-call", "note")).toBe(false);
    expect(await restarted.call("main-agent", "main-call", "note")).toBe(false);
    expect(restarted.allows("old-call", "note")).toBe(false);
    expect(restarted.take("old-call", "note")).toBeNull();
    expect(await restarted.complete("old-agent", { outcome: "success", output: "stale" })).toBe(false);
    expect(await restarted.call("new-agent", "new-call", "note")).toBe(true);
    expect(restarted.take("new-call", "memory")).toBe("retired");
    expect(restarted.take("new-call", "note")).toBe(input);
    expect(restarted.take("new-call", "note")).toBe("retired");
    expect(await restarted.complete("new-agent", { outcome: "success", output: "new" })).toBe(true);
    expect((await currentRun).outcome).toBe("success");
  });

  it("retired native call IDs cannot re-enter later runs as manual calls", async () => {
    const authority = new CcForkAuthority();
    const first = authority.begin(task());
    authority.register("a");
    expect(await authority.call("a", "id", "note")).toBe(true);
    authority.cancel();
    await first;
    expect(authority.take("id", "note")).toBe("retired");
    const second = authority.begin(task());
    authority.register("b");
    expect(await authority.call("b", "id", "note")).toBe(false);
    authority.cancel();
    await second;
  });
});
