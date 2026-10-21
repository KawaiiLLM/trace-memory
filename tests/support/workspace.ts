import { sourceSeededMemory, type RunAgent, type TraceMemory } from "../source-fixture.ts";
import type { KnowledgePath } from "../../src/core/store/index.ts";
import type { NotingScope } from "../../src/core/workspace/index.ts";
import { fact, knowledge } from "./seed.ts";

/** A session with two Turns (four source entries: user, assistant, user, assistant), the frozen Noting batch over
 * both, and builders for the facts and knowledge a workspace file may name. No agent runs in these tests. */
export function workspaceBatch(options: { bodyTokens?: number; agent?: RunAgent; dbPath?: string } = {}) {
  const memory: TraceMemory = sourceSeededMemory(options.dbPath ?? ":memory:", options.agent ?? (async () => { throw new Error("no agent runs in workspace tests"); }));
  if (options.bodyTokens) memory.config.writing.bodyTokens = options.bodyTokens;
  const store = memory.store;
  const project = store.createProject({ name: "workspace", declaredBy: "mark" });
  const session = store.createSession({ projectId: project.id, host: "pi:workspace", enrollmentChoice: true, startedAt: "now", firstReplyAt: "now" });
  const first = store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "User asked to use pnpm", assistantText: "Pi agent explained the choice", startedAt: "now" });
  const second = store.appendTurn({ sessionId: session.id, parentTurnId: first.id, kind: "turn", userPrompt: "User added the lockfile condition", assistantText: "Pi agent recorded it", startedAt: "now" });
  const entries = store.sourcePath(session.id, "main", second.id);
  const path: KnowledgePath = { sessionId: session.id, branch: "main", headTurnId: second.id };
  const scope: NotingScope = { sessionId: session.id, branch: "main", range: { from: `S${session.id}/T${first.id}`, to: `S${session.id}/T${second.id}` } };
  /** The note address of the i-th entry, as a fact source line starts with it: `[T5#E1@user]`. */
  const address = (index: number) => `T${entries[index]!.turnId}#E${entries[index]!.entryOrdinal}`;
  const roles = ["user", "assistant", "user", "assistant"] as const;
  const source = (index: number, text: string) => `[${address(index)}@${roles[index]}] ${text}`;
  /** A fact already published, for a Dreaming task to cite. */
  const existingFact = (title = "Earlier fact", text = "User asked to use pnpm") =>
    fact(memory, path, title, [{ entry: entries[0] as never, text }]);
  /** A current knowledge item, published through the manual path. */
  const item = (text: string, over: { title?: string; category?: "constraint" | "understanding" | "goal" | "open" | "reference";
    scope?: "global" | "project" | "session" } = {}) => {
    const supports = [existingFact(`Support for ${text}`).id];
    const committed = knowledge(store, path, over.scope ?? "project", over.category ?? "constraint", supports, text, { operation: { title: over.title ?? text.slice(0, 20) } });
    return { ...committed, supports, ordinal: store.versionOrdinal(committed.knowledgeId, committed.commit),
      ref: `K${committed.knowledgeId}@v${store.versionOrdinal(committed.knowledgeId, committed.commit)}` };
  };
  return { memory, store, project, session, entries, path, scope, address, source, existingFact, item };
}
export type WorkspaceBatch = ReturnType<typeof workspaceBatch>;

/** Join block lines the way an agent writes a file: fields, a blank line, the body. */
export const block = (heading: string, fields: Record<string, string> = {}, body = ""): string =>
  [`## ${heading}`, ...Object.entries(fields).map(([key, value]) => `${key}: ${value}`), "", body, ""].join("\n");
