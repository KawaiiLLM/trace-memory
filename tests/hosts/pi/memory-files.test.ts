// 101: Pi's same-name `read` and `grep` serve /tm from Trace Memory and hand every other path to Pi's
// own tools; `edit` and `write` under /tm are refused; a `read` or `grep` another extension registered
// first is reported. A real Pi AgentSession with the real extension and a scripted provider.
import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import zlib from "node:zlib";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../../../src/hosts/pi/index.ts";
import { MEMORY_READ_ONLY, TraceMemory } from "../../../src/core/api/index.ts";
import { entry, fact, knowledge, session } from "../../support/seed.ts";
import { call, piSession, say, type Body } from "./native-fixture.ts";

/** A minimal solid-color PNG, larger than Pi's default 2000x2000 resize ceiling, so the delegated
 * `read`'s handling of `autoResizeImages` (a dimension note added, or not) is directly observable. */
function solidPng(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const typeBuf = Buffer.from(type, "ascii"), len = Buffer.alloc(4), crc = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0); crc.writeUInt32BE(zlib.crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([len, typeBuf, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2; // 8-bit depth, RGB
  const rowLen = 1 + width * 3, raw = Buffer.alloc(rowLen * height, 0);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const p = y * rowLen + 1 + x * 3; raw[p] = 200; raw[p + 1] = 30; raw[p + 2] = 30; }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** A database holding one global knowledge item from another session, visible to any reader. */
function seeded() {
  const dir = mkdtempSync(join(tmpdir(), "tm-pi-files-")); dirs.push(dir);
  const dbPath = join(dir, "trace.db");
  const memory = TraceMemory(dbPath, async () => { throw new Error("no model work"); });
  try {
    const project = memory.store.createProject({ name: "seed", declaredBy: "mark" }), s = session(memory.store, project.id, "pi:seed");
    const turn = memory.store.appendTurn({ sessionId: s.id, kind: "turn", startedAt: "2026-09-21T00:00:00.000Z" });
    const source = entry(memory.store, s.id, turn.id, "seed-1", "user", "Use pnpm, never npm.");
    memory.selectEntries(s.id, "main", [source.id]);
    const path = { sessionId: s.id, branch: "main", headTurnId: turn.id };
    knowledge(memory.store, path, "global", "constraint", [fact(memory, path, "Package manager", [{ entry: source, text: "The user rules pnpm." }]).id],
      "Use pnpm, never npm.");
  } finally { memory.close(); }
  return { dir, dbPath };
}
const results = (body: Body) => new Map((body.messages ?? []).filter((m: Body) => m.role === "tool")
  .map((m: Body) => [m.tool_call_id, typeof m.content === "string" ? m.content : m.content.map((c: Body) => c.text).join("")]));

test("the main agent reads /tm through read and grep, other paths reach Pi's own tools, and writes under /tm are refused", async () => {
  const { dir, dbPath } = seeded();
  const real = join(dir, "real.txt");
  writeFileSync(real, "a real file line\n");
  const f = await piSession({ extensions: [extension], activeTools: ["read", "grep", "write"], env: { TRACE_MEMORY_CONFIG: JSON.stringify({ dbPath }) } });
  try {
    const script = [
      call("tm_read", "read", { path: "/tm/knowledge" }),
      call("tm_grep", "grep", { pattern: "pnpm", path: "/tm/knowledge-all" }),
      call("tm_lines", "grep", { pattern: "never", path: "/tm/knowledge-all", ignoreCase: true, output_mode: "content" }),
      call("real_read", "read", { path: real }),
      call("tm_write", "write", { path: "/tm/K1", content: "overwrite" }),
      say("done"),
    ];
    f.script(body => script[(body.messages ?? []).filter((m: Body) => m.role === "assistant").length]!);
    await f.session.prompt("Read your memory under /tm.");
    const seen = results(f.sent.at(-1)!);
    expect(seen.get("tm_read")).toMatch(/^\/tm\/K1  \[constraint\/global\] Use pnpm, never npm\.$/m);
    expect(seen.get("tm_grep")).toBe("/tm/K1@v1");
    expect(seen.get("tm_lines")).toMatch(/^\/tm\/K1@v1:1:\[K1#[a-z]+\] \[K1@v1\] \[constraint\/global\] Use pnpm, never npm\.$/);
    expect(seen.get("real_read")).toContain("a real file line");
    expect(seen.get("tm_write")).toContain(MEMORY_READ_ONLY);
    // The model saw one read and one grep: Pi's own, extended for /tm.
    const tools = (f.sent[0]!.tools ?? []).map((tool: Body) => tool.function?.name ?? tool.name);
    expect(tools.filter((name: string) => name === "read" || name === "grep")).toEqual(["read", "grep"]);
  } finally { f.dispose(); }
});

test("a delegated read of a path outside /tm honors the user's autoResizeImages setting, on and off", async () => {
  const { dbPath } = seeded();
  for (const autoResize of [false, true]) {
    const dir = mkdtempSync(join(tmpdir(), "tm-pi-image-")); dirs.push(dir);
    const image = join(dir, "big.png");
    writeFileSync(image, solidPng(2500, 2500));
    const f = await piSession({ extensions: [extension], activeTools: ["read", "grep"],
      env: { TRACE_MEMORY_CONFIG: JSON.stringify({ dbPath }) }, settings: { images: { autoResize } } });
    try {
      const script = [call("img_read", "read", { path: image }), say("done")];
      f.script(body => script[(body.messages ?? []).filter((m: Body) => m.role === "assistant").length]!);
      await f.session.prompt("Read the image.");
      const text = results(f.sent.at(-1)!).get("img_read")!;
      if (autoResize) expect(text).toContain("[Image: original 2500x2500, displayed at 2000x2000.");
      else { expect(text).toContain("Read image file [image/png]"); expect(text).not.toContain("[Image: original"); }
    } finally { f.dispose(); }
  }
});

test("a read or grep another extension registered first is reported with what it costs", async () => {
  const { dbPath } = seeded();
  const other = (pi: ExtensionAPI) => pi.registerTool({ name: "read", label: "read", description: "Another extension's read.",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } as never,
    async execute() { return { content: [{ type: "text", text: "not memory" }], details: {} }; } });
  const notices: string[] = [];
  const ui = { notify: (text: string) => { notices.push(text); }, setStatus() {}, setWidget() {}, setFooter() {}, setTitle() {} };
  for (const extensions of [[other, extension], [extension]]) {
    notices.length = 0;
    // Pi 0.87.1 lists the clash among its load diagnostics; Trace Memory says what it costs.
    const f = await piSession({ extensions, activeTools: ["read", "grep"], env: { TRACE_MEMORY_CONFIG: JSON.stringify({ dbPath }) },
      extensionErrors: extensions.length === 2 ? [{ path: "<inline:2>", error: 'Tool "read" conflicts with <inline:1>' }] : [] });
    try {
      await f.session.bindExtensions({ uiContext: ui as never });
      const conflicts = notices.filter(text => text.includes("registered") && text.includes("first"));
      if (extensions.length === 2) expect(conflicts).toEqual([expect.stringMatching(/registered read first.*read cannot read Trace Memory under \/tm\//)]);
      else expect(conflicts).toEqual([]);
    } finally { f.dispose(); }
  }
});
