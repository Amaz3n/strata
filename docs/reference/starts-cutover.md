# Starts cutover

How the Starts release path moves to production. It is one short window, not a feature flag: the database fences and the two generations of code cannot overlap in either order, so the unit is an ordered sequence run by a person. Everything below that touches production is the human's. Nothing in this repository applies a migration, edits the Vercel cron or reaches a production database.

## What the cutover is

- **One copy path.** The transactional drawing copy (`reserve_plan_drawing_copy` -> storage `CopyObject` with `If-Match` -> `publish_plan_drawing_copy`) is the only path. The legacy non-atomic copy and the `plan_drawing_copy_transactions` flag are deleted; there is nothing to enable per org.
- **Server-owned state.** The whole instantiation ledger (`projects.metadata->plan_instantiation`: steps, produced, seq and the drawing-copy manifest; the interactive instantiation writes it with the service client after its permission check), the eight drawing job types and every claim/lease column are writable only by service-role and definer paths (`20261014140000_starts_cutover_guards.sql`). The drawings "Retry processing" and "prioritize" actions write through the service client after their permission check.
- **Schema-readiness guard.** `runStartsPipeline` probes `claim_starts_jobs` and `starts_cutover_ready` (`lib/release/schema-requirements.ts`). On a database missing the first, or where the second is absent or answers false, it returns `{ notCutOver: true }` without claiming, draining or sweeping anything, so code deployed ahead of the schema does no work. The route answers 503 for it, so `job_runs` records a failed run: an inert worker is never a clean run. `starts_cutover_ready()` (last rewritten in 20261014195000) is true only when an object from each EP07 migration exists, whatever order they were applied in; when a later EP07 migration is added, add its object to that function.
- **Releases already running finish.** The database refuses to queue or publish a release with an incomplete gate (`assert_start_gates_complete`). Packages that are releasing or parked in attention when 20261014194000 applies are stamped `gate_rules_legacy` and publish on the gate states they started with; the stamp drops when the package leaves releasing/attention, so a cancelled and re-queued release meets today's rules.
- **One job per claim.** The worker claims one job at a time; a second job no longer sits behind the first one's lease.
- **Isolated sweep.** Each abandoned drawing copy is cleared on its own; a storage error on one is reported in the run (`copyCleanupFailed`, HTTP 207) and never blocks the rest. The sweep claims oldest first, only reservations a day old whose home has no package releasing or parked in attention and no file naming the path, and only a path the home's own reservation could have built.
- **Published copies supersede.** A published copy belongs to the release that made it: reserving for another actor, plan version or source file replaces it and keeps the receipt in the audit trail.

## Pending set

The deployable unit is the whole pending migration set, not the starts files: the worker imports lot fit, plan-pin review, margin and product baselines and permits. Apply them in filename order, one file at a time, never `db push` and never `--include-all` against production (the ledger head is later than most pending files, so either would try to replay migrations that are already live). Refresh the ledger first and list what is pending:

```
pnpm db:pending --ledger <ledger-export-file>
```

## Window

Rehearsed on the acceptance stack by CUT-01 (legacy drain, lease honoured, activation, rollback, readiness guard) and the storage subcases of LOT-01. Times are targets to confirm in the rehearsal.

1. **T-7 days.** CUT-01, LOT-01 (with `--storage-env`) and RACE-02 pass at the release commit on a fresh stack. Export the production ledger read-only and review `pnpm db:pending`.
2. **T-0, pause.** Pause the starts cron (remove `/api/jobs/starts-pipeline` from the schedule, or rotate the cron secret so the route answers 401) and wait six minutes: the previous worker's longest run is `maxDuration` 300 and a legacy claim goes stale after five. Take a restore point.
3. **Migrate.** Run the ledger repair once, confirm `pnpm db:ledger:check` shows only the intended pending set, then apply the set file by file, checking after each that its ledger row exists.
4. **Deploy** the matching code. Keep the previous deployment for rollback.
5. **Verify.** `psql -f scripts/starts-cutover/verify.sql`: marker and claim protocol present, fences enabled, no failed starts jobs. Resume the cron and watch three clean `starts-pipeline` runs in `job_runs` (a run that says `notCutOver` is failed, not clean). Run one release in the QA org.
6. **Legacy drain.** Any starts job the previous worker still held is requeued by `drainLegacyProcessingJobs` three minutes after its last touch and claimed again under a token; a release lease held by the previous worker is honoured until it is five minutes stale.

## Rollback

Safe until the first production release under the new path. `scripts/starts-cutover/rollback.sql` (`-v cutover_confirm=1`) disables the starts and drawing fences and browser-write guards, requeues tokened jobs as tokenless (the shape the previous worker drains), and clears release leases on packages still releasing. Then redeploy the previous code and resume the cron. Functions, columns and data stay; nothing is dropped. `reactivate.sql` turns the same triggers back on.

**What stays on.** Rollback relaxes the fences, not the product rules EP07 added, which live in the database: a house needs a superintendent before it releases (`queue_start_release`), superintendent and release-slot writes are locked to the new assignment path, throughput targets and financing evidence apply, a release cannot queue or publish with an incomplete gate, and a lot cannot be re-pinned or detached under a release. The previous code does not know to assign a superintendent, so after a rollback a coordinator assigns one on the new Starts desk (or by SQL) before a house releases. CUT-01 proves a release queues under today's rules after a rollback and that the previous worker's claim and ledger writes work; it does not run the previous code. The purchase-agreement, closing, permit, selection and sales fences of the other workstreams also stay on. After the first production release, fix forward.

## What only the human does in production

- Export the production ledger and refresh `pnpm db:pending`.
- Approve and apply every migration, run the ledger repair, and confirm each ledger row.
- Pause and resume the starts cron, redeploy, and keep the previous deployment.
- Take the restore point and restore from it if the window fails.
- Run `rollback.sql`, `reactivate.sql` and `verify.sql`.
- Keep the acceptance R2 env file out of the repository and give its path to the storage runs.
- Read `job_runs` and the Supabase advisors after the window.

## Retirement

After two weeks of clean `starts-pipeline` runs on production:

- delete `drainLegacyProcessingJobs` and `LEGACY_STALE_PROCESSING_MINUTES` from `lib/services/starts-pipeline.ts`;
- add a gated migration (`supabase/pending-migrations/`) that makes `claim_jobs` raise when asked for a starts or drawing job type. `claim_jobs` itself stays: it is the generic outbox claimer for every other job type;
- delete this document.
