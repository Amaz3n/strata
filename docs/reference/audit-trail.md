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
`x-correlation-id` request header (`public.request_correlation_id()`); the
Supabase clients do not send that header yet, so those rows are null until they
do. Idempotent event receipts also take the database default, because a replay
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
cannot also cost the mutation its event, delivery or sync. A service that calls
another (a pay application voiding its invoice) stops at that point; the change
and the queued row both stand.

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
| `payment_run.preparer_cannot_approve` | the preparer deciding their own run | the org's sole-approval policy allows the requester |
| `budget_transfer.requester_cannot_approve` | the requester approving their transfer | none (also enforced in `post_budget_transfer`) |
| `variance_order.requester_cannot_approve` | the requester approving their variance order | none |

Release is separate again: the payment approver and releaser rules live in
`lib/services/vendor-bills.ts` and `lib/services/payment-runs.ts`.
