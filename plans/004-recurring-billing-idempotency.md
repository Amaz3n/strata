# Plan 004: Stop recurring-invoice double-billing and surface swallowed late-fee failures

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 7e98e5de..HEAD -- lib/services/invoice-schedules.ts app/api/jobs/late-fees/route.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED (touches invoice generation for real customers)
- **Depends on**: plans/001-verification-baseline.md (verification commands)
- **Category**: bug (money correctness)
- **Planned at**: commit `7e98e5de`, 2026-07-07 (working tree carried
  uncommitted changes; excerpts reflect the working tree)

## Why this matters

Two cron-driven money paths have unsafe failure modes:

1. **Recurring invoices** (`runDueInvoiceSchedules`): the cron creates the
   invoice FIRST and advances the schedule's `next_run_on` SECOND, in a
   separate un-transacted write. If the advance fails (transient DB error,
   function timeout between the two writes), tomorrow's run sees the schedule
   still due and **bills the same period again** — a duplicate invoice,
   possibly auto-sent to a real client. Two overlapping runs produce the same
   result. The dangerous direction is double-billing; a skipped period is
   recoverable, a duplicate sent invoice is a customer-facing incident.
2. **Late fees** (`app/api/jobs/late-fees/route.ts`): the result of the
   `apply_invoice_late_fee_atomic` RPC is discarded except for incrementing a
   counter — `if (!applyError) applied += 1`. A failed application (RLS,
   constraint, transient error) is not logged, not retried, not reported:
   revenue silently not charged, with zero signal.

## Current state

- `lib/services/invoice-schedules.ts:277-335` — `runDueInvoiceSchedules`
  (cron entry point). Key excerpt:

```ts
const { data: due, error } = await serviceClient
  .from("invoice_schedules")
  .select(SCHEDULE_COLUMNS)
  .eq("active", true)
  .lte("next_run_on", todayStr)
  .order("org_id", { ascending: true })
...
// Sequential on purpose: per-org invoice numbers derive from the latest inserted row.
for (const row of due ?? []) {
  try {
    ...
    const invoice = await createInvoice({ input, context: { supabase: serviceClient, orgId: row.org_id, userId: row.created_by } })

    await serviceClient
      .from("invoice_schedules")
      .update({
        last_run_at: new Date().toISOString(),
        last_invoice_id: invoice.id,
        next_run_on: format(advanceRunDate(row, new Date(`${row.next_run_on}T00:00:00`)), "yyyy-MM-dd"),
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id)
```

  Note: `advanceRunDate(row, date)` computes the next occurrence from the
  schedule's frequency — read it before starting. The "Sequential on purpose"
  comment is a real constraint (invoice numbering); keep the loop sequential.

- `app/api/jobs/late-fees/route.ts:79-90` — the swallowed error:

```ts
const { error: applyError } = await supabase.rpc("apply_invoice_late_fee_atomic", {
  p_org_id: invoice.org_id,
  p_invoice_id: invoice.id,
  p_rule_id: rule.id,
  p_amount_cents: feeAmountCents,
  p_days_overdue: daysOverdue,
})

if (!applyError) applied += 1
...
return NextResponse.json({ applied })
```

  The route already handles GET (`export const GET = POST` at the bottom) —
  leave that. The count-then-apply gates above it (`max_applications`,
  `repeat_days`) are check-then-act in JS; hardening them belongs in the RPC
  (schema change) and is out of scope — see Maintenance.

- Conventions: services own logic; this cron uses the service-role client
  (`createServiceSupabaseClient`) because it spans orgs; events are recorded
  via `recordEvent` after success (keep that).

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Typecheck | `pnpm typecheck` | exit 0 |
| Lint | `pnpm lint` | exit 0 |
| Tests | `pnpm test` | all pass |

Do NOT test against the database — local env points at PRODUCTION Supabase.

## Scope

**In scope** (the only files you should modify):
- `lib/services/invoice-schedules.ts` (`runDueInvoiceSchedules` only)
- `app/api/jobs/late-fees/route.ts`
- One new test file (see Test plan)

**Out of scope** (do NOT touch):
- `createInvoice` in `lib/services/invoices.ts` — the invoice-creation
  internals are not the problem.
- The `apply_invoice_late_fee_atomic` RPC / any `supabase/migrations/` change.
- The invoice-schedule CRUD functions in the same file (create/delete/
  setActive) — only the cron runner changes.
- `vercel.json` cron schedule.

## Git workflow

- Branch: `advisor/004-recurring-billing-idempotency`
- Commit per step; short imperative subjects matching `git log`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Claim-then-create in `runDueInvoiceSchedules`

Restructure the loop body to advance the schedule BEFORE creating the invoice,
using a conditional update as the claim:

```ts
const originalNextRunOn = row.next_run_on
const nextRunOn = format(advanceRunDate(row, new Date(`${originalNextRunOn}T00:00:00`)), "yyyy-MM-dd")

// Claim: only proceed if we are the run that advanced the schedule.
const { data: claimed } = await serviceClient
  .from("invoice_schedules")
  .update({ next_run_on: nextRunOn, updated_at: new Date().toISOString() })
  .eq("id", row.id)
  .eq("next_run_on", originalNextRunOn)   // ← guard: someone else already ran this
  .eq("active", true)
  .select("id")

if (!claimed?.length) {
  results.push({ ...identifying fields..., status: "failed", error: "Schedule already claimed by a concurrent run" })
  continue
}

// Now create the invoice; on failure, revert the claim so the schedule
// isn't silently skipped (no invoice exists, so revert cannot double-bill).
try {
  const invoice = await createInvoice({ ... })
  await serviceClient.from("invoice_schedules")
    .update({ last_run_at: new Date().toISOString(), last_invoice_id: invoice.id, updated_at: new Date().toISOString() })
    .eq("id", row.id)
  ...recordEvent as today...
} catch (err) {
  await serviceClient.from("invoice_schedules")
    .update({ next_run_on: originalNextRunOn, updated_at: new Date().toISOString() })
    .eq("id", row.id)
    .eq("next_run_on", nextRunOn)   // only revert our own claim
  throw err  // let the existing per-row catch record the failure result
}
```

Adapt to the function's actual result-collection shape (`ScheduleRunResult`).
The invariant to preserve: **an invoice is only created after this run has
exclusively advanced the schedule, and the schedule is only reverted when no
invoice was created.** Move the invoice-number allocation
(`nextLocalInvoiceNumber`) to AFTER the successful claim so a skipped row
doesn't burn a number.

**Verify**: `pnpm typecheck && pnpm lint` → exit 0.

### Step 2: Surface late-fee application failures

In `app/api/jobs/late-fees/route.ts`:

- Collect failures: `const failures: Array<{ invoice_id: string; rule_id: string; amount_cents: number; error: string }> = []`
- On `applyError`, push the failure and `console.error("[late-fees] apply failed", { invoiceId: invoice.id, ruleId: rule.id, error: applyError.message })`.
- Return `NextResponse.json({ applied, failed: failures.length, failures })`.

Keep the response's `applied` field unchanged (additive only).

**Verify**: `pnpm typecheck && pnpm lint` → exit 0;
`grep -n "if (!applyError) applied += 1" app/api/jobs/late-fees/route.ts` → no match.

## Test plan

`runDueInvoiceSchedules`'s claim logic is testable only with a DB double, so
follow the repo's existing invariant-test pattern
(`tests/qbo-import-reliability.test.js` — `readFileSync` + regex over source):
create `tests/recurring-billing-invariants.test.js` with `node --test`,
asserting on `lib/services/invoice-schedules.ts` source:

1. The `invoice_schedules` claim update appears BEFORE the `createInvoice(`
   call in `runDueInvoiceSchedules` (match order of indices in the source).
2. The claim update includes `.eq("next_run_on"` (the guard).
3. A revert branch exists (`.eq("next_run_on", nextRunOn)` after a catch).

And on `app/api/jobs/late-fees/route.ts`:

4. The string `failures` appears in the JSON response and `applyError` is
   referenced beyond a truthiness check (e.g. `applyError.message`).

Label the tests as architectural invariants. Wire the file into the `test`
script from plan 001.

**Verify**: `pnpm test` → all pass, including 4 new assertions.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm typecheck`, `pnpm lint` exit 0
- [ ] `pnpm test` passes including `tests/recurring-billing-invariants.test.js`
- [ ] In `runDueInvoiceSchedules`, schedule advance precedes invoice creation
      and is guarded by `.eq("next_run_on", <original>)`
- [ ] Late-fee route logs and returns failures
- [ ] `git status` shows only the two in-scope source files + the new test
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `advanceRunDate` mutates `row` or depends on `last_run_at` in a way that
  breaks the claim-first ordering.
- `createInvoice` internally reads the schedule row or assumes `next_run_on`
  is still the billing period (search its source for `invoice_schedules`
  before starting — if it does, the claim-first design needs rework).
- The `ScheduleRunResult` shape is consumed somewhere that a new failure
  status string would break (grep callers of `runDueInvoiceSchedules`).
- You conclude a schema change (e.g. a `(schedule_id, period)` unique key on
  invoices) is the only correct fix — that's the stronger long-term design but
  requires a production migration; report instead of writing one.

## Maintenance notes

- The residual race window is now a single conditional UPDATE — safe under
  concurrent runs (one claims, the other skips). The stronger guarantee (a
  unique `(schedule_id, billing_period)` key on invoices) was deliberately
  deferred: it needs a production migration and operator sign-off.
- Late fees: the `max_applications` / `repeat_days` gates remain check-then-act
  in JS; if double-application is ever observed, move those guards inside the
  `apply_invoice_late_fee_atomic` RPC (migration).
- A `failures` array in the late-fee response is only useful if someone reads
  it — consider wiring cron responses into monitoring/Sentry later.
- Reviewers of future changes to `runDueInvoiceSchedules`: the claim-before-
  create ordering is load-bearing; a refactor that re-inverts it reintroduces
  double-billing.
