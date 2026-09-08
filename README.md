# Trace Memory

Traceable cross-session memory for Pi. A background Noter extracts facts from conversation; a Consolidator turns them into knowledge. Each knowledge revision links to its supporting facts and original source messages.

**Beta release candidate.** The Pi adapter is implemented and tested with Pi 0.85.1 on Node 24.6.0. Claude Code is not supported yet. Real-workflow extraction and recall quality are still being evaluated.

## Install

**Use a new database when coming from a development build.** There is no migration for older development schemas, including those before commit reasons and topics. Keep the old database and its logs; choose an unused path instead of deleting them.

Upgrading from `0.1.0-beta.1` does not require a new database. Project marker files are no longer read; existing stored project assignments are retained.

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
pi install npm:trace-memory@0.1.0-beta.2
```

Start a new Pi process, run `/trace status`, and use `/trace enable` if the session is disabled. Sessions created before the plugin's initialization baseline default to disabled; explicit choices persist.

## Use

Enabled sessions make background model requests using your Pi credentials and may incur charges. By default, Noter requests fork execution and Consolidator uses a fresh subagent; both follow the foreground model unless configured otherwise.

- **Inspect:** `/trace` opens the menu; `/trace runs 10` lists recent memory runs.
- **Catch up:** `/trace catchup` drains a finite snapshot of pending work in subagent mode.
- **Stop:** `/trace stop` cancels this executor's background work; future automatic triggers remain enabled.
- **Disable:** `/trace disable` pauses processing and future injection without deleting memory.
- **Share a project:** after the first assistant reply, use `/trace project <name>`. The same name in the same database shares a project across sessions. Without a declaration, each session has its own project. Files, working directories and Git remotes do not declare project membership.

The agent gets four tools: `trace`, `search`, `note`, and `memory`. Explicit reads can search across the local database; automatic knowledge selection and write evidence follow scope and conversation ancestry. Topics organize knowledge without changing those permissions.

## Data and limits

- **Storage:** the default database is `~/.trace-memory/trace.db`; the installation example uses a separate Beta database. Private worker logs live beside the database in `runs/`. The files contain conversation content and model requests: keep them private. Log retention is not automatic.
- **Evidence:** original stored source entries remain traceable. Facts are attributed records, not certified truth; knowledge revisions preserve their evidence and history.
- **Compatibility:** Node 24.6.0 or later is required; Pi 0.85.1 is the tested host. Pi 0.85.0 has a known public-SDK import issue. Other host versions and providers are not all verified.
- **Budget:** default Noter admission uses 10k pending primary-view tokens and batches at most 10k. A fork still inherits the foreground context; this batch limit is not a 10k provider-request limit. Fresh memory material targets a 30k budget, excluding instructions, tools and later tool results.

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
