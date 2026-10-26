# Clustering

1. Read `items.md` and every full-text batch file named by {{tool.check}}; read every item's complete body, not only its title.
2. Fill the pre-made `groups.md` template: use as few groups as possible, each with at most 50 items, and place every supplied item exactly once.
3. Within each group, put highly related items in adjacent clusters of at most 10, keeping duplicates and contradictions together; label each cluster with `## Cluster <label>` and list each item on its own `- K<id>` line in cluster order. On a suspected problematic item's own line, append ` ! duplicate <level> K<partner>[,K<partner>…]: <reason>` or ` ! contradiction <level> K<partner>[,K<partner>…]: <reason>`, naming the items it duplicates or contradicts as partners. Mark items, not pairs: each marked item gets its own line. The level says how sure you are, and the Dreamer reviews high marks first because it has room for only some:
   - `high`: reading the bodies confirms the items say the same thing, or reach opposite conclusions;
   - `medium`: likely overlap or conflict that the Dreamer must judge;
   - `low`: possibly related, worth a look.
4. Call {{tool.check}}, correct its findings, then stop; check reports the configured soft budgets and usage, in principle at most 30 steps and +150k context.
