begin;

select plan(11);

select has_function(
  'public',
  'project_books_fact_and_journal_atomic',
  array['uuid','uuid','jsonb','jsonb','jsonb','date','text'],
  'atomic projector RPC exists'
);

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) values (
  '11000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'books-rpc@example.test', '', now(),
  now(), now(), '{}'::jsonb, '{}'::jsonb
);
insert into public.app_users (id, email, full_name)
values ('11000000-0000-0000-0000-000000000001', 'books-rpc@example.test', 'Books RPC Test');
insert into public.orgs (id, name, slug, created_by)
values ('21000000-0000-0000-0000-000000000001', 'Books RPC Test', 'books-rpc-test', '11000000-0000-0000-0000-000000000001');
insert into public.gl_accounts (
  id, org_id, code, name, account_type, subtype, normal_balance,
  cash_flow_category, is_system, active
) values
  ('31000000-0000-0000-0000-000000000001', '21000000-0000-0000-0000-000000000001', '1000', 'Cash', 'asset', 'cash', 'debit', 'cash', true, true),
  ('31000000-0000-0000-0000-000000000002', '21000000-0000-0000-0000-000000000001', '4900', 'Other revenue', 'income', 'other_revenue', 'credit', 'operating', false, true);
insert into public.accounting_periods (
  id, org_id, period_start, period_end, fiscal_year, fiscal_period, status
) values (
  '41000000-0000-0000-0000-000000000001',
  '21000000-0000-0000-0000-000000000001',
  '2026-08-01', '2026-08-31', 2026, 8, 'open'
);

select lives_ok($$
  select public.project_books_fact_and_journal_atomic(
    '21000000-0000-0000-0000-000000000001', null,
    jsonb_build_object(
      'source_type', 'test_receipt',
      'source_id', '51000000-0000-0000-0000-000000000001',
      'source_version', 1,
      'fact_kind', 'test_receipt.recognized',
      'occurred_at', '2026-08-01T12:00:00Z',
      'accounting_date', '2026-08-01',
      'payload', jsonb_build_object('amount_cents', 10000),
      'payload_hash', repeat('a', 64),
      'policy_version', 1,
      'idempotency_key', repeat('1', 64)
    ),
    jsonb_build_object(
      'entry_date', '2026-08-01',
      'entry_kind', 'operational',
      'memo', 'Initial receipt',
      'posting_key', 'test-receipt:v1',
      'projection_version', 1,
      'policy_version', 1,
      'source_type', 'test_receipt',
      'source_id', '51000000-0000-0000-0000-000000000001'
    ),
    jsonb_build_array(
      jsonb_build_object('line_no', 1, 'account_id', '31000000-0000-0000-0000-000000000001', 'debit_cents', 10000, 'credit_cents', 0),
      jsonb_build_object('line_no', 2, 'account_id', '31000000-0000-0000-0000-000000000002', 'debit_cents', 0, 'credit_cents', 10000)
    ),
    '2026-08-01', 'test source revised'
  )
$$, 'initial fact and journal post together');

select is((select count(*)::integer from public.accounting_facts where org_id = '21000000-0000-0000-0000-000000000001'), 1, 'one initial fact');
select is((select count(*)::integer from public.journal_entries where org_id = '21000000-0000-0000-0000-000000000001' and status = 'posted'), 1, 'one initial posted journal');

select lives_ok($$
  do $block$
  declare prior_id uuid;
  begin
    select id into prior_id from public.accounting_facts
    where org_id = '21000000-0000-0000-0000-000000000001'
    order by source_version desc limit 1;
    perform public.project_books_fact_and_journal_atomic(
      '21000000-0000-0000-0000-000000000001', prior_id,
      jsonb_build_object(
        'source_type', 'test_receipt', 'source_id', '51000000-0000-0000-0000-000000000001',
        'source_version', 2, 'fact_kind', 'test_receipt.recognized',
        'occurred_at', '2026-08-02T12:00:00Z', 'accounting_date', '2026-08-02',
        'payload', jsonb_build_object('amount_cents', 12500),
        'payload_hash', repeat('b', 64), 'policy_version', 1, 'idempotency_key', repeat('2', 64)
      ),
      jsonb_build_object(
        'entry_date', '2026-08-02', 'entry_kind', 'operational', 'memo', 'Revised receipt',
        'posting_key', 'test-receipt:v2', 'projection_version', 1, 'policy_version', 1,
        'source_type', 'test_receipt', 'source_id', '51000000-0000-0000-0000-000000000001'
      ),
      jsonb_build_array(
        jsonb_build_object('line_no', 1, 'account_id', '31000000-0000-0000-0000-000000000001', 'debit_cents', 12500, 'credit_cents', 0),
        jsonb_build_object('line_no', 2, 'account_id', '31000000-0000-0000-0000-000000000002', 'debit_cents', 0, 'credit_cents', 12500)
      ),
      '2026-08-02', 'test source revised'
    );
  end $block$
$$, 'revision reverses and replaces in one transaction');

select is((select count(*)::integer from public.accounting_facts where org_id = '21000000-0000-0000-0000-000000000001'), 2, 'revision creates the next immutable fact');
select is((select count(*)::integer from public.journal_entries where org_id = '21000000-0000-0000-0000-000000000001' and entry_kind = 'reversal'), 1, 'revision creates one reversal');
select is((select count(*)::integer from public.journal_entries where org_id = '21000000-0000-0000-0000-000000000001' and status = 'reversed'), 1, 'prior journal is marked reversed');
select is((select count(*)::integer from public.journal_entries where org_id = '21000000-0000-0000-0000-000000000001' and status = 'posted'), 2, 'replacement and reversal are posted');

select throws_ok(
  $$insert into public.journal_lines (
      org_id, entry_id, line_no, account_id, debit_cents, credit_cents
    ) select org_id, id, 99, '31000000-0000-0000-0000-000000000001', 1, 0
      from public.journal_entries
      where org_id = '21000000-0000-0000-0000-000000000001' and status = 'posted'
      limit 1$$,
  'Posted journal lines are immutable; create a reversal',
  'posted journals reject inserted lines'
);

select is(
  (select count(*)::integer from public.journal_entries where org_id = '21000000-0000-0000-0000-000000000001'),
  3,
  'failed line mutation leaves journal count unchanged'
);

select * from finish();
rollback;
