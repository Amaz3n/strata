begin;
select plan(8);
select ok(not has_function_privilege('authenticated','public.assert_accounting_d2_ready()','EXECUTE'),'members cannot authorize D2 cleanup');
select throws_ok('select public.assert_accounting_d2_ready()','P0001','HOLD D2: no active approved acceptance campaign','no campaign fails closed');
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,created_at,updated_at,raw_app_meta_data,raw_user_meta_data) values('19000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000000','authenticated','authenticated','d2-gate@example.test','',now(),now(),now(),'{}','{}');
insert into app_users(id,email,full_name) values('19000000-0000-0000-0000-000000000001','d2-gate@example.test','Gate Reviewer');
insert into orgs(id,name,slug,created_by) values('29000000-0000-0000-0000-000000000001','Gate Test','d2-gate-test','19000000-0000-0000-0000-000000000001');
insert into accounting_connections(id,org_id,provider,label,external_account_id,external_account_name,status,connected_by,refresh_failure_count,token_expires_at,refresh_token_expires_at,last_inbound_poll_at) values('39000000-0000-0000-0000-000000000001','29000000-0000-0000-0000-000000000001','qbo','Gate Books','gate-realm','Gate Books','active','19000000-0000-0000-0000-000000000001',0,now()+interval '1 hour',now()+interval '90 days',now());
create table if not exists public.accounting_d2_legacy_archive(org_id uuid,source_table text,entity_id uuid,legacy_data jsonb,captured_at timestamptz default now(),unique(org_id,source_table,entity_id));
insert into job_runs(job_name,status,started_at,finished_at,duration_ms,http_status) select name,'success',now()-interval '1 minute',now(),60000,200 from unnest(array['accounting-process-outbox','accounting-process-inbound','accounting-process-changes','accounting-reconciliation']) name;
insert into accounting_d2_campaigns(id,candidate_sha,schema_fingerprint,checker_version,parity_version,expected_org_id,expected_connection_id,expected_realm_id,expected_company_name,release_evidence,approved_by,approved_at,started_at,created_at)
values('59000000-0000-0000-0000-000000000001',repeat('a',40),accounting_d2_schema_fingerprint(),'accounting-d2-v1','legacy-present-neutral-equivalence-v1','29000000-0000-0000-0000-000000000001','39000000-0000-0000-0000-000000000001','gate-realm','Gate Books',jsonb_build_object('candidate_sha',repeat('a',40),'runtime_consumers',0,'drop_rehearsal_passed',true,'repairs_verified',true,'artifact_inventory_complete',true,'archive_verified',true),'19000000-0000-0000-0000-000000000001',now()-interval '16 days',now()-interval '15 days',now()-interval '17 days');

insert into projects(id,org_id,name) values('49000000-0000-0000-0000-000000000002','29000000-0000-0000-0000-000000000001','Mirror fixture');
insert into project_expenses(id,org_id,project_id,expense_date,amount_cents,accounting_coding,qbo_expense_account_id,qbo_expense_account_name)
values('49000000-0000-0000-0000-000000000003','29000000-0000-0000-0000-000000000001','49000000-0000-0000-0000-000000000002',current_date,90000,'{"expense_account":{"id":"old","name":"Old"}}','old','Old');
insert into accounting_sync_records(org_id,connection_id,provider,entity_type,entity_id,external_id,status)
values('29000000-0000-0000-0000-000000000001','39000000-0000-0000-0000-000000000001','qbo','project_expense','49000000-0000-0000-0000-000000000003','237','synced');
update project_expenses set accounting_coding='{"expense_account":{"id":"new","name":"New"}}' where id='49000000-0000-0000-0000-000000000003';
select is((select qbo_expense_account_id from project_expenses where id='49000000-0000-0000-0000-000000000003'),'new','neutral account update mirrors temporary compatibility ID');
select is((select amount_cents from project_expenses where id='49000000-0000-0000-0000-000000000003'),90000,'coding changes preserve money');
select is((select legacy_data->>'qbo_expense_account_id' from accounting_d2_legacy_archive where entity_id='49000000-0000-0000-0000-000000000003'),'new','archive tracks current compatibility');
select ok(exists(select 1 from audit_log where entity_id='49000000-0000-0000-0000-000000000003' and before_data->>'qbo_expense_account_id'='old' and after_data->>'qbo_expense_account_id'='new'),'old archive value survives in audit history');
update project_expenses set qbo_expense_account_id='disagreement' where id='49000000-0000-0000-0000-000000000003';
select throws_ok($q$update project_expenses set accounting_coding='{"expense_account":{"id":"third"}}' where id='49000000-0000-0000-0000-000000000003'$q$,'P0001','Existing compatibility disagreement requires reviewed repair','preexisting disagreement fails closed');
select ok(not has_function_privilege('authenticated','public.accounting_d2_refresh_archive()','EXECUTE'),'archive helper is not a public RPC');
select * from finish();
rollback;
