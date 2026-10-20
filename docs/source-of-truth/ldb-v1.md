# LDB-v1

Status: implemented for the synthetic demo.

An LDB-v1 record is the learning brief. The studio accepts a source label and an audience label with an age band, then stores version 1 as a draft. Rights status is forced to `unverified`. `contentHash` stays null because uploaded bytes are not stored. The workspace id is the fixed synthetic workspace, not a customer tenant.

The record is validated with a strict schema. Executable markup in the text fields is rejected.

Deferred proposal, not an approved product decision: durable brief storage, byte-level source hashes, and a rights workflow that can set `cleared`.
