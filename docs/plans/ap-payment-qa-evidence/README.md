# AP payment QA evidence

These files are empty human-run evidence records for Phase H. Run only in the isolated QA organization with Stripe test credentials. Never paste API keys, bank-account details, webhook signing secrets, or personal data into these files.

An LLM may prepare and triage these records, but must never mark a case passed, record a launch attestation, or invent provider/database identifiers.

Phase I's cross-workstream regression checks are folded into the existing evidence
records so the release matrix remains 46 cases: vendor first-click recovery is in
`MATRIX-01`; manual platform payouts, bulk-approval notifications, and stuck-run admin
cancel are in `MATRIX-02`; transfer-claim crash recovery is in `FAILURE-02`;
post-transfer returns are in `FAILURE-05`; per-payee isolation is in `FAILURE-12`; and
expired-token backlog replay is in `ACCOUNTING-04`.

## Cases

### Matrix

- [MATRIX-01 — One bill, one ACH vendor, sole approval](./matrix-01-one-bill-sole-approval.md)
- [MATRIX-02 — Multiple bills across projects, dual approval, scheduled release](./matrix-02-multi-project-dual-scheduled.md)
- [MATRIX-03 — Partial bill payment with retainage held](./matrix-03-partial-payment-retainage.md)
- [MATRIX-04 — Signed conditional waiver with valid through-date](./matrix-04-conditional-waiver.md)
- [MATRIX-05 — First- and second-tier waivers](./matrix-05-subtier-waivers.md)
- [MATRIX-06 — Vendor credit before remaining cash](./matrix-06-vendor-credit.md)
- [MATRIX-07 — Same idempotency key and same payload](./matrix-07-idempotency-same-payload.md)
- [MATRIX-08 — Same idempotency key and different payload](./matrix-08-idempotency-different-payload.md)
- [MATRIX-09 — Two simultaneous runs exceed daily limit](./matrix-09-daily-limit-race.md)
- [MATRIX-10 — Client substitutes another recipient UUID](./matrix-10-recipient-substitution.md)
- [MATRIX-11 — Mixed-currency bills](./matrix-11-mixed-currency.md)
- [MATRIX-12 — Concurrent duplicate vendor invoice](./matrix-12-duplicate-invoice-race.md)

### Failure

- [FAILURE-01 — Response drops after Stripe accepts PaymentIntent](./failure-01-response-drop-after-intent.md)
- [FAILURE-02 — Local update fails after provider acceptance](./failure-02-local-update-after-provider.md)
- [FAILURE-03 — Duplicate and out-of-order webhooks](./failure-03-duplicate-out-of-order-webhooks.md)
- [FAILURE-04 — Debit return or cancellation before payout](./failure-04-return-before-payout.md)
- [FAILURE-05 — Paid ACH return](./failure-05-paid-ach-return.md)
- [FAILURE-06 — Ledger posting fails after settlement](./failure-06-ledger-failure-after-settlement.md)
- [FAILURE-07 — Accounting enqueue fails after settlement](./failure-07-accounting-enqueue-failure.md)
- [FAILURE-08 — Accounting push fails then retries](./failure-08-accounting-push-retry.md)
- [FAILURE-09 — Unmatched provider event](./failure-09-unmatched-provider-event.md)
- [FAILURE-10 — Reconcile more than 1,000 disbursements](./failure-10-reconcile-over-1000.md)
- [FAILURE-11 — ACH authorization warning then actual return](./failure-11-warning-then-return.md)
- [FAILURE-12 — Connected payout fails after transfer](./failure-12-payout-failure-after-transfer.md)
- [FAILURE-13 — Builder funding method disabled or updated](./failure-13-funding-method-disabled.md)
- [FAILURE-14 — Provider activity without Arc rows](./failure-14-provider-orphans.md)
- [FAILURE-15 — Reconciliation fails after starting](./failure-15-reconciliation-crash.md)
- [FAILURE-16 — Recover more than 2,000 stale exceptions](./failure-16-recover-over-2000.md)

### Construction

- [CONSTRUCTION-01 — Retainage derives from approved bill](./construction-01-retainage-frozen.md)
- [CONSTRUCTION-02 — Waiver evidence provenance](./construction-02-waiver-provenance.md)
- [CONSTRUCTION-03 — Expired or short waiver through-date](./construction-03-waiver-expiry.md)
- [CONSTRUCTION-04 — Missing sub-tier claimant waiver](./construction-04-subtier-claimants.md)
- [CONSTRUCTION-05 — Commercial linkage consistency](./construction-05-commercial-linkage.md)
- [CONSTRUCTION-06 — Joint-payee ACH verification](./construction-06-joint-payee.md)
- [CONSTRUCTION-07 — External check controls](./construction-07-external-check.md)
- [CONSTRUCTION-08 — In-flight bill mutation rejection](./construction-08-immutable-inflight-bill.md)
- [CONSTRUCTION-09 — Suspended relationship and vendor entity](./construction-09-suspended-relationship.md)
- [CONSTRUCTION-10 — Canonical duplicate invoice identity](./construction-10-canonical-duplicate.md)

### Accounting

- [ACCOUNTING-01 — Bill approval creates sync intent](./accounting-01-bill-approval-sync.md)
- [ACCOUNTING-02 — Provider errors are visible and retryable](./accounting-02-errors-visible-retry.md)
- [ACCOUNTING-03 — Settlement creates one bill-payment sync](./accounting-03-settlement-idempotency.md)
- [ACCOUNTING-04 — Expired token backlog replays after reconnect](./accounting-04-expired-token-backlog.md)
- [ACCOUNTING-05 — Connection hierarchy routing](./accounting-05-connection-routing.md)
- [ACCOUNTING-06 — Inbound-only records never push back](./accounting-06-inbound-only.md)
- [ACCOUNTING-07 — Accounting coding fidelity](./accounting-07-coding-fidelity.md)
- [ACCOUNTING-08 — Re-home and cutover protection](./accounting-08-cutover-protection.md)
