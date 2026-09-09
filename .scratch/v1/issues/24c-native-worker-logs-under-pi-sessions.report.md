# 24c — Native worker logs under Pi's session tree (implementation report)

**Branch:** `ticket-24c`, from `80e2cb5` (the parent ticket's stated baseline).
**Note on the starting point:** the worktree's HEAD was `bdb9968`, an *ancestor* of `80e2cb5`, not a
descendant. The branch was therefore created at `80e2cb5` explicitly rather than at the worktree's
HEAD, and `npm ci` was run because the worktree had no `node_modules`.

## What changed

One decision moved: where a native worker log goes when no `runsDir` is configured.

| | Before (ruling 19:5) | After (24c) |
|---|---|---|
| Default destination | `<dbPath's directory>/runs/<parent Pi session id>/` | `<resolved Pi agent directory>/sessions/trace-memory/` |
| Levels below the sessions root | not in the tree at all | exactly one, no per-parent subdirectory |
| Explicit `runsDir` | `<runsDir>/<parent Pi session id>/` | unchanged, including precedence |

`src/hosts/pi/index.ts` — `runsDirectory(piId)` now returns `join(agentDir, "sessions",
"trace-memory")` when `runsDir` is unset, and keeps 19a's `join(configured, piId)` when it is set. The
configured value is still read from `flat` on **every** call, because `restore()` reloads the settings
layers at each session start; a directory frozen at construction would have gone stale (this is a
behaviour-preserving detail, not a new mechanism). A sibling predicate, `runsOutsideScan()`, reports
whether an explicit directory leaves the scanned tree, and the read-only settings view appends that
disclosure to the `runsDir` line and now names the new default. `native.ts` was not modified: it
already writes wherever the host points it, already records the actual path as `nativeLog`, and
already lets a directory or persistence failure fail the run.

**Ticket 19 supersession is explicit and documented.** `docs/pi.md`'s `runsDir` paragraph — which
attributed the default to 19a and said the logs were "outside Pi's own sessions directory, so
`/resume` never lists them" — was rewritten to state the new default, to name ruling 19:5 as
superseded and quote what it said, to give the reason (external readers scan the root plus one level),
and to state the accepted tradeoff: worker sessions now appear in Pi's all-session browser under
`trace-memory`. No hiding framework and no discovery-driven import were added; worker
resource/extension discovery stays disabled. Two further doc sites were corrected (the fresh-child
`SessionManager.create` paragraph and the retention note). `CONTEXT.md` gained one term, **Worker
log**.

Old logs were not touched. Nothing moves, copies, symlinks, deletes or rewrites a file, and no
historical `nativeLog` is rewritten — the change decides where the *next* log is written and nothing
else. Logs outside the scanned tree are not retroactively part of anyone's daily total.

### Line delta (honest count)

`src/hosts/pi/index.ts`: **+26 / −8**, net **+18** lines. Of those, **13 added lines are comments**
(the superseded-ruling rationale, the lazy-read rationale, and the disclosure rationale); the actual
code delta is about **+5 net lines** — one line became four (`sessionsRoot`, `configuredRunsDir`,
`runsDirectory`, `runsOutsideScan`), the settings-display default string changed, and one line was
added to the settings-display formatter. No schema change, no new dependency, no new configuration
key, no new mechanism.

Full diff: `CONTEXT.md` +1/−0, `docs/pi.md` +25/−8, `src/hosts/pi/index.ts` +26/−8,
`tests/hosts/pi/native-fixture.ts` +8/−3, `tests/hosts/pi/native.test.ts` +8/−7,
`tests/hosts/pi/smoke.ts` +2/−1, new `tests/hosts/pi/logs.test.ts` (251 lines).

### Test-side change worth naming

`native-fixture.ts` used to put the parent session in `<tmp>/sessions` — beside the agent directory
rather than inside it. That made the old assertion "the children are not in Pi's sessions directory"
true for the wrong reason. The fixture now puts the parent where real Pi puts one,
`<agentDir>/sessions/parent/`, so the worker directory is its genuine sibling and an external reader
of that root sees the tree a user would have. Existing assertions in `native.test.ts` were retargeted
at the fixture's exported `runsDir`; `smoke.ts` now checks the log's parent directory instead of
matching the substring `/runs/`.

## Acceptance

- [x] **Log location.** `tests/hosts/pi/logs.test.ts`, four cases on a temporary agent root: a fork's
  log is a direct child of `sessions/trace-memory` with Pi's `<timestamp>_<child id>.jsonl` name, its
  header's `parentSession` points back at the parent file, every copied entry keeps the parent's entry
  id, message bytes and original timestamp, the child's own assistant entries carry usage, the tool
  call/result history is present, and the audited `nativeLog` is the file that exists. A fresh
  subagent lands in the same directory with the parent id nowhere on the path and no subdirectories
  inside it. An explicit `runsDir` still wins and keeps `<runsDir>/<parent id>/`, and the superseded
  default is not created at all. An earlier run written to another directory keeps its recorded path,
  its bytes and its mtime after a later session runs on the new default, and no new file joins the old
  directory.
- [x] **Daily statistics compatibility.** One temporary sessions tree holding a parent, its fork with
  copied history and new usage, and an independent subagent (drained by `catchup`). The reader is
  imported by absolute path and returns: every response this process really made charged exactly once
  (`= f.sent.length × $12`, the wire being the ground truth for how many billable responses existed);
  the parent's inherited reply, present in two files, charged once; two distinct responses whose text
  is byte-identical (`"Done."`) charged separately; and, for a window that starts one millisecond after
  the parent's first reply, that reply dropped from both files even though the fork's file was written
  inside the window. A different provider id and an empty directory both cost zero. Ground truth is a
  recursive walk of the tree, so the reader — not the test's bookkeeping — is what has to find the
  logs.
- [x] **No external coupling.** The reader is not a dependency: a separate case greps every `.ts` file
  under `src/` for `pi-statusline` / `usage-spend` / `pi-extensions` and checks the manifest's three
  dependency maps; both are empty. The compatibility case is `test.skipIf` on the checkout's presence,
  so the suite passes on a machine without pi-extensions.
- [x] **Revert probes.** Each applied alone, then restored and verified with `cmp`:
  - *Restore the old default destination* (`runsDirectory` falls back to `<dbPath dir>/runs/<piId>`):
    red — `24c: with no runsDir configured a fork's log is a direct child of sessions/trace-memory…`,
    plus the subagent, old-path and daily-reader cases.
  - *Add a per-parent directory level under the default* (`join(sessionsRoot, "trace-memory", piId)`):
    red — `24c: the external daily reader charges every new worker response once…` fails with
    **expected 24 to be 48**, i.e. the reader stops seeing the worker logs entirely; the two
    location cases go red as well.
- [x] **Gates.** `npm test` **639 → 646** (37 → 38 files; the baseline number was measured by stashing
  the change and re-running, then restoring and confirming the restored tree byte-identical to the
  backup). `npm run typecheck` clean. `npm run smoke:pi` passes. `npm run smoke:package` passes
  (installed tarball, Pi discovery/load and a native Noting run through the installed entry).
  `git diff --check` clean.
- [x] **Docs.** `docs/pi.md` (`runsDir` default, ticket-19 supersession stated in the text, the
  session-browser tradeoff, the fresh-child and retention notes) and `CONTEXT.md` (**Worker log**).

## Reader identity actually tested

`git` could not be run against `~/Projects/pi-extensions` from this worktree (the harness refuses
git operations targeting another checkout), so the identity was read from the repository's own ref
files rather than from `git rev-parse` / `git diff --stat`:

- `.git/HEAD` → `ref: refs/heads/powerline-style`
- `.git/refs/heads/powerline-style` → **`395d6f8479b664111ccfb007dd9cf724841c454c`** — the exact commit
  the ticket names as the base of the uncommitted deduplication change.
- File tested: `packages/pi-statusline/src/usage-spend.ts`, sha256
  `75ae5d2048b91630c610c00cbcb549b08d50ade658adfb958eb738d349aa2680`, 3286 bytes, mtime
  `2026-09-09 14:27:04`.
- The working copy does contain the deduplication change described in the ticket: `sumProviderSpend`
  keeps a `charged: Set<string>` of entry ids and skips an entry whose id it has already charged. Its
  `listSessionFiles` scans the root plus one directory level.

**Unverified:** that the working copy differs from the committed `395d6f84` blob could not be
confirmed with `git diff --stat`; it is inferred from the ticket's statement plus the presence of the
deduplication code. This is a local integration candidate, not a published compatibility guarantee —
a released pi-statusline without the deduplication change would double-charge inherited fork history,
and this ticket does not implement or own that deduplication.

## Observed vs. assumed

**Observed in this repository's tests.** Everything under Acceptance above, on a temporary
`PI_CODING_AGENT_DIR`, with the provider stubbed at the wire. No paid call, no live database, no
access to `~/.trace-memory` or `~/.pi/agent`.

**Assumed, not verified here.**

1. *Real Pi's foreground session layout.* The tests place the parent at
   `<agentDir>/sessions/parent/`, matching `SessionManager.getDefaultSessionDir`'s
   `<agentDir>/sessions/<encoded cwd>/` shape read from the installed SDK 0.85.1 — but a real Pi
   session was not started. If a future Pi changed that root, the worker directory would move with
   `PI_CODING_AGENT_DIR` but the *relationship* to the foreground sessions would need rechecking.
2. *Pi's all-session browser really lists the worker sessions.* This follows from the directory being
   inside the tree Pi scans, and is documented as the accepted tradeoff, but it was not exercised
   against a running Pi UI.
3. *pi-statusline's shipped behaviour.* Only the user's working copy was run. See above.
4. *Multi-parent sharing of one directory.* Filenames are Pi's `<ISO timestamp>_<uuidv7>.jsonl`, so
   two parents cannot collide in practice; the tests exercise two sessions in one tree only through
   the old-path case, not two concurrent parents writing simultaneously.

## Not done / out of scope here

- The footer, `showSpend`, the menu structure and the command surface were left alone (24a and 24b
  own them). The only menu-adjacent edit is the `runsDir` line of the read-only settings view, which
  is the log-location contract's own disclosure: it names the new default and, for an explicit
  directory, says the logs fall outside the scanned tree. It is two lines and one string, deliberately
  kept small for the merge.
- Retention/pruning of the worker directory is still an unimplemented v1 limit, now documented as
  applying inside Pi's sessions tree.
- `npm run perf` was not run: this ticket adds no footer, hook or render work, and the parent assigns
  the ticket-22 responsiveness re-measurement to the footer slice (24a).
