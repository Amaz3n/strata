# Audit trail and separation of duties

What evidence a material mutation leaves, and which approvals one person may
not make alone.

## Evidence rows

| Table | Written by | Holds |
|---|---|---|
| `audit_log` | `recordAudit()` (`lib/services/audit.ts`), and some SQL functions | actor, org, entity, before/after snapshots, source |
| `events` | `recordEvent()` (`lib/services/events.ts`) | what happened, for activity and notifications |
| `authorization_audit_log` | `authorize()` and the separation refusals | every denial (and sampled allows) with its reason |

**Correlation.** Every row carries the unit of work that wrote it:
`audit_log.correlation_id`, `events.correlation_id` and
`authorization_audit_log.request_id` (the older column, same meaning).
`correlationId()` (`lib/observability/correlation.ts`) resolves it: an explicit
`withCorrelation(id, fn)` scope first (the outbox runner wraps each job as
`outbox:<job id>`), then the request's `x-request-id` / `x-vercel-id`, then a
fresh uuid. Rows inserted inside a SQL function default to the
`x-correlation-id` request header (`public.request_correlation_id()`). Every
Supabase client built in `lib/supabase/server.ts` (the user's, the browserless
fallback, the service singleton and the worker clients) wraps its fetch in
`correlatedFetch()`, which stamps that header on writes and RPCs — every method
but `GET`/`HEAD`, since a read writes no row. A client built elsewhere, or a
read-only RPC sent as `GET`, leaves the column null; nothing is inferred.
Idempotent event receipts also take the database default, because a replay
must compare equal to the original.

## Critical audit rows

`recordAudit()` never throws for an ordinary row: it runs after the mutation
committed, so a failure is reported (log + Sentry, never the snapshots) and the
call returns. For a money mutation whose audit row is **not** written inside its
own transaction, the call passes `critical: true`:

1. A failed insert is retried once.
2. If it still fails, it is reported, the complete row (with its original
   correlation id and time) is queued as an `audit_retry` outbox job, and
   `AuditRecordPendingError` is thrown.
3. The action returns `{ success: false }` with "The change was saved, but its
   audit record is still pending…". The change is not reported as failed, and it
   is not reported as cleanly done while its evidence is missing.

Each critical call is the last write of its mutation, so a pending audit row
cannot also cost the mutation its event, delivery or sync.

**Nesting.** A service that calls another service's critical mutation and still
has writes of its own afterwards (a pay application issuing or voiding its
invoice, then recording the send or the void) runs the inner call through
`settleAuditPending()`. The pending error is returned rather than thrown, the
outer writes complete, and the outer service rethrows it last — so the caller is
neither stranded half-done (a retry would be refused because the invoice already
issued) nor told it cleanly succeeded. A compensating call on a failure path
(voiding the invoice a failed submit created) settles the pending error and
reports the original failure. A caller with nothing left to write lets the error
propagate.

**The queue is server-only.** `audit_retry` jobs are written with the service
role. The outbox table's member policy is broad, so
`guard_audit_retry_browser_writes` refuses any browser-role insert, update or
delete of an `audit_retry` row (or turning another job into one) — otherwise a
member could queue a forged row for the worker to write as the service role, or
fail a genuine one. `writeDeferredAudit()` also accepts only the exact row shape
`recordAudit()` queues, for the job's own org, and never one dated in the future.

| Mutation | Where | Evidence |
|---|---|---|
| Payment run decision | `decidePaymentRun` | `payment_run_approvals` row in `decide_payment_run_atomic` + critical audit |
| Budget transfer approval | `approveBudgetTransfer` | revision posted by `post_budget_transfer` + critical audit |
| Commitment CO / variance order approval | `approveCommitmentChangeOrder` | critical audit |
| Client change order approval | `approveChangeOrder` | critical audit (portal and envelope approvals are best-effort) |
| Invoice issue | `issueInvoiceWithContext` | `issued_snapshot` on the invoice + critical audit |
| Invoice void | `voidInvoice` | `void_invoice_atomic` + critical audit |
| Commitment issue (approval) | `updateCommitment` when status becomes `approved` | critical audit |
| Commitment execution | `executeCommitment`, envelope execution | critical audit |
| Journal post by a person | `postBooksJournalEntry` | the journal entry + critical audit; job postings are receipted by fact and posting key |
| Journal reversal by a person | `reverseBooksJournalEntry` | the reversal entry + critical audit |
| Deposit batch | `createDepositBatch` | `create_books_deposit_batch_atomic` + critical audit |
| Payables approvals, payment reversals, daily logs, catalog publication, starts, warranty completion | SQL functions | audit row written in the same transaction — already atomic |

## Separation of duties

The person who starts a money movement does not approve it. Rules are pure in
`lib/financials/separation-of-duties.ts`; enforcement and evidence are in
`lib/services/separation-of-duties.ts`. Every refusal writes a `deny` row to
`authorization_audit_log` with `reason_code = 'deny_separation_of_duties'` and
`context.rule`, then throws — a rejected bypass leaves evidence even though
nothing changed.

| Rule (`context.rule`) | Refused | Exception |
|---|---|---|
| `bill.enterer_cannot_approve` | the person who keyed in a bill, or uploaded its invoice, approving it | nobody else who holds `bill.approve` **and can reach the bill's project** (division and assigned-project scope, overrides) — a one-person AP department |
| `commitment.creator_cannot_approve` | the person who created a commitment (recorded in `metadata.created_by_user_id`) approving it, by update, create-as-approved, or recording its execution | nobody else who holds `commitment.approve` and can reach the project; commitments with no recorded creator (generated, imported) are never refused |
| `payment_run.preparer_cannot_approve` | the preparer deciding their own run | the org's sole-approval policy allows the requester |
| `budget_transfer.requester_cannot_approve` | the requester approving their transfer | none (also enforced in `post_budget_transfer`) |
| `variance_order.requester_cannot_approve` | the requester approving their variance order | none |

Release is separate again: the payment approver and releaser rules live in
`lib/services/vendor-bills.ts` and `lib/services/payment-runs.ts`.
