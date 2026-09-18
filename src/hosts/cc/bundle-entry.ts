import { runCcCommand } from "./index.ts";

void runCcCommand().catch(error => {
  console.error(`Trace Memory CC: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
