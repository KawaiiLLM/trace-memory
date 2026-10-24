# Trace Memory Claude Code plugin

The standalone plugin requires Node >=24.6.0 and fails at its bundled entry before loading adapter or SDK code on an older runtime. It never downloads or installs a replacement runtime.

Before loading the plugin, edit `cc.config.json`. Set absolute paths for `stateDir`, `worker.claudeExecutable`, and the worker's private `cwd`. In `worker.contextWindows`, supply the prepared context capacity for each selected model, keyed by its exact configured name; each must be a safe integer greater than 10,000. The template's `null` values require explicit preparation, not a guessed capacity. The adapter runs on any installed Claude Code and records the version each worker run started; the native probes last passed on 2.1.280, and the status line shows `unverified CC <version>` while the running version differs. An old `worker.claudeVersion` key in an installed file is ignored.

CC uses the same flat phase-setting keys as Pi. The shipped defaults are:

| Phase | Model key | Default | Thinking key | Default |
| --- | --- | --- | --- | --- |
| Noter | `notingModel` | `haiku` | `notingThinking` | `xhigh` |
| Dreamer notes, curate and its scoring continuation (clustering uses Haiku `xhigh`) | `dreaming.model` | `sonnet` | `dreaming.thinking` | `xhigh` |

These are top-level JSON keys, including literal dots. CC and Pi store settings separately. CC Dreamer notes and curate run on Sonnet (default thinking `xhigh`): an explicit Sonnet model id is retained; otherwise it uses the configured Noter's Sonnet id, or the canonical `sonnet` alias. Scoring continues each group's curate conversation on that same model and thinking, with the same tools and readable roots. Clustering runs on Haiku at `xhigh` on every run, in parallel with repository notes. Register the Sonnet and Haiku identifiers in `worker.contextWindows`. The separate classify model/thinking keys are removed and rejected. Noter remains independently configured; unsupported native effort still fails explicitly. Omit `worker` only for ingestion/read-only operation.

A fresh worker uses its configured phase model, thinking level and capacity consistently for admission, execution and run records, including borrowed work and catchup. Each workspace task launches with its run's workspace as cwd; native transcripts follow that real cwd. Temporary memory renderings remain under the prepared private `worker.cwd/rendered`; only the run's rendering directory is additionally readable under `--restricted`, denied to Bash writes, and removed at settlement. The worker's Read hook still rejects other files, including unrelated files inside cwd. Capacity is looked up by model name, not copied from another phase. The local `/trace` Settings screen saves edits to this file and applies them to subsequent tasks on the running executor. It reports file save and executor apply separately; already admitted tasks retain their settings. Manual edits outside that command still require a restart.

Every Noter and Dreamer workspace task has Bash (152). Claude Code's sandbox is required and fails closed if unavailable, with no unsandboxed fallback or excluded commands. The workspace is explicitly writable; repository roots, the worker HOME's `.trace-memory` and `.pi/agent`, the configured database's directory, Pi's effective agent directory (`PI_CODING_AGENT_DIR` when set), and the rendering directory are denied writes. All those private directories and the shared repository-secret patterns are denied reads. The workspace and rendering directory must be outside every denied directory, including through symlinks; an overlap fails the task before launch rather than weakening a denial. The rendering directory must also stay outside the writable workspace. Bash has no allowed network domains, Unix sockets or local binding. Existing Read, Write, Edit, Grep and Glob path hooks are unchanged. The prompts require read-only use outside the workspace and forbid network use; this is not a claim of universal workspace-only confinement.

Ticket 151's third probe supplies sandbox-enforcement evidence on macOS: changing cwd to the workspace matched all 25 attempted outcomes, not every possible runtime path or network route. The dispatcher retains the manual check at `.scratch/151/probe-sandbox-bash.ts`, outside the test suite; run it from its owning worktree with `node .scratch/151/probe-sandbox-bash.ts`. It uses disposable `/private/tmp` targets and `tests/hosts/cc-native-fence.ts`. The fence prevents nested sandbox initialization, so its Bash calls fail closed. The third probe's unfenced launch was separately authorized; reproducing it requires fresh authorization, not removing the fence from the script.

Core phase bounds use optional top-level keys in the same file:

| Key | Default | Meaning |
| --- | ---: | --- |
| `noting.triggerTokens` | 10,000 | Noter trigger checked at every main-session entry end; catchup still drains below it |
| `dreaming.triggerOperations` | 30 | Dreamer trigger: Noter knowledge operations (creates and updates) not yet covered by a Dreamer pass |
| `dreaming.timeoutMs` | 1,800,000 | Wall-clock bound per stage interval; curate plus scoring gets two intervals |
| `dreaming.groupItems` | 50 | Maximum candidate items per conversation; cannot exceed 50 |
| `dreaming.parallelGroups` | 5 | Concurrent group limit; cannot exceed five |
| `dreaming.notesSteps` / `dreaming.notesTokens` | 10 / 10,000 | Soft response budget / hard notes-file token cap |
| `dreaming.clusteringSteps` / `dreaming.clusteringContextTokens` | 30 / 150,000 | Every-run clustering soft response / context-growth budgets |
| `dreaming.curateSteps` / `dreaming.curateContextTokens` | 100 / 200,000 | Dispatcher-proposed soft response / context-growth budgets |
| `dreaming.scoringSteps` / `dreaming.scoringContextTokens` | 10 / 60,000 | Soft response / context-growth budgets counted from the scoring stage's start |
| `compaction.temporaryTokens` | 10,000 | Body pool: pending Raw overflow, then unscored Knowledge newest first (165) |
| `compaction.pointerTokens` | 10,000 | Independent pointer pool: titles of Knowledge not shown whole by score, then user words and fact titles together by newest path turn (165/140) |
| `compaction.userTurns` | 100 | User-word reach including the anchor, counted along its path |
| `compaction.titleTurns` | 100 | Fact-title reach including the anchor, counted along its path |
| `compaction.userEntryTokens` | 300 | Middle-cut cap for each earlier human user entry |
| `writing.titleWords` | 20 | Title target of a fact or knowledge item in units (each CJK character, and each run of letters and digits, counts 1), for every writer; a check refuses only above target + 10%, rounded up (22) |
| `writing.bodyWords` | 200 | Body target of a fact (its segments summed) or knowledge item in units, for every writer; refused only above 220 |

Both temporary pools are configured independently of the Noter and Dreamer triggers.
Noter publishes facts and knowledge together; facts have no later processing queue. Database pool
budgets size injection and compaction only: they trigger no Dreamer run and decide none's success. The Dreamer
curates the knowledge (merge, split, archive, rewrite), verifies its own changes against facts and the repositories,
and classifies items by importance (1 to 100); a task with nothing to do makes no model call.

Compaction retains the 20k Knowledge, 10k Raw and 10k full-fact bases. Independent 10k body and
pointer pools make the default envelope 60k before the guide and live tasks. Bodies cannot crowd out titles.
Noter shares selection at its batch endpoint without extending the configured reaches;
capacity negotiation reduces pointers, then overflow bodies, then full historical facts.
The episodic order is titles, full facts, user words, Raw, running tasks.

The compaction hook supplies running/waiting agents from `$.agent.list()`. Claude Code 2.1.293
did not reattach task status after a hook-supplied compaction in the fenced local-provider probe.
Background shells are not listed: historical structured launch ids have incomplete terminal
notifications, so their presence does not establish live state. The adapter conservatively lists
agents only rather than guessing. No running-task block is emitted when empty.

If any pending Raw entry cannot fit its base plus temporary allowance, `hook-compact`
passes through to native compaction, then the existing Knowledge supplement (133 R1).
The read-only `trace://compact` view still truncates with receipts, and no compaction starts N.
Task-list lookup errors retain native fallback. Malformed individual agent records are
skipped without discarding the custom compaction; the boundary uses hand-written checks.

Optional `retry: { "maxRetries": 2 }` configures the native request retry count. Omission preserves
Claude Code's native default; zero disables those retries. Timing, backoff and eligible errors remain
native policy. The adapter records retry events, specific API errors and received usage, but adds no
retry loop and does not promise recovery from errors inside an already-started stream.

A narrowly scoped process guard contains the pinned SDK's late control-response abort only when it
belongs to an already-aborted worker. It records that diagnostic; unrelated unhandled rejections
remain fatal. This contains the known SDK cancellation defect without modifying the installed SDK.

Each fresh CC worker run's conversation is a native Claude Code session, written by Claude Code itself —
not a custom log. It lands where Claude Code always puts a session for a given working directory:
`<CLAUDE_CONFIG_DIR, or ~/.claude>/projects/<run's real cwd, with every non-alphanumeric character turned
into a dash>/<session id>.jsonl`. For workspace-bearing tasks, that cwd is the run's workspace, not
the prepared `worker.cwd`. Every isolation option stays on (`settingSources: []`, no plugins,
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

CC omission receipts retain the omitted material's pool: base bodies charge the Knowledge base, overflow bodies charge the body pool, and titles charge the pointer pool. Mixed omissions use separate receipts per pool. A pool overrun never evicts knowledge from another pool.

## Automatic scheduling

After every ingested main-session entry, N and D may each start one run under the existing seats (141). Busy phases queue nothing, and ordinary task completion schedules nothing; the next entry after settlement checks afresh. Automatic failures retry at a later entry end; three consecutive failures still disable memory. Manual catchup keeps its completion checkpoints, and closed-session borrowing remains turn-end-driven. Noting uses the incremental pending counter; Dreaming retains a not-due result until its progress signal (coverage, hand-off, failure and score changes) or selected/enrollment state changes.

The executor observes transcript writes with or without function hooks; no per-entry hook process blocks the native session. Each import that persists new selected main-session entries checks own N/D once after the complete path is published, using `reconcile.headTurnId` as head and the newest persisted entry's id as trigger. This includes historical bootstrap at executor startup, not a fully imported restart/resume. Subagent transcripts, sibling-only imports and unchanged polls create no entry opportunity. Manual catchup freezes its own boundary; the function turn-end reconcile retains the turn-end check. The main `turn.complete` checkpoint stays as a turn-end opportunity, with overlapping observations deduplicated. A withdrawal that leaves no native source creates no synthetic entry.

Native transcript reads decode one JSONL record at a time from bounded byte chunks, including full scans, compaction-parent lookups, tail reads and worker-log verification. Transcripts larger than V8's single-string limit are supported; a single record may span chunks. Imports still commit only newline-completed records and preserve byte offsets. Full scans retain their byte snapshot until the file-stability check passes, and parsed records and lineage indexes still consume memory proportional to the transcript.

The Noter always runs as a fresh worker (ruling 2026-10-22): a fork's prefix is the main conversation, not the compaction memory the Noter starts from. `noting.forkModeDefault` and `noting.branchModeDefault` are removed settings; a `cc.config.json` that still carries one fails to load with `Removed setting noting.forkModeDefault: the Noter runs fresh only; remove this key`.

Thinking-only entries remain in the processing batch and are marked processed on publication. The plugin stores no Raw/carrier association. The plugin denies `note` and `memory` to subagents, so only the main session writes manually, and subagent transcripts are not imported as foreground Raw. Stop cancels work and checks already received by the executor; it does not disable later checkpoints.

## Enable function hooks

Set `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` in the **Claude Code process environment** before launching it. An interactive installation can set the variable in Claude Code settings' `env` block. SDK-launched processes and fresh `CLAUDE_CONFIG_DIR` directories do not necessarily inherit those personal settings: pass the variable explicitly to the CC child process. `claude plugin validate` checks the module; it does not prove runtime loading. Use `--debug` to confirm that the hooks module loaded. A disabled module may be reported only in the debug log, not stream-json output.

Main-agent `note` and `memory` calls wait in `tool.call` until their containing model response's
`turn.step` stream finishes, then pass unchanged to Claude Code's permissions and the executor's
exact persisted-call binding. Other tools remain eager; subagents remain denied. The gate matches
streamed tool-use IDs within their own session and step, so parallel calls share a boundary and
overlapping responses cannot release each other's writes. Cancellation or stream failure releases
waiters without dispatching a write.

The top-level `writeResponseTimeoutMs` setting bounds that response wait: **8,000 ms** by default,
an integer from 1 to 9,000. The default covers the measured seven-second response tail while
leaving two seconds of Claude Code's 10,000 ms own-time hook budget for cleanup and dispatch.
Expiry passes the unchanged call onward; it does not authorize a write or extend the separate
`writeSourceTimeoutMs` binding wait (default 5,000 ms). The gate reads the setting from
`cc.config.json` when a write is waiting. Without function hooks, dispatch and the
`source-not-ready` refusal remain unchanged.

With the function module loaded, Trace Memory performs Claude Code's main-session manual `/compact` (without instructions) and automatic compactions (threshold, mid-turn and prompt-too-long) itself, as Pi's compaction does: no summarisation request is sent. The hook returns one user message carrying the same material Pi's compaction carries (knowledge, recent facts and pending compressed Raw, within the windows above) and keeps no original message: the turn in flight — the prompt just submitted, or a tool call and its result — is the newest Raw in it, so the interrupted turn continues from the block. Claude Code has that turn in memory but writes it to the transcript a moment later, so the build waits (up to 10 seconds) for the row and for the executor to import it, reading only the transcript after the stored leaf; without a live executor it imports the transcript itself. The block's knowledge is recorded as the compaction's delivered state before it is returned, so `SessionStart(compact)` (which never injects) and the next `UserPromptSubmit` add nothing. The block is framed exactly as Pi frames a compaction summary for the model ("The conversation history before this point was compacted into the following summary:" and a `<summary>` element), so the model reads it as the continued conversation; the Trace Memory envelope inside is never imported as Raw, and `--resume` restores it. After an automatic compaction only, the block also ends, after that framing, with Claude Code's own native instruction to continue the pending task without asking the user; a manual `/compact` gets none. When it omits pending Raw or facts, a transcript notice (not sent to the model) says so; the omitted material stays pending for Noting.

Plugin-triggered, precompute and subagent compactions, and those of an unbound or disabled session, stay Claude Code's own; so does a `/compact` with instructions (text after `/compact`, non-empty after trimming), because the instructions steer a summary and Trace Memory's compaction has none (Pi's `/compact <instructions>` is native the same way); so does any compaction whose build fails (for example because the session or its selected path changed meanwhile). After such a native main-session compaction, the hook calculates the missing exact knowledge versions from the deliveries recorded on the selected path and appends them; that supplement becomes the compaction's baseline. It uses the existing knowledge budget and records each part's rendered Knowledge cost. A failed or cancelled supplement leaves the native compaction result unchanged and records no delivery; a failure of native compaction itself retains its original failure semantics.

With the function module loaded, the main session's system prompt also carries the retrieval policy (when to look memory up; one `trace-memory-retrieval` section appended by the `prompt.compose` hook) while the session's memory is on. Claude Code renders the system prompt once per session and again at `/compact` and `/clear`, so a `/trace on` or `/trace off` takes effect at the next of those. Subagents and fresh Noter and Dreamer runs build their own prompts. Without the function module there is no policy. With it loaded, Read reads the read-only virtual `trace://` namespace in the main thread and ordinary subagents. `Read trace://` lists addresses. Node views use `trace://<layer>/S<n>[/T<t>]`; raw alone accepts entry and role suffixes. `trace://knowledge/S<n>` gives a child background, and `trace://compact/S<n>` gives it continuation material. Public `trace` is removed; internal rendering and human `/trace` controls remain. Claude Code main sessions have no Grep or Glob tool, so there is no hook for them; `search` (with `code`) finds exact strings. The function hook only answers addresses that start with exactly `trace://` (lowercase) and delegates every other path to the native tool. Claude Code resolves a Read's `file_path` against its working directory before a command or SDK hook runs, so `trace://K1` reaches `hooks/read.mjs` and the N/D worker's hook as `<cwd>/trace:/K1`; both recover the address from that form. It runs `dist/cc.cjs fs` for the native session's bound reader. Ordinary paged Reads use the command PreToolUse rewrite; whole knowledge/compact/entry views require the function module. Without that module those whole views are unavailable; MCP `search`, `note` and `memory` remain, not a `trace` fallback. Writes under `trace://` are refused and reads record no delivery.

If the function module is not loaded, the next `UserPromptSubmit` is the recovery opportunity: it calculates missing bodies from the deliveries recorded on the selected path. **After automatic compaction, the rest of that same turn can lack knowledge until the next user submission.** This recovery does not provide another knowledge window, and versions already recorded as delivered on the path are not delivered again. It does not make `/trace` available without function hooks; there is no model-invoked fallback skill.

The function module uses Claude Code's experimental function-hooks API, last verified on 2.1.293. Installation does not run a package manager or edit personal Claude Code settings or the user's status-line script.

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

Use `/trace` to open the local, zero-foreground-model-turn menu. It shows the current context (when verifiable), pending triggers, spend and recent runs, with actions for enrollment, catchup, dream, stop, project and settings. Its Settings screen writes database budgets and `cc.config.json` worker preferences, preserving unrelated keys. The running executor applies successful edits to future tasks, while already running tasks keep their admitted configuration. If a save succeeds but apply fails, both outcomes are reported separately; the menu does not claim that the saved value is already effective. `/clear` changes the native session identity; every menu action resolves the live ID before dispatch. The command runs only on the pinned function-hooks API. Opening the menu starts no memory work or remote token-count request: In pinned Claude Code 2.1.280, the `summary` total uses the last valid response's input and cache-input usage when available, otherwise local estimates; it is not a promise of the next request's complete wire size.

Knowledge/Facts/Raw are measured from envelopes inside the current Messages snapshot's SessionStart and UserPromptSubmit hook-context blocks. User-message envelopes, bare or in Pi's compaction framing (Trace Memory's compaction and the function-compaction supplement), cannot be distinguished from a user's verbatim copy through Messages alone. One is attributed, as an estimate, when the database records a compaction's delivery with exactly its knowledge versions, state notices and Knowledge cost; it is then measured like a hook-context envelope. Without such a record its memory breakdown is unavailable rather than reported as zero. This does not mean the context is empty or invalidate independently available total estimates or usage. Carrier recognition reads neither the transcript nor executor import state. Complete envelopes verify their database/session identity and body digest. Previews verify the same identity; when their referenced original file exists, its digest and prefix must also match. A deleted original permits identity-only verification. Classification and accounting use only the retained preview, never the omitted original. Repeated carriers or failed verification make the split unavailable.

Embedded images use their PNG/JPEG/GIF/WebP header dimensions and the session model's resolution tier. Local estimates follow Anthropic's [Vision guide](https://platform.claude.com/docs/en/build-with-claude/vision#evaluate-image-size) and [resize reference](https://platform.claude.com/docs/en/build-with-claude/vision-coordinates#resize-your-image-before-uploading), checked 2026-09-24 UTC: resize to the model's edge/token limits, then count `ceil(width / 28) × ceil(height / 28)`. Both user images and images inside tool results count. At the 4096-message limit, with unreadable image dimensions or an unknown image model tier, or with a document/unsupported block, the split is unavailable and Messages remains unchanged. Image URLs and file IDs are not fetched.

The direct CLI accepts the following existing verbs:

| Subcommand | Effect |
| --- | --- |
| `on` | Enable memory for this session; does not start a catchup. |
| `off` | Stop this executor's work and disable memory. |
| `catchup` | Start one finite Noting drain with ordinary Dreamer threshold checks, or report the active drain. |
| `dream` | Start one Dreaming run for this session now, whatever the Noter-operation count says; the status shows in `/trace` as `Dream: …`. |
| `full-check` | Cluster all visible project/global knowledge, curate every group and rescore all survivors without anchors; also available as Full check beside Dream in `/trace`. |
| `full-check --dry-run` | Model-free items and measured cost estimate; includes persisted groups and committed decisions after clustering. |
| `stop` | Stop this executor's work without disabling memory. |
| `project <name>` | Declare this session's shared project. |

The former model-invoked `trace` skill is removed so its bare alias cannot conflict with the local command. The direct CLI remains available from a trusted shell; it does not silently fall back to a model turn when function hooks are disabled.

`catchup` requires an enabled session and its live MCP executor. It reconciles the current path and freezes the pending Raw boundary. Noting drains it in bounded subagent batches, ignoring only N's trigger threshold; later Raw does not extend the drain. One checkpoint at start and after every successful catchup-owned N or D completion checks both phases. D uses the ordinary session-wide overflow or summed-pending conditions; one pool exceeding its own budget alone does not make D due. No new foreground message or intervening N batch is needed. Completion requires exhausted frozen Raw, D not due, and all owned work settled. Empty/dropped results do not re-arm the loop. A failed Noting step immediately retries the same phase and boundary without checking other phases. A failed Dreaming run does not: it retries at the next entry-end check and ends an active drain for the same session and path, whoever started the run. Three consecutive failures of one logical task turn memory off and end the drain; cancellation also ends it.

Catchup uses ordinary slots and claims: at most one N per session; D has one database-wide seat, and one run covers all of the session's pools. A busy completion trigger is skipped, not retained or retried on slot release. Low-threshold tails may remain when catchup finishes. Repeating the command reports the active drain. Acknowledgement is not completion; `stop`, `off`, path changes and shutdown fence further launches while retaining committed work.

Startup and restored-history imports that persist new selected main-session entries check own N/D once at the final selected head, triggered by the newest persisted entry; restart/restore without new entries creates no automatic checkpoint. Newly ingested selected main-session entries check N/D without requiring a terminal; sibling-only imports and unchanged polling start no task. Ordinary worker completion schedules nothing. Explicit catchup remains available for the selected backlog. A failed attachment discards its resources even when cleanup throws, reports the original error rather than readiness, and retries from fresh resources only on the next existing wake. After an executor restart, `/reload-plugins` can restore turn-end checks without SessionStart only if the new executor has the same live native process assignment (PID, start time, session and transcript) and the prior close was unconfirmed. A confirmed close, changed process or unverifiable assignment still needs SessionStart.

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

Replace `on` with `off`, `catchup`, `dream`, `stop`, or `project <name>`. The `trace://` files read the same way: `node "$CLAUDE_PLUGIN_ROOT/dist/cc.cjs" fs --config "$CLAUDE_PLUGIN_ROOT/cc.config.json" --session <native-session-id> read|materialize <trace://…>`, printing JSON. `stop` reports the executor's abort acknowledgement separately from observed process termination. Neither entry installs the plugin, edits configuration, or starts a replacement executor when the session's MCP executor is absent.
