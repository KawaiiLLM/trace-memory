import type { CcSessionBinding } from "./binding.ts";
import { selectedNativePath, type CcTranscriptSnapshot } from "./transcript.ts";

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** The last clear's foreground warning, not a reconstruction from pending work.
 * Native 2.1.280 writes our SessionStart Hook's JSON stdout as hook_success, then the displayed
 * systemMessage as a child hook_system_message (possibly followed by hook_additional_context).
 * Only the currently selected native ancestry counts; the first prompt need not exist yet. */
export function ccLastCompactionNotice(snapshot: CcTranscriptSnapshot,
  binding: Pick<CcSessionBinding, "clearedFrom" | "transcriptPath" | "nativeSessionId" | "selectedLeafUuid">): string | null {
  if (snapshot.problem || snapshot.incompleteBytes || !binding.clearedFrom?.compactionTurnId ||
      !snapshot.exists || snapshot.path !== binding.transcriptPath) return null;
  const selected = selectedNativePath(snapshot.records);
  if (selected.problem || selected.leafUuid !== binding.selectedLeafUuid) return null;
  // Before the first user prompt, there is no selected source leaf. Only an unambiguous single
  // SessionStart Hook in this native session can establish the foreground warning then.
  const records = selected.leafUuid ? selected.records : snapshot.records;
  const successes = records.filter(record => {
    const hook = object(record.attachment);
    return record.type === "attachment" && record.sessionId === binding.nativeSessionId &&
      hook?.type === "hook_success" && hook.hookEvent === "SessionStart" &&
      typeof hook.command === "string" && hook.command.includes("/dist/cc.cjs\" hook --config ") &&
      hook.exitCode === 0;
  });
  if (!selected.leafUuid && successes.length !== 1) return null;
  const success = successes.at(-1), hook = object(success?.attachment);
  if (!success || !hook || typeof hook.stdout !== "string") return null;
  let output: Record<string, unknown> | null;
  try { output = object(JSON.parse(hook.stdout)); } catch { return null; }
  if (object(output?.hookSpecificOutput)?.hookEventName !== "SessionStart") return null;
  const warning = output?.systemMessage;
  if (warning === undefined) return null; // Later clean SessionStart supersedes an earlier warning.
  if (typeof warning !== "string" || !warning.startsWith("Trace Memory: compaction omitted ") ||
      !warning.endsWith("; they remain pending for Noting and Consolidation.")) return null;
  const shown = records.find(record => {
    const attachment = object(record.attachment);
    return record.type === "attachment" && record.sessionId === binding.nativeSessionId &&
      record.parentUuid === success.uuid && attachment?.type === "hook_system_message" &&
      attachment.content === warning && attachment.hookEvent === hook.hookEvent &&
      attachment.hookName === hook.hookName && attachment.toolUseID === hook.toolUseID;
  });
  return shown ? warning : null;
}
