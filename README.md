# adeena

Living Knowledge. Internal MVP baseline for Creator Studio.

```bash
npm ci
npm test
npm run lint
npm run typecheck
npm run build
```

This build uses synthetic previews only. It does not call a model, store uploaded bytes, or open public sharing. Guest publication stays blocked.

## Limitations

- Preview, score, and share state lives in the Node process. It is not a database or a queue, and it disappears on exit.
- Share always returns 403. ACCESS-v1, RISK-v1, and APPROVAL-v1 are enforced as demo gates. They are not production authorization.
- No environment variables are required. `.env*` stays ignored, with an exception for a future `.env.example`.
- Contract baselines: `docs/source-of-truth/`.

## Escalated dependency

`GHSA-vfj7-8cjw-p6xm` affects `braces@3.0.3`, pulled in only by `eslint-config-next` through `@next/eslint-plugin-next`, `fast-glob`, and `micromatch`. npm's latest `braces` is still 3.0.3, which is inside the affected range. The only audit fix offered is downgrading `eslint-config-next` to 14.2.35. That downgrade is not applied. CI runs `node scripts/audit-gate.mjs`, which fails on any other high or critical advisory.

