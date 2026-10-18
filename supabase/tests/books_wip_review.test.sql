begin;
select plan(19);
insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) values (
  '13000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'books-wip-review@example.test', '', now(),
  now(), now(), '{}'::jsonb, '{}'::jsonb
);
insert into public.app_users (id, email, full_name)
values ('13000000-0000-0000-0000-000000000001', 'books-wip-review@example.test', 'Books WIP Review Test');
insert into public.orgs (id, name, slug, created_by)
values ('23000000-0000-0000-0000-000000000001', 'Books WIP Review Test', 'books-wip-review-test', '13000000-0000-0000-0000-000000000001');

insert into public.projects(id,org_id,name) values('53000000-0000-0000-0000-000000000001','23000000-0000-0000-0000-000000000001','WIP project');
insert into public.accounting_periods(id,org_id,period_start,period_end,fiscal_year,fiscal_period)
values('43000000-0000-0000-0000-000000000001','23000000-0000-0000-0000-000000000001','2026-09-01','2026-09-30',2026,9);
insert into public.poc_snapshots(id,org_id,project_id,as_of,original_contract_cents,approved_change_orders_cents,revised_contract_cents,cost_to_date_cents,eac_cents,percent_complete,earned_revenue_cents,billed_cents,over_under_cents,forecast_gross_profit_cents,inputs_hash,preparation)
values('63000000-0000-0000-0000-000000000001','23000000-0000-0000-0000-000000000001','53000000-0000-0000-0000-000000000001','2026-09-30',10000,0,10000,4000,8000,0.5,5000,3000,-2000,2000,'review-hash','{"kind":"period_prepared","sources":{"costs":[],"billings":[],"credits":[]}}');
create function pg_temp.wip_review_test(amount bigint default 5000) returns jsonb language sql as $$
  select public.review_books_wip_atomic('23000000-0000-0000-0000-000000000001','43000000-0000-0000-0000-000000000001','13000000-0000-0000-0000-000000000001',
  jsonb_build_object('note','Reviewed contract and estimate','snapshots',jsonb_build_array(jsonb_build_object(
  'projectId','53000000-0000-0000-0000-000000000001','snapshotId','63000000-0000-0000-0000-000000000001','inputsHash','review-hash','asOf','2026-09-30','earnedRevenueCents',amount,'warnings','[]'::jsonb))));
$$;
select throws_matching($$select pg_temp.wip_review_test(5001)$$,'evidence changed','altered amount is rejected');
select lives_ok($$select pg_temp.wip_review_test()$$,'valid evidence is approved');
select is((select support_review->>'reviewerId' from public.books_close_items where period_id='43000000-0000-0000-0000-000000000001'),'13000000-0000-0000-0000-000000000001','reviewer is attributed');
select ok(not has_function_privilege('authenticated','public.review_books_wip_atomic(uuid,uuid,uuid,jsonb)','execute'),'browser role cannot bypass service authorization');
select lives_ok($$select public.begin_books_period_close('23000000-0000-0000-0000-000000000001','43000000-0000-0000-0000-000000000001')$$,'begin close');
select throws_matching($$select pg_temp.wip_review_test()$$,'Reopen','review is frozen during close');
select throws_matching($$insert into public.poc_snapshots(org_id,project_id,as_of,original_contract_cents,approved_change_orders_cents,revised_contract_cents,cost_to_date_cents,eac_cents,percent_complete,earned_revenue_cents,billed_cents,over_under_cents,forecast_gross_profit_cents,inputs_hash)
values('23000000-0000-0000-0000-000000000001','53000000-0000-0000-0000-000000000001','2026-09-30',10000,0,10000,4000,8000,0.5,5000,3000,-2000,2000,'late-hash')$$,'evidence is frozen','new evidence cannot replace reviewed figures during close');
update public.accounting_periods set status='reopened' where id='43000000-0000-0000-0000-000000000001';
insert into public.job_cost_entries(org_id,project_id,source_type,source_id,incurred_on,cost_cents,status)
values('23000000-0000-0000-0000-000000000001','53000000-0000-0000-0000-000000000001','project_expense','73000000-0000-0000-0000-000000000001','2026-09-30',1000,'posted');
select ok(not public.books_wip_sources_current('23000000-0000-0000-0000-000000000001',array['63000000-0000-0000-0000-000000000001']::uuid[]),'late cost invalidates prepared source evidence');
select lives_ok($$select public.prepare_books_wip_atomic('23000000-0000-0000-0000-000000000001','43000000-0000-0000-0000-000000000001','53000000-0000-0000-0000-000000000001','13000000-0000-0000-0000-000000000001',10000,0,5000,'Estimate supported by dated construction records')$$,'reopened period can prepare a corrected position');
select is((select earned_revenue_cents from public.poc_snapshots where project_id='53000000-0000-0000-0000-000000000001' order by created_at desc,id desc limit 1),2000::bigint,'new dated costs drive earned revenue');
select is((select preparation->>'preparedBy' from public.poc_snapshots where project_id='53000000-0000-0000-0000-000000000001' order by created_at desc,id desc limit 1),'13000000-0000-0000-0000-000000000001','preparation preserves attribution');

select lives_ok($$do $body$
declare snapshot_id uuid; snapshot_hash text;
begin
  snapshot_id:=public.prepare_books_wip_atomic('23000000-0000-0000-0000-000000000001','43000000-0000-0000-0000-000000000001','53000000-0000-0000-0000-000000000001','13000000-0000-0000-0000-000000000001',10000,0,1000,'Final completed project estimate supported by actual costs');
  select inputs_hash into snapshot_hash from public.poc_snapshots where id=snapshot_id;
  perform public.review_books_wip_atomic('23000000-0000-0000-0000-000000000001','43000000-0000-0000-0000-000000000001','13000000-0000-0000-0000-000000000001',jsonb_build_object('note','Reviewed final completion estimate','snapshots',jsonb_build_array(jsonb_build_object('projectId','53000000-0000-0000-0000-000000000001','snapshotId',snapshot_id,'inputsHash',snapshot_hash,'asOf','2026-09-30','earnedRevenueCents',10000,'warnings','[]'::jsonb))));
  update public.accounting_periods set status='closed',closed_at=now(),closed_by='13000000-0000-0000-0000-000000000001',close_digest='test' where id='43000000-0000-0000-0000-000000000001';
  update public.projects set status='completed' where id='53000000-0000-0000-0000-000000000001';
end; $body$; $$,'final WIP position can be reviewed and closed');
insert into public.accounting_periods(id,org_id,period_start,period_end,fiscal_year,fiscal_period)
values('43000000-0000-0000-0000-000000000002','23000000-0000-0000-0000-000000000001','2026-10-01','2026-10-01',2026,10);
select lives_ok($$select public.carry_forward_books_wip_atomic('23000000-0000-0000-0000-000000000001','43000000-0000-0000-0000-000000000002','53000000-0000-0000-0000-000000000001','13000000-0000-0000-0000-000000000001','Final contract and estimate confirmed unchanged')$$,'completed final estimate carries forward');
select is((select preparation->>'carriedFromPeriodId' from public.poc_snapshots where project_id='53000000-0000-0000-0000-000000000001' and as_of='2026-10-01'),'43000000-0000-0000-0000-000000000001','carryforward retains the prior approved period');
insert into public.job_cost_entries(org_id,project_id,source_type,source_id,incurred_on,cost_cents,status)
values('23000000-0000-0000-0000-000000000001','53000000-0000-0000-0000-000000000001','project_expense','73000000-0000-0000-0000-000000000002','2026-10-01',100,'posted');
select throws_matching($$select public.carry_forward_books_wip_atomic('23000000-0000-0000-0000-000000000001','43000000-0000-0000-0000-000000000002','53000000-0000-0000-0000-000000000001','13000000-0000-0000-0000-000000000001','Final contract and estimate confirmed unchanged')$$,'costs or billings changed','late cost prevents carrying the old estimate forward');

insert into public.projects(id,org_id,name) values('53000000-0000-0000-0000-000000000002','23000000-0000-0000-0000-000000000001','Exact WIP cents');
insert into public.job_cost_entries(org_id,project_id,source_type,source_id,incurred_on,cost_cents,status)
values('23000000-0000-0000-0000-000000000001','53000000-0000-0000-0000-000000000002','project_expense','73000000-0000-0000-0000-000000000003','2026-10-01',29,'posted');
select lives_ok($$select public.prepare_books_wip_atomic('23000000-0000-0000-0000-000000000001','43000000-0000-0000-0000-000000000002','53000000-0000-0000-0000-000000000002','13000000-0000-0000-0000-000000000001',1000031715595,0,110,'Exact rounding test with documented estimate')$$,'integer rounding preparation succeeds');
select is((select earned_revenue_cents from public.poc_snapshots where project_id='53000000-0000-0000-0000-000000000002'),263644725021::bigint,'earned revenue rounds exact cents');
select throws_matching($$update public.poc_snapshots set earned_revenue_cents=0 where project_id='53000000-0000-0000-0000-000000000002'$$,'append-only','prepared earned revenue is immutable');
select throws_matching($$select public.prepare_books_wip_atomic('23000000-0000-0000-0000-000000000001','43000000-0000-0000-0000-000000000002','53000000-0000-0000-0000-000000000002','13000000-0000-0000-0000-000000000001',1000031715595,0,28,'Invalid completion estimate below dated cost')$$,'below incurred','EAC cannot understate incurred costs');
select * from finish();
rollback;
