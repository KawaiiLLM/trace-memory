import { expect, test } from "vitest";
import { toolDefinitions, renderToolDefinitions, canonicalToolNames } from "../../../src/core/api/index.ts";
import { runNative, NotForkable } from "../../../src/hosts/pi/native.ts";
import { fixture, say, type Body } from "./native-fixture.ts";

const anthropicReply = () => {
  const events = [
    { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "test", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } },
    { type: "message_stop" },
  ];
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } });
};

for (const provider of ["fake", "fakeanthropic"])
  for (const defect of ["none", "description", "drop", "nested", "root"] as const)
    test(`92: native wire schema compatibility ${provider}/${defect}`, async () => {
      const f = await fixture({ "noting.triggerTokens": 1e9 }, provider);
      try {
        f.script(() => provider === "fake" ? say("Done") : anthropicReply());
        const captured = await f.turn();
        const note = (captured.tools as Body[]).map(tool => tool.function ?? tool).find(tool => tool.name === "note")!;
        const schema = note.input_schema ?? note.parameters;
        if (defect === "description") note.description += " obsolete";
        if (defect === "drop") delete schema.properties.drop;
        if (defect === "nested") delete schema.properties.facts.items.additionalProperties;
        if (defect === "root") schema.additionalProperties = true;
        const sent = f.sent.length;
        let requests = 0;
        const task = f.task(captured, {
          tools: renderToolDefinitions(toolDefinitions.filter(tool => tool.name === "note" || tool.name === "memory"), canonicalToolNames)
            .map(tool => ({ ...tool, execute: () => { throw new Error("no tool call was scripted"); } })),
          reportToolRejection: () => { throw new Error("no tool call was scripted"); },
          onRequest: () => { requests++; },
        });
        if (defect === "none") {
          const result = await runNative(task);
          expect(result.outcome).toBe("success");
          expect(result.verification).toMatchObject({ passed: true, differingPath: null });
          expect(requests).toBe(1);
          expect(f.sent).toHaveLength(sent + 1);
          expect(captured.tools).toEqual(f.sent.at(-1)!.tools);
        } else {
          await expect(runNative(task)).rejects.toThrow(NotForkable);
          expect(requests).toBe(0);
          expect(f.sent).toHaveLength(sent);
        }
      } finally { await f.dispose(); }
    });
