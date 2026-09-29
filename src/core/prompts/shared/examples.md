These only show how to write; they are not Raw entry evidence. Real facts must cite their own sources.

### Separate observation from explanation

> **Fact title**: Claude Code investigates the slow import
> Tool result segment: timing shows that database commits take most of the time, but gives no breakdown inside the commit.
> Agent segment: Claude Code suspects disk synchronization, but the results cannot tell it apart from other commit costs; it proposes measuring the parts separately.
> **Knowledge (open)**: The slow import's root cause is unsettled. Claude Code's timing investigation located most of the time in the commit phase; disk synchronization is only a candidate explanation, to be told apart by measuring the parts.

Do not write "disk synchronization was proven to cause the slowdown".

### Keep the final design and its reason

> **Fact title**: Confirming the final character interaction design
> User segment: the user confirms that dialogue influences the characters' decisions while outer rules control gameplay progression, so different gameplay modes share the dialogue interaction; this is the final design for implementation.
> **Knowledge (understanding)**: The user approved separating character dialogue from gameplay progression rules, so different gameplay modes share the dialogue interaction. The current definition and details are in the final Character Interaction Design.

The knowledge keeps the current understanding, the reason and the entry point; it neither stacks earlier drafts nor leaves only a document name. If a verification changes this understanding, update the original item; if it only adds process detail that can be looked up, record only a fact.

### Divide by independent maintenance

> Original item: "The user requires delivery state to be maintained uniformly by the database; the implementation is deployed; the slow recovery has not been investigated."
> Judgment: once the slow recovery is resolved, the user's ruling still holds; a change in the ruling would not settle the slow recovery either. The two therefore need independent maintenance.
> Handling: record the ruling with its necessary reasons, and the recovery investigation's current state and gap, separately; then classify them by content as `constraint` and `open`. If the deployment state affects later judgment, keep it in the relevant item; the deployment process that can be looked up stays in facts. Once the investigation concludes, update the understanding worth keeping under its original identity and classify it again, then keep or archive it by admission and budget.

The division follows whether parts change and are maintained independently, not category labels; knowledge of the same category may also need separating. This example does not prescribe how many items a piece of work must produce.

### Keep a concrete case worth remembering

> Material: the user recalls visiting the Harbor Museum. Optional galleries all rejoin one main loop, so a shorter visit never loses orientation, unlike a fixed route that must be walked in full. The user recorded the floor plan in Visitor Route Notes.
> Too abstract: Offer flexible routes.
> Too thin: Harbor Museum; see Visitor Route Notes.
> **Knowledge (reference)**: The user's Harbor Museum visit can serve as a reference for flexible touring: optional galleries all rejoin the main loop, keeping orientation while shortening the visit. Consult the sketch in Visitor Route Notes when comparing route designs.

The object, the comparison and the lookup cue keep this case's meaning; visit details that do not affect this understanding stay in the sources. This example is fictional and does not mean every case should be kept.
