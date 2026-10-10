import { Worker, type MessagePort } from "node:worker_threads";

/** Start the sandbox's worker thread. The Claude Code bundle replaces this module with one that runs the
 * worker's built text (scripts/build-cc.mjs), because a bundle has no files beside it. */
export function startCodeWorker(workerData: object, transferList: MessagePort[]): Worker {
  return new Worker(new URL("./code-worker.mjs", import.meta.url), { workerData, transferList });
}
