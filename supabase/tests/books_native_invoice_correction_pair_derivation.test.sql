begin;
select plan(4);
select ok(not has_function_privilege('anon','public.books_derive_native_invoice_correction_pair(uuid,uuid,uuid,uuid,uuid,uuid,jsonb,jsonb,text)','execute') and not has_function_privilege('authenticated','public.books_derive_native_invoice_correction_pair(uuid,uuid,uuid,uuid,uuid,uuid,jsonb,jsonb,text)','execute'),'public clients cannot derive private correction pairs');
select ok(has_function_privilege('service_role','public.books_derive_native_invoice_correction_pair(uuid,uuid,uuid,uuid,uuid,uuid,jsonb,jsonb,text)','execute') and not (select prosecdef from pg_proc where oid='public.books_derive_native_invoice_correction_pair(uuid,uuid,uuid,uuid,uuid,uuid,jsonb,jsonb,text)'::regprocedure),'correction pair derivation retains INVOKER authority');
select ok(not has_function_privilege('anon','public.books_derive_native_invoice_replacement_draft(jsonb,uuid)','execute') and not has_function_privilege('authenticated','public.books_derive_native_invoice_replacement_draft(jsonb,uuid)','execute'),'replacement draft helper is private');
select ok(has_function_privilege('service_role','public.books_derive_native_invoice_replacement_draft(jsonb,uuid)','execute') and not (select prosecdef from pg_proc where oid='public.books_derive_native_invoice_replacement_draft(jsonb,uuid)'::regprocedure),'replacement draft helper retains INVOKER authority');
select * from finish();
rollback;
