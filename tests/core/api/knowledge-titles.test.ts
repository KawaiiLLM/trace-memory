// Where a knowledge version's title appears: on the header line after the id and category tags, with the body on
// the following lines. A legacy version has none and shows its body's leading characters, cut to the title target in units (145).
import { afterEach, expect, test } from "vitest";
import { sourceSeededMemory, compacted } from "../../source-fixture.ts";
import { fact as seedFact, knowledge as seedKnowledge, legacyKnowledge } from "../../support/seed.ts";
import { memoryFiles } from "../../../src/core/api/files.ts";
import { knowledgeTitle, words } from "../../../src/core/render/index.ts";
import { curatePrefix } from "../../../src/core/dreaming/curate.ts";

let memory: ReturnType<typeof sourceSeededMemory>;
afterEach(() => memory?.close());

const titled = "Package manager rule", titledBody = "Use pnpm, never npm, and keep the lockfile committed.";
const legacyBody = "Legacy rule about lockfiles and how installs must be reproduced across every machine that builds this project, including continuous integration runners, release builders and each developer laptop in the team";

function setup() {
  memory = sourceSeededMemory(":memory:", async () => { throw new Error("no model"); });
  const project = memory.store.createProject({ name: "titles", declaredBy: "mark" });
  const session = memory.store.createSession({ enrollmentChoice: true, host: "pi:titles", projectId: project.id, startedAt: "now", firstReplyAt: "now" });
  const turn = memory.store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "Use pnpm", assistantText: "Okay", startedAt: "now" });
  const entries = memory.store.listSourceEntries(session.id);
  memory.selectEntries(session.id, "main", entries.map(entry => entry.id));
  const path = { sessionId: session.id, branch: "main", headTurnId: turn.id };
  seedFact(memory, path, "Use pnpm", [{ entry: memory.store.getSourceEntry(entries[0]!.id)!, text: "Use pnpm" }]);
  const withTitle = seedKnowledge(memory.store, path, "project", "constraint", [1], titledBody, { operation: { title: titled } });
  const legacy = legacyKnowledge(memory.store, path, { text: legacyBody, category: "reference", scope: "project", supports: [1] });
  return { path, session, withTitle, legacy, limit: memory.config.writing.titleWords };
}

/** The header line of the item `K<id>` in a view, and the line after it. */
function header(view: string, id: number): [string, string] {
  const lines = view.split("\n"), at = lines.findIndex(line => new RegExp(`^\\[K${id}[#@]`).test(line));
  expect(at, `K${id} in:\n${view}`).toBeGreaterThanOrEqual(0);
  return [lines[at]!, lines[at + 1]!];
}

test("a legacy version shows its body's leading characters, cut to the title target in units, as its title", () => {
  const { legacy, limit } = setup();
  const title = knowledgeTitle(memory.store.getKnowledgeRevision(legacy.knowledgeId, legacy.commit)!, limit);
  expect(legacyBody.startsWith(title)).toBe(true);
  expect(words(title)).toBe(limit); // the target, not the limit a check allows
  expect(title.length).toBeLessThan(legacyBody.length);
  expect(words(legacyBody.slice(0, legacyBody.indexOf(" ", title.length + 1)))).toBe(limit + 1); // it is the longest prefix that fits
  expect(memory.store.getKnowledgeRevision(legacy.knowledgeId, legacy.commit)!.title).toBeNull();
  // A body with no more units than the target is its own title, trailing punctuation included; CJK counts per character.
  expect(knowledgeTitle({ title: null, text: "Use pnpm, never npm." }, limit)).toBe("Use pnpm, never npm.");
  expect(knowledgeTitle({ title: null, text: "项目一律使用 pnpm 管理依赖，禁止使用 npm 安装任何包，锁文件必须提交到仓库。" }, 10)).toBe("项目一律使用 pnpm 管理依");
  // One unbroken run (a path, an identifier) is one unit, so the unit cut alone would make all of it the title: it is bounded to 8 characters per unit of the target.
  const run = "src/".repeat(500) + "x";
  expect(words(run)).toBe(1);
  expect(knowledgeTitle({ title: null, text: `${run} then more words` }, limit)).toHaveLength(limit * 8);
  expect(knowledgeTitle({ title: null, text: "𠮷".repeat(500) }, limit)).toBe("𠮷".repeat(limit)); // a CJK title is cut by units first and a surrogate pair is never split
});

test("injection, the compaction block, the knowledge view, an exact read and the Dreamer's curate view put the title on the header line", () => {
  const { path, session, withTitle, legacy, limit } = setup();
  const legacyTitle = knowledgeTitle(memory.store.getKnowledgeRevision(legacy.knowledgeId, legacy.commit)!, limit);
  const views: Record<string, string> = {
    injection: memory.inject(session.id),
    compaction: compacted(memory.compact(session.id, "main", path.headTurnId)),
    knowledge: memoryFiles(memory, path).read(`trace://knowledge/S${session.id}`).content,
    dreamer: curatePrefix(memory.store, path).text,
  };
  for (const [name, view] of Object.entries(views)) {
    const [head, body] = header(view, withTitle.knowledgeId);
    expect(head, name).toMatch(new RegExp(`\\[constraint/project\\] (?:\\(\\d+ tokens\\) )?${titled}$`));
    expect(body, name).toBe(titledBody);
    const [legacyHead, legacyFirst] = header(view, legacy.knowledgeId);
    expect(legacyHead, name).toMatch(new RegExp(`\\[reference/project\\] (?:\\(\\d+ tokens\\) )?${legacyTitle}$`));
    expect(legacyFirst, name).toBe(legacyBody);
  }
  const exact = memoryFiles(memory, path).read(`trace://K${withTitle.knowledgeId}`).content;
  expect(header(exact, withTitle.knowledgeId)).toEqual([expect.stringMatching(new RegExp(`\\[constraint/project\\] ${titled}$`)), titledBody]);
  const exactLegacy = memoryFiles(memory, path).read(`trace://K${legacy.knowledgeId}`).content;
  expect(header(exactLegacy, legacy.knowledgeId)).toEqual([expect.stringMatching(new RegExp(`\\[reference/project\\] ${legacyTitle}$`)), legacyBody]);
});

test("a search hit carries the title before its snippet, and a title is searchable", async () => {
  const { path, withTitle } = setup();
  const hit = memory.search("Package manager", "knowledge", path) as string;
  expect(hit).toMatch(new RegExp(`^\\[K${withTitle.knowledgeId}@v1\\] \\[constraint/project\\] ${titled} — `));
  const code = memory.search("Package manager", "knowledge", { ...path, code: "return hits.map(hit => hit.title).join('|')" });
  await expect(code).resolves.toContain(titled);
});
