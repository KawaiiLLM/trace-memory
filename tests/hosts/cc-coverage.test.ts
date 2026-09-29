import { describe, expect, it } from "vitest";
import { ccOriginalRaw, type CcOriginalCandidate } from "../../src/hosts/cc/coverage-original.ts";
import { encodeCcInjection } from "../../src/hosts/cc/injection.ts";
import type { CcNativeRecord } from "../../src/hosts/cc/transcript.ts";

const user = (uuid: string, parentUuid: string | null, text: string): CcNativeRecord =>
  ({ uuid, parentUuid, type: "user", promptSource: "typed", message: { role: "user", content: text } });
const call = (uuid: string, parentUuid: string, id: string): CcNativeRecord =>
  ({ uuid, parentUuid, type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name: "mcp__demo__echo", input: { value: "x" } }] } });
const result = (uuid: string, parentUuid: string, id: string, text: string): CcNativeRecord =>
  ({ uuid, parentUuid, type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id,
    content: [{ type: "text", text }] }] } });
const candidate = (record: CcNativeRecord, kind: CcOriginalCandidate["kind"], afterBoundary = true): CcOriginalCandidate =>
  ({ nativeId: record.uuid!, record, kind, afterBoundary });
const old = user("old", null, "old quotation");
const candidates = [candidate(old, "user", false), candidate(user("new", "boundary", "new original"), "user"),
  candidate(call("call", "new", "tool-1"), "assistant"), candidate(result("result", "call", "tool-1", "complete result"), "toolResult")];
const select = (...ids: string[]) => candidates.filter(value => ids.includes(value.nativeId));
const api = [{ role: "user", content: [{ type: "text", text: "<summary>old quotation</summary>" }, { type: "text", text: "new original" }] },
  { role: "assistant", content: [{ type: "tool_use", id: "tool-1", name: "mcp__demo__echo", input: { value: "x" } }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1", content: [
    { type: "text", text: "complete result\n" }, { type: "text", text: "<system-reminder>extra</system-reminder>" }] }] }];

describe("CC original Raw coverage", () => {
  it("uses complete current blocks and tool IDs, not historical rows, quotations or compact carriers", () => {
    expect([...ccOriginalRaw(select("old", "new", "call", "result"), api)]).toEqual([
      ["new", "source"], ["call", "source"], ["result", "source"]]);
    const replaced = structuredClone(api);
    (replaced[2]!.content[0] as { content: { text: string }[] }).content[0]!.text = "complete resul\n";
    expect(ccOriginalRaw(select("result"), replaced).size).toBe(0);
    const wrongId = structuredClone(api);
    (wrongId[1]!.content[0] as { id: string }).id = "other";
    expect(ccOriginalRaw(select("call"), wrongId).size).toBe(0);
    const text = encodeCcInjection({ db: "db", nativeSession: "native", coreSession: 1 }, {
      text: "[T1#E1@user] user: old quotation", knowledgeCommitIds: [], entryIds: [7], factIds: [] });
    const carrier = [{ role: "user", content: [{ type: "text", text }] }];
    expect(ccOriginalRaw(select("old"), carrier).size).toBe(0);
    expect(ccOriginalRaw([candidate(old, "user")], carrier).size).toBe(0);
  });

  it("does not assign one visible assistant block to two distinct original entries", () => {
    const repeated = [user("u1", null, "first"), { ...call("a1", "u1", "one"), message: { role: "assistant", content: [{ type: "text", text: "Repeated reply" }] } },
      user("u2", "a1", "second"), { ...call("a2", "u2", "two"), message: { role: "assistant", content: [{ type: "text", text: "Repeated reply" }] } }];
    const selected = [repeated[1]!, repeated[3]!].map(record => candidate(record, "assistant"));
    expect(ccOriginalRaw(selected, [{ role: "user", content: [{ type: "text", text: "second" }] },
      { role: "assistant", content: [{ type: "text", text: "Repeated reply" }] }]).size).toBe(0);
  });

  it("compares tool arguments structurally, verifies error state, and identifies parallel results by call ID", () => {
    const a = call("a", "u", "a"), b = call("b", "a", "b");
    a.message!.content = [{ type: "tool_use", name: "mcp__demo__echo", input: { outer: { first: 1, second: 2 } }, id: "a" }];
    b.message!.content = [{ type: "tool_use", id: "b", name: "mcp__demo__echo", input: { value: "x" } }];
    const first = result("r1", "b", "a", "first"), second = result("r2", "b", "b", "second");
    second.message!.content = [{ type: "tool_result", tool_use_id: "b", is_error: true,
      content: [{ type: "text", text: "second" }] }];
    const selected = [candidate(a, "assistant"), candidate(b, "assistant"), candidate(first, "toolResult"), candidate(second, "toolResult")];
    const view = [{ role: "assistant", content: [
      { type: "tool_use", id: "a", name: "mcp__demo__echo", input: { outer: { second: 2, first: 1 } }, metadata: 1 },
      { type: "tool_use", id: "b", name: "mcp__demo__echo", input: { value: "x" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "b", is_error: true,
        content: [{ type: "text", text: "second\n" }] }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: [{ type: "text", text: "first\n" }] }] }];
    expect([...ccOriginalRaw(selected, view).keys()]).toEqual(["a", "b", "r1", "r2"]);
    const wrongName = structuredClone(view);
    (wrongName[0]!.content[0] as { name: string }).name = "mcp__demo__different";
    expect(ccOriginalRaw(selected, wrongName).has("a")).toBe(false);
    const wrongInput = structuredClone(view);
    (wrongInput[0]!.content[0] as { input: { outer: { first: number } } }).input.outer.first = 0;
    expect(ccOriginalRaw(selected, wrongInput).has("a")).toBe(false);
    const wrongError = structuredClone(view);
    delete (wrongError[1]!.content[0] as { is_error?: boolean }).is_error;
    expect(ccOriginalRaw(selected, wrongError).has("r2")).toBe(false);
    const truncated = structuredClone(view);
    (truncated[2]!.content[0] as { content: { text: string }[] }).content[0]!.text = "fir\n";
    expect(ccOriginalRaw(selected, truncated).has("r1")).toBe(false);
    const thinking = { ...a, message: { role: "assistant", content: [{ type: "thinking", thinking: "private" },
      { type: "tool_use", id: "a", name: "mcp__demo__echo", input: { outer: { first: 1, second: 2 } } }] } };
    expect(ccOriginalRaw([candidate(thinking, "assistant")], view).size).toBe(0);
    const malformed = { ...first, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "a",
      content: [{ type: "text", text: "first" }, null] }] } };
    expect(ccOriginalRaw([candidate(malformed, "toolResult")], view).size).toBe(0);
  });
});
