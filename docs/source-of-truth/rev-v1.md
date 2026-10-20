# REV-v1

Status: contract implemented. The studio does not create revisions yet.

`planRevision` returns a new REV-v1 record whose `toVersion` is the parent version plus one. The parent object is not modified. The safety block requires source trace preservation and forbids introducing executable scripts.

Deferred proposal, not an approved product decision: a revision API and storage for successive immutable drafts.
