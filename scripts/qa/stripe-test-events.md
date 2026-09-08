# Stripe sandbox failure-injection commands

Use only the isolated Arc QA deployment and a Stripe sandbox/test account. Never
put an API key or webhook signing secret in this file. Prefer a restricted test
key with only the resources needed by the QA operator.

Stripe does not guarantee event order. A captured event can be manually resent
with `stripe events resend <event_id> --webhook-endpoint=<endpoint_id>` for up to
30 days. Generic `stripe trigger` fixtures are useful for signature/routing tests,
but they do not carry Arc's run/disbursement metadata; correlated money cases must
start through Arc and resend the resulting real sandbox event.

References: [Stripe CLI](https://docs.stripe.com/stripe-cli),
[webhook retries and ordering](https://docs.stripe.com/webhooks),
[ACH test accounts](https://docs.stripe.com/testing?numbers-or-method-or-token=tokens),
[Connect payout testing](https://docs.stripe.com/connect/testing).

## One-time setup

```bash
export QA_BASE_URL="https://<qa-host>"
export WEBHOOK_ENDPOINT_ID="we_<qa-endpoint>"
export CONNECTED_ACCOUNT_ID="acct_<qa-vendor>"

stripe login
stripe listen --forward-to "$QA_BASE_URL/api/webhooks/stripe" --forward-connect-to "$QA_BASE_URL/api/webhooks/stripe"
```

Keep the listener in its own terminal. Record the signing secret in the QA
deployment's secret manager, never in evidence markdown.

For every captured event:

```bash
export EVENT_ID="evt_<sandbox-event>"
stripe events retrieve "$EVENT_ID"
stripe events resend "$EVENT_ID" --webhook-endpoint="$WEBHOOK_ENDPOINT_ID"
```

## 01 — Response dropped after PaymentIntent acceptance

Create the payment through Arc while an approved QA proxy/debugger drops the
response after provider acceptance. The repository intentionally ships no
runtime fault switch for this. Capture its `payment_intent.processing` or
`payment_intent.succeeded` event, remove the interception, then retry execution.

```bash
stripe events resend "$EVENT_ID" --webhook-endpoint="$WEBHOOK_ENDPOINT_ID"
```

## 02 — Local disbursement update fails after provider acceptance

Run this case twice. First, use an approved database fault injector or debugger
break to fail the local PaymentIntent/disbursement write after provider
acceptance. Second, let the debit settle and fail after Stripe accepts the vendor
transfer but before Arc records its transfer claim. The repository intentionally
ships no runtime fault switch. In each run remove the interception, retry the run,
and resend the correlated event; the second run must adopt the transfer rather
than create another one.

```bash
export INTENT_EVENT_ID="evt_<accepted-payment-intent>"
export TRANSFER_EVENT_ID="evt_<accepted-transfer>"
stripe events resend "$INTENT_EVENT_ID" --webhook-endpoint="$WEBHOOK_ENDPOINT_ID"
stripe events resend "$TRANSFER_EVENT_ID" --webhook-endpoint="$WEBHOOK_ENDPOINT_ID"
```

## 03 — Duplicate and out-of-order webhooks

Set the IDs to events from the same Arc sandbox disbursement. Send the later event
first, resend each twice, and keep the exact order in the evidence file.

```bash
export PROCESSING_EVENT_ID="evt_<payment-intent-processing>"
export SUCCEEDED_EVENT_ID="evt_<payment-intent-succeeded>"
export PAYOUT_EVENT_ID="evt_<payout-paid>"

stripe events resend "$PAYOUT_EVENT_ID" --webhook-endpoint="$WEBHOOK_ENDPOINT_ID"
stripe events resend "$SUCCEEDED_EVENT_ID" --webhook-endpoint="$WEBHOOK_ENDPOINT_ID"
stripe events resend "$PROCESSING_EVENT_ID" --webhook-endpoint="$WEBHOOK_ENDPOINT_ID"
stripe events resend "$PAYOUT_EVENT_ID" --webhook-endpoint="$WEBHOOK_ENDPOINT_ID"
stripe events resend "$SUCCEEDED_EVENT_ID" --webhook-endpoint="$WEBHOOK_ENDPOINT_ID"
stripe events resend "$PROCESSING_EVENT_ID" --webhook-endpoint="$WEBHOOK_ENDPOINT_ID"
```

## 04 — Return or cancel before payout

For cancellation, create an Arc payment using Stripe's indefinitely-processing
ACH test PaymentMethod `pm_usBankAccount_processing`, then cancel the captured
PaymentIntent in the sandbox. Resend the resulting canceled event.

```bash
export PAYMENT_INTENT_ID="pi_<arc-sandbox-intent>"
stripe payment_intents cancel "$PAYMENT_INTENT_ID"
stripe events resend "$EVENT_ID" --webhook-endpoint="$WEBHOOK_ENDPOINT_ID"
```

For an ACH return path, use the dispute test PaymentMethod
`pm_usBankAccount_dispute` through Arc and capture the generated dispute event.

## 05 — Return a paid ACH

Use `pm_usBankAccount_dispute` on two QA funding setups. In the first run, hold or
pause the connected payout in Stripe test mode, wait for Arc to create the vendor
transfer, then deliver the return before payout. In the second, allow payout to
complete before delivering the return. Capture the real Arc-correlated return
event for each timing window.

```bash
export PRE_PAYOUT_RETURN_EVENT_ID="evt_<post-transfer-pre-payout-return>"
export POST_PAYOUT_RETURN_EVENT_ID="evt_<post-payout-return>"
stripe events resend "$PRE_PAYOUT_RETURN_EVENT_ID" --webhook-endpoint="$WEBHOOK_ENDPOINT_ID"
stripe events resend "$POST_PAYOUT_RETURN_EVENT_ID" --webhook-endpoint="$WEBHOOK_ENDPOINT_ID"
stripe events resend "$POST_PAYOUT_RETURN_EVENT_ID" --webhook-endpoint="$WEBHOOK_ENDPOINT_ID"
```

The duplicate post-payout resend proves exactly-once reversal behavior.

## 06 — Ledger posting fails after settlement

Use an approved database fault injector to fail the ledger write before first
delivery. Remove the interception after the failed attempt, then resend the same
captured payout event.

```bash
stripe events resend "$EVENT_ID" --webhook-endpoint="$WEBHOOK_ENDPOINT_ID"
```

## 07 — Accounting enqueue fails after settlement

Use an approved database fault injector to fail the accounting enqueue before
first delivery. Remove it, then redeliver the same event.

```bash
stripe events resend "$EVENT_ID" --webhook-endpoint="$WEBHOOK_ENDPOINT_ID"
```

## 08 — Accounting push fails, then retries

This is an Arc/accounting-adapter failure, not a Stripe-generated event. Use the
captured settlement event to prove that webhook redelivery does not duplicate the
job; repair the accounting connection/coding and use Arc's Retry control.

```bash
stripe events resend "$EVENT_ID" --webhook-endpoint="$WEBHOOK_ENDPOINT_ID"
```

## 09 — Unmatched provider event

The generic fixture intentionally has no Arc metadata, so it must be retained as
unmatched/actionable rather than attributed to a payment.

```bash
stripe trigger payment_intent.succeeded
```

Capture the emitted event ID from the listener and resend it:

```bash
stripe events resend "$EVENT_ID" --webhook-endpoint="$WEBHOOK_ENDPOINT_ID"
```

## 10 — Reconcile more than 1,000 disbursements

Do not load-test Stripe's sandbox. Create the dataset with Arc's database QA
fixture, then generate one real sandbox event to validate the endpoint and run
Arc reconciliation over the fixture population.

```bash
stripe trigger payment_intent.succeeded
```

## 11 — ACH warning inquiry, then actual return

Use the Arc-created ACH test transaction. Capture the
`charge.dispute.created` warning event and later the actual return event; do not
substitute an unsigned JSON request.

```bash
export WARNING_EVENT_ID="evt_<warning-needs-response>"
export RETURN_EVENT_ID="evt_<actual-return>"
stripe events resend "$WARNING_EVENT_ID" --webhook-endpoint="$WEBHOOK_ENDPOINT_ID"
stripe events resend "$RETURN_EVENT_ID" --webhook-endpoint="$WEBHOOK_ENDPOINT_ID"
stripe events resend "$RETURN_EVENT_ID" --webhook-endpoint="$WEBHOOK_ENDPOINT_ID"
```

## 12 — Connected payout fails after transfer

Create a run with at least two vendor payees. Configure only one connected
account's sandbox payout bank as routing `110000000`, account `000111111116`,
which produces `payout.failed`; leave the other payee on a successful test bank.
Capture the successful payee event, failed payee event, and eventual paid event
from the repaired payout. Their IDs must prove that retrying the failed payee did
not resubmit the successful one.

```bash
export OTHER_PAYEE_PAID_EVENT_ID="evt_<other-payee-payout-paid>"
export PAYOUT_FAILED_EVENT_ID="evt_<payout-failed>"
export PAYOUT_PAID_EVENT_ID="evt_<payout-paid>"
stripe events resend "$OTHER_PAYEE_PAID_EVENT_ID" --webhook-endpoint="$WEBHOOK_ENDPOINT_ID"
stripe events resend "$PAYOUT_FAILED_EVENT_ID" --webhook-endpoint="$WEBHOOK_ENDPOINT_ID"
stripe events resend "$PAYOUT_FAILED_EVENT_ID" --webhook-endpoint="$WEBHOOK_ENDPOINT_ID"
stripe events resend "$PAYOUT_PAID_EVENT_ID" --webhook-endpoint="$WEBHOOK_ENDPOINT_ID"
```

## 13 — Funding method disabled or automatically updated

For the provider-authentic path, update/disable the sandbox funding method in
Stripe Workbench and capture `payment_method.automatically_updated`, then resend
that exact signed event:

```bash
stripe events resend "$EVENT_ID" --webhook-endpoint="$WEBHOOK_ENDPOINT_ID"
```

Do not fabricate a JSON request or signature for this case.

## 14 — Provider activity with no Arc row

Generate a generic sandbox PaymentIntent without Arc metadata and leave it
unmatched. Create transfer, payout, and fee objects in the same sandbox through
Workbench/API using QA-owned funds, then run independent provider reconciliation.

```bash
stripe trigger payment_intent.succeeded
stripe events resend "$EVENT_ID" --webhook-endpoint="$WEBHOOK_ENDPOINT_ID"
```

## 15 — Reconciliation fails after starting

This fault is internal and creates no Stripe event. First prove the provider
event source is reachable, then use an approved database fault injector or
debugger break after the reconciliation run starts. Arc intentionally ships no
runtime fault switch for this production-sensitive path.

```bash
stripe trigger payment_intent.succeeded
```

## 16 — Recover more than 2,000 stale exceptions

Create stale rows with the database QA fixture; do not issue 2,000 Stripe sandbox
requests. Use one signed fixture as the provider-side control, then run recovery
twice to prove pagination and idempotency.

```bash
stripe trigger payment_intent.succeeded
stripe events resend "$EVENT_ID" --webhook-endpoint="$WEBHOOK_ENDPOINT_ID"
```

## Cleanup and evidence

- Remove every QA proxy, debugger, or database fault interception before the next case.
- Record every event ID and Workbench link in the matching evidence markdown.
- Keep `FINTECH_PAYMENTS_MODE=test` and `FINTECH_PAYMENTS_LIVE_MODE_APPROVED=false`.
- Never run these commands against a live endpoint or with real bank data.
