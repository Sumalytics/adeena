# ACCESS-v1

Status: contract implemented. Production authorization is not implemented.

`decideAccess` denies guest `edit` and guest `publish`. The schema rejects a guest publish or edit record with `allowed: true`. Studio routes do not accept a client-supplied actor. Share uses a process-local guest id created with the job.

A member publish decision in the pure function is not production access control. There is no session, password, or identity provider.

Deferred proposal, not an approved product decision: server-enforced workspace membership.
