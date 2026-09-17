import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

const sourceFiles = (directory: string): string[] => readdirSync(directory, { withFileTypes: true })
  .flatMap(entry => entry.isDirectory() ? sourceFiles(join(directory, entry.name))
    : entry.name.endsWith(".ts") ? [join(directory, entry.name)] : []);

test("53: core has no host import or concrete Pi visibility format", () => {
  const files = sourceFiles("src/core");
  const sources = files.map(path => ({ path, text: readFileSync(path, "utf8") }));
  for (const { path, text } of sources) {
    expect(text, `${path} imports a host`).not.toMatch(/from\s+["'][^"']*(?:\/hosts\/|\.\.\/\.\.\/hosts\/)/);
    for (const concrete of ["custom_message", "details.traceMemory", "VisibleBinding", "ContextEntry", "visibleView"])
      expect(text, `${path} contains host visibility format/type ${concrete}`).not.toContain(concrete);
  }
});
