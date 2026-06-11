-- Older webhook processing created qbo_sync_records with a random entity_id for inbound
-- BillPayment events. Those rows did not point to payments and incorrectly hid the transaction
-- from the manual import sheet. Real mappings always reference an existing payments.id.
delete from public.qbo_sync_records qsr
where qsr.entity_type = 'bill_payment'
  and coalesce(qsr.metadata->>'source', '') = 'qbo_inbound'
  and not exists (
    select 1
    from public.payments p
    where p.org_id = qsr.org_id
      and p.id = qsr.entity_id
  );
