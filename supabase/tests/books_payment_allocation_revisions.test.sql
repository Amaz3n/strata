begin;
select plan(10);
select ok(exists(select 1 from pg_trigger where tgrelid='public.payments'::regclass and tgname='zz_books_payment_source_revision' and tgenabled='O'),'payment headers advance after transaction-time update triggers');
select ok(exists(select 1 from pg_trigger where tgrelid='public.payment_allocations'::regclass and tgname='books_payment_allocation_source_touch' and tgenabled='O'),'allocation changes invalidate parent source revisions');
select ok(not has_function_privilege('authenticated','public.books_touch_payment_allocation_source()','execute'),'browser cannot directly invoke the parent-touch function');
select ok(exists(select 1 from pg_proc where oid='public.books_touch_payment_allocation_source()'::regprocedure and prosecdef and proconfig @> array['search_path=pg_catalog, public']),'source invalidation uses a fixed privileged search path');

-- Use real parent/child constraints and all existing timestamp triggers. A
-- future source revision proves transaction-time triggers cannot move it back.
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,created_at,updated_at,raw_app_meta_data,raw_user_meta_data)
values('16000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000000','authenticated','authenticated','books-allocation-revision@example.test','',now(),now(),'{}','{}');
insert into public.app_users(id,email,full_name)
values('16000000-0000-0000-0000-000000000001','books-allocation-revision@example.test','Allocation Revision Test');
insert into public.orgs(id,name,slug,created_by)
values('26000000-0000-0000-0000-000000000001','Allocation Revision Test','books-allocation-revision-test','16000000-0000-0000-0000-000000000001');
insert into public.invoices(id,org_id,invoice_number,status,issue_date,total_cents,balance_due_cents)
values('56000000-0000-0000-0000-000000000001','26000000-0000-0000-0000-000000000001','REVISION-1','sent','2026-09-01',1000,1000);
insert into public.payments(id,org_id,amount_cents,status,updated_at) values
('66000000-0000-0000-0000-000000000001','26000000-0000-0000-0000-000000000001',1000,'completed','2099-01-01'),
('66000000-0000-0000-0000-000000000002','26000000-0000-0000-0000-000000000001',1000,'completed','2099-01-01');
create temporary table prior_payment_revisions as select id,updated_at from public.payments where org_id='26000000-0000-0000-0000-000000000001';
insert into public.payment_allocations(id,org_id,payment_id,invoice_id,amount_cents)
values('76000000-0000-0000-0000-000000000001','26000000-0000-0000-0000-000000000001','66000000-0000-0000-0000-000000000001','56000000-0000-0000-0000-000000000001',1000);
select ok((select p.updated_at>r.updated_at from public.payments p join prior_payment_revisions r using(id) where p.id='66000000-0000-0000-0000-000000000001'),'insert advances the parent beyond a future revision');
update prior_payment_revisions r set updated_at=p.updated_at from public.payments p where p.id=r.id;
update public.payment_allocations set amount_cents=999 where id='76000000-0000-0000-0000-000000000001';
select ok((select p.updated_at>r.updated_at from public.payments p join prior_payment_revisions r using(id) where p.id='66000000-0000-0000-0000-000000000001'),'allocation edit advances its parent within the same transaction');
update prior_payment_revisions r set updated_at=p.updated_at from public.payments p where p.id=r.id;
update public.payment_allocations set payment_id='66000000-0000-0000-0000-000000000002' where id='76000000-0000-0000-0000-000000000001';
select ok((select p.updated_at>r.updated_at from public.payments p join prior_payment_revisions r using(id) where p.id='66000000-0000-0000-0000-000000000001'),'reassignment advances the old parent');
select ok((select p.updated_at>r.updated_at from public.payments p join prior_payment_revisions r using(id) where p.id='66000000-0000-0000-0000-000000000002'),'reassignment advances the new parent');
update prior_payment_revisions r set updated_at=p.updated_at from public.payments p where p.id=r.id;
delete from public.payment_allocations where id='76000000-0000-0000-0000-000000000001';
select ok((select p.updated_at>r.updated_at from public.payments p join prior_payment_revisions r using(id) where p.id='66000000-0000-0000-0000-000000000002'),'deletion advances the last parent');
update prior_payment_revisions r set updated_at=p.updated_at from public.payments p where p.id=r.id;
update public.payments set reference='Edited within the same transaction' where id='66000000-0000-0000-0000-000000000002';
select ok((select p.updated_at>r.updated_at from public.payments p join prior_payment_revisions r using(id) where p.id='66000000-0000-0000-0000-000000000002'),'direct header edit also advances the source revision');
set constraints all immediate;
select * from finish();
rollback;
