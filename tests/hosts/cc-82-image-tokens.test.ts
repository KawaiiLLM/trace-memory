import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { estimateCcImageTokens } from "../../src/hosts/cc/image-tokens.ts";

const fixture = (name: string, mime: string) => ({
  type: "image", source: { type: "base64", media_type: mime,
    data: readFileSync(fileURLToPath(new URL(`./fixtures/cc82/${name}`, import.meta.url))).toString("base64") },
});
const scan = fixture("scan-1075x1520.png", "image/png");
const screenshot = fixture("screenshot-3840x2160.jpg", "image/jpeg");

test("actual PNG and JPEG headers drive model-tier resizing, not encoded byte length", () => {
  // Official standard A4 example: 1075×1520 → 924×1307 → 33×47 patches.
  expect(estimateCcImageTokens(scan, "claude-sonnet-4-6")).toBe(1551);
  expect(estimateCcImageTokens(scan, "claude-3-7-sonnet-20250219")).toBe(1551);
  expect(estimateCcImageTokens(scan, "claude-3-opus-20240229")).toBe(1551);
  expect(estimateCcImageTokens(scan, "claude-sonnet-4-20250514")).toBe(1551);
  expect(estimateCcImageTokens(scan, "claude-opus-5-5[1m]")).toBe(2145);
  // Official 4K examples: standard 1456×819, high 2576×1449.
  expect(estimateCcImageTokens(screenshot, "claude-sonnet-4-6")).toBe(1560);
  expect(estimateCcImageTokens(screenshot, "claude-opus-4-7")).toBe(4784);
  expect(estimateCcImageTokens(screenshot, "claude-opus-5-5[1m]")).toBe(4784);
});

test("unsupported sources, corrupt sizes, documents and unknown models remain unavailable", () => {
  const base = scan.source;
  for (const block of [
    { type: "image", source: { ...base, data: "not an image" } },
    { type: "image", source: { type: "url", url: "https://example.test/image.png" } },
    { type: "image", source: { type: "file", file_id: "file_123" } },
    { type: "document", source: base },
    { type: "image", source: { ...base, media_type: "image/jpeg" } },
  ]) expect(estimateCcImageTokens(block, "claude-sonnet-5")).toBeNull();
  expect(estimateCcImageTokens(scan, undefined)).toBeNull();
  expect(estimateCcImageTokens(scan, "sonnet")).toBeNull();
  expect(estimateCcImageTokens(scan, "custom-provider/claude-sonnet-5")).toBeNull();
});

test("a small real image avoids resizing on either tier", () => {
  // Both large real fixtures exercise resizing elsewhere; use a tiny embedded PNG fixture here.
  const image = { type: "image", source: { type: "base64", media_type: "image/png",
    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==" } };
  expect(estimateCcImageTokens(image, "claude-sonnet-4-6")).toBe(1);
  expect(estimateCcImageTokens(image, "claude-sonnet-5")).toBe(1);
});
