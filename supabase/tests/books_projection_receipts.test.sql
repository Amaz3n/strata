begin;
select plan(4);
select ok((select relrowsecurity from pg_class where oid='public.books_projection_receipts'::regclass),'projection receipts have RLS enabled');
select ok(not has_table_privilege('authenticated','public.books_projection_receipts','select'),'browser cannot read unscoped receipts');
select ok(not has_function_privilege('authenticated','public.record_books_projection_receipt(uuid,text,uuid,timestamptz,uuid,uuid)','execute'),'browser cannot certify a projection');
select throws_matching($$select public.record_books_projection_receipt('99000000-0000-4000-8000-000000000099','invoice','99000000-0000-4000-8000-000000000098',now(),'99000000-0000-4000-8000-000000000097','99000000-0000-4000-8000-000000000096')$$,'requires a posted journal','receipt cannot certify missing accounting evidence');
select * from finish();
rollback;
