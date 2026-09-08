begin;
select plan(25);
select ok(not has_function_privilege('authenticated','public.accounting_persist_import_row(uuid,uuid,uuid,text,text,text,text,text,jsonb)','EXECUTE'),'members cannot bypass the import authorization boundary');
select ok(not has_function_privilege('anon','public.accounting_persist_import_children(uuid,uuid,text,jsonb)','EXECUTE'),'anonymous callers cannot write imported lines');
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,created_at,updated_at,raw_app_meta_data,raw_user_meta_data)
values('19000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000000','authenticated','authenticated','import-recovery@example.test','',now(),now(),now(),'{}','{}');
insert into public.app_users(id,email,full_name) values('19000000-0000-0000-0000-000000000001','import-recovery@example.test','Import Recovery');
insert into public.orgs(id,name,slug,created_by) values('29000000-0000-0000-0000-000000000001','Import Recovery','import-recovery-test','19000000-0000-0000-0000-000000000001');
insert into public.projects(id,org_id,name,created_by) values('49000000-0000-0000-0000-000000000001','29000000-0000-0000-0000-000000000001','Import Recovery Project','19000000-0000-0000-0000-000000000001');
insert into public.accounting_connections(id,org_id,provider,label,external_account_id,status,connected_by) values
('39000000-0000-0000-0000-000000000001','29000000-0000-0000-0000-000000000001','qbo','Book One','import-book-one','active','19000000-0000-0000-0000-000000000001'),
('39000000-0000-0000-0000-000000000002','29000000-0000-0000-0000-000000000001','qbo','Book Two','import-book-two','active','19000000-0000-0000-0000-000000000001');
create temporary table import_fixture(connection_id uuid, token uuid, entity_id uuid);
insert into import_fixture(connection_id,token) select id,public.accounting_claim_import(org_id,id,'invoice','42') from accounting_connections where org_id='29000000-0000-0000-0000-000000000001';
select is((select count(*)::integer from import_fixture where token is not null),2,'two books own independent claims for overlapping remote IDs');
create function pg_temp.import_document(p_connection uuid,p_extra jsonb default '{}'::jsonb,p_line text default 'document') returns uuid language sql as $$
select public.accounting_persist_import_row('29000000-0000-0000-0000-000000000001',p_connection,
 (select token from import_fixture where connection_id=p_connection),'invoices','invoice','Invoice','42',p_line,
 '{"org_id":"29000000-0000-0000-0000-000000000001","project_id":"49000000-0000-0000-0000-000000000001","status":"draft","total_cents":1000,"subtotal_cents":1000,"tax_cents":0,"balance_due_cents":1000,"currency":"usd","metadata":{"imported_from_qbo":true}}'::jsonb || p_extra)
$$;
update import_fixture set entity_id=pg_temp.import_document(connection_id);
select is((select count(*)::integer from invoices where org_id='29000000-0000-0000-0000-000000000001'),2,'overlapping provider IDs create distinct local invoices for distinct books');
select is((select count(*)::integer from accounting_sync_records where org_id='29000000-0000-0000-0000-000000000001' and external_id='42'),2,'each committed invoice already has its neutral mapping');
select isnt((select entity_id from import_fixture where connection_id='39000000-0000-0000-0000-000000000001'),(select entity_id from import_fixture where connection_id='39000000-0000-0000-0000-000000000002'),'realm identity is part of deduplication');
select is(pg_temp.import_document('39000000-0000-0000-0000-000000000001'),(select entity_id from import_fixture where connection_id='39000000-0000-0000-0000-000000000001'),'retry after parent commit resumes the original document');
select throws_ok($$select pg_temp.import_document('39000000-0000-0000-0000-000000000001','{"invalid_import_column":true}','broken-line')$$,'42703',null,'a failed row insert cannot leave a mapping');
select is((select count(*)::integer from accounting_sync_records where org_id='29000000-0000-0000-0000-000000000001' and metadata->>'import_line_id'='broken-line'),0,'failed insert leaves no neutral identity');
create function pg_temp.import_lines(p_bad boolean default false) returns jsonb language sql as $$
 select public.accounting_persist_import_children('29000000-0000-0000-0000-000000000001',f.token,'invoice_lines',jsonb_build_array(
 jsonb_build_object('org_id','29000000-0000-0000-0000-000000000001','invoice_id',f.entity_id,'description','First','quantity',1,'unit','ea','unit_price_cents',500),
 jsonb_build_object('org_id',case when p_bad then '29000000-0000-0000-0000-000000000002' else '29000000-0000-0000-0000-000000000001' end,'invoice_id',f.entity_id,'description','Second','quantity',1,'unit','ea','unit_price_cents',500)))
 from import_fixture f where f.connection_id='39000000-0000-0000-0000-000000000001'
$$;
select throws_ok($$select pg_temp.import_lines(true)$$,'P0001','Import child scope mismatch','failure on the second child rolls back the whole line set');
select is((select count(*)::integer from invoice_lines where org_id='29000000-0000-0000-0000-000000000001'),0,'partial child insertion leaves no orphaned lines');
select is(jsonb_array_length(pg_temp.import_lines()),2,'retry creates the complete line set');
select is(jsonb_array_length(pg_temp.import_lines()),2,'replaying a completed line set returns its stable IDs');
select is((select count(*)::integer from invoice_lines where org_id='29000000-0000-0000-0000-000000000001'),2,'child retries cannot duplicate invoice lines');
select isnt(pg_temp.import_document('39000000-0000-0000-0000-000000000001','{}','allocation-one'),pg_temp.import_document('39000000-0000-0000-0000-000000000001','{}','allocation-two'),'fan-out allocations have distinct stable source-line identities');
select is(pg_temp.import_document('39000000-0000-0000-0000-000000000001','{}','allocation-one'),pg_temp.import_document('39000000-0000-0000-0000-000000000001','{}','allocation-one'),'a split retry adopts the existing allocation');
select throws_ok($$select public.accounting_persist_import_row('29000000-0000-0000-0000-000000000001','39000000-0000-0000-0000-000000000001','59000000-0000-0000-0000-000000000001','invoices','invoice','Invoice','42','document','{}')$$,'P0001','Import claim is no longer owned','a stale owner cannot persist imported financial facts');
select throws_ok($$select pg_temp.import_document('39000000-0000-0000-0000-000000000001','{"org_id":"29000000-0000-0000-0000-000000000002"}','foreign-org')$$,'P0001','Import organization mismatch','row organization must match the authorized claim');
select ok((select bool_and(status='pending' and pushable=false) from accounting_sync_records where org_id='29000000-0000-0000-0000-000000000001'),'an incomplete import cannot appear synced or be pushed outbound');
select throws_ok($$select public.accounting_persist_import_row('29000000-0000-0000-0000-000000000001','39000000-0000-0000-0000-000000000001',(select token from import_fixture where connection_id='39000000-0000-0000-0000-000000000001'),'payments','payment','Payment','42','payment','{"org_id":"29000000-0000-0000-0000-000000000001"}')$$,'P0001','Import claim is no longer owned','Invoice 42 claim cannot create Payment 42');
update invoice_lines set description='Changed after import' where org_id='29000000-0000-0000-0000-000000000001' and description='First';
select throws_ok($$select pg_temp.import_lines()$$,'P0001','Existing import line identity or content is unverifiable; review required','equal line counts cannot certify edited document content');
update invoice_lines set description='First' where org_id='29000000-0000-0000-0000-000000000001' and description='Changed after import';
update invoice_lines set metadata=metadata-'accounting_import_ordinal' where org_id='29000000-0000-0000-0000-000000000001';
select throws_ok($$select pg_temp.import_lines()$$,'P0001','Existing import line identity or content is unverifiable; review required','legacy lines without stable order cannot attach external items by arbitrary UUID order');
select throws_ok($$select public.accounting_persist_import_children('29000000-0000-0000-0000-000000000001',(select token from import_fixture where connection_id='39000000-0000-0000-0000-000000000001'),'project_expense_lines',jsonb_build_array(jsonb_build_object('org_id','29000000-0000-0000-0000-000000000001','expense_id',(select entity_id from import_fixture where connection_id='39000000-0000-0000-0000-000000000001'),'amount_cents',100)))$$,'P0001','Import parent is outside claim','a mapped invoice UUID cannot authorize expense-line writes');
select throws_ok($$select accounting_adopt_import_identity('29000000-0000-0000-0000-000000000001','39000000-0000-0000-0000-000000000002',(select token from import_fixture where connection_id='39000000-0000-0000-0000-000000000002'),'invoice',(select entity_id from import_fixture where connection_id='39000000-0000-0000-0000-000000000001'),'42')$$,'P0001','Local document already belongs to another external identity','adopting an existing document cannot rehome its connection');
insert into invoices(id,org_id,project_id,status,total_cents,subtotal_cents,tax_cents,balance_due_cents,currency) values('69000000-0000-0000-0000-000000000001','29000000-0000-0000-0000-000000000001','49000000-0000-0000-0000-000000000001','draft',1000,1000,0,1000,'usd');
select throws_ok($$select accounting_adopt_import_identity('29000000-0000-0000-0000-000000000001','39000000-0000-0000-0000-000000000002',(select token from import_fixture where connection_id='39000000-0000-0000-0000-000000000002'),'invoice','69000000-0000-0000-0000-000000000001','42')$$,'P0001','External document already belongs to another local identity','adopting an existing invoice cannot duplicate a remote document identity');
select * from finish();
rollback;
