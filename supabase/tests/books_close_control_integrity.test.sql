begin;
select plan(7);
insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) values (
  '12000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'books-close-control@example.test', '', now(),
  now(), now(), '{}'::jsonb, '{}'::jsonb
);
insert into public.app_users (id, email, full_name)
values ('12000000-0000-0000-0000-000000000001', 'books-close-control@example.test', 'Books Close Control Test');
insert into public.orgs (id, name, slug, created_by)
values ('22000000-0000-0000-0000-000000000001', 'Books Close Control Test', 'books-close-control-test', '12000000-0000-0000-0000-000000000001');
insert into public.gl_accounts (
  id, org_id, code, name, account_type, subtype, normal_balance,
  cash_flow_category, is_system, active
) values
  ('32000000-0000-0000-0000-000000000001', '22000000-0000-0000-0000-000000000001', '1000', 'Cash', 'asset', 'cash', 'debit', 'cash', true, true),
  ('32000000-0000-0000-0000-000000000002', '22000000-0000-0000-0000-000000000001', '4900', 'Other revenue', 'income', 'other_revenue', 'credit', 'operating', false, true);
insert into public.accounting_periods (
  id, org_id, period_start, period_end, fiscal_year, fiscal_period, status
) values (
  '42000000-0000-0000-0000-000000000001',
  '22000000-0000-0000-0000-000000000001',
  '2026-12-01', '2026-12-31', 2026, 12, 'open'
);

insert into public.gl_accounts (id,org_id,code,name,account_type,subtype,normal_balance)
values ('32000000-0000-0000-0000-000000000003','22000000-0000-0000-0000-000000000001','3100','Retained earnings','equity','retained_earnings','credit');

create function pg_temp.close_test_post(post_key text, source text, kind text, entry_day date default '2026-12-31', source_uuid uuid default '42000000-0000-0000-0000-000000000001') returns uuid language sql as $fn$
  select public.post_books_journal_entry(
    '22000000-0000-0000-0000-000000000001',
    jsonb_build_object('entry_date',entry_day,'entry_kind',kind,'memo',post_key,'posting_key',post_key,'policy_version',1,'source_type',source,'source_id',source_uuid),
    jsonb_build_array(
      jsonb_build_object('line_no',1,'account_id','32000000-0000-0000-0000-000000000002','debit_cents',10000,'credit_cents',0),
      jsonb_build_object('line_no',2,'account_id','32000000-0000-0000-0000-000000000003','debit_cents',0,'credit_cents',10000)
    )
  );
$fn$;

select lives_ok($$ select public.begin_books_period_close('22000000-0000-0000-0000-000000000001','42000000-0000-0000-0000-000000000001') $$, 'begin close freezes the period');
select throws_matching($$ select pg_temp.close_test_post('late-operational','invoice','operational') $$, 'reviewing', 'ordinary postings remain frozen');
select throws_matching($$ select pg_temp.close_test_post('wrong-kind','year_end_close','operational') $$, 'reviewing', 'source label cannot bypass entry kind');
select throws_matching($$ select pg_temp.close_test_post('wrong-date','year_end_close','closing','2026-12-30') $$, 'reviewing', 'closing date must equal period end');
select throws_matching($$ select pg_temp.close_test_post('wrong-source','year_end_close','closing','2026-12-31','42000000-0000-0000-0000-000000000099') $$, 'reviewing', 'closing source must identify this period');
select lives_ok($$ select pg_temp.close_test_post('valid-close','year_end_close','closing') $$, 'year-end journal posts during review through the real RPC');
select is((select count(*)::integer from public.journal_entries where org_id='22000000-0000-0000-0000-000000000001'),1,'rejected attempts leave no journals');
set constraints all immediate;
select * from finish();
rollback;
