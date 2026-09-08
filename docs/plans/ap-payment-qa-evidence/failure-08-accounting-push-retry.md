# FAILURE-08 — Accounting push fails then retries

Runbook case: `FAILURE-08`

> Human QA evidence. An agent must not mark this case passed or manufacture identifiers.

## Execution

- Status: [ ] Not run [ ] Pass [ ] Fail
- QA organization ID: `<ORG_ID>`
- Tester:
- Started at (UTC):
- Completed at (UTC):
- Deployment/commit:
- Stripe sandbox/account:
- Defect links:

## Required evidence

| Artifact | ID or observed state |
|---|---|
| Payment run | `<RUN_ID>` |
| Disbursement | `<DISBURSEMENT_ID>` |
| Stripe PaymentIntent / charge | |
| Stripe transfer / payout / balance transaction | |
| Ledger transaction IDs | |
| Payment | `<PAYMENT_ID>` |
| Vendor bill and final state | `<BILL_ID>` / |
| Accounting sync record and outbox job | |
| Stripe webhook event | `<PROVIDER_EVENT_ID>` |
| Reconciliation run/result | `<RECONCILIATION_RUN_ID>` / |

## Acceptance

- [ ] The visible error clears after coding or connection repair and a manual retry.
- [ ] Screenshots, Stripe Workbench links, logs, and SQL output are attached or linked.
- [ ] No unresolved severity-1 or severity-2 defect is associated with this case.
- Notes:

## Evidence SELECT

Replace the seven angle-bracket values. The query is read-only and returns the
canonical rows needed to fill the table above.

```sql
with p as (
  select '<ORG_ID>'::text org_id, '<RUN_ID>'::text run_id,
         '<DISBURSEMENT_ID>'::text disbursement_id, '<PAYMENT_ID>'::text payment_id,
         '<BILL_ID>'::text bill_id, '<PROVIDER_EVENT_ID>'::text provider_event_id,
         '<RECONCILIATION_RUN_ID>'::text reconciliation_run_id
)
select
  (select to_jsonb(r) from public.payment_runs r, p where r.id::text=p.run_id and r.org_id::text=p.org_id) payment_run,
  (select jsonb_agg(to_jsonb(i) order by i.created_at) from public.payment_run_items i, p where i.run_id::text=p.run_id) run_items,
  (select jsonb_agg(to_jsonb(d) order by d.created_at) from public.disbursements d, p where d.run_id::text=p.run_id or d.id::text=p.disbursement_id) disbursements,
  (select jsonb_agg(to_jsonb(t) order by t.created_at) from public.payment_ledger_transactions t, p where t.disbursement_id::text=p.disbursement_id) ledger_transactions,
  (select to_jsonb(pay) from public.payments pay, p where pay.id::text=p.payment_id) payment,
  (select to_jsonb(b) from public.vendor_bills b, p where b.id::text=p.bill_id) bill,
  (select jsonb_agg(to_jsonb(s) order by s.updated_at) from public.accounting_sync_records s, p where s.entity_id::text in (p.bill_id,p.payment_id)) accounting_sync,
  (select jsonb_agg(to_jsonb(o) order by o.created_at) from public.outbox o, p where o.payload @> jsonb_build_object('bill_id',p.bill_id) or o.payload @> jsonb_build_object('payment_id',p.payment_id)) outbox_jobs,
  (select to_jsonb(e) from public.payment_provider_events e, p where e.provider_event_id=p.provider_event_id) webhook_event,
  (select to_jsonb(rr) from public.payment_reconciliation_runs rr, p where rr.id::text=p.reconciliation_run_id) reconciliation_run,
  (select jsonb_agg(to_jsonb(ri) order by ri.created_at) from public.payment_reconciliation_items ri, p where ri.reconciliation_run_id::text=p.reconciliation_run_id) reconciliation_items;
```

