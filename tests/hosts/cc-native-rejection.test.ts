import { afterEach, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { installCcNativeRejectionGuard, runWithCcNativeAbortOwner } from "../../src/hosts/cc/native-rejection.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const sdkAbort = () => Object.assign(new Error("Operation aborted"), { stack:
  "Error: Operation aborted\n    at ProcessTransport.write (file:///x/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs:1:1)\n    at Query.handleControlRequest (file:///x/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs:2:2)" });
const turn = () => new Promise(resolve => setTimeout(resolve, 10));

test("native guard owns a late SDK control abort by async context and does not leak listeners", async () => {
  const baseline = process.listenerCount("unhandledRejection");
  const dispose = installCcNativeRejectionGuard();
  expect(process.listenerCount("unhandledRejection")).toBe(baseline + 1);
  const controller = new AbortController(), audit = vi.fn();
  await runWithCcNativeAbortOwner(controller.signal, audit, async () => {
    controller.abort(new Error("worker failed"));
    setTimeout(() => void Promise.reject(sdkAbort()), 0);
  });
  await turn();
  expect(audit).toHaveBeenCalledWith(expect.objectContaining({ message: "Operation aborted" }));
  dispose(); dispose();
  expect(process.listenerCount("unhandledRejection")).toBe(baseline);
});

test("concurrent native owners attribute a late abort only to its query", async () => {
  const dispose = installCcNativeRejectionGuard();
  const controllers = [new AbortController(), new AbortController(), new AbortController()];
  const audits = [vi.fn(), vi.fn(), vi.fn()];
  await Promise.all(controllers.map((controller, index) => runWithCcNativeAbortOwner(controller.signal, audits[index]!, async () => {
    if (index === 1) {
      controller.abort(new Error("only C aborted"));
      setTimeout(() => void Promise.reject(sdkAbort()), 0);
    }
  })));
  await turn();
  expect(audits.map(audit => audit.mock.calls.length)).toEqual([0, 1, 0]);
  dispose();
});

test.each([
  ["unrelated stack",  "const e=new Error('Operation aborted'); e.stack='Error: Operation aborted\\n at unrelated'; Promise.reject(e);"],
  ["unaborted owner", "Promise.reject(abortError());"],
])("native guard keeps %s fatal", (_label, body) => {
  const directory = mkdtempSync(join(tmpdir(), "tm-cc-rejection-child-")); dirs.push(directory);
  const script = join(directory, "probe.mjs");
  const module = new URL("../../src/hosts/cc/native-rejection.ts", import.meta.url).href;
  writeFileSync(script, `import {installCcNativeRejectionGuard,runWithCcNativeAbortOwner} from ${JSON.stringify(module)};\n`
    + `const abortError=()=>Object.assign(new Error('Operation aborted'),{stack:'Error: Operation aborted\\n at ProcessTransport.write (file:///x/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs:1:1)\\n at Query.handleControlRequest (file:///x/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs:2:2)'});\n`
    + `installCcNativeRejectionGuard(); const c=new AbortController(); await runWithCcNativeAbortOwner(c.signal,()=>{},async()=>{${body}}); await new Promise(r=>setTimeout(r,30));\n`);
  const child = spawnSync(process.execPath, [script], { encoding: "utf8" });
  expect(child.status).not.toBe(0);
  expect(child.stderr).toContain("Operation aborted");
});
