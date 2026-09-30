import { expect, test } from "vitest";
import { build } from "esbuild";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
// @ts-expect-error The production build script is plain JavaScript without a declaration.
import { promptLoader } from "../../scripts/build-cc.mjs";
import { loadPrompt } from "../../src/core/prompts/load.ts";
import { ccPluginToolNames, ccWorkerToolNames } from "../../src/hosts/cc/tool-names.ts";

test("the standalone CC bundle expands shared blocks but renders exposed names at launch", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-prompt-bundle-"));
  try {
    const entry = join(dir, "entry.mjs"), outfile = join(dir, "bundle.mjs");
    writeFileSync(entry, `export { loadPrompt } from ${JSON.stringify(fileURLToPath(new URL("../../src/core/prompts/load.ts", import.meta.url)))};\n`);
    await build({ entryPoints: [entry], outfile, bundle: true, platform: "node", format: "esm", plugins: [promptLoader] });
    const { loadPrompt: bundled } = await import(pathToFileURL(outfile).href);
    for (const file of ["noting.md", "dreaming.md"] as const) {
      for (const names of [ccWorkerToolNames, ccPluginToolNames]) {
        expect(bundled(file, names)).toBe(loadPrompt(file, names));
        expect(bundled(file, names)).toContain(names.memory);
        expect(bundled(file, names)).not.toContain("{{tool.");
        expect(bundled(file, names)).not.toContain("<!-- include:");
      }
    }
    expect(bundled("noting.md", ccWorkerToolNames)).not.toBe(bundled("noting.md", ccPluginToolNames));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
