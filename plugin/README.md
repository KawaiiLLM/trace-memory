# Trace Memory Claude Code plugin

The standalone plugin requires Node >=24.6.0 and fails at its bundled entry before loading adapter or SDK code on an older runtime. It never downloads or installs a replacement runtime.

Before loading the plugin, edit `cc.config.json`. Set absolute paths for `stateDir`, `worker.claudeExecutable`, and the worker's private `cwd`. In `worker.contextWindows`, supply the prepared context capacity for each selected model, keyed by its exact configured name; each must be a safe integer greater than 10,000. The template's `null` values require explicit preparation, not a guessed capacity. The adapter runs on any installed Claude Code and records the version each worker run started; the native probes last passed on 2.1.280, and the status line shows `unverified CC <version>` while the running version differs. An old `worker.claudeVersion` key in an installed file is ignored.

CC uses the same flat phase-setting keys as Pi. The shipped defaults are:

| Phase | Model key | Default | Thinking key | Default |
| --- | --- | --- | --- | --- |
| Noter | `notingModel` | `sonnet` | `notingThinking` | `high` |
| Dreamer | `dreaming.model` | `opus` | `dreaming.thinking` | `high` |

These are top-level JSON keys, including the literal dots in the Dreamer keys. CC and Pi store their values separately: this file neither reads nor changes Pi settings. Fresh CC workers do not inherit the foreground selection, so `session` and `inherit` fail explicitly as worker-model settings. Its adapter converts each thinking setting to the SDK's effort and verifies native model support; unsupported settings are not silently replaced. All four settings are required when `worker` is present. Omit `worker` only for ingestion/read-only operation.

A fresh worker uses its configured phase model, thinking level and capacity consistently for admission, execution and run records, including borrowed work and catchup. Capacity is looked up by model name, not copied from another phase. A native Noter fork instead inherits the actual parent model and effective window; the fresh-worker configuration does not override them. The local `/trace` Settings screen saves edits to this file and applies them to subsequent tasks on the running executor. It reports file save and executor apply separately; already admitted tasks retain their settings. Manual edits outside that command still require a restart.

Core phase bounds use optional top-level keys in the same file:

| Key | Default | Meaning |
| --- | ---: | --- |
| `noting.triggerTokens` | 10,000 | Noter trigger checked at main turn end; catchup still drains below it |
| `noting.forkModeDefault` | `false` | Request native fork when eligible; otherwise record the fresh fallback reason |
| `dreaming.triggerTokens` | 5,000 | Dreamer trigger on the session's pending weight summed across its pools |
| `dreaming.timeoutMs` | 1,800,000 | Dreamer wall-clock bound; no tool-round ceiling |
| `compaction.sharedAllowanceTokens` | 10,000 | Shared allowance Knowledge borrows first, then unprocessed Raw |

The shared material allowance is this configured value, not derived from the N or D triggers.
Noter publishes facts and knowledge together; facts have no later processing queue. Database pool
budgets still size pools and decide a Dreamer run's success; a session whose knowledge exceeds their
sum plus the shared allowance is due for a Dreamer run.

Optional `retry: { "maxRetries": 2 }` configures the native request retry count. Omission preserves
Claude Code's native default; zero disables those retries. Timing, backoff and eligible errors remain
native policy. The adapter records retry events, specific API errors and received usage, but adds no
retry loop and does not promise recovery from errors inside an already-started stream.

A narrowly scoped process guard contains the pinned SDK's late control-response abort only when it
belongs to an already-aborted worker. It records that diagnostic; unrelated unhandled rejections
remain fatal. This contains the known SDK cancellation defect without modifying the installed SDK.

Each fresh CC worker run's conversation is a native Claude Code session, written by Claude Code itself —
not a custom log. It lands where Claude Code always puts a session for a given working directory:
`<CLAUDE_CONFIG_DIR, or ~/.claude>/projects/<worker.cwd, with every non-alphanumeric character turned
into a dash>/<session id>.jsonl`. Every isolation option stays on (`settingSources: []`, no plugins,
the private trace_memory MCP server as the only connected server), so this file is never bound,
imported or enrolled as a foreground session by the CC adapter — Claude Code just happens to persist
it, the same way it persists any session. The run record's `nativeLog` names this exact path; a run
whose file cannot be verified after the fact records an audit note there instead, without changing
the run's outcome. claude-powerline's daily cost counts these transcripts the same way it counts any
other Claude Code session, because they sit one level under its own `projects` root. Existing worker
logs under the retired `<stateDir>/workers/` are untouched by this — nothing moves, imports, or
rewrites them.

**Upgrade from the single-model configuration:** remove `worker.model`, `worker.effort` and `worker.contextWindow`; set the four phase keys above and register each selected model's capacity in `worker.contextWindows`. The retired fields are rejected rather than used as a shared fallback. The file is the only mutable plugin configuration surface and must not contain credentials.

Omit `dbPath` to use `~/.trace-memory/trace.db`, the same default as Pi. An existing database is opened in place, never replaced or copied by installation; an absent database is created on first use. Set an explicit absolute `dbPath` only to use another database (or to match a customized Pi path). Database reuse includes the existing Store's normal schema migration checks; it does not reset facts, knowledge, or enrollment. A new session on either host joins the project its repository directory (the git repository root, or the real cwd outside a repository) already has when that is exactly one project; the home directory and temporary directories are excluded, and `project <name>` overrides.

For startup, resume and clear, SessionStart uses 24 command slots, each at most 10,000 UTF-16 code units. An elected producer freezes one rendering; the other slots read their independently identified parts. Empty slots print nothing. Whole items that do not fit are named in omission receipts. Staging records the publication as delivered in the database; hooks read the delivered state from there and never read carriers back from the transcript. The plugin also registers SessionEnd, a stdio MCP server and the function-hooks `/trace` command.

## Automatic scheduling and fork

At each main turn end, N and D are checked once and may each start one run under the existing seats. Entry imports, ordinary task completions and busy checks accumulate no further runs. Both due phases use existing admission without a new ordering rule; automatic failures wait for a later turn end, and manual catchup keeps its own completion checkpoints. These three consequences are derived interpretations of 105. Three consecutive failures still disable memory.

With function hooks, the checkpoint is the main `turn.complete`. Without a usable hook, the executor recognizes recorded native terminal events; overlapping observations are deduplicated. An extremely early withdrawal that leaves no native entry or terminal record creates no synthetic source or check. The next recognizable turn end checks afresh. Ordinary interrupted or errored turns are not exempt.

Set `noting.forkModeDefault: true` to request a native Noter fork. Claude Code also requires `CLAUDE_CODE_FORK_SUBAGENT=1` in the parent process. At final admission, the adapter rechecks the selected-path checkpoint and frozen batch, and treats entries after the latest persisted compaction boundary as inherited; Core checks capacity including the existing headroom. This boundary is an admission rule, not proof that full original content remains in context: microcompact may clear results, persisted-output may leave previews, and thinking-only replies may be dropped. It reserves no earlier N seat and waits for no future hook. Missing sources, unavailable fork capability or an explicit pre-start capacity refusal use the existing fresh runner and preserve the per-attempt reason. A started or ambiguous fork failure is not a fresh retry.

Originals present only inside a compaction carrier deliberately use fresh execution; this is accepted behavior, not missing carrier support. The plugin stores no new Raw/carrier association. Native fork tools use the parent's definitions; only the registered session/agent/call identity gets private Noter slots. Main-session calls remain manual, and fork transcripts are not imported as foreground Raw. Stop cancels work and checks already received by the executor; it does not disable later checkpoints.

A native fork run records its usage like a fresh one. Its tokens come from the fork's `turn.complete` at settlement. Its cost is added afterwards, off the write fence and the physical stop: the executor re-reads the fork's own transcript (`<session>/subagents/agent-<id>.jsonl`) for at most ten seconds until its per-response totals equal the recorded tokens, then prices each response with Claude Code's own baked model catalog, read from the running executable and cached once per build in the state directory (`cc-price-catalog.json`). A fork that was stopped, cancelled or disconnected has no completed event: whatever its transcript holds is recorded as partial usage. When the catalog cannot be read, the model is unlisted, a response ran in fast mode, or the transcript never reaches the recorded tokens, the tokens stay and the cost is unknown: recorded as null, named in the run's problems, marked (not counted as $0) in `/trace` spend, the Runs list and the status line, and never a partial sum. Org `modelPricing` overrides are not applied: the cost follows the baked list price. A fork response whose cache read is below half of its input warns once in the transcript (`Trace Memory: fork cache miss (… of … input tokens read from cache).`); nothing else follows from it.

## Enable function hooks

Set `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` in the **Claude Code process environment** before launching it. An interactive installation can set the variable in Claude Code settings' `env` block. SDK-launched processes and fresh `CLAUDE_CONFIG_DIR` directories do not necessarily inherit those personal settings: pass the variable explicitly to the CC child process. `claude plugin validate` checks the module; it does not prove runtime loading. Use `--debug` to confirm that the hooks module loaded. A disabled module may be reported only in the debug log, not stream-json output.

With the function module loaded, Trace Memory performs Claude Code's main-session manual `/compact` and automatic compactions (threshold, mid-turn and prompt-too-long) itself, as Pi's compaction does: no summarisation request is sent. The hook returns one user message carrying the same material Pi's compaction carries (knowledge, recent facts and pending compressed Raw, within the windows above) and keeps no original message: the turn in flight — the prompt just submitted, or a tool call and its result — is the newest Raw in it, so the interrupted turn continues from the block. Claude Code has that turn in memory but writes it to the transcript a moment later, so the build waits (up to 10 seconds) for the row and for the executor to import it, reading only the transcript after the stored leaf; without a live executor it imports the transcript itself. The block's knowledge is recorded as the compaction's delivered state before it is returned, so `SessionStart(compact)` (which never injects) and the next `UserPromptSubmit` add nothing. The block is framed exactly as Pi frames a compaction summary for the model ("The conversation history before this point was compacted into the following summary:" and a `<summary>` element), so the model reads it as the continued conversation; the Trace Memory envelope inside is never imported as Raw, and `--resume` restores it. After an automatic compaction only, the block also ends, after that framing, with Claude Code's own native instruction to continue the pending task without asking the user; a manual `/compact` gets none. When it omits pending Raw or facts, a transcript notice (not sent to the model) says so; the omitted material stays pending for Noting.

Plugin-triggered, precompute and subagent compactions, and those of an unbound or disabled session, stay Claude Code's own; so does any compaction whose build fails (for example because the session or its selected path changed meanwhile). After such a native main-session compaction, the hook calculates the missing exact knowledge versions from the deliveries recorded on the selected path and appends them; that supplement becomes the compaction's baseline. It uses the existing knowledge budget and records each part's rendered Knowledge cost. A failed or cancelled supplement leaves the native compaction result unchanged and records no delivery; a failure of native compaction itself retains its original failure semantics.

With the function module loaded, Read, Grep and Glob also read Trace Memory as read-only files under `/tm/` (ticket 101), in the main thread and inside subagents such as `general-purpose` and `Explore`. `Read /tm` shows the layout: `/tm/<address>` is what `trace(<address>)` shows the session; `/tm/knowledge` and `/tm/knowledge-all` list knowledge; `/tm/S<n>/knowledge` is the knowledge a fresh context of session S<n> receives, which the injected knowledge names so a main agent can point a subagent at it. Grep lists matching files by default and searches Raw entries in full. The hook's answer skips Claude Code's permission and path checks, so it answers only an absolute path that normalises to `/tm` or lies under `/tm/` — no `..` escape, no lookalike such as `/tmp` or `/tm-foo`, nothing resolved on disk — and hands every other call to Claude Code's own tool untouched. It runs `dist/cc.cjs fs` for the native session's bound reader, a process of its own (about 0.1 s a call), so a long search never holds the executor. Edit, Write and NotebookEdit under `/tm/` are refused with a pointer to `note` and `memory`; reading records nothing. Without function hooks, `/tm/` does not exist and `trace` and `search` remain.

If the function module is not loaded, the next `UserPromptSubmit` is the recovery opportunity: it calculates missing bodies from the deliveries recorded on the selected path. **After automatic compaction, the rest of that same turn can lack knowledge until the next user submission.** This recovery does not provide another knowledge window, and versions already recorded as delivered on the path are not delivered again. It does not make `/trace` available without function hooks; there is no model-invoked fallback skill.

The function module uses Claude Code's experimental function-hooks API, last verified on 2.1.284. Installation does not run a package manager or edit personal Claude Code settings or the user's status-line script.

## Status line

Ticket 75: a live executor publishes its memory status — the same line Pi's footer shows — to `<stateDir>/status/<native-session-id>.json` at its own lifecycle points (attach, a reconcile that imports new history or moves the selected path, a task's admission and settlement, and enrollment on/off). The file is removed on shutdown, and when the executor follows `/clear` to the new session. A `dist/status.cjs` bundle entry reads Claude Code's own status-line hook JSON from stdin, the matching status file, and — for ownership/liveness only — the matching binding file; it opens no database and costs roughly a bare Node process start (about 30–50 ms on typical hardware), not the 80–90 ms `dist/cc.cjs` costs. It prints nothing for a session that is not bound to Trace Memory, and `?` for every count with the idle `○` when the publishing executor is no longer alive or has been superseded — never a stale running `●`.

This does not modify `claude-powerline` or Claude Code's own status line rendering; it is a second line placed under an existing `statusLine` command that already runs powerline, by chaining that command to also run `dist/status.cjs` and print its (possibly empty) line. Example, given a `statusline-command.sh` that currently runs powerline alone:

```sh
#!/bin/sh
# Claude Code status line: local claude-powerline build, then Trace Memory's one-line status underneath (ticket 75).
input="$(cat)"
printf '%s' "$input" | node /path/to/claude-powerline/dist/index.mjs --config ~/.claude/claude-powerline.json
status=$?
line="$(printf '%s' "$input" | node "$CLAUDE_PLUGIN_ROOT/dist/status.cjs" --config "$CLAUDE_PLUGIN_ROOT/cc.config.json" 2>/dev/null)"
[ -n "$line" ] && printf '%s\n' "$line"
exit "$status"
```

Stdin is read exactly once and forwarded unchanged to both commands; powerline's own output and exit status are untouched — `status.cjs` runs after it and only ever adds a line, never replaces or delays powerline's. Replace `$CLAUDE_PLUGIN_ROOT` with this plugin's actual installed `dist/status.cjs` and `cc.config.json` paths if the statusLine command's environment does not set it; re-point it after every plugin version upgrade if those paths are version-pinned. This is a personal file outside the plugin's own installation, so applying it is a manual, deliberate step — never done by installation or an update.

## Session commands

Use `/trace` to open the local, zero-foreground-model-turn menu. It shows the current context (when verifiable), pending triggers, spend and recent runs, with actions for enrollment, catchup, stop, project and settings. Its Settings screen writes database budgets and `cc.config.json` worker preferences, preserving unrelated keys. The running executor applies successful edits to future tasks, while already running tasks keep their admitted configuration. If a save succeeds but apply fails, both outcomes are reported separately; the menu does not claim that the saved value is already effective. `/clear` changes the native session identity; every menu action resolves the live ID before dispatch. The command runs only on the pinned function-hooks API. Opening the menu starts no memory work or remote token-count request: In pinned Claude Code 2.1.280, the `summary` total uses the last valid response's input and cache-input usage when available, otherwise local estimates; it is not a promise of the next request's complete wire size.

Knowledge/Facts/Raw are measured from envelopes inside the current Messages snapshot's SessionStart and UserPromptSubmit hook-context blocks. User-message envelopes, bare or in Pi's compaction framing (Trace Memory's compaction and the function-compaction supplement), cannot be distinguished from a user's verbatim copy through Messages alone. One is attributed, as an estimate, when the database records a compaction's delivery with exactly its knowledge versions, state notices and Knowledge cost; it is then measured like a hook-context envelope. Without such a record its memory breakdown is unavailable rather than reported as zero. This does not mean the context is empty or invalidate independently available total estimates or usage. Carrier recognition reads neither the transcript nor executor import state. Complete envelopes verify their database/session identity and body digest. Previews verify the same identity; when their referenced original file exists, its digest and prefix must also match. A deleted original permits identity-only verification. Classification and accounting use only the retained preview, never the omitted original. Repeated carriers or failed verification make the split unavailable.

Embedded images use their PNG/JPEG/GIF/WebP header dimensions and the session model's resolution tier. Local estimates follow Anthropic's [Vision guide](https://platform.claude.com/docs/en/build-with-claude/vision#evaluate-image-size) and [resize reference](https://platform.claude.com/docs/en/build-with-claude/vision-coordinates#resize-your-image-before-uploading), checked 2026-09-24 UTC: resize to the model's edge/token limits, then count `ceil(width / 28) × ceil(height / 28)`. Both user images and images inside tool results count. At the 4096-message limit, with unreadable image dimensions or an unknown image model tier, or with a document/unsupported block, the split is unavailable and Messages remains unchanged. Image URLs and file IDs are not fetched.

The direct CLI accepts the following existing verbs:

| Subcommand | Effect |
| --- | --- |
| `on` | Enable memory for this session; does not start a catchup. |
| `off` | Stop this executor's work and disable memory. |
| `catchup` | Start one finite Noting drain with ordinary Dreamer threshold checks, or report the active drain. |
| `stop` | Stop this executor's work without disabling memory. |
| `project <name>` | Declare this session's shared project. |

The former model-invoked `trace` skill is removed so its bare alias cannot conflict with the local command. The direct CLI remains available from a trusted shell; it does not silently fall back to a model turn when function hooks are disabled.

`catchup` requires an enabled session and its live MCP executor. It reconciles the current path and freezes the pending Raw boundary. Noting drains it in bounded subagent batches, ignoring only N's trigger threshold; later Raw does not extend the drain. One checkpoint at start and after every successful catchup-owned N or D completion checks both phases. D uses the ordinary session-wide overflow or summed-pending conditions; one pool exceeding its own budget alone does not make D due. No new foreground message or intervening N batch is needed. Completion requires exhausted frozen Raw, D not due, and all owned work settled. Empty/dropped results do not re-arm the loop. A failed catchup step immediately retries the same phase and boundary without checking other phases. Three consecutive failures of one logical task turn memory off and end the drain; cancellation also ends it.

Catchup uses ordinary slots and claims: at most one N per session; D has one database-wide seat and one pool per run. A busy completion trigger is skipped, not retained or retried on slot release. Low-threshold tails may remain when catchup finishes. Repeating the command reports the active drain. Acknowledgement is not completion; `stop`, `off`, path changes and shutdown fence further launches while retaining committed work.

Historical import and restart/restore alone create no automatic checkpoint. A newly recognized main-turn terminal can check once; importing entries without a terminal, sibling-only imports and unchanged polling start no task. Entry ingestion and ordinary worker completion never substitute for that terminal. Explicit catchup remains available for the selected backlog. A failed attachment discards its resources even when cleanup throws, reports the original error rather than readiness, and retries from fresh resources only on the next existing wake. After an executor restart, `/reload-plugins` can restore turn-end checks without SessionStart only if the new executor has the same live native process assignment (PID, start time, session and transcript) and the prior close was unconfirmed. A confirmed close, changed process or unverifiable assignment still needs SessionStart.

Changing project ownership requires the declaring session to have no running N/D and no reached N/D trigger, including all applicable knowledge pools. Refusal names the phase and starts nothing. Other sessions do not block the change, but their in-flight writes retain ordinary authority checks. Moved project versions keep their identity and lose only their destination processing records, so return moves become pending again.

Every SessionEnd, `/clear`'s included, closes its native lineage without waiting for the MCP executor to exit or the transcript tail to import. MCP shutdown alone never closes it. SessionStart records the invoking native process identity from the existing `CLAUDE_PID` mechanism, fencing late SessionEnd hooks from an older process; unavailable identity is reported explicitly, not guessed. Remaining transcript entries can be imported on reopening.

`/clear` ends the session like an exit and starts an ordinary new one, exactly as a startup in the same directory would: its own binding and core session, the default enrollment, the project its directory already has (see above), and the startup injection. The cleared session's session-scoped knowledge does not come along, and its pending Raw is left to closed-session borrowing. The Claude Code process's MCP executor follows it: it leaves the cleared session as it does on exit (a final import of the transcript tail, bounded by `finalSyncTimeoutMs`; its tasks cancelled and settled; its claims and executor record released), then attaches to the new session as at startup. It follows any later session of the same process the same way, including one chosen with `/resume` inside it. Sessions that an earlier version linked on `/clear` to the session they were cleared from keep that core session and read their inherited path; while another of its native lineages is live, a SessionEnd leaves the shared core session open.

## Database upgrade

Stop older Pi and CC executors before opening the shared database with this upgrade; mixed-runtime writes are unsupported. The transaction preserves source, fact, knowledge-history, session and project records. Historical empty support lists inherit their parents' supports; root-empty ancestry remains empty and is reported. Knowledge marks are removed entirely.

The old-default budget policy (4k/10k/1k) becomes 4k/15k/1k; custom policies are kept and reported. Legacy processing records are translated only for current visible versions into their current pools. This translation does not mark every version handled or change knowledge validity. Validate the upgrade on a consistent database copy before deployment. Store sets and verifies WAL on file-database open before its schema transaction; new databases therefore use WAL automatically. For this existing shared production database, stop all executors, take and validate a consistent backup, then convert manually and verify the mode before any updated worker starts. The deployment order controls that first conversion; it does not disable Store's normal WAL initialization. Code installation and production cutover are separate operations.

Ticket 86 also clears old Dreamer failure counters once in the normal-open upgrade transaction. They used reservation IDs instead of stable pending-revision IDs. The reset and SQLite application-version marker commit together; later opens retain new counters. N/C counters, all execution/run audit and on/off state are preserved. No counter reset runs on every open.

## Direct CLI

Run the same operator commands from a trusted shell or Claude Code's `!` shell escape with the native session ID:

```sh
node "$CLAUDE_PLUGIN_ROOT/dist/cc.cjs" cli \
  --config "$CLAUDE_PLUGIN_ROOT/cc.config.json" \
  --session <native-session-id> on
```

Replace `on` with `off`, `catchup`, `stop`, or `project <name>`. The `/tm/` files read the same way: `node "$CLAUDE_PLUGIN_ROOT/dist/cc.cjs" fs --config "$CLAUDE_PLUGIN_ROOT/cc.config.json" --session <native-session-id> read|grep|glob …`, for example `grep -in hashline /tm/S12` (short flags combine; `-n` shows matching lines, `-c` counts, `-F` is literal, `-A`/`-B`/`-C` add context), printing JSON. `stop` reports the executor's abort acknowledgement separately from observed process termination. Neither entry installs the plugin, edits configuration, or starts a replacement executor when the session's MCP executor is absent.
