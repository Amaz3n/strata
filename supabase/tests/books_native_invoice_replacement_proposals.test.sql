begin;
select plan(3);
select ok(not has_function_privilege('anon','public.books_validate_native_invoice_correction_request(jsonb,uuid,uuid,uuid,uuid)','execute') and not has_function_privilege('authenticated','public.books_validate_native_invoice_correction_request(jsonb,uuid,uuid,uuid,uuid)','execute'),'replacement request validator is private');
select ok(not (select prosecdef from pg_proc where oid='public.books_native_invoice_correction_proposal_guard()'::regprocedure) and has_function_privilege('service_role','public.books_native_invoice_correction_proposal_guard()','execute'),'replacement proposal guard retains INVOKER authority');
select ok(exists(select 1 from pg_constraint where conrelid='public.books_native_invoice_correction_proposals'::regclass and conname='books_native_invoice_correction_request_size' and pg_get_constraintdef(oid) like '%16800000%'),'bounded replacement intent has room for its original economic witness');
select * from finish();
rollback;
