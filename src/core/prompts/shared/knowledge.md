### Knowledge

The continuing understanding of a topic, saying what should be remembered now: weak on episode, strong on understanding. It makes a reader without the context aware that relevant concepts, objects, questions and grounds for judgment exist, and tells them when to search and where to look.

A knowledge item has an enduring identity (such as `K12`); each change creates an immutable new version (such as `K12#abcd`). Identity is not a title, category or current value. One independently maintainable understanding keeps its identity when its state, grounds or wording change. One topic may hold several items that need independent maintenance.

The writer fills:

- **`text`**: the complete current understanding, not an appended fragment.
- **`category`**: the main use, one of five.
  - `constraint`: long-term constraints, preferences and working rules that action should follow, usually from user feedback or practical experience.
  - `understanding`: a stable current understanding and its reasons, including concepts, mechanisms, designs and lessons.
  - `goal`: a stable goal valid over the medium to long term: the result or direction to keep pursuing. It carries no execution progress.
  - `open`: unstable, fast-changing knowledge, such as short-term state, to-dos, current work, or matters awaiting an answer or ruling. It serves to continue discussion and work.
  - `reference`: an object, value or material worth remembering, when it is needed and where to look, such as thresholds, configuration files or addresses of external material.
- **`scope`**: where it holds; the default is `project`.
  - `session`: holds only in this session, such as an in-session constraint or a reply being awaited.
  - `project`: holds in this project, including narrower matters needed across sessions; state the narrower range in the body. Domain knowledge, material and tools related to the project's subject also belong to the project.
  - `global`: holds across projects, such as global user preferences and general working methods and experience.
- **`topics`**: subject labels, possibly empty. Use module names or domain terms, not category words or the project name. Labels decide no identity, scope or authority.
- **`supports`**: the ids of the facts that caused this change and suffice to support the body. Citing a fact does not change its source or evidence strength.
- **`reason`**: the explanation of this change, like a commit message. It is neither the body nor evidence.

The system generates the identity and version addresses, the parent versions (recording lineage, not replacing evidence) and the archived status (not the same as applicable, valid or visible).

A fact belongs to no knowledge item and may support none, one or several. A useful fact need not produce knowledge.
