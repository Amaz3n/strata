begin;
select plan(20);
select ok(not has_table_privilege('authenticated','public.accounting_d2_acceptance_samples','INSERT'),'members cannot manufacture passing days');
select ok(not has_table_privilege('service_role','public.accounting_d2_acceptance_samples','UPDATE'),'service role cannot erase failed days');
select ok(not has_table_privilege('service_role','public.accounting_d2_acceptance_samples','INSERT'),'even service callers use the measured collector');
select ok(not has_function_privilege('anon','public.capture_accounting_d2_acceptance(text,text,boolean)','EXECUTE'),'anonymous callers cannot capture release evidence');
select ok(not has_function_privilege('authenticated','public.capture_accounting_d2_acceptance(text,text,boolean)','EXECUTE'),'members cannot invoke service collector');
select ok(has_function_privilege('service_role','public.capture_accounting_d2_acceptance(text,text,boolean)','EXECUTE'),'cron service can invoke collector');
select is((select count(*)::integer from public.capture_accounting_d2_acceptance(repeat('a',40),'accounting-d2-v1',true)),0,'no campaign means no synthetic acceptance history');
select is((public.accounting_d2_parity_snapshot()->>'complete')::boolean,true,'global parity returns a complete aggregate');
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,created_at,updated_at,raw_app_meta_data,raw_user_meta_data)
values('18000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000000','authenticated','authenticated','acceptance@example.test','',now(),now(),now(),'{}','{}');
insert into public.app_users(id,email,full_name) values('18000000-0000-0000-0000-000000000001','acceptance@example.test','Acceptance Reviewer');
insert into public.orgs(id,name,slug,created_by) values('28000000-0000-0000-0000-000000000001','Acceptance Test','accounting-acceptance-test','18000000-0000-0000-0000-000000000001');
insert into public.accounting_connections(id,org_id,provider,label,external_account_id,status,connected_by)
values('38000000-0000-0000-0000-000000000001','28000000-0000-0000-0000-000000000001','qbo','Acceptance Book','acceptance-realm','active','18000000-0000-0000-0000-000000000001');
insert into public.accounting_d2_campaigns(candidate_sha,schema_fingerprint,checker_version,parity_version,expected_org_id,expected_connection_id,expected_realm_id,expected_company_name,release_evidence,approved_by)
values(repeat('a',40),public.accounting_d2_schema_fingerprint(),'accounting-d2-v1','legacy-present-neutral-equivalence-v1','28000000-0000-0000-0000-000000000001','38000000-0000-0000-0000-000000000001','acceptance-realm','Acceptance Book','{}','18000000-0000-0000-0000-000000000001');
select is((select passed from public.capture_accounting_d2_acceptance(repeat('b',40),'accounting-d2-v1',false)),false,'unhealthy or unidentified deployment fails closed');
select ok((select evidence->'blockers' ? 'deployment_sha_mismatch' from public.accounting_d2_acceptance_samples order by id desc limit 1),'candidate mismatch is measured');
select ok((select evidence->'blockers' ? 'nightly_reconciliation_incomplete' from public.accounting_d2_acceptance_samples order by id desc limit 1),'incomplete nightly run is persisted as a failure');
select ok((select evidence->'blockers' ? 'release_prerequisites_unverified' from public.accounting_d2_acceptance_samples order by id desc limit 1),'release evidence must affirm repaired artifacts and rehearsal');
select is((select passed from public.capture_accounting_d2_acceptance(repeat('a',40),'accounting-d2-v1',true)),false,'matching SHA alone cannot manufacture a passing day');
select is((select count(*)::integer from public.accounting_d2_acceptance_samples),2,'retries append instead of replacing failed evidence');
insert into public.accounting_d2_decisions(org_id,connection_id,entity_type,entity_id,before_state,proposed_action,expected_after_state,status,disposition,rationale,reviewed_by,reviewed_at)
values('28000000-0000-0000-0000-000000000001','38000000-0000-0000-0000-000000000001','bill','fixture','{"updated_at":"old","amount_cents":100}', 'Preserve inspected history','{}','approved','preserve_history','Reviewed immutable historical fixture','18000000-0000-0000-0000-000000000001',now());
select ok(public.accounting_d2_disposition_matches('28000000-0000-0000-0000-000000000001','38000000-0000-0000-0000-000000000001','bill','fixture','{"updated_at":"old","amount_cents":100,"status":"conflict"}'),'approved disposition matches exact reviewed before values');
select ok(not public.accounting_d2_disposition_matches('28000000-0000-0000-0000-000000000001','38000000-0000-0000-0000-000000000001','bill','fixture','{"updated_at":"new","amount_cents":101}'),'changed financial facts invalidate an old disposition');

-- An unscoped legacy cache cannot select whichever book happens to match first.
insert into accounting_connections(id,org_id,provider,label,external_account_id,status,connected_by)
values('38000000-0000-0000-0000-000000000002','28000000-0000-0000-0000-000000000001','qbo','Prior Book','prior-realm','expired','18000000-0000-0000-0000-000000000001');
insert into projects(id,org_id,name,created_by,qbo_class_id) values('48000000-0000-0000-0000-000000000001','28000000-0000-0000-0000-000000000001','Parity Fixture','18000000-0000-0000-0000-000000000001','class-a');
insert into accounting_entity_map(org_id,project_id,connection_id,dimensions) values
('28000000-0000-0000-0000-000000000001','48000000-0000-0000-0000-000000000001','38000000-0000-0000-0000-000000000001','{"class":{"id":"class-b"}}');
select is((accounting_d2_parity_snapshot()->>'divergent_records')::integer,1,'conflicting project dimensions require review');
update accounting_entity_map set dimensions='{"class":{"id":"class-a"}}' where project_id='48000000-0000-0000-0000-000000000001';
select is((accounting_d2_parity_snapshot()->>'divergent_records')::integer,0,'equivalent project dimensions retain parity');
insert into companies(id,org_id,name,qbo_vendor_id) values('48000000-0000-0000-0000-000000000002','28000000-0000-0000-0000-000000000001','Parity Vendor','vendor-a');
insert into accounting_counterparty_links(org_id,connection_id,provider,entity_type,entity_id,role,external_id) values
('28000000-0000-0000-0000-000000000001','38000000-0000-0000-0000-000000000001','qbo','company','48000000-0000-0000-0000-000000000002','vendor','vendor-a'),
('28000000-0000-0000-0000-000000000001','38000000-0000-0000-0000-000000000002','qbo','company','48000000-0000-0000-0000-000000000002','vendor','vendor-b');
select is((accounting_d2_parity_snapshot()->>'divergent_records')::integer,1,'matching one historical company link cannot hide another conflicting book');
update accounting_counterparty_links set external_id='vendor-a' where entity_id='48000000-0000-0000-0000-000000000002';
select is((accounting_d2_parity_snapshot()->>'divergent_records')::integer,0,'equivalent counterparty links retain parity');

select * from finish();
rollback;
