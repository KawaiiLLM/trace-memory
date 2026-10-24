# Clustering

1. Read `items.md`, one line per current item visible in this project; read full items by their `trace://` addresses when needed.
2. Fill the pre-made `groups.md` template: use as few groups as possible, each with at most 50 items, and place every supplied item exactly once.
3. Within each group, put highly related items in adjacent clusters, keeping duplicates and contradictions together; label each cluster with `## Cluster <label>` and list its item addresses on `items:`, comma-separated, in cluster order.
4. Call {{tool.check}}, correct its findings, then stop; check reports the configured soft budgets and usage, in principle at most 10 steps and +30k context.
