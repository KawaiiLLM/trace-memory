# Trace Memory

Traceable cross-session memory for Pi and Claude Code. A background Noter extracts facts from conversation, a Consolidator creates knowledge, and a bounded Dreamer maintains it. Each knowledge revision links to supporting facts and original source messages.

This checkout includes the Pi adapter and a separately packaged [Claude Code plugin](plugin/README.md). The changes below are unreleased; the historical Beta notes describe their own releases, not the current contract. Real-model extraction and maintenance quality remain separate from offline implementation tests.

## Unreleased

- **Knowledge maintenance:** Consolidator creates only; Dreamer updates, merges, splits and archives within one pool. Manual writes allow create and archive. Current-version resolution uses directly cited facts and persisted lineage cursors, with commit-order priority and no fallback through archive or scope. Maintenance writes materialize their parents' supports; transactional current-base and claim checks remain.
- **Session scheduling:** Global/project/session budgets default to 4k/15k/1k. Each ingested entry checks the session's pools together: a Dreamer run is due when their total exceeds the Knowledge base plus the shared allowance (30k by default), or when their pending weight, summed, reaches `dreaming.triggerTokens` (5k). The run takes the pool most over its budget, else the one with the most pending weight, and succeeds only when that pool ends within its budget with every frozen item deliberated; successful runs follow back to back until neither condition holds. Dreamer records only skipped frozen versions and its own outputs; untouched items remain pending. Runs have a thirty-minute default wall-clock bound, with no tool-round ceiling. Budgets do not reject writes. Runs have a ten-minute default wall-clock bound, with no tool-round ceiling. Budgets do not reject writes.
- **Shared material allowance:** The configured N and C triggers and D cap contribute once each, deriving a 20k shared allowance independent of database pool budgets. Knowledge/facts/Raw bases are 20k/10k/10k; Knowledge input can use 40k and the compaction envelope at most 60k. `dreaming.triggerTokens` is configurable again; `compaction.overflowTokens` remains retired. Knowledge marks and the Consolidator review round are removed; Noter NEAR remains.
- **Current context snapshot:** Other Pi extensions can synchronously request the freshly rendered Trace Memory compact material for the current persisted native node through the shared event bus. The read-only v1 result carries exact native/memory/source-path identity, text, token composition and supplied IDs; disabled, unready and over-capacity states are explicit and never invoke recovery, a worker, a summarizer or native compaction. See [the consumer contract](docs/pi.md#current-context-snapshot-for-other-extensions).
- **Noter NEAR review:** A valid automatic Noting batch with lexically similar earlier facts now receives one system-generated comparison round before commit. The candidate pool and source membership are frozen at binding time; batches with no neighbours and all manual notes still commit immediately. NEAR is only a prompt to judge `support` or `negate`, never relation evidence or a commit authority.
- **Noter NEAR audit:** Successful reviewed runs retain the originally shown pairs and record any still-near final fact/neighbour pairs without an explicit relation as the non-gating `unanswered_near` diagnostic. Reordering, dropping or rewriting the final batch is assessed by committed fact identity rather than original position; an absent diagnostic does not prove the comparison was understood.
- **Proportional context composition:** Current session uses SDK usage and the model window for occupied/free capacity, while the local census supplies only category color proportions. Each positive category gets full cells plus its own partial remainder, so the 20-cell-wide grid can grow beyond 200 glyphs without hiding small categories. Difference and the local-over-SDK single-color fallback are gone; Memory projects Knowledge, Facts, Raw and Unclassified separately, and unavailable or overflowing capacity remains explicit.

## Historical Beta.7 — September 13, 2026

The following records the former Beta.7 behavior. Ticket 64 supersedes its applicability, processing, retry and budget rules; use [the domain glossary](CONTEXT.md) for the current contract.

- **Lineage and processing:** New revisions use complete bodies with change-only supports and recursive exact-parent applicability. Path-aware concurrency permits proven sibling origins while rejecting comparable or unprovable consumers. Dreamer settlement separates supplied-event accounting from successor-free exact certification; actual maintenance of processed-reference knowledge inside the frozen family includes this exact run's terminal output without certifying the reference merely because it was read. An unchanged retained task blocked by an indivisible 10k admission item waits for an obligation-graph change or explicit retry instead of relaunching automatically.
- **Foreground delivery:** Enabled ordinary prompts use one Knowledge-only predicate. Persisted exact bodies and complete state-transition notices share the remaining database-derived allowance (20k at defaults) as deterministic whole items. Visible Facts or source identities can suppress fully covered change evidence. Bounded Raw counts only when its exact database/native pair belongs to the selected session path; a truncated bounded view can still suppress delivery after its evidence text was removed.
- **Database-owned Knowledge budgets:** Each database stores Global/Project/Session budgets (defaults 4k/10k/1k). Their 15k sum is the applicable processed ceiling; adding the fixed 5k buffer derives the 20k injection/compaction and Dreamer processed-input capacities. The buffer is not reserved exclusively for new Knowledge and does not guarantee 5k of free space. Settings edits one field transactionally, rejects unsafe reductions, and shows the derived capacities. `render.knowledgeBlockTokens` is retired and must be removed from file/environment configuration.
- **Dreamer check receipt:** Explicit checks and host-generated repair feedback show target-relevant owner budgets, the worst path across the full projection, separate pending event/version obligations, current derived capacities, the run's frozen admitted processed-input ceiling and every blocker. Full zero-inclusive owner/path totals and exact processing sets remain in the run audit and continue to control finalization; the receipt grants no read or write authority.
- **Dreamer workflow:** Commit each item's operations before moving to the next; record a reasoned skip when deliberation leaves it unchanged. The wall-clock bound covers the run, including corrections and native retries, without a tool-round ceiling. Maintenance protects meaning and valid topics, compares complete claims and checks the final state. Archiving still-valid information to fit a budget must disclose the loss; scripted tests are not proof of better model judgment or lower cost.
- **Current session:** SDK capacity estimates no longer depend on a complete local text classification. Images and SDK/text discrepancies do not replace the grid with question marks; unavailable usage gets a concise explanation. The full-screen panel covers unused text rows so dialogue and background text no longer show through. **Known limitation:** Pi 0.85.1 bypasses overlay composition for Kitty/iTerm2 inline-image rows, so existing terminal graphics may remain visible. Complete image hiding/restoration is not guaranteed; no private-host workaround is installed.
- **Atomic upgrade:** Supported schema, source/lineage migrations and database-policy initialization commit atomically; a failed upgrade publishes no partial policy and reopening retries idempotently. Existing revisions, support semantics, parent links, citations, Raw and certificates are preserved; unknown historical origins stay unknown. Back up the database and worker logs, then stop every older executor sharing the database before opening it with Beta.7. Mixed old/new runtimes are unsupported.
- **Validation limits:** Offline provider tests, temporary-database migrations, deterministic concurrency and compositor tests cover the release behavior. Real-model maintenance quality, manual terminal-image appearance and the new full-path audit's performance on a large production-database copy remain unverified.

## Install

Back up the database and worker logs, validate on a consistent copy, then stop all Pi and CC executors sharing the database before upgrading. Open the database once with the new code during the maintenance window; legacy JSON source paths migrate in the same atomic schema transaction as other supported migrations. Then restart the executors. Supported migrations preserve source, fact and knowledge history. Historical empty supports inherit their parents' evidence; an unchanged old-default budget becomes 4k/15k/1k, while custom values remain. Only legacy-processed current visible versions receive processing records in their pools. This does not promise compatibility with arbitrary partial development schemas.

Remove retired `render.knowledgeBlockTokens` and `compaction.overflowTokens` keys from all configuration layers; invalid or retired keys fail explicitly. Use Pi Settings for database budgets and [CC configuration instructions](plugin/README.md) for its independently stored phase settings.

**Historical Beta.6 release notes — September 12, 2026:**

- **Bounded Dreamer:** Dreamer runs as a fresh subagent with at most 20k processed knowledge, 10k changed knowledge and 10k direct facts. Its transactional final check enforces the shared processed caps: global 4k, each project 10k, each session 1k and applicable 15k, including framing. Retained retries reselect whole current results into bounded batches; one indivisible result that cannot fit remains pending.
- **Compaction:** required knowledge, facts and Raw use fixed 20k/10k/10k base windows. Their positive excesses share a required-only 10k allowance; unused bases do not lend. Optional refill selects newest already-extracted Raw first, then consolidated facts not fully covered by that Raw. Overflow recovery can run at most one eligible Noter, Consolidator and Dreamer task over at most three rounds before native fallback.
- **Trace and source authority:** Raw uses stable native `T<n>#E<m>` entry addresses, exact text/call/result selectors and independent per-child content budgets. Page budgets remain separate and cursor-based; complete knowledge write handles require the full semantic body across every page. Legacy aliases remain readable, but thinking and unproved legacy fragments cannot authorize new facts.
- **Failure handling:** three terminal business failures of the same logical task automatically turn off that target while retaining data and backlog; `/trace on` resets the streaks. A Dreamer blocked only by a verified post-freeze external successor ends in a neutral conflict, so it neither increments nor resets the streak and certifies nothing.
- **Current session and Settings:** Current session now shows bounded context composition, Memory's Knowledge/Facts/Raw split and separate Noting/Consolidation/Dreaming pending-to-trigger bars. Beta.6 Settings covered Noter and Consolidator modes/models/thinking, Dreamer model/thinking and closed-session scope. Database-owned budgets and derived capacities are added in Beta.7.
- **Accepted release fixes:** cleanup keeps lightweight enrollment controls out of full context/status scans. Legacy entry upgrades preserve original evidence, ordinals, aliases and citations when a recognized mapping cannot be normalized. Dreamer authority, external-conflict settlement and retained-range batching are enforced by core rather than model claims. The footer splits current Knowledge versions into exact unprocessed and processed counts.

**Historical Beta.5 notes:** Beta.5 made Noter and Consolidator subagents by default, restored Consolidator fork as an opt-in, introduced one bounded Raw view, and replaced continuous foreground receipts with initial injection plus one-shot `/trace on` and `/trace project` supplements. Its three-lending-window compaction design and lack of Dreamer are superseded by Beta.6. When upgrading older configuration, remove `render.toolCallTokens`, `render.secondaryToolCallTokens`, `render.secondaryEntryTokens` and `render.knowledgeBlockTokens`; retired keys fail by name rather than being reinterpreted. Knowledge capacity is now edited in Settings and stored in the selected database.

**Beta.3 configuration change:** remove `consolidation.subagentModeDefault` from any configuration layer that contains it, whether its value is `true` or `false`. The retired inverse key still causes a named load error. Beta.5 restores Consolidation fork: set `consolidation.forkModeDefault: true` to select it; the default remains subagent (`false`). Closed-session background work now defaults to same-project executors (`closedSessionScope: "project"`); choose `"global"` to retain cross-project borrowing or `"off"` to leave closed tails pending.

**Beta.4 changes:** no configuration change is required. A Noter now completes an empty batch only by an explicit `note({facts: []})`; a run that ends without submitting is recorded as incomplete and leaves its entries pending, and Beta.4 paused automatic Noting after two such runs. Beta.6's [persisted three-failure rule](docs/pi.md#three-failures-turn-memory-off-32c) replaces that historical pause and requires `/trace on` to recover. Memory workers inherit the foreground thinking level; the optional `notingThinking` and `consolidationThinking` settings (default `inherit`) fix a level for subagent execution. Worker admission uses one capacity rule, Pi's own context measure plus 10,000 tokens within the model window; a fork that cannot fit, or whose request the provider rejects for context size, runs once more as a subagent. Memory worker sessions run with Pi's automatic compaction disabled.

Before loading the extension, merge this example into `~/.pi/agent/settings.json`, preserving your other settings:

```json
{
  "trace-memory": {
    "dbPath": "~/.trace-memory/trace-beta-1.db"
  }
}
```

From a local checkout, install the package directory:

```sh
pi install /absolute/path/to/trace-memory
```

Install the Beta from npm instead:

```sh
pi install npm:trace-memory@0.1.0-beta.7
```

Start a new Pi process, run `/trace` (the menu, or status when headless), and use `/trace on` if the session is disabled. Sessions created before the plugin's initialization baseline default to disabled; explicit choices persist.

## Use

Enabled sessions make background model requests using your Pi credentials and may incur charges. By default, Noter and Consolidator use fresh subagents and follow the foreground model; Dreamer always uses a fresh subagent. The mode default applies only when no explicit override is supplied; existing `forkModeDefault: true` settings (including the legacy `noting.branchModeDefault` alias) still request fork execution.

- **Inspect:** `/trace` opens the menu — Current session (context composition, three phase queues, status, On/Off, runs and project), Catch up, Stop and Settings.
- **Catch up:** `/trace catchup` drains a frozen Raw backlog in bounded Noting subagents. At start and after any successful catchup-owned N, C or D completion, all three phases are checked. It completes when frozen Raw is exhausted and C/D are not due, after owned tasks settle. Busy triggers are skipped, not queued; below-threshold tails stay pending.
- **Stop:** `/trace stop` cancels this executor's background work; future automatic triggers remain enabled.
- **Turn off:** `/trace off` pauses this session's processing and future injection without deleting memory; `/trace on` resumes it. There is no global switch.
- **Settings:** saves phase mode/model/thinking and `closedSessionScope`: `project` (default), `global`, or `off`. Closed-session borrowing applies only to Noting and Consolidation; Dreamer processes a due pool visible at the current node. Database budgets are edited separately without writing Pi settings. Running tasks retain their frozen settings and material.
- **Watch:** `🧠 ● notes: 24->102 memory: 9->252/306 cost: $0.12` means 24 pending entries, 102 facts, 9 unconsolidated facts, and 252 changed out of 306 current Knowledge versions. Processing records are scheduling state, not validity. Cost is today's memory spend across the shared database. A disabled session shows `🧠 ○ off`.
- **Share a project:** `/trace project <name>` explicitly declares shared membership. New sessions may join the unique project already associated with their repository/directory; home and temporary directories do not select one. The same name in the same database shares a project across both hosts.

The agent gets four tools: `trace`, `search`, `note`, and `memory`. Explicit reads can search across the local database; automatic knowledge selection and write evidence follow scope and conversation ancestry. Topics organize knowledge without changing those permissions.

**Facts and entry reads:** new facts carry a title and one `{address, text}` segment per contributing entry. `T792` shows that Turn's contributions; `T792#E2` reads a whole native entry; `T792@observation` reads result entries. Role filters replace block selectors. Content budgets remain independent of 2,000-token default pages; use `full: true` and follow every cursor for uncompressed content. Complete knowledge bodies reveal an exact tag such as `K12#qfzt`; numbered history uses `K12@v3`, and writes still require a valid current base. See [fact slices and entry reads](docs/unified-entry.md) for the current schema, grammar and legacy-data rules.

## Data and limits

- **Storage:** the default database is `~/.trace-memory/trace.db`; the installation example uses a separate Beta database. New Pi worker logs default to `<Pi agent directory>/sessions/trace-memory/`; an explicit `runsDir` override is preserved. CC worker logs are native Claude Code sessions, written by Claude Code itself under `<CC config dir>/projects/<directory for worker.cwd>/`, the same place any other Claude Code session lands — counted by claude-powerline's daily cost like any other. Existing logs on either host are not moved. The files contain conversation content and model requests: keep them private. Log retention is not automatic.
- **Evidence:** original stored source entries remain traceable. Facts are attributed records, not certified truth; knowledge revisions preserve their evidence and history.
- **Compatibility:** Node 24.6.0 or later is required; Pi 0.85.1 is the tested host. Pi 0.85.0 has a known public-SDK import issue. Other host versions and providers are not all verified.
- **Worker budgets:** Noter defaults to a 10k trigger and batch; Consolidator to a 5k trigger and 10k fact batch. Consolidator Knowledge has a 40k maximum at defaults. Dreamer handles one due pool, with a frozen range capped by that pool's budget and same-pool references sharing the Knowledge allowance. Instructions, tools and later results also count toward the independent model-context guard.
- **Compaction budget:** Knowledge/facts/Raw bases default to 20k/10k/10k, plus the runtime-derived shared 20k. Required pending Raw, unconsolidated facts and Knowledge state notices reserve capacity first. Optional current Knowledge, historical Raw and historical facts then use the remainder in that order; bases never lend. Knowledge bodies have no special pending protection. If required material still cannot fit, bounded recovery may use each eligible phase once before native fallback.

See the [Pi configuration and behavior reference](docs/pi.md) and [live verification record](docs/live-verification.md) for details and remaining coverage gaps.

## Repository layout

Source, tests and documentation are kept separate:

```text
src/
  core/          # Host-neutral memory logic and model prompts
  hosts/pi/      # Pi adapter
  hosts/cc/      # Claude Code adapter; bundled separately under plugin/
tests/
  core/          # Core regression tests
  hosts/pi/      # Host tests, native fixtures and smoke check
  fixtures/      # Test data
  package-smoke.mjs
  source-fixture.ts
docs/            # Core, Pi and live-verification references
CONTEXT.md       # Domain glossary
```

The Pi package contains production core/Pi source and documentation, not tests or development fixtures. The Claude Code plugin has its own bundled entry. See the [core reference](docs/core.md) for module responsibilities.

## Development and release

Run checks from a source checkout, not the installed npm package:

```sh
npm ci
npm test
npm run typecheck
npm run smoke:pi
npm run smoke:package
```

`smoke:package` packs the current checkout, installs the tarball in a temporary directory without registry access, checks Pi discovery and loading, and runs the existing native-worker smoke against the installed entry. Pi peer dependencies come from the installed development SDK; model HTTP is stubbed. Tests and their fixtures are not shipped to users.

The package defaults to npm's `next` tag. After reviewing the checks and tarball, a maintainer can publish the Beta explicitly:

```sh
npm publish --tag next
```

That command publishes to npm; none of the checks publish anything.
