import { AsyncLocalStorage } from "node:async_hooks";

interface NativeAbortOwner {
  readonly signal: AbortSignal;
  readonly audit: (error: Error) => void;
}

const owners = new AsyncLocalStorage<NativeAbortOwner>();
let installs = 0;

function errorOf(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}

function isOwnedSdkControlAbort(reason: unknown, owner: NativeAbortOwner | undefined): reason is Error {
  if (!owner?.signal.aborted || !(reason instanceof Error)) return false;
  const stack = reason.stack ?? "";
  return reason.message === "Operation aborted"
    && stack.includes("ProcessTransport.write")
    && stack.includes("Query.handleControlRequest")
    && stack.includes("@anthropic-ai/claude-agent-sdk");
}

const onUnhandledRejection = (reason: unknown) => {
  const owner = owners.getStore();
  if (owner && isOwnedSdkControlAbort(reason, owner)) {
    owner.audit(reason);
    return;
  }
  // Installing a rejection listener disables Node's fatal default. Restore that behavior for every
  // rejection outside the one pinned SDK abort path above; unknown corruption is never suppressed.
  process.nextTick(() => { throw errorOf(reason); });
};

/** Installs the process guard for one executor lifetime. Nested installs share one listener. */
export function installCcNativeRejectionGuard(): () => void {
  if (installs++ === 0) process.on("unhandledRejection", onUnhandledRejection);
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    if (--installs === 0) process.off("unhandledRejection", onUnhandledRejection);
  };
}

/** Associates every promise created by one native query with that query's exact abort authority. */
export function runWithCcNativeAbortOwner<T>(signal: AbortSignal, audit: (error: Error) => void,
  operation: () => Promise<T>): Promise<T> {
  return owners.run({ signal, audit }, operation);
}
