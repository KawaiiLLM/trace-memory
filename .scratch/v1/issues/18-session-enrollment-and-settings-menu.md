# 18 — Session enrollment and settings menu

Label: ready-for-agent. Tracker: none configured; this file is the ticket.

Status: specified, held behind ticket 17 (17a–17c), which the user has not released. Baseline: `b4fcd51`, revised 2026-09-08.

Depends on the entry identity and attach-time reconciliation of 17a, the queue contracts of 17b and the claim of 17c. Rulings recorded 2026-09-08: "enabled means delivered, whatever the worker mode" supersedes the 2026-09-07 consumer-mode backfill matrix; configuration follows pi-om's shape (a namespaced key in Pi's `settings.json`, read-only, environment overrides) and the menu shows effective values without editing them; there is no historical-import machinery beyond 17a's reconciliation gated by enrollment; there is no migration section.

## Problem Statement

Users need one answer to whether a conversation participates in Trace Memory. Recording and Integration execution modes should not implicitly decide whether memory enters the main conversation. Users also need a visible, reversible way to pause participation and manage configuration without editing files.

Installing the plugin must not silently enroll every old Pi conversation when it is reopened. Conversely, new conversations created after installation should work automatically. Historical entries were never seen by the plugin's event listeners, so explicitly enabling an old conversation requires importing its existing source path before normal incremental processing can work.

## Solution

Give each memory session one persistent enrollment state: enabled or disabled. New Pi sessions created after the installation baseline default to enabled; older or unclassifiable sessions default to disabled. Explicit choices override defaults permanently until changed again.

Enabled sessions participate in source ingestion, initial knowledge injection, incremental fact and knowledge delivery, Recording, Integration and closed-session catch-up. Disabled sessions do not participate automatically. Disabling preserves existing memory; enabling imports missing native history and resumes processing from durable progress.

The `/trace` command opens a native Pi menu showing the current session's enrollment state, the effective global settings (read-only), run history and status. Explicit enable, disable, runs and status commands remain available without interactive UI.

## User Stories

1. As a user, I want new conversations created after plugin installation enabled automatically, so that I do not have to opt in every time.
2. As a user, I want pre-existing conversations disabled by default, so that reopening an old conversation does not silently process its history.
3. As a user, I want an explicit choice to survive restarts and upgrades, so that defaults never undo my decision.
4. As a user, I want unclassifiable conversations disabled by default, so that missing metadata does not cause unexpected ingestion.
5. As a user, I want one enrollment switch independent of worker modes, so that branch and subagent settings only control execution.
6. As a user, I want enrollment visible in the menu and footer, so that I can tell whether memory is continuing.
7. As a user, I want to enable an old conversation, so that its available history can become traceable memory.
8. As a user, I want existing native entries imported when I enable memory, so that installation timing does not discard earlier context.
9. As a user, I want repeated enable operations to be idempotent, so that they do not duplicate Turns, facts or queued entries.
10. As a user, I want import to follow my current tree path, so that sibling conversations are not mixed into current evidence.
11. As a user, I want history before compaction imported when still available, so that the compacted model context is not mistaken for the full source.
12. As a user, I want missing or corrupt history reported accurately, so that memory does not silently claim full coverage.
13. As a user, I want historical import to enqueue rather than immediately drain extraction, so that enabling memory does not start an unbounded model workload.
14. As a user, I want new completed entries to continue through the same ingestion path, so that imported and live sources behave consistently.
15. As a user, I want disabling memory to stop new background work and automatic injections, so that participation genuinely pauses.
16. As a user, I want uncommitted work cancelled or prevented from committing after disable, so that an acknowledged pause is respected.
17. As a user, I want already-committed facts and knowledge preserved on disable, so that pausing does not destroy prior work.
18. As a user, I want a warning that injected text remains in the current context, so that disabling is not confused with erasing model context.
19. As a user, I want re-enabling to import the paused interval, so that continuing memory resumes the conversation rather than creating an unexplained gap.
20. As a user, I want explicit search and trace reads available while disabled, so that I can inspect stored evidence without enrolling the conversation.
21. As a user, I want write tools rejected while disabled, so that manual writes cannot bypass the enrollment switch.
22. As a user, I want tree navigation to retain my enrollment choice, so that selecting a different node does not unexpectedly toggle memory.
23. As a user, I want fork and clone behavior to respect shared memory identity, so that copied state does not create conflicting enrollment decisions.
24. As a user, I want disabled closed sessions excluded from catch-up, so that another active conversation cannot restart processing them.
25. As a user, I want enabled-session backfill independent of branch or subagent mode, so that changing an execution strategy does not change participation.
26. As a user, I want the effective global settings visible in the menu with their source, so that I can see what the plugin is running with before editing `settings.json` by hand.
27. As a user, I want the settings scope stated explicitly, so that a global value is not mistaken for a current-session preference.
28. As a user, I want invalid settings rejected at load with a clear message, so that a typo cannot break extraction silently.
29. As a user, I want cancelled menu interactions to change nothing, so that browsing is safe.
30. As a user, I want noninteractive commands for enrollment and status, so that scripts and non-TUI hosts can use the same operations.
32. As a user, I want sessions open in another Pi process to observe shared enrollment, so that a stale host cannot continue writing after I disable the session elsewhere.
33. As a user, I want previous knowledge to remain available in its original scope after disabling its source session, so that a pause does not silently retract established knowledge from other conversations.

## Implementation Decisions

### Enrollment defaults and identity

- **Single state.** Persist enabled or disabled for each Trace Memory session identity. Track explicit decisions separately from derived defaults so reopening, upgrades and metadata discovery do not overwrite user intent. Use the same policy at every automatic entry point and write boundary.
- **Installation baseline.** Create one durable installation-scoped timestamp at first successful plugin initialization. Initialize it atomically and retain it across restarts, upgrades and session openings. This is the operational baseline: the plugin cannot infer the package manager's historical installation time before it first runs. A session created in that unknown interval is conservatively classified as pre-existing.
- **Native creation time.** Compare the native Pi session creation timestamp, not file modification time, database creation time, or when the plugin first encounters the conversation. A trustworthy creation time strictly after the baseline defaults to enabled. An earlier, equal, missing or malformed timestamp defaults to disabled. An explicit setting always wins.
- **Early decisions.** Enrollment must be resolvable before the first assistant reply and before automatic injection. The core currently creates memory sessions only once an assistant reply exists; keep that domain contract. Persist a provisional native-session enrollment choice and transfer it when a memory identity is allocated, without requiring an otherwise unnecessary Raw Turn.
- **Shared identities.** When a Pi fork or clone carries an existing Trace Memory session identity, inherit that identity's enrollment state. A copied file's newer timestamp cannot re-enable a disabled identity. The menu must disclose that changing this state also affects sibling copies sharing that identity. A genuinely independent Pi session without copied memory identity uses the normal creation-time default.
- **Current state authority.** Tree restoration may restore historical branch position, but must not restore a stale enrollment value from an old custom state entry over the current persisted choice. A tree position and an enrollment preference are different kinds of state.

### Enabled and disabled behavior

The enrollment switch controls participation, not deletion:

| Behavior | Enabled | Disabled |
| --- | --- | --- |
| Import current-path history and ingest new source entries | Yes | No |
| Initial knowledge injection and incremental fact/knowledge delivery | Yes | No |
| Plugin Raw/memory injection during compaction or branch carry | Yes | No |
| Automatic Recording and Integration | Subject to ticket 17 triggers | No |
| Target of closed-session catch-up | If closed and eligible | No |
| Entry events initiate closed-session catch-up checks | Yes | No |
| Explicit read-only search, trace and status | Available | Available |
| Manual note and memory writes | Subject to existing validation | Rejected with an enable instruction |
| Existing Raw, facts, knowledge and run records | Retained | Retained |

- **Mode independence.** For enabled sessions, both new facts and knowledge changes are delivered regardless of worker mode. Branch or subagent controls how a worker runs, not whether the main conversation receives memory. This supersedes the 2026-09-07 consumer-mode backfill matrix (user ruling 2026-09-08); the configuration-derived delivery switches from commit `2ff66be` are deleted, while the branch-mode wait for a pending delivery stays.
- **Enable.** Persist the enrollment choice, reconcile the current native source path, and expose any pending work. Import is local ingestion, not a model call. Do not launch a drain loop or turn import into a synthetic entry-completion event. The next ordinary eligible completion checks thresholds under ticket 17; later closure permits its bounded catch-up behavior.
- **Disable.** Persist the disabled state before acknowledging success, reject new task admissions and writes, and request cancellation of in-flight work that has not committed. At the commit boundary, recheck enrollment so a stale worker cannot commit after disable. If a commit wins the race before disable, preserve it as success. Do not hold a database transaction while waiting for cancellation or a provider response.
- **Visibility limits.** Stop future plugin injection immediately, but do not claim to remove text already present in Pi's model context or native history. Leave outstanding deliveries unconfirmed rather than acknowledging unseen content. Existing settled-only delivery confirmation remains valid for content actually shown before disable.
- **Resume.** On re-enable, ingest the paused interval from native history and continue from proven processing progress. This is a pause/resume feature, not a permanent exclusion range. Do not silently skip entries merely because they were authored while disabled.
- **Preserved knowledge.** Disabling does not archive, delete or narrow the scope of knowledge previously created by the session. It does not revoke evidence already available to other sessions. Permanent deletion, redaction and revocation are separate operations.
- **Native fallback.** When disabled, do not suppress Pi's own compaction or navigation behavior simply because the plugin is not contributing a memory block. Avoid returning a replacement summary that would discard native context without its normal fallback.

### Historical import and tree behavior

- **One ingestion path.** Reuse ticket 17's entry ingestion for historical and newly persisted messages. Native history is the source of entry identity, ordering and ancestry; the database is a projection, not a substitute source reconstructed from the current compacted prompt.
- **Source selection.** Import only the selected path's original source messages. Preserve original message times and roles; associate entries with their owning Turn based on user-message boundaries. Exclude plugin injections, plugin state, worker logs and compaction summaries as specified in ticket 17.
- **Stable deduplication.** Match native lineage and entry identity so retries and shared-ancestry forks reuse source records. Entry IDs must be interpreted within their native origin/lineage; do not assume an arbitrary short ID is globally unique, and do not deduplicate by message text.
- **Compacted history.** Use persisted ancestry that still includes pre-compaction sources. Do not import the compaction summary as if it were the missing original user conversation. If source history is unavailable, expose the unavailable range and continue only where identity and ancestry are known.
- **Import is reconciliation.** Enabling runs 17a's attach-time reconciliation over the current native path; it is idempotent by entry identity, so interruption, retry and entries completing during the reconciliation all resolve through the same path. The plugin never parses the session file itself; it reads entries through the session manager.
- **Tree navigation.** If enabled, reconcile any newly selected ancestry before queue selection and automatic source injection. Reuse common ancestor progress and retain sibling queues separately. Navigation changes neither enrollment nor the trigger policy; it does not initiate a model flush.

### Menu and configuration

- **Native UI.** Register a command that uses Pi's `select`, `confirm` and `input` dialogs. No new UI dependency.
- **Top-level actions.** With no arguments, `/trace` presents Current session, Settings, Runs and Status. Current session shows Enabled or Disabled plus whether the state came from a default or explicit choice. Settings is visibly labelled Global and is read-only.
- **Explicit commands.** Keep `/trace enable`, `/trace disable`, `/trace status` and existing run/read command forms. Menu actions and commands call the same enrollment/configuration operations. In a headless context, bare `/trace` returns status and available commands instead of attempting a blocking menu.
- **Toggle copy.** Explain on disable that processing and future injection stop but stored memory and already-injected text remain. Explain on enable that available history, including the paused interval, will be queued. Mention shared fork/clone identity when applicable. Cancellation makes no state change.
- **Configuration shape (pi-om's).** Configuration is read from the `trace-memory` key of Pi's global `settings.json` (the agent dir) and the project's `.pi/settings.json`, project over global, with `TRACE_MEMORY_CONFIG` environment overrides on top; the reader that already loads Pi's `retry` settings is reused. Recording mode, Integration mode, trigger thresholds, compressed-view limits and batch budget live there and nowhere per session. Enrollment alone is session-scoped. The plugin never writes configuration.
- **Effective values.** The menu shows each effective value and which layer supplied it. Editing is by hand in the file; a value masked by an environment override is shown as masked.
- **Validation.** Counts and token limits must be finite positive integers and enum values supported; a bad value fails loading with a message naming the key, and limits that make the configured entry view impossible to batch are rejected as a capacity error.
- **Status.** Clearly distinguish Disabled from Enabled but idle or empty. Extend the existing footer/status item; do not replace the whole Pi footer or add animation. Do not mislabel a shared memory-session switch as a single-branch preference.

### Core and host contracts

- **Host responsibilities.** The Pi host supplies native creation metadata, source ancestry and UI actions. It reconciles source persistence boundaries, routes default decisions and respects disabled behavior before injecting anything.
- **Core responsibilities.** The façade/store owns durable enrollment, safe admission and commit checks, and entry deduplication. A UI-only guard is insufficient because manual tools, queued background work and another host may access the same session.
- **Shared workers.** Use ticket 17's session-wide ownership mechanism for task admission and cross-process races. Enrollment is another eligibility condition, not a second scheduler or a separate queue. A shared session disabled in one process cannot keep committing through another process's cached preference.
- **Preserved invariants.** Keep scope/path evidence rules, exact request auditing, atomic batch persistence, provider retries, per-fact Integration accounting and successful postcommit outcomes. No AgentSession migration is necessary for this feature.
- **Documentation changes.** Update the glossary, main specification, command help, host documentation and status wording together. Ticket 17 remains the authority for source-view limits and entry-triggered scheduling; this ticket adds the enrollment gate and replaces its retained mode-dependent backfill behavior.

## Testing Decisions

**Proposed primary seam:** extend the existing fake Pi host backed by the public TraceMemory façade and a temporary real database. Drive native metadata, persisted ancestry, menu selections, explicit commands and completion/lifecycle events. Inspect visible status, provider requests, queue behavior, source trace reads and committed records rather than internal table layouts or helper names. Confirm this seam choice with the user before implementation.

Reuse existing host restoration, queued-message persistence, branch carry, delivery confirmation and façade validation tests. Extend the two-process ownership check already required by ticket 17 for enrollment races; do not add another concurrency harness. Only small renderer/configuration boundary checks should fall below the host seam when the boundary cannot be expressed reliably through the host.

Acceptance covers these externally observable scenarios:

1. **Creation-time defaults.** A native session created before the baseline is disabled; one created after it is enabled. Equality, missing metadata and malformed timestamps are conservative. Reopening an old session today does not make it new.
2. **Stable baseline.** Restart, upgrade and concurrent first initialization preserve one baseline. Simulate first initialization after native session creation and verify the documented conservative result rather than inventing an earlier installation time.
3. **Explicit precedence.** Enable an old session and disable a new one. Reopen, switch tree position and reload configuration; both choices survive.
4. **Before-first-reply behavior.** Resolve enrollment and initial injection before a memory session exists. Toggle through the menu, then create the first assistant reply; the choice transfers without an artificial Turn or duplicate session.
5. **Historical import.** Enable a conversation with several pre-plugin Turns, including repeated identical user text, multiple assistant entries and tool results. Verify stable Turn addresses, source ordering and one queued copy of each entry.
6. **No import-triggered extraction.** Import a backlog above every normal threshold without making a provider call. A subsequent eligible entry completion schedules exactly the bounded work allowed by ticket 17.
7. **Compaction and missing sources.** Import available pre-compaction history, exclude the summary as evidence, and surface a deliberately missing segment. Do not invent Raw from the compacted prompt.
8. **Reconciliation recovery.** Interrupt the enabling reconciliation and restart it, with an entry completing meanwhile. Verify no lost completed entry, duplicated source or falsely advanced coverage.
9. **Pause/resume.** Disable, append native conversation entries, and verify no ingestion, injection, extraction or catch-up scan. Re-enable and verify the paused interval is queued from native history while existing processed entries stay processed.
10. **Write versus read.** While disabled, explicit search/trace/status work and note/memory mutations fail clearly without committing. Re-enable and confirm the existing normal validation still applies.
11. **Commit race.** Disable during a pending provider call and reject its late uncommitted batch. Disable after a successful batch and preserve its result. Repeat through another process using the ownership check from ticket 17.
12. **Delivery and context.** Disabled sessions receive no new plugin block and do not confirm unseen deliveries. Re-enable permits fact and knowledge delivery in all four Recording/Integration mode combinations. Content already injected before disable is not falsely reported as removed.
13. **Tree and shared copies.** Switch between siblings, fork a shared memory identity and reopen an older copied state. Enrollment remains current and shared, ancestor import is idempotent, and branch facts do not leak into another path.
14. **Catch-up gate.** An enabled closed session is eligible under ticket 17; a disabled one is not, even when its tail exceeds ordinary thresholds. Re-enabling makes existing pending work eligible again at the next permitted opportunity.
15. **Menu parity.** Native menu selection and explicit commands produce the same state. Escape/cancel changes nothing; headless bare command returns useful text. Changing a shared-session switch displays its scope.
16. **Configuration loading.** Global file, project file and environment layer in that precedence; invalid and boundary values fail loading by key; the menu shows each effective value and its source, including a masked file value.
17. **Retained memory.** Disabling a source session does not retract its already-shared knowledge from another session.

Revert probes should fail when default selection uses first-seen time, source ingestion deduplicates by text, only the menu checks enrollment, fork restoration overwrites the current switch from historical state, or delivery is gated on worker mode again. A final live Pi acceptance verifies native creation timestamps, persistence timing and terminal menu interactions; synthetic tests do not establish those runtime details by themselves.

## Out of Scope

- Reimplementing ticket 17's scheduler, compressed-view policy or shared task claims.
- Per-Turn permanent exclusion ranges, redaction, deletion or retroactive knowledge revocation.
- Removing already-injected text from the current native context when disabled.
- Independently toggling branches that currently share one Trace Memory session identity.
- Per-session mode/budget overrides, configuration profiles, a web settings UI, or any menu that writes configuration.
- A separate import worker that continuously scans all old sessions without opt-in.
- Immediate drain-on-enable, extraction on configuration changes, compaction or shutdown.
- Replacing the existing worker runtime with AgentSession.
- A new cross-machine settings service, log-export system or footer redesign.

## Further Notes

The final default ruling is: sessions created after plugin installation default to enabled; pre-existing sessions default to disabled. The operational implementation uses first successful initialization because a running plugin has no reliable retrospective package-installation timestamp. This limitation must be documented rather than hidden behind first-seen session time.

The later entry-view decision remains authoritative: user and assistant entries also have the overall entry cap. This enrollment ticket does not revive the earlier proposal to leave them unbounded, nor the older lifecycle drain rules.

Ticket 17 deliberately excluded enrollment UI and retained mode-dependent backfill. Those are the additions here, not reasons to duplicate its source ingestion or scheduling mechanisms. The settings editor of the first draft was dropped on 2026-09-08 after checking pi-om, which registers only read-only `/om:status` and `/om:view` and reads its configuration from a namespaced `settings.json` key. The proposed fake-host/façade test seam, with reuse of ticket 17's two-process check, is the sole confirmation requested before implementation.

No external issue was published: the repository has no configured issue tracker or Git remote. This local ticket follows the existing ready-for-agent convention.
