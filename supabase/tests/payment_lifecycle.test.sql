begin;

select plan(51);

-- Real-schema behavioral coverage for the money RPCs. These fixtures are
-- intentionally complete enough to exercise FKs and table constraints rather
-- than calling isolated mock functions.
insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) values (
  '10000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'payments-rpc@example.test', '', now(),
  now(), now(), '{}'::jsonb, '{}'::jsonb
);
insert into public.app_users (id, email, full_name)
values ('10000000-0000-0000-0000-000000000001', 'payments-rpc@example.test', 'Payment RPC Test');
insert into public.orgs (id, name, slug, created_by)
values ('20000000-0000-0000-0000-000000000001', 'Payment RPC Test', 'payment-rpc-test', '10000000-0000-0000-0000-000000000001');
insert into public.projects (id, org_id, name, created_by)
values ('30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'Test Project', '10000000-0000-0000-0000-000000000001');
insert into public.companies (id, org_id, name, company_type)
values ('40000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'Test Vendor', 'vendor');
insert into public.vendor_portal_identities (id, email, full_name, status, email_verified_at)
values ('50000000-0000-0000-0000-000000000001', 'vendor-rpc@example.test', 'Vendor Admin', 'active', now());
insert into public.vendor_entities (id, legal_name, status, created_by_identity_id)
values ('60000000-0000-0000-0000-000000000001', 'Test Vendor LLC', 'active', '50000000-0000-0000-0000-000000000001');
insert into public.vendor_company_claims (
  id, org_id, company_id, vendor_entity_id, claimed_by_identity_id,
  status, verification_method, verified_at
) values (
  '70000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001',
  '40000000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000001',
  '50000000-0000-0000-0000-000000000001', 'verified', 'portal_invitation', now()
);
insert into public.payment_recipient_accounts (
  id, vendor_entity_id, provider, provider_account_id, status,
  details_submitted, payouts_enabled
) values (
  '80000000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000001',
  'stripe', 'acct_rpc_test', 'ready', true, true
);
insert into public.vendor_payment_relationships (
  id, org_id, company_id, vendor_company_claim_id, vendor_entity_id,
  recipient_account_id, status, accepted_by_identity_id, accepted_at
) values (
  '90000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001',
  '40000000-0000-0000-0000-000000000001', '70000000-0000-0000-0000-000000000001',
  '60000000-0000-0000-0000-000000000001', '80000000-0000-0000-0000-000000000001',
  'active', '50000000-0000-0000-0000-000000000001', now()
);
insert into public.org_funding_sources (
  id, org_id, provider, provider_customer_id, provider_payment_method_id,
  provider_mandate_id, mandate_status, verification_status, status, is_default,
  usable_after, created_by, activated_by, activated_at
) values (
  'a0000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001',
  'stripe', 'cus_rpc_test', 'pm_rpc_test', 'mandate_rpc_test', 'accepted', 'verified',
  'active', true, now() - interval '1 day', '10000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000001', now() - interval '1 day'
);

insert into public.vendor_bills (
  id, org_id, project_id, company_id, bill_number, status, bill_date, due_date,
  total_cents, paid_cents, currency, metadata, approved_at, approved_by
) values
  ('b0000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', 'ELEC-1', 'approved', current_date, current_date + 30, 10000, 0, 'usd', '{"creation_state":"ready"}', now(), '10000000-0000-0000-0000-000000000001'),
  ('b0000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', 'MANUAL-1', 'approved', current_date, current_date + 30, 10000, 0, 'usd', '{"creation_state":"ready"}', now(), '10000000-0000-0000-0000-000000000001'),
  ('b0000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', 'CREDIT-TARGET', 'approved', current_date, current_date + 30, 9000, 0, 'usd', '{"creation_state":"ready"}', now(), '10000000-0000-0000-0000-000000000001'),
  ('b0000000-0000-0000-0000-000000000004', '20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', 'CREDIT-1', 'approved', current_date, current_date + 30, -9000, 0, 'usd', '{"creation_state":"ready","source":"vendor_credit"}', now(), '10000000-0000-0000-0000-000000000001'),
  ('b0000000-0000-0000-0000-000000000005', '20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', 'DRAFT-1', 'pending', current_date, current_date + 30, 5000, 0, 'usd', '{"creation_state":"draft"}', null, null),
  ('b0000000-0000-0000-0000-000000000007', '20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001', 'REVERSE-1', 'approved', current_date, current_date + 30, 8000, 0, 'usd', '{"creation_state":"ready"}', now(), '10000000-0000-0000-0000-000000000001');
update public.vendor_bills set retainage_cents = 1000 where id = 'b0000000-0000-0000-0000-000000000002';

select has_function('public', 'create_payment_run_atomic', array['uuid','uuid','uuid','text','text','smallint','bigint','bigint','bigint','bigint','jsonb','text','jsonb']);
select has_function('public', 'record_ap_payment_atomic', array['uuid','uuid','text','text','text','text','text','timestamp with time zone']);
select has_function('public', 'record_ap_payment_reversal_atomic', array['uuid','uuid','bigint','text','text','text','jsonb']);
select has_function('public', 'record_manual_ap_payment_atomic', array['uuid','uuid','uuid','bigint','text','text','text','text','timestamp with time zone','jsonb','text']);
select has_function('public', 'apply_vendor_credit_atomic', array['uuid','uuid','uuid','uuid','bigint','text','jsonb']);
select has_function('public', 'reverse_manual_ap_payment_atomic', array['uuid','uuid','uuid','bigint','text','text']);
select hasnt_column('public', 'vendor_portal_identities', 'password_hash', 'vendor profiles do not retain a stale password hash');
select hasnt_column('public', 'vendor_portal_identities', 'last_authenticated_at', 'vendor profiles do not retain a stale authentication timestamp');
select hasnt_column('public', 'payment_run_items', 'allocation_snapshot', 'payment runs do not carry an always-empty speculative allocation snapshot');

select lives_ok($rpc$
  select public.create_payment_run_atomic(
    '20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001',
    'a0000000-0000-0000-0000-000000000001', 'usd', 'sole', 1::smallint,
    10000, 0, 0, 10000, '{"test":true}', 'rpc-run-1',
    '[{"project_id":"30000000-0000-0000-0000-000000000001","bill_id":"b0000000-0000-0000-0000-000000000001","relationship_id":"90000000-0000-0000-0000-000000000001","bill_balance_snapshot_cents":10000,"gross_payment_cents":10000,"retainage_held_cents":0,"vendor_amount_cents":10000,"processor_fee_cents":0,"platform_fee_cents":0,"total_debit_cents":10000,"hold_snapshot":{},"waiver_snapshot":{},"payees":[{"payee_kind":"primary_vendor","method":"ach","recipient_account_id":"80000000-0000-0000-0000-000000000001","payee_name":"Test Vendor LLC","amount_cents":10000}]}]'::jsonb
  )
$rpc$, 'create_payment_run_atomic accepts a constraint-valid run');
select is((select count(*)::integer from public.payment_runs where idempotency_key = 'rpc-run-1'), 1, 'run is persisted once');
select is((select count(*)::integer from public.payment_run_items item join public.payment_runs run on run.id = item.run_id where run.idempotency_key = 'rpc-run-1'), 1, 'run item is persisted');
select is((select count(*)::integer from public.payment_run_item_payees payee join public.payment_run_items item on item.id = payee.run_item_id join public.payment_runs run on run.id = item.run_id where run.idempotency_key = 'rpc-run-1'), 1, 'run payee is persisted');
select throws_ok(
  $$update public.payment_run_item_payees set method = 'external_check' where run_item_id = (select id from public.payment_run_items where run_id = (select id from public.payment_runs where idempotency_key = 'rpc-run-1'))$$,
  '23514', null,
  'electronic payment runs cannot advertise an unimplemented external-check payee'
);
select throws_ok(
  $$insert into public.payment_run_item_payees (
      org_id, run_item_id, payee_kind, method, recipient_account_id, payee_name, amount_cents
    ) select
      run.org_id, item.id, 'primary_vendor', 'ach',
      '80000000-0000-0000-0000-000000000001', 'Duplicate destination', 10000
    from public.payment_runs run
    join public.payment_run_items item on item.run_id = run.id
    where run.idempotency_key = 'rpc-run-1'$$,
  '23505', null,
  'each payable has exactly one electronic destination'
);
select ok((public.create_payment_run_atomic(
  '20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001',
  'a0000000-0000-0000-0000-000000000001', 'usd', 'sole', 1::smallint,
  10000, 0, 0, 10000, '{"test":true}', 'rpc-run-1',
  '[{"project_id":"30000000-0000-0000-0000-000000000001","bill_id":"b0000000-0000-0000-0000-000000000001","relationship_id":"90000000-0000-0000-0000-000000000001","bill_balance_snapshot_cents":10000,"gross_payment_cents":10000,"retainage_held_cents":0,"vendor_amount_cents":10000,"processor_fee_cents":0,"platform_fee_cents":0,"total_debit_cents":10000,"hold_snapshot":{},"waiver_snapshot":{},"payees":[{"payee_kind":"primary_vendor","method":"ach","recipient_account_id":"80000000-0000-0000-0000-000000000001","payee_name":"Test Vendor LLC","amount_cents":10000}]}]'
  )->>'duplicate')::boolean, 'run creation is idempotent for the same request');

select throws_ok(
  $$update public.vendor_bills set total_cents = 10001 where id = 'b0000000-0000-0000-0000-000000000001'$$,
  'P0001', 'This payable belongs to an active payment run; cancel the run before changing the approved obligation',
  'an active run makes its live payable obligation immutable'
);

select throws_ok(
  $$insert into public.vendor_bills (
      id, org_id, project_id, company_id, bill_number, status, bill_date, due_date,
      total_cents, paid_cents, currency, metadata, approved_at, approved_by
    ) values (
      'b0000000-0000-0000-0000-000000000006', '20000000-0000-0000-0000-000000000001',
      '30000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001',
      'ELEC 1', 'approved', current_date, current_date + 30, 10000, 0, 'usd',
      '{"creation_state":"ready"}', now(), '10000000-0000-0000-0000-000000000001'
    )$$,
  'P0001', 'Duplicate vendor invoice number for this company',
  'invoice duplicate protection canonicalizes punctuation and spacing'
);

select throws_ok(
  $$insert into public.payment_rail_policies (org_id, enabled, created_by)
    values ('20000000-0000-0000-0000-000000000001', true, '10000000-0000-0000-0000-000000000001')$$,
  '23514', null,
  'the database refuses to arm a rail with unbounded production risk'
);

insert into public.payment_provider_events (id, provider, provider_event_id, event_type, payload)
values ('d0000000-0000-0000-0000-000000000001', 'stripe', 'evt_attempt_rpc', 'test.event', '{}');
select lives_ok($$select public.record_payment_provider_event_attempt(
  'd0000000-0000-0000-0000-000000000001', 'processed', null, now(), now()
)$$, 'provider event attempt allocation succeeds');
select lives_ok($$select public.record_payment_provider_event_attempt(
  'd0000000-0000-0000-0000-000000000001', 'ignored', null, now(), now()
)$$, 'provider event retries allocate another attempt atomically');
select is(
  (select array_agg(attempt_number order by attempt_number) from public.payment_provider_event_attempts where provider_event_id = 'd0000000-0000-0000-0000-000000000001'),
  array[1,2],
  'provider event attempt numbers remain contiguous'
);

update public.payment_runs set status = 'processing' where idempotency_key = 'rpc-run-1';
update public.payment_run_items set status = 'processing' where run_id = (select id from public.payment_runs where idempotency_key = 'rpc-run-1');
update public.payment_run_item_payees set status = 'processing' where run_item_id = (select id from public.payment_run_items where run_id = (select id from public.payment_runs where idempotency_key = 'rpc-run-1'));
insert into public.disbursements (
  id, org_id, project_id, run_id, run_item_id, run_item_payee_id, bill_id,
  funding_source_id, recipient_account_id, provider, status, amount_cents,
  currency, provider_payment_id, provider_transfer_id, provider_payout_id,
  idempotency_key
) select
  'c0000000-0000-0000-0000-000000000001', run.org_id, item.project_id, run.id,
  item.id, payee.id, item.bill_id, run.funding_source_id, payee.recipient_account_id,
  'stripe', 'payout_pending', payee.amount_cents, run.currency, 'pi_rpc_1', 'tr_rpc_1',
  'po_rpc_1', 'rpc-disbursement-1'
from public.payment_runs run
join public.payment_run_items item on item.run_id = run.id
join public.payment_run_item_payees payee on payee.run_item_id = item.id
where run.idempotency_key = 'rpc-run-1';

select throws_ok($rpc$
  select public.record_manual_ap_payment_atomic(
    '20000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000002',
    '10000000-0000-0000-0000-000000000001', 9000, 'eur', 'check', 'Check 100',
    '100', now(), '{"holds":[]}', 'rpc-manual-wrong-currency'
  )
$rpc$, 'P0001', 'Payment currency must match the vendor bill',
  'manual payments cannot change the approved obligation currency');
select lives_ok($rpc$
  select public.record_ap_payment_atomic(
    '20000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001',
    'pi_rpc_1', 'ch_rpc_1', 'tr_rpc_1', 'po_rpc_1', 'txn_rpc_1', now()
  )
$rpc$, 'record_ap_payment_atomic settles the complete AP hierarchy');
select is((select paid_cents from public.vendor_bills where id = 'b0000000-0000-0000-0000-000000000001'), 10000::bigint, 'electronic payment updates paid cents');
select is((select status from public.vendor_bills where id = 'b0000000-0000-0000-0000-000000000001'), 'paid', 'electronic payment closes the bill');
select is((select status from public.payment_runs where idempotency_key = 'rpc-run-1'), 'paid', 'electronic payment closes the run');
select ok((public.record_ap_payment_atomic(
  '20000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001',
  'pi_rpc_1', 'ch_rpc_1', 'tr_rpc_1', 'po_rpc_1', 'txn_rpc_1', now()
)->>'duplicate')::boolean, 'electronic settlement is idempotent');

select lives_ok($rpc$
  select public.record_ap_payment_reversal_atomic(
    '20000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001',
    10000, 'ach_return', 'dp_rpc_1', 'test return', '{}'
  )
$rpc$, 'record_ap_payment_reversal_atomic reopens settled AP');
select is((select paid_cents from public.vendor_bills where id = 'b0000000-0000-0000-0000-000000000001'), 0::bigint, 'reversal removes paid cents');
select is((select status from public.vendor_bills where id = 'b0000000-0000-0000-0000-000000000001'), 'approved', 'reversal reopens the bill');
select is((select status from public.payment_runs where idempotency_key = 'rpc-run-1'), 'failed', 'returned-only run rolls up to failed');

select lives_ok($rpc$
  select public.record_manual_ap_payment_atomic(
    '20000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000002',
    '10000000-0000-0000-0000-000000000001', 9000, 'usd', 'check', 'Check 101',
    '101', now(), '{"holds":[]}', 'rpc-manual-1'
  )
$rpc$, 'manual payment atomically respects retained balance');
select is((select status from public.vendor_bills where id = 'b0000000-0000-0000-0000-000000000002'), 'paid', 'total less retainage closes the manual bill');
select ok((public.record_manual_ap_payment_atomic(
  '20000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000002',
  '10000000-0000-0000-0000-000000000001', 9000, 'usd', 'check', 'Check 101',
  '101', now(), '{"holds":[]}', 'rpc-manual-1'
)->>'duplicate')::boolean, 'manual payment replay returns the committed result');
select is((select count(*)::integer from public.payments where idempotency_key = 'rpc-manual-1'), 1, 'manual replay cannot duplicate the payment row');

select lives_ok($rpc$
  select public.apply_vendor_credit_atomic(
    '20000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000004',
    'b0000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001',
    9000, 'rpc-credit-1', '{"holds":[]}'
  )
$rpc$, 'vendor credit is applied through the atomic payment writer');
select is((select status from public.vendor_bills where id = 'b0000000-0000-0000-0000-000000000003'), 'paid', 'full vendor credit closes the approved bill');

select throws_ok(
  $$update public.vendor_bills set status = 'approved' where id = 'b0000000-0000-0000-0000-000000000005'$$,
  'P0001', 'Complete the payable draft before approval',
  'database trigger rejects draft approval regardless of caller'
);

-- Reversing a payment somebody recorded by hand. Until this existed, a
-- bookkeeper's typo was permanent while an ACH return was not.
select lives_ok($rpc$
  select public.record_manual_ap_payment_atomic(
    '20000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000007',
    '10000000-0000-0000-0000-000000000001', 8000, 'usd', 'check', 'Check 900',
    '900', now(), '{"holds":[]}', 'rpc-reverse-seed'
  )
$rpc$, 'a manual payment is recorded so it can be reversed');
select is((select status from public.vendor_bills where id = 'b0000000-0000-0000-0000-000000000007'), 'paid', 'the seeded manual payment closes the payable');

select throws_ok($rpc$
  select public.reverse_manual_ap_payment_atomic(
    '20000000-0000-0000-0000-000000000001',
    (select id from public.payments where idempotency_key = 'rpc-reverse-seed'),
    '10000000-0000-0000-0000-000000000001', 8000, '   ', 'rpc-reversal-noreason'
  )
$rpc$, 'P0001', 'A reason is required to reverse a recorded payment',
  'a reversal must say why');

select throws_ok($rpc$
  select public.reverse_manual_ap_payment_atomic(
    '20000000-0000-0000-0000-000000000001',
    (select id from public.payments where idempotency_key = 'rpc-reverse-seed'),
    '10000000-0000-0000-0000-000000000001', 9999, 'over-reversal attempt', 'rpc-reversal-over'
  )
$rpc$, 'P0001', 'Reversal exceeds the recorded payment',
  'a reversal cannot exceed what was paid');

-- Rail money returns through the provider. Letting Arc reverse a real ACH debit
-- by hand would make the subledger disagree with the bank.
select throws_ok($rpc$
  select public.reverse_manual_ap_payment_atomic(
    '20000000-0000-0000-0000-000000000001',
    (select id from public.payments where org_id = '20000000-0000-0000-0000-000000000001'
       and bill_id = 'b0000000-0000-0000-0000-000000000001' limit 1),
    '10000000-0000-0000-0000-000000000001', null, 'should not be allowed', 'rpc-reversal-rail'
  )
$rpc$, 'P0001', 'This payment was made on the payment rail. Reverse it through the rail, not by hand.',
  'a rail payment cannot be reversed by hand');

select lives_ok($rpc$
  select public.reverse_manual_ap_payment_atomic(
    '20000000-0000-0000-0000-000000000001',
    (select id from public.payments where idempotency_key = 'rpc-reverse-seed'),
    '10000000-0000-0000-0000-000000000001', null, 'recorded against the wrong payable', 'rpc-reversal-1'
  )
$rpc$, 'a manual payment can be reversed in full');
select is((select paid_cents from public.vendor_bills where id = 'b0000000-0000-0000-0000-000000000007'), 0::bigint, 'reversal returns the payable balance');
select is((select status from public.vendor_bills where id = 'b0000000-0000-0000-0000-000000000007'), 'approved', 'a fully reversed payable is payable again');
select is((select paid_at from public.vendor_bills where id = 'b0000000-0000-0000-0000-000000000007'), null, 'a reversed payable is no longer stamped paid');
select is((select status from public.payments where idempotency_key = 'rpc-reverse-seed'), 'refunded', 'the reversed payment is marked refunded');
select ok((public.reverse_manual_ap_payment_atomic(
  '20000000-0000-0000-0000-000000000001',
  (select id from public.payments where idempotency_key = 'rpc-reverse-seed'),
  '10000000-0000-0000-0000-000000000001', null, 'recorded against the wrong payable', 'rpc-reversal-1'
)->>'duplicate')::boolean, 'reversal replay returns the committed result');
select is((select count(*)::integer from public.payment_reversals where provider_reversal_id = 'manual-reversal:rpc-reversal-1'), 1, 'reversal replay cannot double-reverse');

select * from finish();
rollback;
