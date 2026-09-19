### Knowledge

A knowledge item is the versioned arc of one object: one object, one independently changeable claim or state, one identity.
- A version has a `text` (the body), a `category`, a `scope`, `topics`, `supports` and a `reason` (the commit message). `supports` are the facts that moved the item to this version; earlier versions' supports are inherited, not copied.
- While the object exists, a change to that claim or state — its content, its category or its wording — is an update of the same id.
- Identity is the claim or state itself, not a label, a category or a current value: one role's default of Sol high, then Astra high, then Sol medium is one item in three versions. A ticket-specific override is its own item; implementation and review roles are separate claims.
- Different claims about one object are different items. A piece is its own item only where a later fact would change it while its sibling stands.

**Two kinds.**
- **Established knowledge** — `goal`, `constraint`, `mechanism`, `term`, `reference`. Created, updated or entered by a category change only with reliable certification (Principles).
- **Pending knowledge** — `open`, and `dispute` where two accounts conflict. Knowledge worth keeping that lacks certification stays here; when a certifying fact arrives, it changes category on its own id or merges into the established item of its object.
- An established item never becomes pending: a doubt, an alternative or unfinished work about it is its own pending item, and the established item stands until a certifying fact changes or archives it.

**Seven categories, one test each.** If no test answers yes, it stays in the fact layer.
- **goal** — what is this work meant to achieve? Current intent and acceptance criteria; not a step's plan.
- **constraint** — if a new agent ignored it, would something break or the user be annoyed? Limits, conventions, user preferences, working rules distilled from experience; not a one-off action, not a guess.
- **mechanism** — when explaining why the system looks like this, would you cite it? Load-bearing design choices and root causes; not what it merely does now.
- **term** — without knowing what this word refers to, would you misread the user or the code? Project names, references, the user's coinages and their meaning.
- **reference** — where is the value or location you need when acting? Config values, paths, endpoints, specs, URLs; lookup facts, not explanations.
- **open** — what has no clear outcome, would be re-investigated by the next agent, or needs the user's ruling? Say what and whom it waits for, and keep the change it is about: what stood before, what is proposed instead, who proposed each. Settled categories state only what holds now; their past is in their versions.
- **dispute** — do two accounts of one object under the same conditions coexist with no basis to rule? Write both sides and the object to re-check; do not pick a side.

**Status.** A finished status with no follow-up (merged, implemented, installed) is a few characters in the ruling's body, pointing at its fact. A status with follow-up is its own `open`.

**Object state.** One `reference` item per persistent object the agent acts on (an installed version, a published version, a pinned exclusion); its body is the current state and nothing of the event that produced it. A new state updates that item, citing the new-state fact alone. Never create a second item for it or archive it while the object exists.

**scope.** `session`: holds only in this session (paths and checksums of this run, numbers from one experiment, a reply being waited on). `project`: holds in this project; something narrower than the project but needed across sessions (this snapshot, this ticket) is `project` with the range stated in the text. `global`: holds across projects (the user, the general environment, general working method).

**topics.** Subject labels, never kinds: concrete module names or domain terms (`core/store`, extraction, billing), never category words or the project's own name. A label classifies only: it grants no scope, evidence, lifecycle or coverage, and sharing one merges nothing.
