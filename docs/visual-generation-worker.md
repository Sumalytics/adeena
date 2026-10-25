# Visual generation worker

Run the visual worker independently from Next.js:

```powershell
npm run worker:visual
```

The command first creates a server-only worker bundle with the repository's installed Vite toolchain, then starts that bundle as an independent Node process. To reuse an existing bundle, run `npm run build:worker:visual` once and start `.local/visual-worker/visual-generation-worker.mjs` directly.

The Creator request only enqueues durable work with `ADEENA_APP_DATABASE_URL`. The worker requires a separate `ADEENA_VISUAL_WORKER_DATABASE_URL` that authenticates as the exact PostgreSQL login `adeena_visual_worker`. It claims one job at a time with a PostgreSQL lease and exits gracefully after the active job when it receives `SIGINT` or `SIGTERM`. Use `npm run worker:visual -- --once` for a single claim.

Migration 0021 creates `adeena_visual_worker` as `NOLOGIN` when it does not already exist and grants only claim-scoped worker privileges. A database administrator must provision its credential as a separate secret after migration, for example with `ALTER ROLE adeena_visual_worker LOGIN PASSWORD '<generated secret>'`. Do not grant this role membership, schema ownership, `SUPERUSER`, or `BYPASSRLS`. Worker startup fails closed when its URL is absent or names another role.

Optional timing settings are `ADEENA_VISUAL_WORKER_POLL_MS` (100–30000 ms) and `ADEENA_VISUAL_WORKER_LEASE_MS` (60000–300000 ms). The lease must exceed the configured provider timeout in deployment.

An expired lease is recoverable only when no provider request was recorded as started. If the worker stops after a provider request begins, the next worker records `provider-outcome-unknown` and preserves the possible charge instead of repeating the request. Completed associations and terminal jobs are always reused.
