// 137: the retrieval policy reaches the Claude Code main session as a section of its real system prompt, through
// the plugin's prompt.compose function hook. The hook answers from files already on disk (no process) and, on any
// failure, sends the prompt exactly as Claude Code composed it.
import { beforeAll, expect, test, vi } from "vitest";
import { build } from "esbuild";
import { resolve } from "node:path";
import { retrievalPolicy } from "../../src/core/render/retrieval-policy.ts";
import { ccPluginToolNames } from "../../src/hosts/cc/tool-names.ts";

type Hook = (host: any, event: any, next: any) => Promise<any>;
let compose: Hook;
beforeAll(async () => {
  const output = await build({ entryPoints: [resolve("plugin/hooks/index.tsx")], bundle: true, write: false,
    format: "esm", platform: "neutral", jsx: "transform", jsxFactory: "jsx" });
  const { register } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0]!.contents).toString("base64")}`);
  register((name: string, ...args: any[]) => { if (name === "prompt.compose") compose = args.at(-1); });
});

const CLAUDE_CODE_SECTIONS = [{ id: "intro", text: "intro", scope: "shared" }, { id: "env_info_simple", text: "env", scope: "session" }];
const binding = (enrollment: { defaultEnabled: boolean; choice: boolean | null }, coreSessionId: number | null = null) =>
  JSON.stringify({ coreSessionId, enrollment });

function host(files: Record<string, string>) {
  const read = vi.fn(async (path: string) => { if (path in files) return files[path]!; throw new Error(`ENOENT ${path}`); });
  const run = vi.fn();
  const composed = { sections: CLAUDE_CODE_SECTIONS };
  const next = vi.fn(async (_event: unknown) => composed);
  return { $: { plugin: { root: "/plugin" }, session: { id: async () => "native-1" }, fs: { read }, process: { run } }, run, next, composed };
}
const files = (bindingJson: string, status?: unknown) => ({
  "/plugin/cc.config.json": JSON.stringify({ stateDir: "/state" }),
  "/state/bindings/native-1.json": bindingJson,
  ...(status === undefined ? {} : { "/state/status/native-1.json": JSON.stringify(status) }),
});

test("memory on: one section, last and in the session scope, with Claude Code's own sections untouched", async () => {
  const h = host(files(binding({ defaultEnabled: false, choice: true })));
  const result = await compose(h.$, { traits: [] }, h.next);
  expect(result.sections).toEqual([...CLAUDE_CODE_SECTIONS,
    { id: "trace-memory-retrieval", text: retrievalPolicy(ccPluginToolNames), scope: "session" }]);
  expect(h.next).toHaveBeenCalledOnce();
  expect(h.run).not.toHaveBeenCalled(); // no process is spawned per prompt build
});

test("memory off: the prompt is returned as Claude Code composed it", async () => {
  for (const state of [binding({ defaultEnabled: true, choice: false }), binding({ defaultEnabled: false, choice: null })]) {
    const h = host(files(state));
    expect(await compose(h.$, {}, h.next)).toBe(h.composed);
  }
});

test("once a core session exists, the executor's published state decides, as for injection", async () => {
  const enrolled = binding({ defaultEnabled: true, choice: true }, 7);
  const on = host(files(enrolled, { enabled: true }));
  expect((await compose(on.$, {}, on.next)).sections.at(-1)).toMatchObject({ id: "trace-memory-retrieval" });
  const off = host(files(enrolled, { enabled: false })); // an automatic off never touches the binding
  expect(await compose(off.$, {}, off.next)).toBe(off.composed);
});

test("any failure to tell sends the prompt unchanged: no config, no binding, no status, unreadable JSON", async () => {
  const enrolled = binding({ defaultEnabled: true, choice: true }, 7);
  for (const broken of [{}, { "/plugin/cc.config.json": "{" }, files("{"), files(enrolled)]) {
    const h = host(broken as Record<string, string>);
    expect(await compose(h.$, {}, h.next)).toBe(h.composed);
  }
});
