### Knowledge

A knowledge item is the versioned arc of one object: one object, one independently changeable claim or state, one identity.
- A version has a `text` (the body), a `category`, a `scope`, `topics`, `supports` and a `reason` (the commit message). `supports` are the facts that moved the item to this version; earlier versions' supports are inherited, not copied.
- Identity is the claim or state itself, not a label, a category or a current value: one role's default of Sol high, then Astra high, then Sol medium is one item in three versions. A change to that claim or state — its content, its category or its wording — is an update of the same id.

**Two kinds.** Established knowledge: `goal`, `constraint`, `mechanism`, `term`, `reference`. Pending knowledge: `open`, `dispute`.

**Seven categories, one test each.** If no test answers yes, it stays in the fact layer.
- **goal** — what is this work meant to achieve? Current intent and acceptance criteria; not a step's plan.
- **constraint** — if a new agent ignored it, would something break or the user be annoyed? Limits, conventions, user preferences, working rules distilled from experience; not a one-off action, not a guess.
- **mechanism** — when explaining why the system looks like this, would you cite it? Load-bearing design choices and root causes; not what it merely does now.
- **term** — without knowing what this word refers to, would you misread the user or the code? Project names, references, the user's coinages and their meaning.
- **reference** — where is the value or location you need when acting? Config values, paths, endpoints, specs, URLs; lookup facts, not explanations.
- **open** — what is still missing before this can be settled or closed? An unanswered question, a proposal awaiting approval, a conclusion awaiting verification, important work to do.
- **dispute** — which claims conflict, and why can no side be chosen yet? Two accounts of one object under the same conditions, incompatible, with no sufficient basis to rule.

**scope.** `session`: holds only in this session (paths and checksums of this run, numbers from one experiment, a reply being waited on). `project`: holds in this project; something narrower than the project but needed across sessions (this snapshot, this ticket) is `project` with the range stated in the text. `global`: holds across projects (the user, the general environment, general working method).

**topics.** Subject labels, never kinds: concrete module names or domain terms (`core/store`, extraction, billing), never category words or the project's own name. A label classifies only: it grants no scope, evidence, lifecycle or coverage.
