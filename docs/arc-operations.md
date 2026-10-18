# Arc: operations runbook

How to run Arc as a whole for a production builder: what runs by itself, how a
stopped or failed piece of work is noticed, where the operator finds it and the
safe way back, and what the platform costs and can carry at first-builder size.
Arc Books has its own runbook (`books-operations.md`) for the ledger, close and
recovery; this one covers everything around it and links there rather than
repeating it. Every procedure here is exercised by OPS-01 on the isolated
acceptance stack (`scripts/books-acceptance/scenarios/ops-01.cjs`).

The **operator** is the Arc platform operator (today: Agustin), signed in with a
platform role (`platform.support.read` to look, `platform.support.write` to act).
There is no on-call rotation yet: the operator is on call.

## Where the operator looks

| Screen | What it answers |
|---|---|
| `/admin/ops` | Scheduled jobs (healthy, running, failing, timed out, not started), the outbox queue, backlog by organization, stuck jobs, QuickBooks connections, payment reconciliation, and every open operations alert with its organization |
| `/admin/ops/pipelines` | **Production work** that failed: starts, imports, signing, notifications and warranty, each unit with its error, its correlation id when it has one, where it lives, its documented cure, and the safe recovery button where one exists |
| `/admin/ops/drawings` | Drawings pipeline dead letters |
| `/admin/customers/<org>/onboarding/import/<importer>` | A customer's import batches, including a running Open-WIP cutover's progress and its Cancel / Commit again |

## Scheduled jobs and their runs

Every scheduled job is in `CRON_JOBS` (`lib/services/job-runs.ts`), which mirrors
`vercel.json` (schedule and `maxDurationSeconds`), and every one runs through
`withCronRun`, which writes one `job_runs` row per run:

1. **Before the work starts**, a `running` row with a `deadline_at` of start +
   the function's maximum duration + 120 s grace, and the run's correlation id
   (`cron:<job>:<uuid>`; every audit row and event the run writes carries it).
2. **When the work ends**, the same row becomes `success` or `failed` with the
   HTTP status, duration and error (a 207 partial run is `failed` with its
   counts).
3. **If the runtime kills it**, nothing reports. The next run of that job, or
   the hourly watchdog, turns every `running` row past its deadline into
   `timed_out` (`reconcileOverdueJobRuns`).

The Ops page and the watchdog read the same facts through one pure function
(`lib/ops/cron-health.ts`), so they cannot disagree:

| State | Means | Alert |
|---|---|---|
| running | started, inside its deadline, and the runs before it are fine | none |
| timed out | started, and its runtime died before reporting (accepted, never completed): the run in flight is past its deadline, the newest finished run timed out, or (once its work is not being done) any run timed out inside the window | always (`cron_timed_out`) |
| not started | the scheduler has not started it inside its window (no data = never) | once its work is not being done (`cron_not_started`) |
| failing | it runs and reports failure | once its work is not being done (`cron_failing`); failed units alert by themselves |
| healthy | succeeded inside its window | none |

A run in flight speaks only for itself: what the job has been doing is read
from the runs that finished. Jobs whose deadline is longer than their cadence
(the drawings pipeline runs every minute with a 15-minute deadline) nearly
always have one in flight, and it must not hide that every run before it died.
The watchdog's window is three times the cadence; the Ops page's is twice the
cadence plus five minutes.

### Alerts and who hears them

The watchdog (`ops-watchdog`, hourly at :20) raises incidents through
`sync_payment_operations_incidents` (one table, `payment_operations_incidents`,
generic `finding_code`); an incident opens once, re-notifies on its schedule and
resolves when the finding is gone. Each becomes an event and an in-app
notification, and an email where the type is in `EMAIL_NOTIFICATION_TYPES`.

| Finding | Routed to |
|---|---|
| A payment job timed out, not started or failing | Every organization with the payment rail on (`payment_operations_alert`) |
| Accounting sync not truthful | That organization (`accounting_sync_needs_review`) |
| A starts or warranty job **timed out or not started** | Only organizations with work waiting on it (its backlog code in `operations_pipeline_findings()`): `operations_pipeline_alert` |
| Failed production units: a release in attention, a starts job or warranty enrollment that exhausted its retries (24 h), a builder-run import that failed (24 h, not cancelled) or stalled 30 min | That organization (`operations_pipeline_alert`) |
| An Open-WIP cutover that failed (24 h, not cancelled) or stalled | Platform operators only (a `pipeline_units_failed` finding): the cutover is Arc's onboarding work, so the builder is never told |

`operations_pipeline_alert` goes to members holding the pipeline's permission
(`start.release`, `import.manage`, `warranty.manage`) and to org admins, with a
link to the starts desk, warranty desk or import settings; the email category
is Starts ("Background work stopped"). The pipelines, their jobs, failure codes
and alert wording live in one table, `lib/ops/pipelines.ts`.

**No external paging is configured.** Alerts reach Arc's own notifications and
email only. Delivery to a pager (and whether to wake anyone at night) is the
owner's decision, below.

## Fairness and bulk controls

**Claims take turns by organization.** `claim_jobs` (the outbox) and
`claim_starts_jobs` claim round-robin across organizations with due work, and
remember the last organization served (`outbox_claim_rotation`, per claimed set
of job types), so one builder's import or notification burst cannot hold
another's release behind it. Within an organization, jobs still go by priority,
then age. OPS-01 measures it: with 40 jobs from one tenant queued ahead of 4
from each of two others, the small tenants are fully served by the second claim
of nine, where oldest-first would have served them after all 40. The Ops page's
**Backlog by organization** shows each organization's due, scheduled, running and
failed-in-24-h work and its oldest due job.

**Members cannot forge job state.** Through the data API a member may queue a
plain pending job and reorder or reschedule its own organization's pending work
(claims rotate across organizations, so that moves no one else's). Completing,
failing, requeueing, spending the retries of, deleting or claiming a job,
writing a job run, moving the rotation or reading another tenant's backlog is
refused (`worker_state_browser_write_guard`, which fires after the per-family
drawings, starts and notification guards, and service-only RPCs and tables).

**Bulk mutations are budgeted per organization per hour**
(`enforceMutationRateLimit`, `lib/services/auth-rate-limit.ts`, the same table
as the sign-in throttle). The budget is the organization's, so many members
together cannot starve other tenants; a refusal names the limit and the minutes
left, before anything is written. Like the sign-in throttle it fails open if the
counter cannot be written.

| Mutation | Budget per hour |
|---|---|
| Import file staged | 300 |
| Import committed | 120 |
| Start release batch (up to 50 houses each) | 60 |
| Books archive requested | 12 |
| Document export requested (a retry of the same export is free) | 30 |

## Runbooks

### Deploy rollback

Code and schema roll back differently.

1. **Code only** (no migration in the deploy): promote the previous production
   deployment in Vercel (Instant Rollback). Scheduled jobs follow the promoted
   deployment.
2. **Code with migrations**: never reverse a migration. Production applies
   migrations once (`books-operations.md`, Deploying database changes), and the
   running app is written for the schema it shipped with. Roll the code back only
   if the previous code runs on the new schema (additive changes: new columns,
   tables, functions); otherwise ship a forward fix. A destructive cutover is held
   in `supabase/pending-migrations/` behind a release gate precisely so this
   choice stays available until the gate.
3. Starts has its own reviewed rollback and re-activation scripts
   (`reference/starts-cutover.md`).
4. After either: `/admin/ops` shows every job running on schedule within one
   cadence, and nothing new in Production work.

### A job that stopped, or timed out

1. `/admin/ops`, Scheduled jobs. **Not started**: the scheduler is not calling
   it. Check the deployment's cron list in Vercel against `vercel.json`, and that
   the route is in `PUBLIC_API_ROUTES` (a 307 to sign-in never reaches the job).
   **Timed out**: it started and was killed at its maximum duration; read the
   Vercel function log for that run (its correlation id is on the row) and the
   work it left half-done, which every worker resumes: outbox jobs are reaped back
   to pending (`reap_stale_outbox_jobs`), starts and drawings jobs have leases
   that lapse, a cutover resumes from its receipts.
2. Run it once by hand with the cron secret (`GET` with
   `Authorization: Bearer $CRON_SECRET`; Vercel Cron sends GET).
3. A job that times out repeatedly is doing more than its duration allows:
   lower its batch size, never raise `maxDuration` without the capacity review
   below.

### Stuck or failed background jobs

`/admin/ops`: **Stuck jobs** groups jobs pending past due or processing without
progress; the queue reclaims them. **Outbox failed** lists jobs that exhausted
their three retries; Retry puts one back (keeping its retry count). For the
production families use **Production work**, whose Requeue resets the retry
budget and is audited (`platform_ops`).

### Missing files and previews

A file's record is the row; storage holds the object and the preview ladder.

- A preview that never generated: the file's `generate_file_preview` job is in
  the outbox (failed jobs on `/admin/ops`); retry it. Images that predate the
  responsive ladder are re-previewed by `POST /api/jobs/backfill-image-previews`
  (cron secret, `?batch=`), repeated until it enqueues 0.
- An original missing from storage cannot be regenerated: the row stays (photos
  and documents point at it), the viewer shows it unavailable, and the cure is
  to upload it again from the source (renders read the preview ladder, so a missing original shows only where the original itself is opened). Drawings have a storage reconciliation
  (`queue_drawing_storage_reconciliation`).
- Never delete a `files` row to "clean up": every photo, document and
  correspondence link depends on it.

### Integration backlog

- QuickBooks: `/admin/ops` lists each connection's last error and refresh
  failures; the accounting outbox (`/api/accounting/process-outbox`) and
  reconciliation are covered by `accounting-sync.md`. A connection that needs
  reauthorization is reconnected by the builder from `/settings/integrations`.
- Bank feeds, filing partner and storage keys: `books-operations.md`, Secrets.
- Email delivery: notification jobs that exhausted their retries are listed under
  Notifications in Production work; fix the provider, then Requeue.

### Starts pipeline

The starts worker (`starts-pipeline`, every 5 min, and triggered on release)
claims release and notice jobs with three-minute leases. A release that stops
partway parks its start package in **attention** and is listed in Production
work. The cure belongs to the builder's starts coordinator on the package:
**Retry release** requeues it from the step that failed; **Cancel release**
keeps what already landed on the house and returns the rest. The operator never
requeues starts jobs from Ops, because a job's claim and the package's state move
together in the release RPCs.

### Imports, and the Open-WIP cutover

Imports stage (dry run, writes nothing) and commit. Most commit in one step. The
**Open-WIP cutover** builds one home per house row, each in one transaction with
its receipt, and can run for many minutes:

- **Progress**: the operator's import page shows "N of M built" (receipts) and
  refreshes while it runs.
- **Interrupted** (crash, deploy, timeout): its claim lapses after two minutes and
  the outbox resumes it from its receipts; a home is never built twice. After five
  interruptions it is failed with its homes kept, and listed in Production work.
- **Cancel**: stops it at the next home, never inside one. The batch ends failed
  with `report.cancelled` (who, when, homes built of rows), keeps every home with
  its receipt, and is not alerted on (it was a decision, not a failure).
- **Commit again**: resumes any failed or cancelled cutover from its receipts,
  adopting the homes it already built.
- **Rollback**: a row the source files cannot build fails the batch and takes
  back what that attempt built, restoring each lot as it was; a home someone has
  already used is never deleted. A batch that committed records cannot be
  discarded.

### Warranty

Coverage enrollment (`warranty_enroll_coverage`) runs in the outbox when a home
closes or completes; one that exhausted its retries leaves the home without
coverage and is listed in Production work: Requeue enrolls it once (it is keyed
to the home and its effective date). The SLA sweep (hourly) and courtesy
inspections (daily) read open requests; if either stops running, organizations
with open requests are alerted.

## Capacity and cost at first-builder size

**Needs owner approval.** Sized for the first builder: 3 divisions, 30
communities, 500 active homes, 50 users, on one shared deployment and database
with the other tenants. These are review findings and proposals; nothing here
has been changed in production.

**Vercel.**

- 37 scheduled jobs. Vercel limits cron jobs per project by plan (40 on Pro at
  the time of writing; verify on the account). Three left is tight: the next
  scheduled job should share a route with an existing one rather than add a
  cron. *Decision: accept, or consolidate (for example the daily 12:00-13:50 UTC
  reminder jobs into one route).*
- About 3,600 cron invocations a day, most from `drawings-pipeline` (every
  minute, up to 800 s) and the five-minute jobs (`specs-pipeline`,
  `meeting-transcription`, `payment-release`, `starts-pipeline`). Most return
  quickly when idle; function cost is dominated by the drawings worker during
  plan uploads. *Decision: confirm the plan's included function duration covers a
  month with one full plan library upload per community.*
- `process-outbox` claims 50 jobs per run every 10 minutes: a baseline ceiling
  of about 300 jobs an hour (7,200 a day) beyond the work requests trigger
  inline. A 50-house release, a selection cutoff sweep or an all-companies notice
  is a few hundred jobs, so a burst drains within an hour and fair claiming keeps
  other tenants moving meanwhile. *Proposal: let a run keep claiming until a time
  budget (as the drawings worker does) before the second builder.*
- The watchdog runs hourly, so a timed-out or stopped job is noticed within
  about an hour plus its window. *Proposal: every 15 minutes if the owner wants
  faster detection; it would change `vercel.json` and `CRON_JOBS` together.*

**Supabase.**

- Connections: the app reaches Postgres through PostgREST and the Supabase
  pooler (HTTP), not direct connections, so 50 users do not hold 50 connections;
  the busiest periods are the 10-minute cron boundary, when several workers start
  together. *Decision: confirm the compute size's pooler limit with headroom for
  that boundary; watch `get_advisors` and the pooler's saturation after the first
  month.*
- Database size grows mainly with `outbox` (completed jobs), `events`,
  `audit_log` and `job_runs` (pruned at 60 days). *Proposal: a retention prune
  for completed outbox jobs older than 30 days; events and audit are records and
  are kept.*
- Storage grows with photos, plan sets and their preview ladders; originals are
  kept. *Decision: storage budget per builder per year, and whether HEIC
  originals are kept beside their previews.*
- Point-in-time recovery: the RPO below assumes it. *Decision: confirm PITR is on
  for the production project.*

## Service levels and incidents

**Proposed, not adopted.** These are engineering targets from the load and
restore work (`loadTargets` in `docs/enterprise-production/completion-checklist.json`), offered for the
owner's decision; Arc makes no customer commitment from them.

| Objective | Proposed target | Measured by |
|---|---|---|
| Availability | 99.95% monthly | Successful responses to signed-in pages and API routes |
| Desk read latency | p95 under 2,000 ms | Org desks (Home, Starts, Purchasing, Sales, Warranty) at first-builder size |
| Mutation latency | p95 under 1,500 ms | Server actions on workbenches |
| Background work | No scheduled job timed out or not started for more than one window; no failed production unit older than one business day | `/admin/ops`, Production work |
| Recovery point (RPO) | 15 minutes | Supabase point-in-time recovery |
| Recovery time (RTO) | 60 minutes | The restore drill (`books-restore.md`) |

**Incident procedure** (the operator is on call):

1. **Notice**: an operations alert (in-app and email), a builder's report, or
   `/admin/ops` during the daily look.
2. **Scope**: which organizations (the alert names them; Backlog by organization
   and Production work show who is affected) and which pipeline.
3. **Contain**: stop making it worse. Roll back code (above), pause the job by
   letting it fail rather than editing data, and never run destructive SQL against
   production.
4. **Recover** with the runbook for that pipeline above; each recovery is a
   service action that is audited, never a hand edit of rows.
5. **Tell** the affected builders what happened to their work and what, if
   anything, they need to redo.
6. **Learn**: a short note (what happened, how it was noticed, time to notice and
   to recover, the fix) and, where a check could have caught it, a golden
   scenario subcase.

**Pending owner decisions**: whether alerts page anyone (and through what
service), outside which hours, and which of the targets above become
commitments.
