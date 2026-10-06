begin;
select plan(8);
insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) values (
  '15000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'books-wip-allocation@example.test', '', now(),
  now(), now(), '{}'::jsonb, '{}'::jsonb
);
insert into public.app_users (id, email, full_name)
values ('15000000-0000-0000-0000-000000000001', 'books-wip-allocation@example.test', 'Books WIP Allocation Test');
insert into public.orgs (id, name, slug, created_by)
values ('25000000-0000-0000-0000-000000000001', 'Books WIP Allocation Test', 'books-wip-allocation-test', '15000000-0000-0000-0000-000000000001');

insert into public.projects(id,org_id,name) values('55000000-0000-0000-0000-000000000001','25000000-0000-0000-0000-000000000001','WIP project');
insert into public.accounting_periods(id,org_id,period_start,period_end,fiscal_year,fiscal_period)
values('45000000-0000-0000-0000-000000000001','25000000-0000-0000-0000-000000000001','2026-09-01','2026-09-30',2026,9);

insert into public.gl_accounts(id,org_id,code,name,account_type,subtype,normal_balance) values
('35000000-0000-0000-0000-000000000001','25000000-0000-0000-0000-000000000001','1000','Cash','asset','cash','debit'),
('35000000-0000-0000-0000-000000000002','25000000-0000-0000-0000-000000000001','4010','Native income','income','construction_revenue','credit');
insert into public.job_cost_entries(org_id,project_id,source_type,source_id,incurred_on,cost_cents,status)
values('25000000-0000-0000-0000-000000000001','55000000-0000-0000-0000-000000000001','project_expense','75000000-0000-0000-0000-000000000001','2026-09-30',60000,'posted');
create temporary table loss_snapshot as select public.prepare_books_wip_atomic(
'25000000-0000-0000-0000-000000000001','45000000-0000-0000-0000-000000000001','55000000-0000-0000-0000-000000000001','15000000-0000-0000-0000-000000000001',100000,0,120000,'Documented final estimate with expected construction loss') id;

create function pg_temp.allocate_wip(amount bigint default 100000) returns uuid language sql as $$
select public.allocate_books_wip_revenue_atomic('25000000-0000-0000-0000-000000000001','45000000-0000-0000-0000-000000000001',(select id from loss_snapshot),'15000000-0000-0000-0000-000000000001',jsonb_build_array(jsonb_build_object('account_id','35000000-0000-0000-0000-000000000002','contract_cents',amount)),'Reviewed construction income account allocation');
$$;
select ok(not has_function_privilege('authenticated','public.allocate_books_wip_revenue_atomic(uuid,uuid,uuid,uuid,jsonb,text)','execute'),'browser cannot bypass allocation authorization');
select ok(has_function_privilege('service_role','public.allocate_books_wip_revenue_atomic(uuid,uuid,uuid,uuid,jsonb,text)','execute'),'service can allocate reviewed WIP');
select throws_matching($$select pg_temp.allocate_wip(99999)$$,'equal the reviewed','allocation must cover the whole revised contract');
create temporary table allocated_snapshot as select pg_temp.allocate_wip() id;
select is((select revenue_allocations::text from poc_snapshots where id=(select id from loss_snapshot)),'[]','prior snapshot stays immutable');
select isnt((select inputs_hash from poc_snapshots where id=(select id from allocated_snapshot)),(select inputs_hash from poc_snapshots where id=(select id from loss_snapshot)),'allocation revision has new evidence hash');
select ok(public.books_wip_sources_current('25000000-0000-0000-0000-000000000001',array[(select id from allocated_snapshot)]),'new allocation has valid current evidence');
select throws_matching($$select public.review_books_wip_atomic('25000000-0000-0000-0000-000000000001','45000000-0000-0000-0000-000000000001','15000000-0000-0000-0000-000000000001',jsonb_build_object('note','Reviewed superseded estimate','snapshots',jsonb_build_array(jsonb_build_object('projectId',s.project_id,'snapshotId',s.id,'inputsHash',s.inputs_hash,'asOf',s.as_of,'earnedRevenueCents',s.earned_revenue_cents)))) from poc_snapshots s join loss_snapshot x on x.id=s.id$$,'superseded','allocation invalidates approval of prior snapshot');
select public.review_books_wip_atomic('25000000-0000-0000-0000-000000000001','45000000-0000-0000-0000-000000000001','15000000-0000-0000-0000-000000000001',jsonb_build_object('note','Reviewed native income allocation','snapshots',jsonb_build_array(jsonb_build_object('projectId',s.project_id,'snapshotId',s.id,'inputsHash',s.inputs_hash,'asOf',s.as_of,'earnedRevenueCents',s.earned_revenue_cents)))) from poc_snapshots s join allocated_snapshot x on x.id=s.id;
select public.begin_books_period_close('25000000-0000-0000-0000-000000000001','45000000-0000-0000-0000-000000000001');
select throws_matching($$select pg_temp.allocate_wip()$$,'Reopen','allocations freeze during close');
select * from finish();
rollback;
