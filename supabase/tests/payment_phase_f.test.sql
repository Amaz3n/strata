-- Phase F: one emitter per event.
--
-- Catalog-only. `approve_vendor_bills_atomic` raised `vendor_bill_approved`
-- itself while `approveVendorBillsAtomic` raised it through `recordEvent`, so a
-- bulk approval produced two events and two notifications per bill — one of them
-- with a payload too thin for the router to find the submitter. The SQL insert is
-- gone and everything else the transaction owed is still in it.
begin;

select plan(6);

-- Comments survive into `pg_get_functiondef`, and this function's own comment
-- explains the removal in the words "insert into public.events". Matching the
-- raw definition asserted against prose; the code is what has to be clean.
select ok(
  regexp_replace(
    pg_get_functiondef('public.approve_vendor_bills_atomic(uuid,uuid,jsonb)'::regprocedure),
    '--[^' || chr(10) || ']*', '', 'g'
  ) not like '%insert into public.events%',
  'bulk approval no longer raises its own vendor_bill_approved event'
);
select ok(
  pg_get_functiondef('public.approve_vendor_bills_atomic(uuid,uuid,jsonb)'::regprocedure) like '%insert into public.audit_log%',
  'the approval evidence stayed in the transaction'
);
select ok(
  pg_get_functiondef('public.approve_vendor_bills_atomic(uuid,uuid,jsonb)'::regprocedure) like '%project_vendor_bill_approval%',
  'the durable projection job stayed in the transaction'
);
select ok(
  pg_get_functiondef('public.approve_vendor_bills_atomic(uuid,uuid,jsonb)'::regprocedure) like '%lien_waiver_status%',
  'waiver seeding stayed in the transaction'
);
select ok(
  not has_function_privilege('anon','public.approve_vendor_bills_atomic(uuid,uuid,jsonb)','execute')
    and not has_function_privilege('authenticated','public.approve_vendor_bills_atomic(uuid,uuid,jsonb)','execute'),
  'browser roles cannot approve through the atomic RPC'
);

-- The rule is that SQL may not SHADOW a TypeScript emitter, not that SQL may
-- never raise an event. Retainage release has no TypeScript emitter and keeps
-- writing its own, atomically with the money it moves.
select ok(
  pg_get_functiondef('public.release_retainage_atomic(uuid,uuid,uuid,bigint,boolean,timestamptz)'::regprocedure) like '%vendor_bill_retainage_released%',
  'a SQL-only event still writes itself inside its own transaction'
);
select * from finish();
rollback;
