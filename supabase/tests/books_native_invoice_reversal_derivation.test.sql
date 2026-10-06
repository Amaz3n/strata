begin;
select plan(5);
select ok(not has_function_privilege('anon','public.books_derive_native_invoice_reversal(uuid,uuid,uuid,uuid,uuid,uuid,jsonb,text)','execute'),'anonymous clients cannot derive private native corrections');
select ok(not has_function_privilege('authenticated','public.books_derive_native_invoice_reversal(uuid,uuid,uuid,uuid,uuid,uuid,jsonb,text)','execute'),'browser roles cannot bypass authorized correction service');
select ok(has_function_privilege('service_role','public.books_derive_native_invoice_reversal(uuid,uuid,uuid,uuid,uuid,uuid,jsonb,text)','execute'),'server may derive native correction evidence');
select ok(not (select prosecdef from pg_proc where oid='public.books_derive_native_invoice_reversal(uuid,uuid,uuid,uuid,uuid,uuid,jsonb,text)'::regprocedure),'native correction derivation retains INVOKER authority');
select ok((select proconfig @> array['search_path=pg_catalog, public'] from pg_proc where oid='public.books_derive_native_invoice_reversal(uuid,uuid,uuid,uuid,uuid,uuid,jsonb,text)'::regprocedure),'native correction helper pins its search path');
select * from finish();
rollback;
