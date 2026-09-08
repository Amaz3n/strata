begin;

select plan(31);

select has_column('public','payment_rail_policies','enabled_jurisdictions','rail policy owns the enabled jurisdictions');
select has_column('public','payment_runs','canceled_by','canceled runs record their actor');
select has_column('public','payment_runs','cancel_reason','canceled runs record a typed reason');
select has_column('public','payment_execution_reservations','status','daily-limit reservations have a lifecycle');
select has_column('public','payment_risk_reviews','signal_set_hash','risk evaluations have a signal-set identity');
select has_column('public','payment_risk_reviews','identity_enforced','new risk identities are isolated from append-only history');
select has_column('public','vendor_bills','invoice_number_normalized','invoice normalization is generated in the database');
select has_column('public','vendor_bills','vendor_name_normalized','name-only vendor normalization is generated in the database');
select has_column('public','vendor_bills','retainage_release_requested_at','retainage release requests are timestamped');
select has_function('public','release_retainage_atomic',array['uuid','uuid','uuid','bigint','boolean','timestamp with time zone']);
select has_function('public','record_automated_payment_risk_review',array['uuid','uuid','text','text','text','jsonb','numeric','timestamp with time zone']);
select has_function('public','latest_payment_risk_reviews',array['uuid','uuid[]']);
select has_function('public','discard_payment_run_draft_atomic',array['uuid','uuid','uuid']);
select is(public.normalize_vendor_invoice_number(' INV / 10-24._ '),'inv1024','SQL canonicalization ignores case, whitespace and punctuation');

insert into auth.users(id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,created_at,updated_at,raw_app_meta_data,raw_user_meta_data) values
('11000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000000','authenticated','authenticated','phasec-preparer@example.test','',now(),now(),now(),'{}','{}'),
('11000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000000','authenticated','authenticated','phasec-manager@example.test','',now(),now(),now(),'{}','{}');
insert into public.app_users(id,email,full_name) values
('11000000-0000-0000-0000-000000000001','phasec-preparer@example.test','Phase C Preparer'),
('11000000-0000-0000-0000-000000000002','phasec-manager@example.test','Phase C Manager');
insert into public.orgs(id,name,slug,created_by) values('21000000-0000-0000-0000-000000000001','Phase C Test','phase-c-test','11000000-0000-0000-0000-000000000001');
insert into public.memberships(org_id,user_id,role_id,status) values
('21000000-0000-0000-0000-000000000001','11000000-0000-0000-0000-000000000001',(select id from public.roles where key='org_bookkeeper'),'active'),
('21000000-0000-0000-0000-000000000001','11000000-0000-0000-0000-000000000002',(select id from public.roles where key='org_admin'),'active');
insert into public.projects(id,org_id,name,created_by,location) values
('31000000-0000-0000-0000-000000000001','21000000-0000-0000-0000-000000000001','Florida Project','11000000-0000-0000-0000-000000000001','{"state":"FL"}'),
('31000000-0000-0000-0000-000000000002','21000000-0000-0000-0000-000000000001','Georgia Project','11000000-0000-0000-0000-000000000001','{"state":"GA"}');
insert into public.org_funding_sources(id,org_id,provider,provider_customer_id,provider_payment_method_id,mandate_status,verification_status,status,is_default,created_by)
values('a1000000-0000-0000-0000-000000000001','21000000-0000-0000-0000-000000000001','stripe','cus_phasec','pm_phasec','accepted','verified','active',true,'11000000-0000-0000-0000-000000000001');
insert into public.payment_rail_policies(org_id,enabled,approval_mode,requester_may_approve,per_payment_limit_cents,per_run_limit_cents,daily_limit_cents,max_inflight_cents,return_loss_ceiling_cents,enabled_jurisdictions,created_by)
values('21000000-0000-0000-0000-000000000001',true,'sole',false,10000,10000,15000,100000,100000,array['FL'],'11000000-0000-0000-0000-000000000001');

-- A draft cannot cross the DB boundary without a designated eligible approver.
insert into public.payment_runs(id,org_id,funding_source_id,status,currency,payment_count,vendor_amount_cents,total_debit_cents,approval_mode_snapshot,required_approvals,requested_by,control_snapshot,idempotency_key)
values('e1000000-0000-0000-0000-000000000001','21000000-0000-0000-0000-000000000001','a1000000-0000-0000-0000-000000000001','draft','usd',1,10000,10000,'sole',1,'11000000-0000-0000-0000-000000000001','{"policy":{"requester_may_approve":false}}','phase-c-no-roster');
select throws_ok($$select public.submit_payment_run_atomic('21000000-0000-0000-0000-000000000001','e1000000-0000-0000-0000-000000000001','11000000-0000-0000-0000-000000000001',repeat('a',64),now(),null)$$,'P0001','Payment run has fewer eligible approvers than its required approvals','zero-approver runs cannot become pending approval');
select lives_ok($$select public.discard_payment_run_draft_atomic('21000000-0000-0000-0000-000000000001','e1000000-0000-0000-0000-000000000001','11000000-0000-0000-0000-000000000001')$$,'the preparer can discard a draft after submit validation fails');
select is((select status from public.payment_runs where id='e1000000-0000-0000-0000-000000000001'),'canceled','discard frees the draft without weakening submitted-run cancellation');

insert into public.payment_run_approvers(org_id,user_id,approval_limit_cents,created_by) values
('21000000-0000-0000-0000-000000000001','11000000-0000-0000-0000-000000000002',100000,'11000000-0000-0000-0000-000000000001');
insert into public.payment_runs(id,org_id,funding_source_id,status,currency,payment_count,vendor_amount_cents,total_debit_cents,approval_mode_snapshot,required_approvals,requested_by,control_snapshot,idempotency_key) values
('e1000000-0000-0000-0000-000000000002','21000000-0000-0000-0000-000000000001','a1000000-0000-0000-0000-000000000001','draft','usd',1,10000,10000,'sole',1,'11000000-0000-0000-0000-000000000001','{"policy":{"requester_may_approve":false}}','phase-c-limit-one'),
('e1000000-0000-0000-0000-000000000003','21000000-0000-0000-0000-000000000001','a1000000-0000-0000-0000-000000000001','draft','usd',1,10000,10000,'sole',1,'11000000-0000-0000-0000-000000000001','{"policy":{"requester_may_approve":false}}','phase-c-limit-two');
select lives_ok($$select public.submit_payment_run_atomic('21000000-0000-0000-0000-000000000001','e1000000-0000-0000-0000-000000000002','11000000-0000-0000-0000-000000000001',repeat('b',64),now(),null)$$,'first run reserves at submit');
select throws_ok($$select public.submit_payment_run_atomic('21000000-0000-0000-0000-000000000001','e1000000-0000-0000-0000-000000000003','11000000-0000-0000-0000-000000000001',repeat('c',64),now(),null)$$,'P0001','Organization daily payment limit would be exceeded','second over-limit run fails at submit, not execution');
select is((select status from public.payment_execution_reservations where run_id='e1000000-0000-0000-0000-000000000002'),'pending','submit writes the pending daily-limit reservation');
select throws_ok($$select public.decide_payment_run_atomic('21000000-0000-0000-0000-000000000001','e1000000-0000-0000-0000-000000000002','11000000-0000-0000-0000-000000000002','approved',null,repeat('b',64),now()-interval '15 minutes',interval '10 minutes')$$,'P0001','Recent payment step-up verification is required','the database rejects a fifteen-minute-old step-up');
select lives_ok($$select public.cancel_payment_run_atomic('21000000-0000-0000-0000-000000000001','e1000000-0000-0000-0000-000000000002','11000000-0000-0000-0000-000000000002','Risk block cannot be cleared',now(),interval '10 minutes')$$,'a rail manager can cancel an absent-preparer run');
select is((select status from public.payment_execution_reservations where run_id='e1000000-0000-0000-0000-000000000002'),'released','cancel releases the daily-limit reservation');
select is((select coalesce(sum(reserved_cents),0)::bigint from public.payment_execution_reservations where org_id='21000000-0000-0000-0000-000000000001' and status in ('pending','executed')),0::bigint,'live reserved cents exclude released reservations');

select public.record_automated_payment_risk_review('21000000-0000-0000-0000-000000000001','e1000000-0000-0000-0000-000000000002',repeat('d',64),repeat('e',64),'block','[{"code":"test"}]',100,now());
select public.record_automated_payment_risk_review('21000000-0000-0000-0000-000000000001','e1000000-0000-0000-0000-000000000002',repeat('d',64),repeat('e',64),'block','[{"code":"test"}]',100,now());
select public.record_automated_payment_risk_review('21000000-0000-0000-0000-000000000001','e1000000-0000-0000-0000-000000000002',repeat('d',64),repeat('e',64),'allow','[{"code":"test"}]',0,now());
select is((select count(*)::integer from public.payment_risk_reviews where run_id='e1000000-0000-0000-0000-000000000002' and content_hash=repeat('d',64) and signal_set_hash=repeat('e',64)),1,'three identical risk evaluations produce one row');

insert into public.vendor_bills(id,org_id,project_id,bill_number,status,total_cents,currency,metadata) values
('b1000000-0000-0000-0000-000000000001','21000000-0000-0000-0000-000000000001','31000000-0000-0000-0000-000000000001',' INV-20.24 ','pending',1000,'usd','{"vendor_name":"Acme & Sons"}');
select throws_ok($$insert into public.vendor_bills(id,org_id,project_id,bill_number,status,total_cents,currency,metadata) values('b1000000-0000-0000-0000-000000000002','21000000-0000-0000-0000-000000000001','31000000-0000-0000-0000-000000000001','inv / 2024','pending',1000,'usd','{"vendor_name":"ACME & SONS"}')$$,'P0001','Duplicate vendor invoice number for this vendor','name-only vendor invoices are canonicalized by the trigger');

insert into public.vendor_bills(id,org_id,project_id,bill_number,status,total_cents,currency,retainage_cents,retainage_released_cents,lien_waiver_status,approved_at,approved_by) values
('b1000000-0000-0000-0000-000000000003','21000000-0000-0000-0000-000000000001','31000000-0000-0000-0000-000000000001','RET-SOURCE','approved',10000,'usd',2000,0,'received',now(),'11000000-0000-0000-0000-000000000002');
select lives_ok($$select public.release_retainage_atomic('21000000-0000-0000-0000-000000000001','b1000000-0000-0000-0000-000000000003','11000000-0000-0000-0000-000000000002',750,true,now())$$,'retainage is released through the atomic workflow');
select is((select retainage_released_cents from public.vendor_bills where id='b1000000-0000-0000-0000-000000000003'),750::bigint,'retainage released math is derived from the approved source bill');
select is((select count(*)::integer from public.events where event_type='vendor_bill_retainage_released' and entity_id='b1000000-0000-0000-0000-000000000003'),1,'retainage release writes its own event atomically');

select ok(not has_function_privilege('anon','public.cancel_payment_run_atomic(uuid,uuid,uuid,text,timestamp with time zone,interval)','execute') and not has_function_privilege('authenticated','public.cancel_payment_run_atomic(uuid,uuid,uuid,text,timestamp with time zone,interval)','execute'),'browser roles cannot call cancellation RPC directly');
select ok(not has_function_privilege('anon','public.release_retainage_atomic(uuid,uuid,uuid,bigint,boolean,timestamp with time zone)','execute') and not has_function_privilege('authenticated','public.release_retainage_atomic(uuid,uuid,uuid,bigint,boolean,timestamp with time zone)','execute'),'browser roles cannot call retainage release RPC directly');

select * from finish();
rollback;
