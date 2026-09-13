# Trace Memory

Traceable cross-session memory for Pi. A background Noter extracts facts from conversation, a Consolidator turns them into knowledge, and a bounded Dreamer maintains changed knowledge. Each knowledge revision links to its supporting facts and original source messages.

**Beta.7 release (`next`).** The Pi adapter is implemented and tested with Pi 0.85.1 on Node 24.6.0. Claude Code remains an unshipped stub. Real-workflow extraction and recall quality are still being evaluated.

## Unreleased

- **Noter NEAR review:** A valid automatic Noting batch with lexically similar earlier facts now receives one system-generated comparison round before commit. The candidate pool and source membership are frozen at binding time; batches with no neighbours and all manual notes still commit immediately. NEAR is only a prompt to judge `support` or `negate`, never relation evidence or a commit authority.
- **Noter NEAR audit:** Successful reviewed runs retain the originally shown pairs and record any still-near final fact/neighbour pairs without an explicit relation as the non-gating `unanswered_near` diagnostic. Reordering, dropping or rewriting the final batch is assessed by committed fact identity rather than original position; an absent diagnostic does not prove the comparison was understood.
- **Proportional context composition:** Current session uses SDK usage and the model window for occupied/free capacity, while the local census supplies only category color proportions. Each positive category gets full cells plus its own partial remainder, so the 20-cell-wide grid can grow beyond 200 glyphs without hiding small categories. Difference and the local-over-SDK single-color fallback are gone; Memory projects Knowledge, Facts, Raw and Unclassified separately, and unavailable or overflowing capacity remains explicit.

## Beta.7 changes — September 13, 2026

Beta.7 combines Knowledge lineage and delivery changes, Dreamer workflow and database budgets, and the Current session display fixes.

- **Lineage and processing:** New revisions use complete bodies with change-only supports and recursive exact-parent applicability. Path-aware concurrency permits proven sibling origins while rejecting comparable or unprovable consumers. Dreamer settlement separates supplied-event accounting from successor-free exact certification; actual maintenance of processed-reference knowledge inside the frozen family includes this exact run's terminal output without certifying the reference merely because it was read. An unchanged retained task blocked by an indivisible 10k admission item waits for an obligation-graph change or explicit retry instead of relaunching automatically.
- **Foreground delivery:** Enabled ordinary prompts use one Knowledge-only predicate. Persisted exact bodies and complete state-transition notices share the remaining database-derived allowance (20k at defaults) as deterministic whole items. Visible Facts or source identities can suppress fully covered change evidence. Bounded Raw counts only when its exact database/native pair belongs to the selected session path; a truncated bounded view can still suppress delivery after its evidence text was removed.
- **Database-owned Knowledge budgets:** Each database stores Global/Project/Session budgets (defaults 4k/10k/1k). Their 15k sum is the applicable processed ceiling; adding the fixed 5k buffer derives the 20k injection/compaction and Dreamer processed-input capacities. The buffer is not reserved exclusively for new Knowledge and does not guarantee 5k of free space. Settings edits one field transactionally, rejects unsafe reductions, and shows the derived capacities. `render.knowledgeBlockTokens` is retired and must be removed from file/environment configuration.
- **Dreamer check receipt:** Explicit checks and host-generated repair feedback show target-relevant owner budgets, the worst path across the full projection, separate pending event/version obligations, current derived capacities, the run's frozen admitted processed-input ceiling and every blocker. Full zero-inclusive owner/path totals and exact processing sets remain in the run audit and continue to control finalization; the receipt grants no read or write authority.
- **Dreamer repair and workflow:** Host-generated repair feedback uses the public user-message entry so the same system instructions remain active through tool continuations and retries. The same child, history, tools and 50-round shared limit remain. Maintenance checks actual budgets first, protects meaning and valid topics, compares complete claims, chooses dispositions before rewriting, and checks the final state. Archiving still-valid information to meet a hard limit must disclose the loss; smaller receipts and scripted tests are not proof of better model judgment or lower cost.
- **Current session:** SDK capacity estimates no longer depend on a complete local text classification. Images and SDK/text discrepancies do not replace the grid with question marks; unavailable usage gets a concise explanation. The full-screen panel covers unused text rows so dialogue and background text no longer show through. **Known limitation:** Pi 0.85.1 bypasses overlay composition for Kitty/iTerm2 inline-image rows, so existing terminal graphics may remain visible. Complete image hiding/restoration is not guaranteed; no private-host workaround is installed.
- **Atomic upgrade:** Supported schema, source/lineage migrations and database-policy initialization commit atomically; a failed upgrade publishes no partial policy and reopening retries idempotently. Existing revisions, support semantics, parent links, citations, Raw and certificates are preserved; unknown historical origins stay unknown. Back up the database and worker logs, then stop every older executor sharing the database before opening it with Beta.7. Mixed old/new runtimes are unsupported.
- **Validation limits:** Offline provider tests, temporary-database migrations, deterministic concurrency and compositor tests cover the release behavior. Real-model maintenance quality, manual terminal-image appearance and the new full-path audit's performance on a large production-database copy remain unverified.

## Install

Back up the database and worker logs before upgrading, then stop all old executors sharing that database. Released `0.1.0-beta.1` through `0.1.0-beta.6` databases upgrade in place using the supported atomic migrations covered by offline tests. Existing project assignments, Raw bytes and historical citations are retained. Remove the retired `render.knowledgeBlockTokens` key from every file/environment configuration layer before loading Beta.7; use Settings to edit the database policy instead. Invalid or retired configuration fails explicitly. This does not promise compatibility with arbitrary, partial development schemas; use a new `dbPath` for an untagged or unsupported development database.

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

- **Inspect:** `/trace` opens the menu — Current session (context composition, three phase queues, status, On/Off, runs, project and marks), Catch up, Stop and Settings.
- **Catch up:** `/trace catchup` drains a finite snapshot of pending work in subagent mode.
- **Stop:** `/trace stop` cancels this executor's background work; future automatic triggers remain enabled.
- **Turn off:** `/trace off` pauses this session's processing and future injection without deleting memory; `/trace on` resumes it. There is no global switch.
- **Settings:** saves mode/model/thinking for Noter and Consolidator, model/thinking for Dreamer, and `closedSessionScope`: `project` (default, same-project executors), `global` (any executor), or `off` (leave closed-session work pending). It also edits the bound database's Global/Project/Session Knowledge budgets without writing Pi settings and shows the derived applicable, injection and Dreamer capacities. Scope governs all three background phases, not current-session processing or manual catchup. Changes apply to later tasks; running tasks keep their frozen admission ceiling. Use Stop to end running work.
- **Watch:** the footer says what each stage still owes and what it has produced — `🧠 ● notes: 24->102 memory: 9->252=>54 cost: $0.12` is 24 entries left to note over 102 facts, then 9 facts left to consolidate over 252 unprocessed and 54 processed applicable current Knowledge versions on this branch, plus this session's cumulative memory spend. Processing is shared certification of the exact current version: a new or restored uncertified revision is pending even when an older event was settled; restored certified revisions are not. Archives and superseded versions are excluded. A disabled session shows `🧠 ○ off`.
- **Share a project:** after the first assistant reply, use `/trace project <name>`. The same name in the same database shares a project across sessions. Without a declaration, each session has its own project. Files, working directories and Git remotes do not declare project membership.

The agent gets four tools: `trace`, `search`, `note`, and `memory`. Explicit reads can search across the local database; automatic knowledge selection and write evidence follow scope and conversation ancestry. Topics organize knowledge without changing those permissions.

**Beta.6 entry addresses:** `T792#E2` reads a stable native entry; `T792#E2,E7@text` projects text from the selected entries; `T792@toolResult` reads complete result messages. New Noter citations use exact E/block labels; legacy citations remain readable. Content limits apply to each selected child, while pages independently default to 2,000 tokens. Set all three content budgets to null (or use `full: true`) for uncompressed content, then follow every cursor. A complete exact `K<n>@<commit>` body grants the corresponding write handle only after its final page. See [entry addresses and read budgets](docs/unified-entry.md) for grammar, compatibility and upgrade rules.

## Data and limits

- **Storage:** the default database is `~/.trace-memory/trace.db`; the installation example uses a separate Beta database. New worker logs default to `<Pi agent directory>/sessions/trace-memory/`; an explicit `runsDir` override is preserved. Existing logs are not moved. The files contain conversation content and model requests: keep them private. Log retention is not automatic.
- **Evidence:** original stored source entries remain traceable. Facts are attributed records, not certified truth; knowledge revisions preserve their evidence and history.
- **Compatibility:** Node 24.6.0 or later is required; Pi 0.85.1 is the tested host. Pi 0.85.0 has a known public-SDK import issue. Other host versions and providers are not all verified.
- **Worker budgets:** default Noter admission uses 10k pending bounded-view tokens and batches at most 10k. Fresh Noter material contains at most 10k historical facts and 10k compressed Raw; Consolidation contains at most 10k knowledge and 10k pending facts. These are material limits, not provider-request limits: a fork inherits the foreground context, and instructions, tools and later tool results also count toward the model-context guard.
- **Compaction budget:** Knowledge uses the current database-derived injection capacity (20k at defaults); facts and Raw use separate 10k/10k configured base windows, with no lending between them. Unprocessed knowledge, pending facts and pending Raw are required; their excesses share an additional 10k allowance. Processed supplements use only their own window's remaining base: knowledge, then recent Raw, then consolidated facts not fully covered by that Raw or retained context. If required material still does not fit, bounded recovery may use Noting, Consolidation and Dreaming once each, only when eligible, before native fallback.

See the [Pi configuration and behavior reference](docs/pi.md) and [live verification record](docs/live-verification.md) for details and remaining coverage gaps.

## Repository layout

Source, tests and documentation are kept separate:

```text
src/
  core/          # Host-neutral memory logic and model prompts
  hosts/pi/      # Pi adapter
  hosts/cc/      # Placeholder; not shipped in the Beta
tests/
  core/          # Core regression tests
  hosts/pi/      # Host tests, native fixtures and smoke check
  fixtures/      # Test data
  package-smoke.mjs
  source-fixture.ts
docs/            # Core, Pi and live-verification references
CONTEXT.md       # Domain glossary
```

The package contains production source and documentation, not tests or development fixtures. See the [core reference](docs/core.md) for module responsibilities.

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
