// Claude Code 2.1.284 native Read: ~402 tokens by the project estimator, not a wire count.
// SDK does not expose native tool metadata; remeasure when the runtime changes.
export const CC_NATIVE_READ_TOOL_TOKENS = 402;
// The native Write and Edit definitions of the same executable, measured the same way (Write 149, Edit 236).
export const CC_NATIVE_WRITE_TOOL_TOKENS = 385;
// The native Grep and Glob that curate and verify also list (stage 4 §5.4), measured from a real request of the same executable (Grep 832, Glob 188).
export const CC_NATIVE_SEARCH_TOOL_TOKENS = 1020;
// Claude Code 2.1.293 sandboxed Bash, measured from the fenced native worker's provider request (ticket 152).
export const CC_NATIVE_BASH_TOOL_TOKENS = 962;
