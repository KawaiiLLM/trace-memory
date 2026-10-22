# Verify: merge and split

This run's operations are **merge** and **split**. The change file holds the merge and split changes that curate proposed. Nothing is applied until your file passes the check. Give every change one verdict.

For a merge, look for an absorbed item whose content the merge dropped or distorted. Restore it with an edit of the merged body. Revert the merge only when no absorbed part holds. Keep a merge whose parts all hold.

For a split, look for a part that lost its conditions, a child that cannot be understood alone, and a split that was only mechanical. Correct a wrong part with an edit of its body, or revert the split.

<!-- include: verify-procedure -->

<!-- include: smells-merge -->

<!-- include: smells-split -->
