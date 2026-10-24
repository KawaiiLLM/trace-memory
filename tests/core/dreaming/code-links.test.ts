import { expect, test } from "vitest";
import { symbolText } from "../../../src/core/dreaming/code-links.ts";

test("symbol boundaries ignore strings, nested templates, comments and regular expression braces", () => {
  const declaration = 'export function target(): { value: string } | null {\n  const text = `outer ${`inner ${"}"}`} tail`;\n  const re = /[{}]/; // }\n  /* } */ return { value: text.replace(re, "}") };\n}';
  expect(symbolText(`${declaration}\nexport function other() { return 2; }`, "target")).toBe(declaration);
});

test("a negated regular expression does not truncate the enclosing function", () => {
  const declaration = "function target(x) {\n return !/}/.test(x);\n return 1;\n}";
  expect(symbolText(declaration, "target")).toBe(declaration);
});

test("class-qualified methods distinguish repeated names and stop before the next method", () => {
  const first = 'close(): void { this.open = false; }', second = 'close(): void { this.done = true; }';
  const source = `class First {\n  ${first}\n  get state() { return this.open; }\n}\nclass Second {\n  ${second}\n}`;
  expect(symbolText(source, "First.close")).toBe(first);
  expect(symbolText(source, "Second.close")).toBe(second);
  expect(symbolText(source, "close")).toBeUndefined();
  expect(symbolText(source, "First.state")).toBe("get state() { return this.open; }");
  expect(symbolText(source, "First.missing")).toBeUndefined();
});

test("generic class constraints do not hide the class body or its methods", () => {
  const declaration = "class Target<T extends { id: string }> {\n method() { return 1; }\n}";
  expect(symbolText(declaration, "Target")).toBe(declaration);
  expect(symbolText(declaration, "Target.method")).toBe("method() { return 1; }");
});

test("const arrows include their complete expression but not adjacent declarations", () => {
  const arrow = 'target = (value: { text: string; count: number }) => ({ text: value.text, count: value.count })';
  expect(symbolText(`export const ${arrow};\nconst render = () =>\n  target({ text: "x", count: 1 }).text;\nconst unrelated = 2;`, "target")).toBe(arrow);
  expect(symbolText("const value = 2;", "value")).toBeUndefined();
});

test.each([
  "target = () => 1",
  "target = () =>\n  1 +\n  2",
  "target = () => value\n  .map(x => x + 1)",
])("a semicolonless arrow excludes the following declaration: %s", arrow => {
  expect(symbolText(`const ${arrow}\nconst other = () => 2\n`, "target")).toBe(arrow);
});

test("a typed arrow tracks its implementation rather than its type annotation", () => {
  const arrow = "target: () => { value: number } = () => ({ value: 1 })";
  expect(symbolText(`const ${arrow};`, "target")).toBe(arrow);
});

test("return types and non-null division do not truncate a function", () => {
  const declaration = 'export function ratio(value: number | null): Map<string, { ratio: number }> {\n  return new Map([["value", { ratio: value! / 100 }]]);\n}';
  expect(symbolText(declaration, "ratio")).toBe(declaration);
  expect(symbolText(declaration, "missing")).toBeUndefined();
});

test("private and computed class methods retain their declaration names and complete bodies", () => {
  const privateMethod = "#refresh(value: number): void { this.total += value; }";
  const iterator = "[Symbol.asyncIterator](): AsyncIterator<number> { return { next: async () => ({ value: 1, done: false }) }; }";
  const source = `class Queue {\n  ${privateMethod}\n  ${iterator}\n}`;
  expect(symbolText(source, "Queue.#refresh")).toBe(privateMethod);
  expect(symbolText(source, "Queue.[Symbol.asyncIterator]")).toBe(iterator);
});

test("an anonymous default-exported function has the module's default symbol", () => {
  const declaration = "export default function (input: string) { return input.trim(); }";
  expect(symbolText(declaration, "default")).toBe(declaration);
});
