// Knowledge headers distinguish authored titles from untitled bodies (153).
import { afterEach, expect, test } from "vitest";
import { sourceSeededMemory, compacted } from "../../source-fixture.ts";
import { fact as seedFact, knowledge as seedKnowledge, legacyKnowledge } from "../../support/seed.ts";
import { memoryFiles } from "../../../src/core/api/files.ts";
import { groupText } from "../../../src/core/dreaming/curate.ts";

let memory: ReturnType<typeof sourceSeededMemory>;
afterEach(() => memory?.close());

const titled = "Package manager rule", titledBody = "Use pnpm, never npm, and keep the lockfile committed.";
const legacyBody = "Legacy rule about lockfiles and how installs must be reproduced across every machine that builds this project, including continuous integration runners, release builders and each developer laptop in the team";

function setup(untitledBody = legacyBody) {
  memory = sourceSeededMemory(":memory:", async () => { throw new Error("no model"); });
  const project = memory.store.createProject({ name: "titles", declaredBy: "mark" });
  const session = memory.store.createSession({ enrollmentChoice: true, host: "pi:titles", projectId: project.id, startedAt: "now", firstReplyAt: "now" });
  const turn = memory.store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "Use pnpm", assistantText: "Okay", startedAt: "now" });
  const entries = memory.store.listSourceEntries(session.id);
  memory.selectEntries(session.id, "main", entries.map(entry => entry.id));
  const path = { sessionId: session.id, branch: "main", headTurnId: turn.id };
  seedFact(memory, path, "Use pnpm", [{ entry: memory.store.getSourceEntry(entries[0]!.id)!, text: "Use pnpm" }]);
  const withTitle = seedKnowledge(memory.store, path, "project", "constraint", [1], titledBody, { operation: { title: titled } });
  const legacy = legacyKnowledge(memory.store, path, { text: untitledBody, category: "reference", scope: "project", supports: [1] });
  return { path, session, withTitle, legacy, limit: memory.config.writing.titleWords };
}

/** The header line of the item `K<id>` in a view, and the line after it. */
function header(view: string, id: number): [string, string] {
  const lines = view.split("\n"), at = lines.findIndex(line => new RegExp(`^\\[K${id}[#@]`).test(line));
  expect(at, `K${id} in:\n${view}`).toBeGreaterThanOrEqual(0);
  return [lines[at]!, lines[at + 1]!];
}

test("whole knowledge views keep authored titles and mark untitled headers without repeating the opening", () => {
  const { path, session, withTitle, legacy } = setup();
  const views: Record<string, string> = {
    injection: memory.inject(session.id),
    compaction: compacted(memory.compact(session.id, "main", path.headTurnId)),
    knowledge: memoryFiles(memory, path).read(`trace://knowledge/S${session.id}`).content,
    dreamer: groupText(memory.store, memory.store.curateItems(path), {}),
  };
  for (const [name, view] of Object.entries(views)) {
    const [head, body] = header(view, withTitle.knowledgeId);
    expect(head.endsWith(titled), name).toBe(true);
    expect(body, name).toBe(titledBody);
    const [legacyHead, legacyFirst] = header(view, legacy.knowledgeId);
    expect(legacyHead.endsWith("(no title)"), name).toBe(true);
    expect(legacyFirst, name).toBe(legacyBody);
  }
  const exact = memoryFiles(memory, path).read(`trace://K${withTitle.knowledgeId}`).content;
  expect(header(exact, withTitle.knowledgeId)).toEqual([expect.stringMatching(new RegExp(`\\[constraint/project\\] ${titled}$`)), titledBody]);
  const exactLegacy = memoryFiles(memory, path).read(`trace://K${legacy.knowledgeId}`).content;
  expect(header(exactLegacy, legacy.knowledgeId)).toEqual([expect.stringMatching(/\[reference\/project\] \(no title\)$/), legacyBody]);
});

test("a search hit carries the title before its snippet, and a title is searchable", async () => {
  const { path, withTitle } = setup();
  const hit = memory.search("Package manager", "knowledge", path) as string;
  expect(hit).toMatch(new RegExp(`^\\[K${withTitle.knowledgeId}@v1\\] \\[constraint/project\\] ${titled} — `));
  const code = memory.search("Package manager", "knowledge", { ...path, code: "return hits.map(hit => hit.title).join('|')" });
  await expect(code).resolves.toContain(titled);
});

test("search and bodyless trace labels mark the opening of an untitled item", async () => {
  const { path, withTitle, legacy } = setup();
  const opening = "Legacy rule about lockfiles and how installs must be reproduced across every machine that builds this project, including continuous integration";
  const label = `(no title) ${opening}…`;
  const hit = memory.search("Legacy rule", "knowledge", path) as string;
  expect(hit).toContain(`[K${legacy.knowledgeId}@v1] [reference/project] ${label} — `);
  const code = memory.search("Legacy rule", "knowledge", { ...path, code: "return hits.map(hit => hit.title).join('|')" });
  await expect(code).resolves.toContain(label);
  expect(memory.trace(`K${legacy.knowledgeId}`, { fields: ["reason"] })).toContain(`[K${legacy.knowledgeId}@${legacy.commit}] [reference/project] ${label}\n`);
  expect(memory.trace(`K${withTitle.knowledgeId}`, { fields: ["reason"] })).toContain(`[K${withTitle.knowledgeId}@${withTitle.commit}] [constraint/project] ${titled}\n`);
});

test.each([
  ["Use pnpm, never npm.", "Use pnpm, never npm."],
  ["项目一律使用 pnpm 管理依赖，禁止使用 npm 安装任何包，锁文件必须提交到仓库。", "项目一律使用 pnpm 管理依赖，禁止使用 npm 安装任何"],
  ["src/".repeat(500) + "x then more words", "src/".repeat(40)],
  ["𠮷".repeat(500), "𠮷".repeat(20)],
])("untitled search labels keep bounded, Unicode-safe openings: %s", async (text, opening) => {
  const { path, legacy } = setup(text);
  const code = memory.search(undefined, "knowledge", { ...path, code: `return hits.find(hit => hit.id === ${legacy.knowledgeId}).title` });
  await expect(code).resolves.toContain(`(no title) ${opening}…`);
});
