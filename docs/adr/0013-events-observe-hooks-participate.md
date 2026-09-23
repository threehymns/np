# Events observe, hooks participate

np separates event observation from operation hooks. An event records that something happened; subscribers cannot mutate the outcome, veto it, or fail the operation, and the host need not await them in any particular order. A hook wraps a specific host operation with before/after phases; before-hooks run sequentially in plugin activation order, may modify inputs or cancel with a user-visible reason, and are always awaited before the operation proceeds. A throwing hook is contained, logged against its plugin, and never an implicit veto; remaining hooks still run.

This split exists because the two roles need different contracts. Unifying them forces every casual observer to carry ordering, awaiting, and failure semantics, or gives every participant fire-and-forget casualness; a `canVeto` flag on a unified subscription would recreate the split under a worse name. Registry data follows the transform/replay rule instead of either mechanism.
