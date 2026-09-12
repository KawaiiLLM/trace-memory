# Trace Memory

Traceable cross-session memory for Pi. A background Noter extracts facts from conversation, a Consolidator turns them into knowledge, and a bounded Dreamer maintains changed knowledge. Each knowledge revision links to its supporting facts and original source messages.

**Beta.6 release (`next`).** The Pi adapter is implemented and tested with Pi 0.85.1 on Node 24.6.0. Claude Code remains an unshipped stub. Real-workflow extraction and recall quality are still being evaluated.

## Install

Back up the database and worker logs before upgrading, and stop older executors before first open. Released `0.1.0-beta.1` through `0.1.0-beta.5` databases upgrade in place: Beta.6 automatically applies the supported schema, native-entry and knowledge-lineage transitions covered by the migration tests. Existing revision ids/parents/supports, links, certifications, project assignments, Raw bytes and historical citations are retained; legacy support lists keep complete-result semantics and missing historical trigger origins remain unknown. This does not promise compatibility with arbitrary, partial development schemas; use a new `dbPath` for an untagged or unsupported development database.

**Beta.6 release and upgrade notes — September 12, 2026:**

- **Bounded Dreamer:** Dreamer runs as a fresh subagent with at most 20k processed knowledge, 10k changed knowledge and 10k direct facts. Its transactional final check enforces the shared processed caps: global 4k, each project 10k, each session 1k and applicable 15k, including framing. Retained retries reselect whole current results into bounded batches; one indivisible result that cannot fit remains pending.
- **Incremental lineage:** new revisions store complete bodies but cite only change evidence; applicability and effective grounding recurse through exact historical parents. Consolidator owns fact-backed create/update/archive. Trusted Dreamer performs update, exactly-two-parent merge, atomic one-parent/two-child split and archive within its family, and alone may use empty maintenance supports; manual writes retain fact-backed binary merge but gain no split or empty-support authority. Admission freezes the target session and exact ordered native-entry trigger prefix for downstream path handling; Ticket 34b's stronger path guard is not included here.
- **Compaction:** required knowledge, facts and Raw use fixed 20k/10k/10k base windows. Their positive excesses share a required-only 10k allowance; unused bases do not lend. Optional refill selects newest already-extracted Raw first, then consolidated facts not fully covered by that Raw. Overflow recovery can run at most one eligible Noter, Consolidator and Dreamer task over at most three rounds before native fallback.
- **Trace and source authority:** Raw uses stable native `T<n>#E<m>` entry addresses, exact text/call/result selectors and independent per-child content budgets. Page budgets remain separate and cursor-based; complete knowledge write handles require the full semantic body across every page. Legacy aliases remain readable, but thinking and unproved legacy fragments cannot authorize new facts.
- **Failure handling:** three terminal business failures of the same logical task automatically turn off that target while retaining data and backlog; `/trace on` resets the streaks. A Dreamer blocked only by a verified post-freeze external successor ends in a neutral conflict, so it neither increments nor resets the streak and certifies nothing.
- **Current session and Settings:** Current session now shows bounded context composition, Memory's Knowledge/Facts/Raw split and separate Noting/Consolidation/Dreaming pending-to-trigger bars. Settings covers Noter and Consolidator modes/models/thinking, Dreamer model/thinking and closed-session scope.
- **Accepted release fixes:** cleanup keeps lightweight enrollment controls out of full context/status scans. Legacy entry upgrades preserve original evidence, ordinals, aliases and citations when a recognized mapping cannot be normalized. Dreamer authority, external-conflict settlement and retained-range batching are enforced by core rather than model claims. The footer splits current Knowledge versions into exact unprocessed and processed counts.

**Historical Beta.5 notes:** Beta.5 made Noter and Consolidator subagents by default, restored Consolidator fork as an opt-in, introduced one bounded Raw view, and replaced continuous foreground receipts with initial injection plus one-shot `/trace on` and `/trace project` supplements. Its three-lending-window compaction design and lack of Dreamer are superseded by Beta.6. When upgrading older configuration, remove `render.toolCallTokens`, `render.secondaryToolCallTokens` and `render.secondaryEntryTokens`; retired keys fail by name rather than being reinterpreted.

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
pi install npm:trace-memory@0.1.0-beta.6
```

Start a new Pi process, run `/trace` (the menu, or status when headless), and use `/trace on` if the session is disabled. Sessions created before the plugin's initialization baseline default to disabled; explicit choices persist.

## Use

Enabled sessions make background model requests using your Pi credentials and may incur charges. By default, Noter and Consolidator use fresh subagents and follow the foreground model; Dreamer always uses a fresh subagent. The mode default applies only when no explicit override is supplied; existing `forkModeDefault: true` settings (including the legacy `noting.branchModeDefault` alias) still request fork execution.

- **Inspect:** `/trace` opens the menu — Current session (context composition, three phase queues, status, On/Off, runs, project and marks), Catch up, Stop and Settings.
- **Catch up:** `/trace catchup` drains a finite snapshot of pending work in subagent mode.
- **Stop:** `/trace stop` cancels this executor's background work; future automatic triggers remain enabled.
- **Turn off:** `/trace off` pauses this session's processing and future injection without deleting memory; `/trace on` resumes it. There is no global switch.
- **Settings:** saves mode/model/thinking for Noter and Consolidator, model/thinking for Dreamer, and `closedSessionScope`: `project` (default, same-project executors), `global` (any executor), or `off` (leave closed-session work pending). Scope governs all three background phases, not current-session processing or manual catchup. Changes apply to later tasks; running tasks keep their admission settings. Use Stop to end running work.
- **Watch:** the footer says what each stage still owes and what it has produced — `🧠 ● notes: 24->102 memory: 9->252=>54 cost: $0.12` is 24 entries left to note over 102 facts, then 9 facts left to consolidate over 252 unprocessed and 54 processed applicable current Knowledge versions on this branch, plus this session's cumulative memory spend. Processing is for the exact current version, so a new revision returns to unprocessed; archives and superseded versions are excluded. A disabled session shows `🧠 ○ off`.
- **Share a project:** after the first assistant reply, use `/trace project <name>`. The same name in the same database shares a project across sessions. Without a declaration, each session has its own project. Files, working directories and Git remotes do not declare project membership.

The agent gets four tools: `trace`, `search`, `note`, and `memory`. Explicit reads can search across the local database; automatic knowledge selection and write evidence follow scope and conversation ancestry. Topics organize knowledge without changing those permissions.

**Beta.6 entry addresses:** `T792#E2` reads a stable native entry; `T792#E2,E7@text` projects text from the selected entries; `T792@toolResult` reads complete result messages. New Noter citations use exact E/block labels; legacy citations remain readable. Content limits apply to each selected child, while pages independently default to 2,000 tokens. Set all three content budgets to null (or use `full: true`) for uncompressed content, then follow every cursor. A complete exact `K<n>@<commit>` body grants the corresponding write handle only after its final page. See [entry addresses and read budgets](docs/unified-entry.md) for grammar, compatibility and upgrade rules.

## Data and limits

- **Storage:** the default database is `~/.trace-memory/trace.db`; the installation example uses a separate Beta database. New worker logs default to `<Pi agent directory>/sessions/trace-memory/`; an explicit `runsDir` override is preserved. Existing logs are not moved. The files contain conversation content and model requests: keep them private. Log retention is not automatic.
- **Evidence:** original stored source entries remain traceable. Facts are attributed records, not certified truth; knowledge revisions preserve their evidence and history.
- **Compatibility:** Node 24.6.0 or later is required; Pi 0.85.1 is the tested host. Pi 0.85.0 has a known public-SDK import issue. Other host versions and providers are not all verified.
- **Worker budgets:** default Noter admission uses 10k pending bounded-view tokens and batches at most 10k. Fresh Noter material contains at most 10k historical facts and 10k compressed Raw; Consolidation contains at most 10k knowledge and 10k pending facts. These are material limits, not provider-request limits: a fork inherits the foreground context, and instructions, tools and later tool results also count toward the model-context guard.
- **Compaction budget:** knowledge, facts and Raw have separate 20k/10k/10k base windows, with no lending between them. Unprocessed knowledge, pending facts and pending Raw are required; their excesses share an additional 10k allowance. Processed supplements use only their own window's remaining base: knowledge, then recent Raw, then consolidated facts not fully covered by that Raw or retained context. If required material still does not fit, bounded recovery may use Noting, Consolidation and Dreaming once each, only when eligible, before native fallback.

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
