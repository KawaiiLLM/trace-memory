import { appendFileSync } from "node:fs";
import { TraceMemory } from "../../src/core/api/index.ts";
import { markCcFunctionHook, readBinding, updateBinding } from "../../src/hosts/cc/binding.ts";
import { startControlServer } from "../../src/hosts/cc/control.ts";
import { CcCoordinator } from "../../src/hosts/cc/lifecycle.ts";
import type { ResolvedCcHostConfig } from "../../src/hosts/cc/config.ts";

interface Input {
  config: ResolvedCcHostConfig;
  nativeSessionId: string;
  worker: string;
  eventsPath?: string;
  holdMs?: number;
  configPath?: string;
}

const mode = process.argv[2], encoded = process.env.CC_BINDING_CHILD_INPUT;
if (!encoded) throw new Error("CC_BINDING_CHILD_INPUT is required");
const input = JSON.parse(encoded) as Input;
const send = (message: unknown) => process.send?.(message);
const block = (milliseconds?: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);

if (mode === "update") {
  send({ type: "ready" });
  process.once("message", () => {
    send({ type: "attempting" });
    void updateBinding(input.config, input.nativeSessionId, current => {
      if (!current) throw new Error("binding disappeared in child update");
      input.eventsPath && appendFileSync(input.eventsPath, `${JSON.stringify({ event: "start", worker: input.worker })}\n`);
      send({ type: "entered" });
      block(input.holdMs);
      input.eventsPath && appendFileSync(input.eventsPath, `${JSON.stringify({ event: "end", worker: input.worker })}\n`);
      return { ...current, lastClose: { at: new Date().toISOString(), reason: input.worker, confirmed: false } };
    }).then(() => send({ type: "fulfilled" }), error => {
      send({ type: "failed", error: error instanceof Error ? error.message : String(error) }); process.exitCode = 1;
    });
  });
} else if (mode === "control") {
  const memory = TraceMemory(input.config.dbPath, async () => ({ outcome: "cancelled" as const, output: null }));
  send({ type: "ready" });
  process.once("message", () => {
    void (async () => {
      try {
        const binding = readBinding(input.config, input.nativeSessionId);
        if (!binding) throw new Error("binding disappeared before child control attach");
        const server = await startControlServer(input.config, binding, memory, undefined, undefined,
          input.worker === "reload" ? { turnEnd: async turnId => ({ turnId, prompt: "checked" }),
            catchup: async () => ({ state: "failed", entriesDone: 0, entriesTotal: 0, diagnostic: "test control" }),
            beforeCancel: () => {}, holdImport: () => () => {} } : undefined);
        send({ type: "fulfilled", executor: server.executor });
        process.once("message", () => { void server.close().finally(() => memory.close()); });
      } catch (error) {
        memory.close();
        send({ type: "rejected", error: error instanceof Error ? error.message : String(error) });
      }
    })();
  });
} else if (mode === "hook-identity") {
  void markCcFunctionHook(input.config, input.nativeSessionId).then(
    () => send({ type: "fulfilled", identity: readBinding(input.config, input.nativeSessionId)?.functionHookProcess }),
    error => send({ type: "rejected", error: error instanceof Error ? error.message : String(error) }),
  );
} else if (mode === "executor") {
  // A whole executor in its own process: the coordinator watches the configuration file it was given,
  // exactly as `cc.cjs mcp --config` starts it. Diagnostics go to the parent so a test can read them.
  const coordinator = new CcCoordinator(input.config, input.nativeSessionId, message => send({ type: "diagnostic", message }),
    undefined, undefined, input.configPath);
  void coordinator.start().then(() => send({ type: "ready" }), error => send({ type: "rejected", error: String(error) }));
  process.once("message", () => { void coordinator.shutdown("test done").then(() => send({ type: "closed" }), () => send({ type: "closed" })); });
} else {
  throw new Error(`unknown child mode ${String(mode)}`);
}
