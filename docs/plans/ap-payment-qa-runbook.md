# AP payment QA and customer-enablement runbook

This runbook is a release gate, not a product roadmap. Complete it against an isolated test organization and Stripe test credentials. Never use production vendor bank data for QA.

## Required deployment state

- Apply and verify all pending AP migrations, including `20260804005756_ap_payment_execution_hardening.sql`.
- Set `FINTECH_PAYMENTS_MODE=test`, `FINTECH_PAYMENTS_EXECUTION_ENABLED=true`, and `FINTECH_PAYMENTS_RECONCILIATION_ENABLED=true` only in the test deployment.
- Keep `FINTECH_PAYMENTS_LIVE_MODE_APPROVED=false`.
- Configure an organization feature flag for the isolated QA organization only.
- Configure a payment policy, approved fee policy, designated approvers, verified funding source, and Stripe test connected vendor.
- Connect the accounting target and enable bill/payment sync.

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
5. Return a paid ACH. Verify the AP payment reversal, reopened bill balance, suspense entry, and exception case.
6. Fail ledger posting after settlement, then redeliver the webhook. Verify ledger completion.
7. Fail accounting enqueue after settlement, then redeliver. Verify the deduplicated accounting job appears.
8. Fail accounting push, correct the coding/connection, retry from the page, and verify the error clears.
9. Send an unmatched provider event. Verify it remains actionable and is not permanently discarded.
10. Reconcile more than 1,000 disbursements and verify the run is not falsely balanced by a page cap.

## Construction controls

- Confirm retainage is derived from the approved bill and included in frozen approval evidence.
- Confirm waiver evidence includes bill link, type, amount, through-date, signed timestamp, signed file, and signature provenance.
- Confirm expired or short through-date waivers block release.
- Confirm missing sub-tier claimant waivers block when the project requires them.
- Confirm commitment, project, vendor relationship, cost coding, and payment allocation remain consistent.
- Confirm joint-payee ACH is unavailable unless every destination is explicitly verified and bound to the payment relationship.
- Confirm external check recording uses the same payment holds and produces accounting sync and audit evidence.

## Accounting acceptance

- Bill approval produces a provider-neutral sync record and deduplicated outbound job.
- Provider errors and `needs_review` state appear on both payables pages with retry controls.
- Settlement produces one bill-payment sync even when the settlement webhook is retried.
- Project/community/division/org-default connection routing sends each transaction to the expected file.
- Imported/inbound-only records are never pushed back accidentally.
- Payment fees, retainage, credits, project/job, vendor, AP account, and expense coding match the provider record.
- Re-home/cutover protection blocks a transaction from silently moving between accounting files.

## Customer enablement gates

Live mode remains blocked until all are recorded:

- Provider program and settlement configuration approved.
- Payments counsel and money-transmission posture approved.
- State-specific waiver forms and workflow approved for every enabled jurisdiction.
- Fraud, account-takeover, bank-change, return, reconciliation, incident, and vendor-support runbooks staffed and rehearsed.
- Daily reconciliation ownership, exception SLA, escalation path, and customer communication templates assigned.
- Limits, reserves/loss allocation, fees, disclosures, support hours, and customer contract accepted.
- QA evidence above reviewed with no unresolved severity-1 or severity-2 defects.
- A named approver authorizes the customer/org feature flag and `FINTECH_PAYMENTS_LIVE_MODE_APPROVED=true` change.

## Rollback

Turn off the organization feature flag first, then `FINTECH_PAYMENTS_EXECUTION_ENABLED`. Do not delete or rewrite financial records. Continue webhook ingestion, ledger repair, reconciliation, accounting sync, return handling, and vendor support for every already-submitted disbursement.
