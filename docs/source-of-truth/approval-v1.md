# APPROVAL-v1

Status: implemented as a gate. The demo never grants approval.

Blockers are the risk id when publication is disallowed, plus the ids of block-severity educational failures. A blocked decision requires at least one blocker. An approved decision requires no blockers and a timestamp. The demo builder emits `blocked` or `pending`, never `approved`.

`POST /api/studio/share` still returns 403 when a decision would be allowed. That route is fail-closed until a real approval actor exists.

Deferred proposal, not an approved product decision: a human approver and an immutable approval record outside process memory.
