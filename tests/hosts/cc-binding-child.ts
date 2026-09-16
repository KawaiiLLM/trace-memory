import { appendFileSync } from "node:fs";
import { TraceMemory } from "../../src/core/api/index.ts";
import { readBinding, updateBinding } from "../../src/hosts/cc/binding.ts";
import { startControlServer } from "../../src/hosts/cc/control.ts";
import type { ResolvedCcHostConfig } from "../../src/hosts/cc/config.ts";

interface Input {
  config: ResolvedCcHostConfig;
  nativeSessionId: string;
  worker: string;
  eventsPath?: string;
  holdMs?: number;
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
        const server = await startControlServer(input.config, binding, memory);
        send({ type: "fulfilled", executor: server.executor });
        process.once("message", () => { void server.close().finally(() => memory.close()); });
      } catch (error) {
        memory.close();
        send({ type: "rejected", error: error instanceof Error ? error.message : String(error) });
      }
    })();
  });
} else {
  throw new Error(`unknown child mode ${String(mode)}`);
}
