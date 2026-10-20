# PLAYER-v1

Status: implemented for one synthetic scene.

The manifest version is 1. Runtime `requiresLlm` and `executableScripts` must both be false. Animation in the demo is `css`. Rules are `adeena.rules.v1` with `deterministic-choice` scoring. A choice scene must have exactly one correct option. Unknown keys, including a script field, are rejected.

The HTTP preview removes the `correct` flag before responding. Scoring uses the server copy and returns only whether the choice was correct and a point value of 0 or 1.

Deferred proposal, not an approved product decision: a learner player shell, lazy-loaded Phaser, and Rive. None of those are in this build.
