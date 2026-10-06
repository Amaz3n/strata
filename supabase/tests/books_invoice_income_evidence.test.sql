begin;
select plan(9);
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at,raw_app_meta_data,raw_user_meta_data)
values('18000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000000','authenticated','authenticated','books-income-evidence@example.test','',now(),now(),'{}','{}');
insert into public.app_users(id,email,full_name)
values('18000000-0000-0000-0000-000000000001','books-income-evidence@example.test','Income Evidence Test');
insert into public.orgs(id,name,slug,created_by) values
('28000000-0000-0000-0000-000000000001','Income Evidence','books-income-evidence-test','18000000-0000-0000-0000-000000000001'),
('28000000-0000-0000-0000-000000000002','Other Income Evidence','books-income-evidence-other-test','18000000-0000-0000-0000-000000000001');
insert into public.invoices(id,org_id,invoice_number,status,issue_date,total_cents,balance_due_cents) values
('58000000-0000-0000-0000-000000000001','28000000-0000-0000-0000-000000000001','INCOME-1','sent','2026-09-01',1001,1001),
('58000000-0000-0000-0000-000000000002','28000000-0000-0000-0000-000000000002','OTHER-1','sent','2026-09-01',1001,1001);
insert into public.gl_accounts(id,org_id,code,name,account_type,subtype,normal_balance) values
('38000000-0000-0000-0000-000000000001','28000000-0000-0000-0000-000000000001','4010','Design income','income','construction_revenue','credit'),
('38000000-0000-0000-0000-000000000002','28000000-0000-0000-0000-000000000002','4020','Other income','income','construction_revenue','credit');
insert into public.invoice_lines(org_id,invoice_id,description,quantity,unit_price_cents,metadata)
select '28000000-0000-0000-0000-000000000001','58000000-0000-0000-0000-000000000001','Service '||n,1,1,'{"arc_books_gl_account_id":"38000000-0000-0000-0000-000000000001"}'::jsonb from generate_series(1,1001) n;
create temporary table captured_income as select public.books_invoice_income_evidence('28000000-0000-0000-0000-000000000001',array['58000000-0000-0000-0000-000000000001','58000000-0000-0000-0000-000000000002']::uuid[]) evidence;
select ok(not has_function_privilege('authenticated','public.books_invoice_income_evidence(uuid,uuid[])','execute'),'browser cannot bypass Books authorization');
select ok(has_function_privilege('service_role','public.books_invoice_income_evidence(uuid,uuid[])','execute'),'service can capture scoped income evidence');
select is((select jsonb_array_length(evidence) from captured_income),1,'cross-org requested invoice is excluded');
select is((select jsonb_array_length(evidence->0->'lines') from captured_income),1001,'one JSON snapshot preserves all 1001 lines');
select is((select (evidence->0->>'updated_at')::timestamptz from captured_income),(select updated_at from public.invoices where id='58000000-0000-0000-0000-000000000001'),'header revision comes from the same snapshot');
select is((select evidence->0->'lines'->0->'selected_account'->>'code' from captured_income),'4010','native chart account captured with lines');
update public.invoice_lines set metadata='{"arc_books_gl_account_id":"38000000-0000-0000-0000-000000000002"}' where invoice_id='58000000-0000-0000-0000-000000000001';
select is(public.books_invoice_income_evidence('28000000-0000-0000-0000-000000000001',array['58000000-0000-0000-0000-000000000001']::uuid[])->0->'lines'->0->'selected_account','null'::jsonb,'foreign chart identity is never resolved');
select ok(exists(select 1 from pg_proc where oid='public.books_invoice_income_evidence(uuid,uuid[])'::regprocedure and provolatile='s' and not prosecdef),'stable invoker function uses a single statement snapshot');
insert into public.gl_accounts(id,org_id,code,name,account_type,subtype,normal_balance) values
('38000000-0000-0000-0000-000000000003','28000000-0000-0000-0000-000000000001','1110','Retainage AR','asset','retainage_receivable','debit'),
('38000000-0000-0000-0000-000000000004','28000000-0000-0000-0000-000000000001','2350','Deferred progress billing','liability','billings_in_excess','credit');
select lives_ok($$select public.post_books_journal_entry('28000000-0000-0000-0000-000000000001',
'{"entry_date":"2026-09-01","entry_kind":"operational","memo":"Fully retained progress billing","posting_key":"fully-retained-progress-test","policy_version":1,"source_type":"invoice","source_id":"58000000-0000-0000-0000-000000000001"}',
'[{"line_no":1,"account_id":"38000000-0000-0000-0000-000000000003","debit_cents":1000,"credit_cents":0},{"line_no":2,"account_id":"38000000-0000-0000-0000-000000000004","debit_cents":0,"credit_cents":1000}]')$$,'real ledger accepts fully retained billing without a zero AR line');
set constraints all immediate;
select * from finish();
rollback;
