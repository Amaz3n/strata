begin;
select no_plan();
-- Disposable transaction only: execute the consumer suite with the full business
-- cache removed. A dependency failure is a release blocker, never CASCADE it away.
do $$ declare c record; begin
  for c in select table_name,column_name from information_schema.columns
    where table_schema='public' and table_name in ('invoices','project_expenses','vendor_bills','projects','companies')
      and column_name like 'qbo\_%' escape '\'
  loop execute format('alter table public.%I drop column %I',c.table_name,c.column_name); end loop;
end $$;
select is((select count(*)::integer from information_schema.columns where table_schema='public'
  and table_name in ('invoices','project_expenses','vendor_bills','projects','companies') and column_name like 'qbo\_%' escape '\'),0,'all D2 business cache columns are absent during consumer execution');
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,created_at,updated_at,raw_app_meta_data,raw_user_meta_data)
values('1a000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000000','authenticated','authenticated','neutral-consumer@example.test','',now(),now(),now(),'{}','{}');
insert into public.app_users(id,email,full_name) values('1a000000-0000-0000-0000-000000000001','neutral-consumer@example.test','Neutral Consumer');
insert into public.orgs(id,name,slug,created_by) values('2a000000-0000-0000-0000-000000000001','Neutral Consumer','neutral-consumer-test','1a000000-0000-0000-0000-000000000001');
insert into public.projects(id,org_id,name,created_by) values('4a000000-0000-0000-0000-000000000001','2a000000-0000-0000-0000-000000000001','Neutral Consumer Project','1a000000-0000-0000-0000-000000000001');
insert into public.accounting_connections(id,org_id,provider,label,external_account_id,status,connected_by) values
('3a000000-0000-0000-0000-000000000001','2a000000-0000-0000-0000-000000000001','qbo','Book One','import-book-one','active','1a000000-0000-0000-0000-000000000001'),
('3a000000-0000-0000-0000-000000000002','2a000000-0000-0000-0000-000000000001','qbo','Book Two','import-book-two','active','1a000000-0000-0000-0000-000000000001');

insert into companies(id,org_id,name,company_type) values('7a000000-0000-0000-0000-000000000001','2a000000-0000-0000-0000-000000000001','Neutral Vendor','supplier');
insert into vendor_bills(id,org_id,project_id,company_id,bill_number,status,total_cents,bill_date,accounting_coding)
values('5a000000-0000-0000-0000-000000000001','2a000000-0000-0000-0000-000000000001','4a000000-0000-0000-0000-000000000001','7a000000-0000-0000-0000-000000000001','NC-1','pending',1000,current_date,'{"counterparty":{"id":"42","name":"Neutral Vendor"}}');
insert into bill_lines(org_id,bill_id,project_id,description,quantity,unit_cost_cents) values('2a000000-0000-0000-0000-000000000001','5a000000-0000-0000-0000-000000000001','4a000000-0000-0000-0000-000000000001','Work',1,600),('2a000000-0000-0000-0000-000000000001','5a000000-0000-0000-0000-000000000001','4a000000-0000-0000-0000-000000000001','Additional work',1,400);
insert into project_financial_settings(org_id,project_id,cost_codes_enabled) values('2a000000-0000-0000-0000-000000000001','4a000000-0000-0000-0000-000000000001',false) on conflict do nothing;
insert into accounting_sync_records(org_id,connection_id,provider,entity_type,entity_id,external_id,status) values('2a000000-0000-0000-0000-000000000001','3a000000-0000-0000-0000-000000000001','qbo','bill','5a000000-0000-0000-0000-000000000001','remote-bill','synced');
update project_financial_settings set cost_codes_enabled=false where project_id='4a000000-0000-0000-0000-000000000001';
select lives_ok($$select approve_vendor_bills_atomic('2a000000-0000-0000-0000-000000000001','1a000000-0000-0000-0000-000000000001',jsonb_build_array(jsonb_build_object('id','5a000000-0000-0000-0000-000000000001')))$$,'approval executes with neutral state');
select is((select status from accounting_sync_records where entity_id='5a000000-0000-0000-0000-000000000001'),'pending','approval marks the actual bill ledger type pending');
select is((select status from vendor_bills where id='5a000000-0000-0000-0000-000000000001'),'approved','approval retains financial transition');
select throws_ok($$select approve_vendor_bills_atomic('2a000000-0000-0000-0000-000000000001','1a000000-0000-0000-0000-000000000001',jsonb_build_array(jsonb_build_object('id','5a000000-0000-0000-0000-000000000001')))$$,'P0001',null,'already approved bill cannot be approved twice');
select throws_ok($$insert into vendor_bills(org_id,project_id,company_id,bill_number,status,total_cents,bill_date) values('2a000000-0000-0000-0000-000000000001','4a000000-0000-0000-0000-000000000001','7a000000-0000-0000-0000-000000000001','NC-1','pending',1000,current_date)$$,'P0001','Duplicate vendor invoice number for this vendor','duplicate trigger protects neutral bill');
select lives_ok($$update vendor_bills set due_date=current_date+1 where id='5a000000-0000-0000-0000-000000000001'$$,'active-run trigger accepts edits when no active payment run owns bill');
select lives_ok($$select refresh_vendor_scorecards('2a000000-0000-0000-0000-000000000001')$$,'scorecard routine executes neutral status query');
select lives_ok($$select refresh_vendor_tax_readiness('2a000000-0000-0000-0000-000000000001')$$,'tax readiness executes neutral company links query');
select lives_ok($$select detect_directory_merge_candidates('2a000000-0000-0000-0000-000000000001')$$,'directory merge routine executes connection-scoped identity query');
insert into invoices(id,org_id,project_id,status,client_visible,total_cents,subtotal_cents,balance_due_cents,tax_cents,currency)
values('6a000000-0000-0000-0000-000000000001','2a000000-0000-0000-0000-000000000001','4a000000-0000-0000-0000-000000000001','sent',true,1000,1000,1000,0,'usd');
insert into accounting_sync_records(org_id,connection_id,provider,entity_type,entity_id,external_id,status) values('2a000000-0000-0000-0000-000000000001','3a000000-0000-0000-0000-000000000001','qbo','invoice','6a000000-0000-0000-0000-000000000001','remote-invoice','synced');
select lives_ok($$select replace_invoice_lines_atomic('2a000000-0000-0000-0000-000000000001','6a000000-0000-0000-0000-000000000001','{"notes":"Neutral replacement"}','[{"description":"Neutral line","quantity":1,"unit_price_cents":1000}]')$$,'invoice replacement executes without cache columns');
select is((select count(*)::integer from invoice_lines where invoice_id='6a000000-0000-0000-0000-000000000001'),1,'invoice replacement retains exactly one financial line');
create temporary table neutral_adjustment as select create_receivable_adjustment_atomic('2a000000-0000-0000-0000-000000000001','6a000000-0000-0000-0000-000000000001','write_off',100,0,current_date,'Synthetic correction','1a000000-0000-0000-0000-000000000001') as item;
select is((select status from accounting_sync_records where entity_id='6a000000-0000-0000-0000-000000000001'),'needs_review','receivable adjustment flags neutral identity for review');
select lives_ok($$select void_receivable_adjustment_atomic('2a000000-0000-0000-0000-000000000001',(select (item->>'id')::uuid from neutral_adjustment),'1a000000-0000-0000-0000-000000000001')$$,'void adjustment executes neutral state transition');
select is((select status from receivable_adjustments where id=(select (item->>'id')::uuid from neutral_adjustment)),'void','adjustment financial status preserved');
update invoices set balance_due_cents=600 where id='6a000000-0000-0000-0000-000000000001';
select lives_ok($$select reconcile_accounting_invoice_opening_payment('2a000000-0000-0000-0000-000000000001','6a000000-0000-0000-0000-000000000001')$$,'post-mapping opening payment reconciliation executes');
select is((select amount_cents from payments where invoice_id='6a000000-0000-0000-0000-000000000001' and provider='qbo_opening_balance'),400::bigint,'neutral mapping produces correct opening paid balance');
select reconcile_accounting_invoice_opening_payment('2a000000-0000-0000-0000-000000000001','6a000000-0000-0000-0000-000000000001');
select is((select count(*)::integer from payments where invoice_id='6a000000-0000-0000-0000-000000000001' and provider='qbo_opening_balance'),1,'opening payment retry cannot duplicate money');
update vendor_bills set retainage_cents=100 where id='5a000000-0000-0000-0000-000000000001';
create temporary table neutral_retainage as select release_retainage_atomic('2a000000-0000-0000-0000-000000000001','5a000000-0000-0000-0000-000000000001','1a000000-0000-0000-0000-000000000001',100,false,now()) as item;
select is((select accounting_coding from vendor_bills where id=(select (item->>'release_bill_id')::uuid from neutral_retainage)),(select accounting_coding from vendor_bills where id='5a000000-0000-0000-0000-000000000001'),'retainage release preserves neutral accounting coding');
select is((select count(*)::integer from bill_lines where bill_id=(select (item->>'release_bill_id')::uuid from neutral_retainage)),2,'retainage preserves the current waiver lifecycle line distribution');
select is((select array_agg(unit_cost_cents order by unit_cost_cents)::text from bill_lines where bill_id=(select (item->>'release_bill_id')::uuid from neutral_retainage)),'{40,60}','retainage release apportions exact cents across original lines');
select is((select sum(quantity*unit_cost_cents)::bigint from bill_lines where bill_id=(select (item->>'release_bill_id')::uuid from neutral_retainage)),100::bigint,'distributed retainage lines conserve the release amount');
select * from finish();
rollback;
