begin;
select plan(7);
insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) values (
  '14000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'books-expected-loss@example.test', '', now(),
  now(), now(), '{}'::jsonb, '{}'::jsonb
);
insert into public.app_users (id, email, full_name)
values ('14000000-0000-0000-0000-000000000001', 'books-expected-loss@example.test', 'Books Expected Loss Test');
insert into public.orgs (id, name, slug, created_by)
values ('24000000-0000-0000-0000-000000000001', 'Books Expected Loss Test', 'books-expected-loss-test', '14000000-0000-0000-0000-000000000001');

insert into public.projects(id,org_id,name) values('54000000-0000-0000-0000-000000000001','24000000-0000-0000-0000-000000000001','WIP project');
insert into public.accounting_periods(id,org_id,period_start,period_end,fiscal_year,fiscal_period)
values('44000000-0000-0000-0000-000000000001','24000000-0000-0000-0000-000000000001','2026-09-01','2026-09-30',2026,9);

insert into public.gl_accounts(id,org_id,code,name,account_type,subtype,normal_balance) values
('34000000-0000-0000-0000-000000000001','24000000-0000-0000-0000-000000000001','1000','Cash','asset','cash','debit'),
('34000000-0000-0000-0000-000000000002','24000000-0000-0000-0000-000000000001','4000','Revenue','income','construction_revenue','credit');
insert into public.job_cost_entries(org_id,project_id,source_type,source_id,incurred_on,cost_cents,status)
values('24000000-0000-0000-0000-000000000001','54000000-0000-0000-0000-000000000001','project_expense','74000000-0000-0000-0000-000000000001','2026-09-30',60000,'posted');
create temporary table loss_snapshot as select public.prepare_books_wip_atomic(
'24000000-0000-0000-0000-000000000001','44000000-0000-0000-0000-000000000001','54000000-0000-0000-0000-000000000001','14000000-0000-0000-0000-000000000001',100000,0,120000,'Documented final estimate with expected construction loss') id;
select public.review_books_wip_atomic('24000000-0000-0000-0000-000000000001','44000000-0000-0000-0000-000000000001','14000000-0000-0000-0000-000000000001',
jsonb_build_object('note','Reviewed estimate and expected loss','snapshots',jsonb_build_array(jsonb_build_object('projectId',s.project_id,'snapshotId',s.id,'inputsHash',s.inputs_hash,'asOf',s.as_of,'earnedRevenueCents',s.earned_revenue_cents)))) from public.poc_snapshots s join loss_snapshot x on x.id=s.id;
create function pg_temp.loss_post() returns jsonb language sql as $$
select public.post_books_expected_loss_atomic('24000000-0000-0000-0000-000000000001','44000000-0000-0000-0000-000000000001',(select id from loss_snapshot),'14000000-0000-0000-0000-000000000001',1,1);
$$;
select throws_matching($$select pg_temp.loss_post()$$,'requires the period close review','provision belongs to close');
select public.post_books_journal_entry('24000000-0000-0000-0000-000000000001',jsonb_build_object('entry_date','2026-09-30','entry_kind','poc','source_type','revenue_recognition','source_id','54000000-0000-0000-0000-000000000001','memo','Reviewed earned revenue','posting_key','expected-loss-test-revenue','policy_version',1),jsonb_build_array(
jsonb_build_object('line_no',1,'account_id','34000000-0000-0000-0000-000000000001','project_id','54000000-0000-0000-0000-000000000001','debit_cents',50000,'credit_cents',0),
jsonb_build_object('line_no',2,'account_id','34000000-0000-0000-0000-000000000002','project_id','54000000-0000-0000-0000-000000000001','debit_cents',0,'credit_cents',50000)));
select public.begin_books_period_close('24000000-0000-0000-0000-000000000001','44000000-0000-0000-0000-000000000001');
select is((pg_temp.loss_post()->>'deltaCents')::bigint,10000::bigint,'reserve excludes loss already incurred');
select is((pg_temp.loss_post()->>'posted')::boolean,false,'retry posts no duplicate');
select is((select subtype from public.gl_accounts where org_id='24000000-0000-0000-0000-000000000001' and code='2360'),'expected_contract_loss_reserve','reserve has accepted liability subtype');
select is((select subtype from public.gl_accounts where org_id='24000000-0000-0000-0000-000000000001' and code='5060'),'expected_contract_loss_expense','provision has accepted expense subtype');
select is((select sum(l.credit_cents-l.debit_cents)::bigint from public.journal_lines l join public.gl_accounts a on a.id=l.account_id where a.org_id='24000000-0000-0000-0000-000000000001' and a.code='2360'),10000::bigint,'reserve is in the ledger');
select ok(not has_function_privilege('authenticated','public.post_books_expected_loss_atomic(uuid,uuid,uuid,uuid,integer,integer)','execute'),'browser role cannot post provisions');
set constraints all immediate;
select * from finish();
rollback;
