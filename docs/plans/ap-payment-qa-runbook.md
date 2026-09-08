# AP payment QA and customer-enablement runbook

This runbook is a release gate, not a product roadmap. Complete it against an isolated test organization and Stripe test credentials. Never use production vendor bank data for QA.

## Required deployment state

- Complete the WS-A5 migration-ledger repair, confirm `supabase migration list` has
  no local-only or remote-only versions, and run `pnpm db:ledger:check` against the
  target Supabase project. Deployment is blocked unless the check passes with no
  duplicate names or version drift.
- Set `FINTECH_PAYMENTS_MODE=test`, `FINTECH_PAYMENTS_EXECUTION_ENABLED=true`, and `FINTECH_PAYMENTS_RECONCILIATION_ENABLED=true` only in the test deployment.
- Keep `FINTECH_PAYMENTS_LIVE_MODE_APPROVED=false`.
- Configure an organization feature flag for the isolated QA organization only.
- Configure a payment policy with finite per-payment, per-run, daily, in-flight, and return-loss limits; a 48+ business-hour payout hold; a 24+ hour new-vendor hold; an approved fee policy; designated approvers; a verified funding source; and a Stripe test connected vendor.
- Verify through Stripe test/sandbox platform settings that the platform payout
  schedule is `manual`; attach the setting evidence and the approved
  reserve/platform-balance sweep policy. Do not begin the matrix if automatic payouts
  could drain the hold-window balance.
- Connect the accounting target and enable bill/payment sync.
- Record the five launch attestations at `/admin/ops/payment-launch` with durable evidence references. Do not use placeholder approvals; the newest attestation for every gate must be approved.

## Test-mode payment matrix

For every case, save the run ID, disbursement ID, provider IDs, ledger transaction IDs, payment ID, bill state, accounting sync record, webhook event, and reconciliation result.

1. One bill, one ACH vendor, sole approval. Start from the vendor's first invitation
   click: confirm the link opens a usable claim/setup path rather than an auth error,
   and that an expired invitation renders the recovery/re-invite path rather than a
   generic 404. Record both assertions in `MATRIX-01`.
2. Multiple bills across projects, dual approval, scheduled release. Bulk-approve at
   least five bills submitted by at least three people and verify each submitter gets
   exactly one decision notification with no unrelated recipient. Separately leave an
   approved run stuck past its operational threshold, cancel it as an authorized admin
   who is not the preparer, and verify reservations release and the audit timeline
   records the reason. Record both assertions in `MATRIX-02`.
3. Partial bill payment with retainage held from the approved bill.
4. Bill with signed conditional waiver and valid through-date.
5. Bill requiring first- and second-tier waivers.
6. Vendor credit applied before determining the remaining cash requirement.
7. Same idempotency key and same payload; verify one run.
8. Same idempotency key and different payload; verify rejection.
9. Two simultaneous runs that together exceed the daily limit; verify only one execution reservation succeeds.
10. Client attempts to substitute another recipient UUID; verify application and database rejection.
11. Mixed-currency bills; verify run creation is rejected.
12. Duplicate vendor invoice submitted concurrently; verify one obligation.

## Failure and recovery injection

1. Drop the HTTP response after Stripe accepts a PaymentIntent. Retry execution and verify one Stripe intent, one disbursement, and one submitted ledger entry.
2. Fail the local disbursement update after provider acceptance. Also crash after a
   Stripe transfer is accepted but before Arc records the transfer claim. Retry and
   verify the provider idempotency key/adoption lookup repairs local state, with one
   transfer and one claim rather than a second movement.
3. Deliver every supported webhook twice and out of order. Verify monotonic state and one financial effect.
4. Return or cancel a debit before payout. Verify the cash/clearing/fee submission entry is reversed.
5. Return a paid ACH both (a) after Arc created the vendor transfer but before the
   connected payout and (b) after payout. In the post-transfer/pre-payout case verify
   the transfer is reversed or contained without paying the vendor twice; in the
   post-payout case verify the AP payment reversal, reopened bill balance,
   `ach_return_loss` entry, disabled funding source/mandate, return-loss limit
   evaluation, and exception case.
6. Fail ledger posting after settlement, then redeliver the webhook. Verify ledger completion.
7. Fail accounting enqueue after settlement, then redeliver. Verify the deduplicated accounting job appears.
8. Fail accounting push, correct the coding/connection, retry from the page, and verify the error clears.
9. Send an unmatched provider event. Verify it remains actionable and is not permanently discarded.
10. Reconcile more than 1,000 disbursements and verify the run is not falsely balanced by a page cap.
11. Deliver an ACH warning dispute and verify it opens an authorization inquiry without reversing money; then deliver the actual return and verify exactly one reversal.
12. Execute a multi-payee run in which one vendor transfer/payout fails and another
   succeeds. Verify the failed payee remains actionable without resubmitting the
   successful payee. Then mark a connected payout failed after its transfer completed;
   verify the bill is not reopened or paid twice, the payout remains vendor-associated,
   and an operations incident stays open until `payout.paid`.
13. Disable or automatically update the builder funding method at the provider. Verify the funding source and mandate fail closed and an operations alert is persisted.
14. Create provider-side payment, transfer, payout, and fee activity with no Arc row. Verify independent provider-led reconciliation emits `missing_internal` exceptions.
15. Force reconciliation to fail after starting. Verify `last_reconciliation_attempt_at` advances, `last_reconciled_at` does not, and the watchdog reports stale reconciliation.
16. Create more than 2,000 stale payment exceptions, recover them, and verify every row is closed with machine-generated evidence rather than falling outside a query cap.

## Construction controls

- Confirm retainage is derived from the approved bill and included in frozen approval evidence.
- Confirm waiver evidence includes bill link, type, amount, through-date, signed timestamp, signed file, and signature provenance.
- Confirm expired or short through-date waivers block release.
- Confirm missing sub-tier claimant waivers block when the project requires them.
- Confirm commitment, project, vendor relationship, cost coding, and payment allocation remain consistent.
- Confirm joint-payee ACH is unavailable unless every destination is explicitly verified and bound to the payment relationship.
- Confirm external check recording uses the same payment holds and produces accounting sync and audit evidence.
- Add an approved bill to a payment run, then attempt to change its amount, vendor, project, currency, retainage, coding, document, or approval status. Confirm the database rejects every mutation until the run is canceled.
- Suspend the builder/vendor payment relationship and the global vendor entity after run creation. Confirm submit, approval, retry, and execution all fail before provider submission.
- Confirm duplicate invoice numbers are canonicalized across case, whitespace, and punctuation, and that a duplicate-check database failure blocks submission rather than failing open.

## Accounting acceptance

- Bill approval produces a provider-neutral sync record and deduplicated outbound job.
- Provider errors and `needs_review` state appear on both payables pages with retry controls.
- Settlement produces one bill-payment sync even when the settlement webhook is retried.
- Settle three bills while the accounting token is expired, reconnect it, and confirm
  all three bill payments push automatically from the durable backlog with no manual
  per-bill retry.
- Project/community/division/org-default connection routing sends each transaction to the expected file.
- Imported/inbound-only records are never pushed back accidentally.
- Payment fees, retainage, credits, project/job, vendor, AP account, and expense coding match the provider record.
- Re-home/cutover protection blocks a transaction from silently moving between accounting files.

## Customer enablement gates

Live mode remains blocked until all are recorded in the append-only launch-gate ledger and the latest state of every required gate is `approved`:

- Provider program and settlement configuration approved; the Stripe platform payout schedule is verified as `manual`, and the reserve/platform-balance sweep policy is documented.
- Payments counsel and money-transmission posture approved.
- State-specific waiver forms and workflow approved for every enabled jurisdiction.
- Fraud, account-takeover, bank-change, return, reconciliation, incident, and vendor-support runbooks staffed and rehearsed.
- Daily reconciliation ownership, exception SLA, escalation path, and customer communication templates assigned.
- Limits, reserves/loss allocation, fees, disclosures, support hours, and customer contract accepted.
- QA evidence above reviewed with no unresolved severity-1 or severity-2 defects.
- A named approver authorizes the customer/org feature flag and `FINTECH_PAYMENTS_LIVE_MODE_APPROVED=true` change.

The enforced gate keys are `provider_program`, `payments_legal`, `risk_reserves`, `operations_runbook`, and `production_qa`. Only an environment superadmin or `platform_super_admin` can record or revoke them; ordinary support permissions are insufficient. Enabling an organization policy or executing/releasing money calls the same server-side readiness assertion, so UI or API bypasses do not bypass the gate.

## Rollback

Turn off the organization feature flag first, then `FINTECH_PAYMENTS_EXECUTION_ENABLED`. Do not delete or rewrite financial records. Continue webhook ingestion, ledger repair, reconciliation, accounting sync, return handling, and vendor support for every already-submitted disbursement.
