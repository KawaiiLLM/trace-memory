# Trace Memory

Traceable cross-session memory for Pi. A background Noter extracts facts from conversation; a Consolidator turns them into knowledge. Each knowledge revision links to its supporting facts and original source messages.

**Beta release candidate.** The Pi adapter is implemented and tested with Pi 0.85.1 on Node 24.6.0. Claude Code is not supported yet. Real-workflow extraction and recall quality are still being evaluated.

## Install

**Use a new database when coming from a development build.** There is no migration for older development schemas, including those before commit reasons and topics. Keep the old database and its logs; choose an unused path instead of deleting them.

Upgrading from released `0.1.0-beta.1` through `0.1.0-beta.4` does not require a new database. Project marker files are no longer read; existing stored project assignments are retained.

**Beta.5 upgrade notes:**

- **Default execution:** both Noter and Consolidator now default to subagent. Explicit fork settings, including the accepted Noter legacy alias, retain their meaning. Consolidator fork is available again as an opt-in.
- **Raw view configuration:** one bounded view replaces the two tiers, with defaults `render.entryTokens: 2000`, `render.toolInputTokens: 100` and `render.toolResultTokens: 100`. Explicit entry limits are preserved. Remove `render.toolCallTokens`, `render.secondaryToolCallTokens` and `render.secondaryEntryTokens` from any configuration layer before loading; these retired keys cause a named error rather than being silently reinterpreted. The new input/result limits bound each side independently, not a shared combined allowance.
- **Knowledge delivery:** continuous foreground fact/knowledge receipts are retired. Initial knowledge injection remains; each successful `/trace on` or `/trace project` command requests a one-shot supplement of applicable knowledge missing from the selected context, completed only when persisted or when the delta is empty. Pending command intent survives tree navigation.
- **Compaction:** three 10k baseline windows lend within a 30k envelope. Overflow can run one bounded Noting and one Consolidation task before native fallback. Optional history fills with consolidated facts first, then extracted Raw. This release includes recovery cancellation, claim, task-reuse and off-during-compaction repairs; native fallback remains potentially lossy.
- **Evidence and visibility:** fallback attempts preserve their frozen policy and ownership checks; malformed carriers fail closed; knowledge status follows the applicable commit graph; tool-part budgets include separators. Footer counters use dim theme text while the indicator retains its status color.

Dreamer, 40k compaction and the ticket 32 maintenance policies are not included in Beta.5. See the [configuration reference](docs/pi.md) for migration details.

**Beta.3 configuration change:** remove `consolidation.subagentModeDefault` from any configuration layer that contains it, whether its value is `true` or `false`. The retired inverse key still causes a named load error. Beta.5 restores Consolidation fork: set `consolidation.forkModeDefault: true` to select it; the default remains subagent (`false`). Closed-session background work now defaults to same-project executors (`closedSessionScope: "project"`); choose `"global"` to retain cross-project borrowing or `"off"` to leave closed tails pending.

**Beta.4 changes:** no configuration change is required. A Noter now completes an empty batch only by an explicit `note({facts: []})`; a run that ends without submitting is recorded as incomplete and leaves its entries pending, and Beta.4 paused automatic Noting after two such runs. In the development tree, [32c's persisted three-failure rule](docs/pi.md#three-failures-turn-memory-off-32c) replaces that historical pause and requires `/trace on` to recover. Memory workers inherit the foreground thinking level; the optional `notingThinking` and `consolidationThinking` settings (default `inherit`) fix a level for subagent execution. Worker admission uses one capacity rule, Pi's own context measure plus 10,000 tokens within the model window; a fork that cannot fit, or whose request the provider rejects for context size, runs once more as a subagent. Memory worker sessions run with Pi's automatic compaction disabled.

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
pi install npm:trace-memory@0.1.0-beta.5
```

Start a new Pi process, run `/trace` (the menu, or status when headless), and use `/trace on` if the session is disabled. Sessions created before the plugin's initialization baseline default to disabled; explicit choices persist.

## Use

Enabled sessions make background model requests using your Pi credentials and may incur charges. By default, both Noter and Consolidator use fresh subagents and follow the foreground model. The mode default applies only when no explicit override is supplied; existing `forkModeDefault: true` settings (including the legacy `noting.branchModeDefault` alias) still request fork execution.

- **Inspect:** `/trace` opens the menu — Current session (status, On/Off, runs, project, marks), Catch up, Stop and Settings.
- **Catch up:** `/trace catchup` drains a finite snapshot of pending work in subagent mode.
- **Stop:** `/trace stop` cancels this executor's background work; future automatic triggers remain enabled.
- **Turn off:** `/trace off` pauses this session's processing and future injection without deleting memory; `/trace on` resumes it. There is no global switch.
- **Settings:** saves each phase's mode (both subagent by default), the Noter and Consolidator models and `closedSessionScope`: `project` (default, same-project executors), `global` (any executor), or `off` (leave closed-session work pending). Scope governs both background phases, not current-session processing or manual catchup. Changes apply to later tasks; running tasks keep their admission settings. Use Stop to end running work.
- **Watch:** the footer says what each stage still owes and what it has produced — `🧠 ● notes: 24->102 memory: 15->54 cost: $0.12` is 24 entries left to note over 102 facts on this branch, 15 facts left to consolidate over 54 current knowledge items, and this session's cumulative memory spend. A disabled session shows `🧠 ○ off`.
- **Share a project:** after the first assistant reply, use `/trace project <name>`. The same name in the same database shares a project across sessions. Without a declaration, each session has its own project. Files, working directories and Git remotes do not declare project membership.

The agent gets four tools: `trace`, `search`, `note`, and `memory`. Explicit reads can search across the local database; automatic knowledge selection and write evidence follow scope and conversation ancestry. Topics organize knowledge without changing those permissions.

## Data and limits

- **Storage:** the default database is `~/.trace-memory/trace.db`; the installation example uses a separate Beta database. New worker logs default to `<Pi agent directory>/sessions/trace-memory/`; an explicit `runsDir` override is preserved. Existing logs are not moved. The files contain conversation content and model requests: keep them private. Log retention is not automatic.
- **Evidence:** original stored source entries remain traceable. Facts are attributed records, not certified truth; knowledge revisions preserve their evidence and history.
- **Compatibility:** Node 24.6.0 or later is required; Pi 0.85.1 is the tested host. Pi 0.85.0 has a known public-SDK import issue. Other host versions and providers are not all verified.
- **Worker budgets:** default Noter admission uses 10k pending bounded-view tokens and batches at most 10k. Fresh Noter material contains at most 10k historical facts and 10k compressed Raw; Consolidation contains at most 10k knowledge and 10k pending facts. These are material limits, not provider-request limits: a fork inherits the foreground context, and instructions, tools and later tool results also count toward the model-context guard.
- **Compaction budget:** three 10k baseline windows—knowledge, pending facts and pending Raw—lend unused allowance within a 30k total. Optional knowledge above its baseline yields before pending material forces recovery. After required material fits, spare room takes recent consolidated facts first, then already-extracted Raw.

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
