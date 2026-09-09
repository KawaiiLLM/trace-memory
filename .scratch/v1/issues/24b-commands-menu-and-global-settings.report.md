# 24b — Commands, menu and global settings (report)

Branch `ticket-24b`, from `02372ce` (`ticket-24-integration` = main `80e2cb5` + 24a footer counts +
24c worker logs). No schema change, no migration, no new dependency, no new configuration key, no
timer. `npm test` **653 → 668**, `npm run typecheck`, `npm run smoke:pi`, `npm run smoke:package`,
`git diff --check` and `npm run perf -- --repeats=2` all pass.

## 1. The surface, as shipped

### Commands

| Form | Behaviour |
|---|---|
| `/trace` | Opens the menu; without dialog-capable UI prints the status text and the forms below |
| `/trace on` / `/trace off` | Enables/disables **this** memory-session identity, at once, no reload |
| `/trace catchup` / `/trace stop` | The existing finite drain and its cancellation |
| `/trace project <name>` | The existing project declaration |
| `/trace mark K<n>[@<commit>] verified\|flagged\|clear` | The existing knowledge mark |

`enable`, `disable`, `status` and `runs` are retired **without aliases** (amendment 1). Any retired
spelling, unknown word or malformed argument prints:

```text
Trace Memory: /trace enable is not a command form. `enable` was retired; use /trace on.
/trace (menu; status when headless) | /trace on | /trace off | /trace catchup | /trace stop | /trace project <name> | /trace mark K<n>[@<commit>] verified|flagged|clear
Nothing was changed.
```

and mutates nothing — no enrollment change, no declaration, no mark, no worker. `status` and `runs`
name the menu entry that now owns them. The retained four exist because `-p`/rpc has no menu; they
are documented forms of the same functions the menu calls, not hidden aliases of a menu entry.

### Menu

```text
Trace Memory                     Current session (title = the status text)
  Current session                  Off            ← On when disabled
  Catch up                         Runs           → count input
  Stop                             Project        → name input
  Settings                         Mark           → address input, then verified/flagged/clear
                                   Retry fork     ← only while automatically downgraded
```

Current session's dialog title is `status()` — enrollment, 24a's `Pending:` counts, deliveries,
runs, spend, fork suppression, compaction tier and catchup line. Catch up and Stop are the 18b
operations unchanged. Cancelling any select, input or confirm returns without writing anything and
without a model request (pinned by a ten-case test that diffs the settings file, the enrollment and
the host entries afterwards).

### Settings

```text
Settings — four global defaults, saved under "trace-memory" in <agent dir>/settings.json
Project and environment layers still take precedence; advanced values stay in the settings files.
Worker logs: <agent dir>/sessions/trace-memory

  Noter mode: fork (Project); Global=subagent masked
  Noter model: follow foreground (Default); fork mode inherits the foreground model openai/gpt-5
  Consolidator mode: subagent (Default)
  Consolidator model: fake/test-mini (Global)
```

Four preferences on the four existing canonical keys (`noting.forkModeDefault`, `notingModel`,
`consolidation.subagentModeDefault`, `consolidationModel`). Each line carries the effective value,
its `Default`/`Global`/`Project`/`Environment` source and every masked layer — the same shape the
superseded read-only view used for those keys.

**Where the 24c disclosure went:** the `Worker logs:` line of this dialog's header (asked in the
brief). It names the resolved destination and, for an explicit `runsDir` outside Pi's sessions root,
adds "outside Pi's scanned sessions tree, so file-based daily statistics do not see them". It is a
global fact about the installation, and the settings entry is where the superseded view stated it.

## 2. How settings are written and applied

**Written.** `writeGlobal(key, value)` re-reads the resolved global settings file, merges the one
canonical key into its `trace-memory` section, validates the merged layer through the load path, and
replaces the file atomically (temp file + `renameSync`, the idiom the enrollment receipt already
uses). Everything else — Trace Memory's advanced values, Pi's own `retry`, other extensions'
sections — is carried over as parsed. A malformed file, a non-object `trace-memory` section, a value
the next load would reject, or a failing write throws **before** anything is replaced, and the menu
reports the failure: no edit reports a success it did not achieve. If the same preference is present
under its legacy spelling (`noting.branchModeDefault`), the write replaces it with the canonical key
and says so, so the file it produces has no alias conflict at the next load.

The load-path validation is literal reuse, not a copy: `configuration`'s inner `parse` was hoisted to
a module-level `parseLayer(flat, named)`, which `configuration` still calls for every layer and for
the merged result, and which the writer calls over `canonicalFlatConfig(mergedLayer)`.

**Applied, in this instance, without a reload.** `applySettings()` re-reads the settings layers
exactly as `restore` does (so precedence, masking and validation are the load path's), rebinds
`flat/core/sources/layers` — which is what the host's own `modelName`/`launch` read — and hands core
the two mode booleans through the new façade `configure` (amendment 2). It passes the **effective**
merged values, so a project or environment override still decides. Tasks admitted afterwards use
them; a task already running keeps the mode, model, evidence and budgets frozen with it, because
admission captured them before the call. Nothing here dispatches a worker, touches the cache-miss
latch or reopens the database.

`TraceMemory.configure(modes)` is the only new core surface: it canonicalises the override (aliases
mapped, removed keys refused, conflicts named), refuses any section or key other than
`noting.forkModeDefault` and `consolidation.subagentModeDefault`, runs the whole configuration
through `validateConfig`, and assigns the two booleans onto the same `cfg` object every reader
already holds. It is not a second configuration source: it reads no file and reloads nothing.

## 3. Which ruling each choice satisfies

| Choice | Ruling |
|---|---|
| Seven documented forms; `enable`/`disable`/`status`/`runs` retired without aliases | Parent 24 "Commands and menu" + amendment 1 (user, 「可以保留」) |
| A retired or malformed form prints the usage and mutates nothing | Parent 24: "Invalid or extra arguments return the new usage without taking action" |
| `on`/`off` act on the current identity only, at once, no reload; provisional choice, baseline, receipt, shared fork/clone disclosure all unchanged | Parent 24 user story 5 and "Reuse the existing enrollment mechanism"; 18a enrollment rules in `docs/pi.md` |
| No global participation switch | Parent 24: "The earlier proposal for a global participation switch is withdrawn" |
| Four menu entries; status, runs, project, marks, participation and conditional Retry fork under Current session | Parent 24 menu table and user story 10 |
| Retry fork stays menu-only and only while downgraded | 19c "Menu-only reset" (unchanged code path) |
| Catch up / Stop keep their own semantics and are not participation | Parent 24 user story 6; 18b catchup/stop rules |
| Cancelling is inert, and no menu action but Catch up may call a model | Parent 24: "Cancelling a menu or input changes nothing and makes no model request"; "opening the menu, inspecting settings, choosing a model, toggling participation, and Retry fork do not start a worker" |
| Exactly four preferences on the existing canonical keys | Parent 24 "Global settings" table; "rather than introduce a second mode/model system" |
| Models from Pi's registry (`getAvailable`, plus the foreground model), validated with `find` | Parent 24: "Use Pi's native model registry and existing validation/auth availability mechanisms"; "do not request credentials in the menu or call a model to validate a selection" |
| Fork mode discloses the inherited foreground model; the choice is labelled as the subagent one; a saved model survives a mode switch; choosing a model never switches the mode | Parent 24 user story 8 and "In fork mode, show that the actual model is inherited…", "Preserve a saved subagent model while switching modes", "Selecting a model must not silently switch modes" |
| The configured mode, not a fallback, decides the model-selection policy shown | Parent 24: "a requested fork falling back does not grant a new model-selection policy" |
| Re-read/merge/validate/atomic-replace; unrelated settings preserved; no false success | Parent 24: "Write only the chosen global preference…", "Re-read/merge before a safe write; malformed input, cancelled edits, validation failure, or write failure must not corrupt the file or report false success" |
| The legacy spelling of the edited preference is replaced by the canonical key | Parent 24: "Handle any existing legacy spelling of the edited preference consistently with the canonical alias/conflict rules"; 19 "Legacy input" |
| An override is displayed as the effective source and never erased | Parent 24 user story 9 and "Do not erase the override to make a global edit appear effective" |
| Application through façade `configure` (two booleans) + host model re-read; running tasks unchanged | Parent 24 amendment 2, and "Refresh both host selection and core configuration as needed; updating the menu text alone is not application" |
| No advanced submenu, no budget/path editor, no new key; advanced configuration still loaded and validated | Parent 24: "removing its menu display is not removing the configuration surface" |
| The read-only settings menu is superseded, explicitly, in the docs | Parent 24: "supersede the menu's read-only ruling … explicitly" |
| 24c's runsDir disclosure survives in the Settings header | 24c log-location contract; parent 24 "disclose when it leaves logs outside Pi's scanned tree" |

Checked before adding anything: `tests/core/api/rulings.test.ts` (the alias/conflict and
mode-spelling rulings — reused, and one case added for `configure`), `docs/pi.md`'s enrollment rules
(the `toggle` path was not touched), and 18b's catchup/stop rules (`startCatchup`/`stopCatchup`
unchanged). No new mechanism was introduced beyond the two the amendments name.

## 4. Tests

**653 → 668** (38 → 40 files). Two new files, one new ruling case, and the existing suite retargeted
onto the new spellings.

`tests/hosts/pi/commands.test.ts` (7 cases)

1. On/off act at once and per identity: S1's choice survives a second Pi identity's opposite choice
   and a reopen; no request is made.
2. Before the first reply: the provisional receipt, the transfer at allocation, and the shared
   fork/clone disclosure in the dialog title.
3. Retired and malformed forms — 17 of them, plus the four retirement hints — print the usage and
   change no enrollment, run, host entry or request.
4. The retained forms headless (`hasUI` false): bare `/trace` prints the status and the exact usage
   line and opens no dialog; project, catchup, stop, mark (routed to core's own address rejection)
   and on/off all work.
5. Menu parity: the four entries, Current session's option list and status title, Runs with its
   count, Project, and Mark with its address validation and kind selection.
6. Cancellation: ten paths (top level, session menu, confirmation, each input, the settings list,
   the value selection) leave the settings file, enrollment, host entries, runs and requests intact.
7. Menu Catch up and Stop are the 18b operations, and a stop leaves future work enabled.

`tests/hosts/pi/settings.test.ts` (7 cases)

1. Each control writes only its canonical key; another extension's section, Pi's `retry` and an
   advanced `render.entryTokens` all survive all four edits; the four lines read back from Global.
2. A saved mode reaches the next admitted task (`requestedMode` fork → subagent) with no reload,
   and a task held at the wire keeps the mode it froze while the preference is switched under it.
3. A saved model is used by the next subagent run (the child's request really carries `test-mini`);
   switching the mode back to fork preserves it and only discloses the inheritance; choosing a model
   does not switch the mode.
4. A project override stays effective, is named in the notice, is shown as the effective source with
   the global value masked, and its file is byte-identical afterwards.
5. Cancelled selection, an unavailable model, a malformed file, a non-object section and an
   unwritable directory each change nothing and report honestly.
6. A legacy `noting.branchModeDefault` is replaced by the canonical key with a notice, and the
   resulting file loads without a conflict.
7. Editing starts no worker and does not clear the cache-miss latch.

`tests/core/api/rulings.test.ts` gains *24 amendment 2 2026-09-09: configure replaces the two
execution-mode defaults, validated like the load path, and nothing else* — the two booleans move, a
later task is admitted in the new mode, the alias is accepted, and a bad type, a removed key, a
non-reconfigurable key and another section are each refused by name without changing anything.

Retargeted: every `command(h, "enable"|"disable")` → `"on"`/`"off"`; every `command(h, "status")` →
bare `/trace` (headless); `/trace enable` expectations → `/trace on` (the core rejection text in
`tools.ts` and `store/index.ts` changed with it); the three enrollment/alias cases and the 24c
disclosure case now read the Settings dialog instead of the read-only notice; `18a: read-only
settings show precedence…` became `18a/24b: Settings shows the four preferences…`, which also pins
that the advanced keys are still loaded and still validated by name. `test-host.ts` gained a second
fake model (`fake/test-mini`) and `getAvailable`/`getAll` on the fake registry.

`tests/hosts/pi/smoke.ts` — and therefore `npm run smoke:package`, through the installed tarball —
now exercises `/trace off` (status and the compact footer), `/trace on`, `/trace stop`,
`/trace project <name>` and a retired `/trace enable` that prints the usage and changes nothing.

## 5. Revert probes

Each mutation was applied alone to `src/hosts/pi/index.ts`, the affected file run, then the file
restored from a pre-probe copy and verified with `cmp` (all four reported byte-for-byte restoration;
the suite is green afterwards). No production instrumentation was added for them.

| Probe | Mutation | Test that goes red |
|---|---|---|
| 1 — a global instead of a per-session switch | `toggle`: `for (let id = 1; store.getSession(id); id++) store.setEnrollment(id, value)` | `commands.test.ts` › "24b: on and off act on this memory session immediately and without a reload; an independent session is untouched" — S1 is Enabled again after S2 turned itself on |
| 2 — an ignored saved mode | `applySettings`: the `memory.configure(...)` call deleted (layers still re-read, menu text still refreshed) | `settings.test.ts` › "24b: a saved mode reaches the next admitted task…" (`['fork']` instead of `['fork','subagent']`), and consequently › "24b: a saved model is used by the next subagent run…" (`test` instead of `test-mini`, because the phase never leaves fork) |
| 3 — an override erased by a global edit | `writeGlobal`: after the atomic replace, delete the same key from `<cwd>/.pi/settings.json` | `settings.test.ts` › "24b: a project override stays effective and is explained; a global edit never erases it" — the notice no longer names the Project precedence, and the project file's bytes change |
| 4 — a hidden alias for a retired subcommand | the handler: `if (verb === "enable" \|\| verb === "disable") { toggle(verb === "enable"); return; }` | `commands.test.ts` › "24b: retired subcommands and malformed arguments print the usage and change nothing" — `/trace enable` toggles instead of printing the usage |

## 6. Performance

`npm run perf -- --repeats=2` (node v24.6.0, darwin/arm64) was run only to confirm nothing regressed;
24b adds no footer, hook or render work. Against 24a's table: footer counts 12.0 ms baseline /
23.4 ms large (24a: 11.0 / 20.2), `agent_end` 10.8 / 36.3 (24a: 10.8 / 22.8), `tool_result` 16.9 /
60.6 (24a: 18.7 / 34.7), `agent_settled` 4.1 / 12.6, 50 `message_update` 0.7 / 0.7, off
`session_start` 0.2 / 0.2. Every scenario stays far inside the 100 ms p95 bound; the large-fixture
differences are the run-to-run variance 24a already recorded at two repeats, on the same code paths
this ticket did not touch. The perf runner's two host scenarios were renamed with the command
(`host /trace on (import)` / `(repeat)`); their numbers (630 ms / 165 ms baseline, 1,721 ms / 805 ms
large) are the 22b import figures, unchanged.

## 7. Line delta, and what is not met

`src/` **+292 / −79**, net **+213**; **70 of the 292 added lines are comments**, so the net
executable change is about **+143**. Per file: `src/hosts/pi/index.ts` +265 −77 (the whole command,
menu and settings tail was rewritten, and `configuration`'s inner `parse` was hoisted to
`parseLayer` so the writer can reuse it), `src/core/api/index.ts` +25 (the `configure` method and its
contract comment), `src/core/api/tools.ts` and `src/core/store/index.ts` +1 −1 each (the rejection
text now says `/trace on`). Tests: two new files (188 + 187 lines), +28 in `rulings.test.ts`, and
mechanical retargeting elsewhere. Docs: `docs/pi.md` +110 −35 (a new "Commands, menu and global
settings (24b)" section replacing the old menu/command paragraphs, plus the scattered
`/trace status` references), `README.md`, `CONTEXT.md` (Enrollment, Mark, and a new **Global
preference** term), `docs/live-verification.md` (a "24b note" beside the 19c one, and step 5 of the
acceptance procedure), `.scratch/v1/spec.md` (the menu/command paragraph and the sentence "The
plugin never writes settings", which 24b contradicts).

**Not met / stated plainly:**

1. **The read-only view of every effective key is gone, and nothing replaced it.** That is the
   ruling ("no advanced controls"), but it means a user who wants to see the effective
   `noting.triggerTokens` and its source now reads the settings files, or hits the load error if the
   value is invalid. The tests pin that those keys are still loaded and still validated by name;
   they are no longer *displayed* anywhere.
2. **No live Pi run.** Everything here is the fake host, a real Pi child `AgentSession` at the wire,
   the installed-tarball smoke and temporary agent roots. A real `ui.select` returning one of the
   long preference lines is asserted only through the fake (the handler matches the exact option
   string it produced), and `modelRegistry.getAvailable()` was exercised only against the fake
   registry — the installed SDK 0.85.1 declares it (`ModelRegistry.getAvailable(): Model<Api>[]`,
   the auth-resolved snapshot), which is why it is the source used, with `getAll()` and the
   foreground model as fallbacks.
3. **The write-failure case depends on directory permissions.** `chmod 0o500` on the agent directory
   is how the "write failure reports the failure" case is produced; running the suite as root would
   make that one case vacuous (it would succeed instead of failing). Every other refusal
   (malformed file, non-object section, invalid merged layer) is permission-independent.
4. **Cross-process propagation is the settings-load lifecycle only**, as the parent allows: another
   Pi process sees a new global default when it next loads its settings. There is no watcher and no
   broadcast.
5. **`docs/live-verification.md`'s dated records keep their old spellings** (`/trace status`,
   `/trace enable`), as that file's header requires for recorded runs; a "24b note" at the top gives
   the substitution, and the forward-looking acceptance procedure was updated. The closed ticket
   files under `.scratch/v1/issues/` were likewise left as the historical record they are.
6. **A model choice cannot be made for a provider Pi cannot list.** The menu offers
   `getAvailable()` plus the foreground model; a model that exists in `models.json` but whose
   provider has no resolved auth is deliberately not offered, and typing one is not possible from a
   select. The settings file still accepts any `provider/model-id` string by hand, and an
   unresolvable one fails at admission with the existing capacity/availability error.
