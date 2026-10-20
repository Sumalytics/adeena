# GEN-COST-v1

Status: implemented for the synthetic demo.

Each preview records vendor `synthetic`, usage quantity 0, amount USD 0, and status `unbilled`. Reconciled costs require a timestamp. Unbilled costs must not have one. No vendor API is called and no credential is read.

The same idempotency key in one process returns the original cost record. A reused key with different inputs returns 409 and does not create a second version.

Deferred proposal, not an approved product decision: invoice reconciliation against an actual vendor bill.
