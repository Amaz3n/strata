# Production activation manifest

The ordered window that takes the Arc Production release to production: which
migrations go in and in what order, what each one locks, which flags change, how
the workers drain, what to watch, and how to roll back. It composes the existing
runbooks rather than repeating them:

- `books-operations.md` — Deploying database changes, Rebaselining
- `arc-operations.md` — Deploy rollback, jobs, alerts
- `reference/starts-cutover.md` — the Starts window, which this manifest contains

**Only the owner approves the list and only the owner runs the window.**
Nothing in this repository applies a migration, edits the Vercel cron or
reaches the production database. The acceptance stack is where every step below
is rehearsed (see Rehearsal).

## 1. The migration set

### How the list is produced

The authoritative ordered list is produced at the window, not copied into this
document. A hand-kept list goes stale the day another migration lands.

```bash
pnpm db:pending --ledger ledger.txt   # read-only export of supabase_migrations.schema_migrations
```

It lists every file in `supabase/migrations/` that production's ledger does not
hold, in version order. It never lists `supabase/pending-migrations/`: those
destructive cutovers stay held behind their own release gates, and a blanket
`supabase db push` is forbidden because it could sweep them in. At the last
estimate (EP14-08) production lacked about 191 repository migrations. They span
Books (B-series), EP01–EP06 and the production workstreams below. The list is
applied in that order, after the ledger repair (step 4 of the window).

### What the production workstreams add

All are in `supabase/migrations/`; versions are prefixes of the filenames.

| Workstream | Versions | Files | Contents |
|---|---|---|---|
| EP07 Starts and trades | `20261014100000` … `20261014197000` | 18 | Capacity and throughput, trade notices and responses, release resume and fences, starts cutover guards and markers, review fixes |
| EP08 Purchasing | `20261015100000` … `20261015183000` | 19 | Bid and price-book fences, PO generation reconcile, purchasing controls, PO issue acknowledgments, receipts and shortages, PO lock, three review rounds |
| EP09 Field | `20261016100000` … `20261017110000` | 4 | Inspection corrective-work link, punch write guard, superintendent reads of scope and options |
| EP10 Money | `20261017100000`, `20261017120000` | 2 | Land inventory corrections, placeholder home contracts repaired |
| EP11 Warranty | `20261018100000` … `20261018150000` | 7 | Installed-home import, warranty Books recoveries, member write fence |
| EP12 Imports | `20261019100000` … `20261019210000` | 4 | Resumable Open-WIP cutover, imported agreement evidence |
| EP13 Scale and operations | `20261020100000` … `20261020214000` | 11 | Sale cancellation holds the start, fair job claims, running job runs, Open-WIP cancellation, outbox member job types, sales deal anchors |
| EP14 Acceptance | `20261021100000` … `20261021210000` | 5 | Inventory relief counts and classifies reversals (SPEC-01), production member write fences and their review narrowing, with the commitment-line fence and org-level commitment reads (ROLE-01), `applied_migration_versions()` for schema-gated flags |

Earlier production work (EP01–EP06, 20261003…20261013) is in the same list. Its
per-item notes are in `docs/enterprise-production/completion-report.md`.

### Lock and index risk

All of these are additive: new tables, columns with defaults or nullable,
functions, triggers, RESTRICTIVE policies. None rewrites a table. The
statements that take a meaningful lock on a table customers write are:

| Migration | Statement | Lock | Risk at first-builder size |
|---|---|---|---|
| `20261014130000_release_resume_and_fences` | `create unique index` on `budgets`, `schedule_items`, `inspections` `(project_id, metadata->>'release_key')` | SHARE (blocks writes for the build) | Seconds. `schedule_items` is the largest; it also **fails** if two rows already share a release key. Run the check below before the window |
| `20261015140000_po_receipts_and_shortages` | `alter table commitment_lines add column needed_by`, plus an index | ACCESS EXCLUSIVE (metadata only), then SHARE | Brief |
| `20261015130000_po_issue_acknowledgments` | `alter table portal_access_tokens`, a new kind check on `trade_notice_deliveries` | ACCESS EXCLUSIVE, then a validating scan | Brief; small tables |
| `20261020200000_fair_job_claims` | `alter table outbox`, two partial indexes on pending rows | ACCESS EXCLUSIVE, then SHARE | Brief **if the outbox is drained first** (section 3) |
| `20261020201000_running_job_runs` | Replaces `job_runs_status_check`, adds `job_runs_running_has_deadline` | ACCESS EXCLUSIVE plus a validating scan of `job_runs` | Grows with history; seconds. Cron is paused during the window |
| `20261020100000_project_financial_settings_project_index` | `create index` | SHARE | Small table |
| `20261021200000_production_member_write_fences` | `create policy` on `communities`, `lots`, `commitments` | Brief ACCESS EXCLUSIVE per table, no scan | None |
| `20261021210000_member_write_fence_narrowing` | `create`/`drop policy` on `commitment_lines`, `communities`, `lots`, `commitments` | Brief ACCESS EXCLUSIVE per table, no scan | None |
| `20261018100000`, `20261019200000` | Replace importer checks on `import_batches` and `import_mapping_profiles` | Validating scan | Small tables |

No index is built `concurrently` because the migrations run in a transaction.
Set `lock_timeout = '5s'` for the session that applies the list. A migration
that cannot get its lock then fails fast instead of queuing behind a long
transaction and stalling every request behind it. On failure, re-run that file;
each migration is one transaction.

Pre-window check: release keys must be unique. Read-only; it must return zero
rows.

```sql
select 'budgets' t, project_id, metadata->>'release_key' k, count(*) from budgets where metadata ? 'release_key' group by 1,2,3 having count(*) > 1
union all
select 'schedule_items', project_id, metadata->>'release_key', count(*) from schedule_items where metadata ? 'release_key' group by 1,2,3 having count(*) > 1
union all
select 'inspections', project_id, metadata->>'release_key', count(*) from inspections where metadata ? 'release_key' group by 1,2,3 having count(*) > 1;
```

## 2. Flags

Environment flags that switch a code path on. Each one changes only after its
migrations are in.

| Flag | Default | Production state after this release | Gate |
|---|---|---|---|
| `ARC_TRADE_DATABASE_WORKSPACE_ENABLED` | off | Owner's call, after the trade pilot | **Schema-gated** in `lib/schema-flags.ts`: requires `20261014110000_trade_notice_deliveries` and `20261015130000_po_issue_acknowledgments`. `schemaFlagEnabled()` reads the ledger through `applied_migration_versions()` and refuses with the missing migrations named, so turning it on early fails at the switch instead of halfway through a request |
| `FINTECH_PAYMENTS_EXECUTION_ENABLED`, `FINTECH_PAYMENTS_RECONCILIATION_ENABLED`, `FINTECH_PAYMENTS_MODE`, `FINTECH_PAYMENTS_LIVE_MODE_APPROVED` | off | Off; live payment execution is out of scope | Not part of this release |

Per-organization switches are data, not environment, and are set in the org's
settings after the window:

- product tier;
- Arc Trade (Company setup);
- the AI flag;
- the Books accounting mode (`shadow` until the CPA sign-off in
  `books-revenue-recognition.md`).

Starts has no flag; its cutover is the ordered window in
`reference/starts-cutover.md`.

To add a flag that needs schema, put it in `SCHEMA_FLAGS` with the migrations
it requires and read it only through `schemaFlagEnabled()`. Never read it
through `process.env` directly. `tests/schema-flags.test.js` covers the
contract.

## 3. Worker drain

Old code must not run against new schema mid-job, and new claim functions must
not race old workers.

1. **T-15 min.** Announce the window. No imports or Open-WIP cutovers may be
   started; a running one is cancelled from its batch page (it resumes from its
   receipts later).
2. **T-0, pause the writers.** Remove these from the schedule, or rotate
   `CRON_SECRET` so every route answers 401 (`isAuthorizedCronRequest` fails
   closed):

   | Route | Schedule | Max duration |
   |---|---|---|
   | `starts-pipeline` | every 5 min | 300 s |
   | `process-outbox` | every 10 min | 300 s |
   | `drawings-pipeline` | every minute | 800 s |
   | `books-projection` | every 10 min | 300 s |
   | `payment-release` | every 5 min | 300 s |
   | `purchasing-maintenance` | daily | 300 s |
   | `accounting/process-*` | 10–15 min | 120 s |

3. **Wait out the longest run.** That is 800 s for drawings, so about 14
   minutes. A legacy starts claim goes stale after five minutes, and outbox jobs
   left `processing` are reaped back to `pending` (`reap_stale_outbox_jobs`).
4. **Confirm the queue is quiet.** These read-only checks must all return 0:
   - `select count(*) from outbox where status = 'processing'`
   - `select count(*) from job_runs where status = 'running'`. Only valid once
     the `running` status exists; before the migration, check the newest run of
     each paused job has finished.
5. **Take a restore point** (Supabase PITR timestamp, written into the window
   log).

## 4. The window

1. **T-7 days: rehearsal passes** (section 6) at the release commit on a fresh
   acceptance stack bootstrapped from the production baseline. Export the
   production ledger read-only and review `pnpm db:pending` with the owner.
   **The owner approves the list.**
2. **Drain** (section 3).
3. **Migrate.**
   - Run `supabase/scripts/repair-migration-ledger.sql` once; it records applied
     migrations under their repository versions.
   - `pnpm db:ledger:check` must then show exactly the approved pending set.
   - Apply the set with the Supabase CLI, `lock_timeout` set, so repository
     versions are preserved. Check after each file that its ledger row exists.
   - Never use MCP `apply_migration` for this: it stamps fresh versions.
4. **Deploy** the matching code. Keep the previous deployment for rollback.
5. **Verify.**
   - `pnpm db:ledger:check` is clean.
   - `psql -f scripts/starts-cutover/verify.sql` passes.
   - The release-key check above returns zero rows.
6. **Resume** the cron. Then, in the QA org only (never a customer org):
   - watch three clean `starts-pipeline` runs and one `process-outbox` run;
   - do one release and one PO approval.
7. **Turn on flags**, one at a time, only those the owner approved. A
   schema-gated flag that refuses names its missing migration; fix the
   migration, never the flag check.

## 5. Monitoring for 24 hours

| Where | Healthy | Act when |
|---|---|---|
| `/admin/ops`, Scheduled jobs | Every job healthy within one cadence | Any `timed_out` or `not started`: `arc-operations.md`, A job that stopped |
| `/admin/ops/pipelines` | No new failed production work | A failed start, import, signing, notification or warranty unit: its documented cure |
| `/admin/ops`, Stuck jobs and backlog by org | Empty; no org dominating the backlog | Stuck jobs past due: the queue reclaims them; repeated → batch size |
| Vercel runtime errors | No new error signatures since the deploy | A permission refusal shown as a 500: a fence missing a key (compare with ROLE-01's expected file) |
| `/books/close` per Books org | No new findings | Findings: `books-operations.md`, Month end |
| Supabase advisors (security, performance) | No new findings | New RLS or initplan findings: forward fix |

The member write fences (20261021200000, narrowed by 20261021210000) refuse in two
shapes. A fenced UPDATE or DELETE reaches no row, so the caller sees "no row visible
to change" (0 rows), not an error. A fenced INSERT fails the policy's WITH CHECK and
returns SQLSTATE 42501 ("new row violates row-level security policy"); a service that
surfaces that text raw shows it as an error, so a 42501 in the logs from a member's
direct write is a refusal, not an outage. A support report that someone cannot rename
a community, change a lot or change a PO or its lines is expected when their role
lacks the key: `community.write` for communities, `lot.write` or `community.write`
for lots, `commitment.write` on the org role or the home's project role for orders
and order lines. Check the role before treating it as a defect.

## 6. Rollback

`arc-operations.md`, Deploy rollback, governs. Summary for this release:

- **Never reverse a migration.** The release is additive, so the previous code
  runs on the new schema. Rolling the code back means Instant Rollback in
  Vercel.
- **Starts** has its own reviewed rollback and re-activation scripts
  (`reference/starts-cutover.md`, Rollback).
- **Fences:** if a fence refuses a legitimate writer, the forward fix adds that
  key to the policy in a new migration. Dropping the policy reopens the hole
  ROLE-01 found.
- **Restore** from the restore point only for data damage, never for a code
  defect, and only through the drill in `books-restore.md` (RESTORE-02 rehearses
  it).

After any rollback, every job must be running on schedule within one cadence
and nothing new may appear in Production work.

## 7. Rehearsal

Each check in this manifest is replayed on the isolated acceptance stack
(`~/.arc-acceptance`, never production) as golden scenarios. Migrations go on
the stack through `bin/apply.sh` in version order, exactly as the CLI applies
them in the window.

| Manifest check | Replayed by |
|---|---|
| The set applies in order onto the baseline and the replayed schema matches | SCHEMA-01, `pnpm db:ledger:check` (repository half), `scripts/books-acceptance/upgrade.cjs` |
| Fences refuse what they should and nothing they shouldn't | ROLE-01, SEC-01, SUPPLY-01, PO-01, VPO-01, LAND-01, SALE-01, PERMIT-01, MONEY-01, RELEASE-01, WARR-01 |
| Lifecycle still runs end to end after the fences | LOT-01, SEL-01, CUT-01, FLOW-01, PROD-01, LEAD-01, BID-01, TRADE-01, HOME-01, FIELD-01, CUTOVER-01 |
| Concurrency and recovery | RACE-02, RACE-03, OPS-01, RESTORE-02 |
| Jobs drain and resume, timed-out runs are reported | OPS-01 |
| Schema-gated flags refuse early activation | `tests/schema-flags.test.js` |

Last replay, with the two EP14 migrations applied (run tags f1, f1b, f1c on
2026-10-17):

- **Passed in full:**
  - fences: ROLE-01 5/5, SEC-01 9/9, SUPPLY-01 14/14, PO-01 16/16, VPO-01 9/9,
    LAND-01 9/9, SALE-01 19/19, PERMIT-01 5/5, MONEY-01 11/11, RELEASE-01
    11/11, WARR-01 12/12;
  - lifecycle: SEL-01 24/24, CUT-01 8/8, FLOW-01 10/10, PROD-01 9/9, LEAD-01
    7/7, TRADE-01 10/10, HOME-01 6/6;
  - concurrency and recovery: RACE-02 16/16, RACE-03 11/11, OPS-01 6/6.
- **Blocked or partial, none caused by the fences:**
  - FIELD-01 6/7, CUTOVER-01 17/18 and LOT-01 89/96: the missing subcases are
    blocked on storage only, because the stack has no storage key file.
  - BID-01 12/13: one subcase is not implemented.
- **Needed one fix:** SUPPLY-01 needed its expected refusal wording updated,
  because the fence now refuses forged order writes earlier and differently.

After the review round (`20261021210000` applied; run tags g2–g4):

- ROLE-01 5/5 (now with commitment-line cells, before/after stale-role writes and
  named refusal reasons), SEC-01 9/9, SUPPLY-01 14/14 (a field seat's draft line
  edit is now refused), PO-01 16/16, VPO-01 9/9, BID-01 12/13 (one not
  implemented).
- LOT-01 87/96 and 88/96 on two runs: the 7 storage-blocked subcases as before,
  plus one or two starts-job timing failures that differ between runs (a release
  job the app's own worker claimed first; a schedule not yet built); every one of
  them passed on the other run.

To replay:

```bash
~/.arc-acceptance/bin/run.sh <tag> ROLE-01 SEC-01 SUPPLY-01 RACE-02 RACE-03 OPS-01 LOT-01 CUTOVER-01
```
