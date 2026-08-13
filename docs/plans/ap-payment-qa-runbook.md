# AP payment QA and customer-enablement runbook

This runbook is a release gate, not a product roadmap. Complete it against an isolated test organization and Stripe test credentials. Never use production vendor bank data for QA.

## Required deployment state

- Apply and verify every migration through `20260813011917_receivable_adjustments_privilege_lockdown.sql`. Verify the migration ledger contains no duplicate repository versions before deployment.
- Set `FINTECH_PAYMENTS_MODE=test`, `FINTECH_PAYMENTS_EXECUTION_ENABLED=true`, and `FINTECH_PAYMENTS_RECONCILIATION_ENABLED=true` only in the test deployment.
- Keep `FINTECH_PAYMENTS_LIVE_MODE_APPROVED=false`.
- Configure an organization feature flag for the isolated QA organization only.
- Configure a payment policy with finite per-payment, per-run, daily, in-flight, and return-loss limits; a 48+ business-hour payout hold; a 24+ hour new-vendor hold; an approved fee policy; designated approvers; a verified funding source; and a Stripe test connected vendor.
- Connect the accounting target and enable bill/payment sync.
- Record the five launch attestations at `/admin/ops/payment-launch` with durable evidence references. Do not use placeholder approvals; the newest attestation for every gate must be approved.

## Test-mode payment matrix

For every case, save the run ID, disbursement ID, provider IDs, ledger transaction IDs, payment ID, bill state, accounting sync record, webhook event, and reconciliation result.

1. One bill, one ACH vendor, sole approval.
2. Multiple bills across projects, dual approval, scheduled release.
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
2. Fail the local disbursement update after provider acceptance. Retry and verify local state repairs through the provider idempotency key.
3. Deliver every supported webhook twice and out of order. Verify monotonic state and one financial effect.
4. Return or cancel a debit before payout. Verify the cash/clearing/fee submission entry is reversed.
5. Return a paid ACH. Verify the AP payment reversal, reopened bill balance, `ach_return_loss` entry, disabled funding source/mandate, return-loss limit evaluation, and exception case.
6. Fail ledger posting after settlement, then redeliver the webhook. Verify ledger completion.
7. Fail accounting enqueue after settlement, then redeliver. Verify the deduplicated accounting job appears.
8. Fail accounting push, correct the coding/connection, retry from the page, and verify the error clears.
9. Send an unmatched provider event. Verify it remains actionable and is not permanently discarded.
10. Reconcile more than 1,000 disbursements and verify the run is not falsely balanced by a page cap.
11. Deliver an ACH warning dispute and verify it opens an authorization inquiry without reversing money; then deliver the actual return and verify exactly one reversal.
12. Mark a connected payout failed after the transfer has completed. Verify the bill is not reopened or paid twice, the payout remains vendor-associated, and an operations incident stays open until `payout.paid`.
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
- Project/community/division/org-default connection routing sends each transaction to the expected file.
- Imported/inbound-only records are never pushed back accidentally.
- Payment fees, retainage, credits, project/job, vendor, AP account, and expense coding match the provider record.
- Re-home/cutover protection blocks a transaction from silently moving between accounting files.

## Customer enablement gates

Live mode remains blocked until all are recorded in the append-only launch-gate ledger and the latest state of every required gate is `approved`:

- Provider program and settlement configuration approved.
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
