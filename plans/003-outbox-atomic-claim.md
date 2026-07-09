# Plan 003: Make the generic outbox queue claim atomically, recover stuck jobs, and process oldest-first

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 7e98e5de..HEAD -- app/api/jobs/process-outbox/route.ts app/api/qbo/process-outbox/route.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/001-verification-baseline.md (verification commands)
- **Category**: bug (correctness / job queue)
- **Planned at**: commit `7e98e5de`, 2026-07-07 (working tree carried
  uncommitted changes; excerpts reflect the working tree)

## Why this matters

The generic outbox processor (`app/api/jobs/process-outbox/route.ts`) delivers
notification emails, push notifications, bid-invite emails, e-sign side
effects, search indexing, and inbound-bill processing. It has three defects
the QBO outbox processor next door already solved:

1. **Non-atomic claim**: it SELECTs `pending` rows, then UPDATEs them to
   `processing` **without** re-checking status. Two overlapping invocations
   (cron overlap, a manual trigger, a retry after the function times out) both
   select the same batch and both send — duplicate emails/pushes to customers.
2. **No stuck-job recovery**: if a run crashes mid-batch, its rows stay in
   `processing` forever. Nothing resets them; those notifications are silently
   never delivered.
3. **Newest-first ordering**: `order("created_at", { ascending: false })`
   means under sustained backlog (> BATCH_SIZE pending), the oldest jobs
   starve indefinitely.

The correct pattern exists in-repo and must be copied, not reinvented.

## Current state

- **The broken claim** — `app/api/jobs/process-outbox/route.ts:459-477`
  (inside `processOutboxQueue`):

```ts
const { data: jobs, error } = await supabase
  .from("outbox")
  .select("*")
  .in("job_type", ["deliver_notification", "deliver_push", "send_daily_log_mention_email", "send_esign_executed_email", "send_bid_email", "process_esign_execution_side_effects", "refresh_drawing_sheets_list", "index_file", "generate_file_preview", "reindex_search", "remove_search_index", "process_inbound_bill_email"])
  .eq("status", "pending")
  .lte("run_at", now)
  .order("created_at", { ascending: false })
  .limit(BATCH_SIZE)
...
const jobIds = jobs.map((j: any) => j.id)
await supabase.from("outbox").update({ status: "processing" }).in("id", jobIds)
```

  After the per-job loop, jobs are individually marked `completed`, or on error
  reset to `pending` with exponential backoff (`route.ts:525-575`) — the retry
  handling itself is fine and must be preserved. Below the generic loop the
  same route also drains drawings-pipeline job types as a safety net — do not
  break that section.

- **The exemplar** — `app/api/qbo/process-outbox/route.ts:57-112` does all
  three things correctly and its shape should be mirrored:

```ts
// 1) Stale-processing recovery
const staleCutoff = new Date(Date.now() - PROCESSING_TIMEOUT_MINUTES * 60 * 1000).toISOString()
const { data: recoveredRows } = await supabase
  .from("outbox")
  .update({ status: "pending", run_at: new Date().toISOString(), last_error: "Recovered stale processing job" })
  .in("job_type", QBO_JOB_TYPES)
  .eq("status", "processing")
  .lt("updated_at", staleCutoff)
  .select("id")

// 2) Atomic claim via RPC, with guarded fallback
const { data: claimedJobs, error } = await supabase.rpc("claim_jobs", {
  job_types: QBO_JOB_TYPES,
  limit_value: BATCH_SIZE,
})
// fallback when the RPC is absent:
//   select pending (ascending: true) → update to processing
//   .in("id", jobIds).eq("status", "pending")   ← the guard
```

  Note the `claim_jobs` Postgres RPC takes `job_types` + `limit_value`
  parameters, so it is generic — the generic queue can call it with its own
  job-type list. The QBO route also tolerates the RPC being missing
  (`error.message` mentions "claim_jobs") and falls back to a guarded
  update — replicate that tolerance.

- **Enqueue-side dedupe** (`lib/services/outbox.ts:26-56`) is a check-then-act
  SELECT-then-INSERT with no unique constraint. This is a real but smaller
  hole; fixing it needs a schema migration and is **explicitly out of scope**
  here (see Maintenance notes).

- Conventions: this route already returns `{ processed, failed, failures }`
  JSON; keep the response shape backward compatible (additive fields only).
  `pnpm lint` is type-aware and must stay clean.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Typecheck | `pnpm typecheck` | exit 0 |
| Lint | `pnpm lint` | exit 0 |
| Tests | `pnpm test` | all pass |

There is no local queue harness; verification is by code review against the
exemplar plus the greps in Done criteria. Do NOT invent a live test against
the database — local env points at PRODUCTION Supabase.

## Scope

**In scope** (the only file you should modify):
- `app/api/jobs/process-outbox/route.ts`

**Out of scope** (do NOT touch):
- `app/api/qbo/process-outbox/route.ts` — the exemplar; it already works.
- `lib/services/outbox.ts` — the enqueue dedupe fix needs a migration; not here.
- `supabase/migrations/` — no schema changes in this plan. If you conclude the
  fix requires one, that's a STOP condition.
- The drawings-pipeline drain section at the bottom of the route, and every
  job handler function (`deliverNotificationJob`, etc.) — only the
  claim/ordering/recovery mechanics change.
- `vercel.json` cron config.

## Git workflow

- Branch: `advisor/003-outbox-atomic-claim`
- Commit style: short imperative subject matching `git log`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Extract the generic job-type list to a constant

In `app/api/jobs/process-outbox/route.ts`, lift the inline job-type array from
the `.in("job_type", [...])` call into a module-level
`const GENERIC_JOB_TYPES = [...]` (same strings, unchanged). This mirrors
`QBO_JOB_TYPES` in the exemplar and is needed twice below.

**Verify**: `pnpm typecheck` → exit 0; `git diff` shows the array moved, not edited.

### Step 2: Add stale-`processing` recovery

At the top of `processOutboxQueue` (after the auth check and client creation),
add the recovery sweep, copied from the exemplar shape: reset rows with
`status = "processing"`, `job_type in GENERIC_JOB_TYPES`, and `updated_at`
older than a `PROCESSING_TIMEOUT_MINUTES` cutoff back to `pending` with
`last_error: "Recovered stale processing job"`. Define
`PROCESSING_TIMEOUT_MINUTES = 15` (the route's `maxDuration`/typical run is
minutes; 15 is what the QBO route uses — check its constant and match it).
Include a `recoveredStale` count in the JSON response (additive field).

Precondition check: confirm the `outbox` table maintains `updated_at` on
UPDATE (the QBO route already relies on this exact filter, so it does — if you
find otherwise, STOP).

**Verify**: `pnpm typecheck && pnpm lint` → exit 0.

### Step 3: Replace the unguarded claim with the atomic pattern

Replace the SELECT + unguarded UPDATE block (`route.ts:459-477`) with the
exemplar's two-tier claim:

1. Try `supabase.rpc("claim_jobs", { job_types: GENERIC_JOB_TYPES, limit_value: BATCH_SIZE })`.
2. If the RPC errors with a message mentioning `claim_jobs` (function absent),
   fall back to: SELECT pending due jobs **ordered `created_at` ascending**,
   then `update({ status: "processing" }).in("id", jobIds).eq("status", "pending")`
   — the `.eq("status", "pending")` guard is the point of this plan; do not
   omit it.

Check what columns the downstream job handlers read from each `job` object
(the current code selects `*`; the RPC returns `id, org_id, job_type, payload,
retry_count, run_at` per the exemplar's `ClaimedJob` type). If any handler
reads a column the RPC doesn't return, keep using the fallback SELECT's column
list widened accordingly — or STOP if the RPC's return shape can't satisfy the
handlers (schema change territory).

Note the fallback claim is guarded but not fully atomic (two clients can still
select the same rows; only one's update wins — but both then iterate the same
`jobs` array). Mitigate exactly as the exemplar does — this matches accepted
in-repo behavior; do not engineer beyond it.

**Verify**: `pnpm typecheck && pnpm lint` → exit 0, and
`grep -n 'ascending: false' app/api/jobs/process-outbox/route.ts` returns no
match inside the generic claim block.

### Step 4: Confirm retry/backoff behavior is untouched

Diff-review your change: the per-job try/catch, `MAX_RETRIES`, exponential
`run_at` backoff, the `SHEET_VERSION_NOT_FOUND` skip branch, and the
drawings-pipeline drain below must be byte-identical to before.

**Verify**: `git diff app/api/jobs/process-outbox/route.ts` touches only the
claim block, the new recovery block, the constant extraction, and the response
JSON additive field.

## Test plan

No existing test covers this route, and a behavioral test would need a
database. Add a source-level invariant to the suite that already does this
style of check (`tests/qbo-import-reliability.test.js` uses `readFileSync`
assertions): add a test in `tests/financials-regression.test.js` OR a new
`tests/outbox-claim.test.js` (node --test) asserting the route source
contains `.eq("status", "pending")` on the claim update and
`Recovered stale processing job`. Label the test name as an architectural
invariant (e.g. "outbox claim is guarded and recovers stale jobs"). This is
the one place source-text assertions are appropriate (per the repo's existing
pattern); keep it to these two invariants.

**Verify**: `pnpm test` → all pass including the new invariant test.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm typecheck`, `pnpm lint` exit 0
- [ ] `pnpm test` passes including the new invariant test
- [ ] The claim update includes `.eq("status", "pending")`
- [ ] A stale-recovery block exists for `GENERIC_JOB_TYPES`
- [ ] Generic claim ordering is `created_at` ascending
- [ ] `git status` shows only `app/api/jobs/process-outbox/route.ts` and the
      test file modified
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The `claim_jobs` RPC signature in the exemplar doesn't match what you find
  (e.g. it hard-codes QBO job types server-side) — check
  `supabase/migrations/` for its definition; if it is QBO-specific, use only
  the guarded-fallback path and say so in your report.
- A job handler requires columns the claim can't provide without schema
  changes.
- `outbox.updated_at` turns out not to update on status transitions.
- You find yourself wanting to edit `lib/services/outbox.ts` or write a
  migration — both are out of scope by design.

## Maintenance notes

- **Deferred follow-up (deliberate)**: `enqueueOutboxJob`'s
  `dedupeByPayloadKeys` is check-then-act with no DB constraint
  (`lib/services/outbox.ts:26-56`). The durable fix is a computed dedupe-key
  column with a partial unique index over pending/processing rows and
  `onConflict: ignore` on insert — that's a schema migration requiring
  operator approval (production database). Plan it separately.
- If a new job type is added to this route, it must be added to
  `GENERIC_JOB_TYPES` (single source now) — reviewers should check that.
- If the function's `maxDuration` is raised, revisit
  `PROCESSING_TIMEOUT_MINUTES` (must exceed the longest legitimate run).
