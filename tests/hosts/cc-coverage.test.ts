import { describe, expect, it } from "vitest";
import { ccInheritedRaw, type CcRawCandidate } from "../../src/hosts/cc/coverage.ts";
import { encodeCcInjection } from "../../src/hosts/cc/injection.ts";
import type { CcNativeRecord } from "../../src/hosts/cc/transcript.ts";

const user = (uuid: string, parentUuid: string | null, text: string): CcNativeRecord =>
  ({ uuid, parentUuid, type: "user", promptSource: "typed", message: { role: "user", content: text } });
const call = (uuid: string, parentUuid: string, id: string): CcNativeRecord =>
  ({ uuid, parentUuid, type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name: "mcp__demo__echo", input: { value: "x" } }] } });
const result = (uuid: string, parentUuid: string, id: string, text: string): CcNativeRecord =>
  ({ uuid, parentUuid, type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id,
    content: [{ type: "text", text }] }] } });
const native = [user("old", null, "old quotation"),
  { uuid: "boundary", parentUuid: "old", type: "system", subtype: "compact_boundary" },
  user("new", "boundary", "new original"), call("call", "new", "tool-1"), result("result", "call", "tool-1", "complete result")];
const candidates = native.filter(record => record.type !== "system").map(record => ({ nativeId: record.uuid!, record,
  afterBoundary: record.uuid !== "old" })) as CcRawCandidate[];
const select = (...ids: string[]) => candidates.filter(value => ids.includes(value.nativeId));
const api = [{ role: "user", content: [{ type: "text", text: "<summary>old quotation</summary>" }, { type: "text", text: "new original" }] },
  { role: "assistant", content: [{ type: "tool_use", id: "tool-1", name: "mcp__demo__echo", input: { value: "x" } }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1", content: [
    { type: "text", text: "complete result\n" }, { type: "text", text: "<system-reminder>extra</system-reminder>" }] }] }];

describe("CC inherited Raw coverage", () => {
  it("uses complete current blocks and tool IDs, not historical rows or summary quotations", () => {
    expect([...ccInheritedRaw(select("old", "new", "call", "result"), api)]).toEqual([
      ["new", "source"], ["call", "source"], ["result", "source"]]);
    const replaced = structuredClone(api);
    (replaced[2]!.content[0] as { content: { text: string }[] }).content[0]!.text = "complete resul\n";
    expect(ccInheritedRaw(select("result"), replaced).size).toBe(0);
    const wrongId = structuredClone(api);
    (wrongId[1]!.content[0] as { id: string }).id = "other";
    expect(ccInheritedRaw(select("call"), wrongId).size).toBe(0);
  });

  it("does not assign one visible assistant block to two distinct original entries", () => {
    const repeated = [user("u1", null, "first"), { ...call("a1", "u1", "one"), message: { role: "assistant", content: [{ type: "text", text: "Repeated reply" }] } },
      user("u2", "a1", "second"), { ...call("a2", "u2", "two"), message: { role: "assistant", content: [{ type: "text", text: "Repeated reply" }] } }];
    const selected = [repeated[1]!, repeated[3]!].map(record => ({ nativeId: record.uuid!, record, afterBoundary: true }));
    expect(ccInheritedRaw(selected, [{ role: "user", content: [{ type: "text", text: "second" }] },
      { role: "assistant", content: [{ type: "text", text: "Repeated reply" }] }]).size).toBe(0);
  });

  it("compares tool arguments structurally, verifies error state, and identifies parallel results by call ID", () => {
    const a = call("a", "u", "a"), b = call("b", "a", "b");
    a.message!.content = [{ type: "tool_use", name: "mcp__demo__echo", input: { outer: { first: 1, second: 2 } }, id: "a" }];
    b.message!.content = [{ type: "tool_use", id: "b", name: "mcp__demo__echo", input: { value: "x" } }];
    const first = result("r1", "b", "a", "first"), second = result("r2", "b", "b", "second");
    second.message!.content = [{ type: "tool_result", tool_use_id: "b", is_error: true,
      content: [{ type: "text", text: "second" }] }];
    const selected = [a, b, first, second].map(record => ({ nativeId: record.uuid!, record, afterBoundary: true }));
    const view = [{ role: "assistant", content: [
      { type: "tool_use", id: "a", name: "mcp__demo__echo", input: { outer: { second: 2, first: 1 } }, metadata: 1 },
      { type: "tool_use", id: "b", name: "mcp__demo__echo", input: { value: "x" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "b", is_error: true,
        content: [{ type: "text", text: "second\n" }] }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: [{ type: "text", text: "first\n" }] }] }];
    expect([...ccInheritedRaw(selected, view).keys()]).toEqual(["a", "b", "r1", "r2"]);
    const wrongName = structuredClone(view);
    (wrongName[0]!.content[0] as { name: string }).name = "mcp__demo__different";
    expect(ccInheritedRaw(selected, wrongName).has("a")).toBe(false);
    const wrongInput = structuredClone(view);
    (wrongInput[0]!.content[0] as { input: { outer: { first: number } } }).input.outer.first = 0;
    expect(ccInheritedRaw(selected, wrongInput).has("a")).toBe(false);
    const wrongError = structuredClone(view);
    delete (wrongError[1]!.content[0] as { is_error?: boolean }).is_error;
    expect(ccInheritedRaw(selected, wrongError).has("r2")).toBe(false);
    const truncated = structuredClone(view);
    (truncated[2]!.content[0] as { content: { text: string }[] }).content[0]!.text = "fir\n";
    expect(ccInheritedRaw(selected, truncated).has("r1")).toBe(false);
    const thinking = { ...a, message: { role: "assistant", content: [{ type: "thinking", thinking: "private" },
      { type: "tool_use", id: "a", name: "mcp__demo__echo", input: { outer: { first: 1, second: 2 } } }] } };
    expect(ccInheritedRaw([{ nativeId: "a", record: thinking, afterBoundary: true }], view).size).toBe(0);
    const malformed = { ...first, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "a",
      content: [{ type: "text", text: "first" }, null] }] } };
    expect(ccInheritedRaw([{ nativeId: "r1", record: malformed, afterBoundary: true }], view).size).toBe(0);
  });

  it("recognizes only an intact, recorded bounded carrier paired with the stored entry identity", () => {
    const binding = { db: "db", nativeSession: "native", coreSession: 1 };
    const text = encodeCcInjection(binding, { text: "[T1#E1@user] user: old quotation", knowledgeCommitIds: [],
      entryIds: [7], factIds: [] });
    const carrier = [{ role: "user", content: [{ type: "text", text }] }];
    const options = { binding, nativeIdForEntry: (id: number) => id === 7 ? "old" : undefined,
      recorded: () => true };
    expect(ccInheritedRaw(select("old"), carrier, options).get("old")).toBe("view");
    expect(ccInheritedRaw(select("old"), carrier, { ...options, recorded: () => false }).size).toBe(0);
    expect(ccInheritedRaw(select("old"), [{ role: "user", content: [{ type: "text", text: text.replace("old quotation", "old quote") }] }],
      options).size).toBe(0);
  });
});
