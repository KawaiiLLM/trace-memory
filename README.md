# Trace Memory

Traceable cross-session memory for Pi. A background Noter extracts facts from conversation; a Consolidator turns them into knowledge. Each knowledge revision links to its supporting facts and original source messages.

**Beta release candidate.** The Pi adapter is implemented and tested with Pi 0.85.1 on Node 24.6.0. Claude Code is not supported yet. Real-workflow extraction and recall quality are still being evaluated.

## Install

**Use a new database when coming from a development build.** There is no migration for older development schemas, including those before commit reasons and topics. Keep the old database and its logs; choose an unused path instead of deleting them.

Upgrading from `0.1.0-beta.1`, `0.1.0-beta.2` or `0.1.0-beta.3` does not require a new database. Project marker files are no longer read; existing stored project assignments are retained.

**Beta.3 configuration change:** remove `consolidation.subagentModeDefault` from any configuration layer that contains it, whether its value is `true` or `false`. Consolidation now always uses subagent mode; the retired key causes a named load error. Explicit Consolidation fork requests are also rejected. Closed-session background work now defaults to same-project executors (`closedSessionScope: "project"`); choose `"global"` to retain cross-project borrowing or `"off"` to leave closed tails pending.

**Beta.4 changes:** no configuration change is required. A Noter now completes an empty batch only by an explicit `note({facts: []})`; a run that ends without submitting is recorded as incomplete and leaves its entries pending, and two consecutive incomplete runs pause automatic Noting for that session until `/trace catchup` or a reopen. Memory workers inherit the foreground thinking level; the optional `notingThinking` and `consolidationThinking` settings (default `inherit`) fix a level for subagent execution. Worker admission uses one capacity rule, Pi's own context measure plus 10,000 tokens within the model window; a fork that cannot fit, or whose request the provider rejects for context size, runs once more as a subagent. Memory worker sessions run with Pi's automatic compaction disabled.

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
pi install npm:trace-memory@0.1.0-beta.4
```

Start a new Pi process, run `/trace` (the menu, or status when headless), and use `/trace on` if the session is disabled. Sessions created before the plugin's initialization baseline default to disabled; explicit choices persist.

## Use

Enabled sessions make background model requests using your Pi credentials and may incur charges. By default, Noter requests fork execution and Consolidator uses a fresh subagent; both follow the foreground model unless configured otherwise.

- **Inspect:** `/trace` opens the menu — Current session (status, On/Off, runs, project, marks), Catch up, Stop and Settings.
- **Catch up:** `/trace catchup` drains a finite snapshot of pending work in subagent mode.
- **Stop:** `/trace stop` cancels this executor's background work; future automatic triggers remain enabled.
- **Turn off:** `/trace off` pauses this session's processing and future injection without deleting memory; `/trace on` resumes it. There is no global switch.
- **Settings:** saves each phase's mode (Noter fork, Consolidator subagent by default), the Noter and Consolidator models and `closedSessionScope`: `project` (default, same-project executors), `global` (any executor), or `off` (leave closed-session work pending). Scope governs both background phases, not current-session processing or manual catchup. Changes apply to later tasks; running tasks keep their admission settings. Use Stop to end running work.
- **Watch:** the footer says what each stage still owes and what it has produced — `🧠 ● notes: 24->102 memory: 15->54 cost: $0.12` is 24 entries left to note over 102 facts on this branch, 15 facts left to consolidate over 54 current knowledge items, and this session's cumulative memory spend. A disabled session shows `🧠 ○ off`.
- **Share a project:** after the first assistant reply, use `/trace project <name>`. The same name in the same database shares a project across sessions. Without a declaration, each session has its own project. Files, working directories and Git remotes do not declare project membership.

The agent gets four tools: `trace`, `search`, `note`, and `memory`. Explicit reads can search across the local database; automatic knowledge selection and write evidence follow scope and conversation ancestry. Topics organize knowledge without changing those permissions.

## Data and limits

- **Storage:** the default database is `~/.trace-memory/trace.db`; the installation example uses a separate Beta database. New worker logs default to `<Pi agent directory>/sessions/trace-memory/`; an explicit `runsDir` override is preserved. Existing logs are not moved. The files contain conversation content and model requests: keep them private. Log retention is not automatic.
- **Evidence:** original stored source entries remain traceable. Facts are attributed records, not certified truth; knowledge revisions preserve their evidence and history.
- **Compatibility:** Node 24.6.0 or later is required; Pi 0.85.1 is the tested host. Pi 0.85.0 has a known public-SDK import issue. Other host versions and providers are not all verified.
- **Budget:** default Noter admission uses 10k pending primary-view tokens and batches at most 10k. A fork still inherits the foreground context; this batch limit is not a 10k provider-request limit. Fresh Noter material contains at most 10k historical facts and 10k compressed Raw; Consolidation contains at most 10k knowledge and 10k pending facts. Compaction uses up to 10k knowledge plus a shared 20k for facts and pending Raw, prioritizing Raw. Instructions, tools and later tool results additionally count toward the model-context guard.

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
