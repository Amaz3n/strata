# Arc Pay stale test-run dossier

> Read-only production snapshot taken through Supabase MCP on 2026-09-02 UTC.
> This is a QA organization and a test-mode payment. Do not edit payment, run,
> disbursement, or ledger rows by hand; close it through the normal provider/RPC
> lifecycle only.

## Identity and current state

| Field | Value |
|---|---|
| Organization | Strata Construction LLC (`2c99095e-e918-4c90-968a-0a4d94ef7d13`) |
| Payment run | `d229fe07-4a80-4217-8c97-b23b2101236b` — `processing` since 2026-08-03 15:07:48 UTC |
| Run item | `d43a5928-a709-42dc-99fe-c4c0c658b4bd` — `processing` |
| Payee | Austral Electric, Inc. — ACH — `processing` |
| Bill | `c9283442-e731-456d-9333-19ccf76da2ca` / no. 1511 — `approved`, paid 0 |
| Disbursement | `747bbadd-129c-4c24-a171-71ec09f955c2` — `transfer_pending` |
| Vendor amount | $1,000.00 (`100000` cents) |
| Processor / platform fee snapshots | $21.50 / $10.00 |
| Open stale-state incident | **None** at snapshot time |

The run is still protected by the in-flight bill index, so bill 1511 cannot join
another payment run until this test run reaches a terminal state.

## Provider evidence

- PaymentIntent: [`pi_3U0NSzFZq01YONht0l6G8WjW`](https://dashboard.stripe.com/test/payments/pi_3U0NSzFZq01YONht0l6G8WjW)
- Charge: `py_3U0NSzFZq01YONht08bU0dYg`
- Transfer: [`tr_3U0NSzFZq01YONht0JyhjnEU`](https://dashboard.stripe.com/test/connect/transfers/tr_3U0NSzFZq01YONht0JyhjnEU)
- Balance transaction: `txn_3U0NSzFZq01YONht0T38aMMY`
- Payout: none recorded in Arc

Arc received and successfully processed:

| Provider event | Event time | Arc receipt time | Outcome |
|---|---|---|---|
| `charge.succeeded` / `evt_3U0NSzFZq01YONht0jHn3v0E` | 2026-08-03 15:08:06 UTC | 2026-08-03 15:25:33 UTC | processed |
| `transfer.created` / `evt_3U0NSzFZq01YONht0ZvLHuhO` | 2026-08-03 15:08:00 UTC | 2026-08-03 15:25:33 UTC | processed |

The human operator must open the Stripe links and confirm the objects' current
test-mode state. Supabase proves what Arc recorded; it does not prove Stripe's
state today.

## Ledger evidence

One posted `payment_submitted` transaction exists:
`32935ec1-2e25-42ca-822c-32d0fd7e6f08`, effective 2026-08-03 15:07:48 UTC.
It balances at $1,031.50:

- Debit ACH clearing $1,000.00
- Debit processor fee expense $21.50
- Debit platform fee expense $10.00
- Credit organization cash $1,031.50

There is no later `funds_available`, `transfer_created`, `payout_paid`, return,
or reversal ledger transaction for this disbursement.

## Human cleanup gate

After confirming Stripe's current test objects, use one supported path:

1. Replay the appropriate test-mode payout/provider event so the ordinary
   webhook lifecycle completes the disbursement and run; or
2. Wait for the administrator-cancel RPC planned in WS-C1 and cancel through it.

Never clear this run with direct SQL. The stale-state watchdog change in Phase A
will open an incident after deployment; it does not mutate or unlock this run.
