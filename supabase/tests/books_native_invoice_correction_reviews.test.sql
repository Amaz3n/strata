begin;
select plan(4);
select ok(not has_function_privilege('anon','public.review_books_native_invoice_correction(uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,text)','execute') and not has_function_privilege('authenticated','public.review_books_native_invoice_correction(uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,text)','execute'),'review API remains server-only');
select ok(not (select prosecdef from pg_proc where oid='public.books_native_invoice_correction_review_guard()'::regprocedure),'review guard retains INVOKER authority');
select ok((select relrowsecurity from pg_class where oid='public.books_native_invoice_correction_reviews'::regclass) and not has_table_privilege('authenticated','public.books_native_invoice_correction_reviews','select'),'review evidence is private with RLS');
select ok(not has_table_privilege('service_role','public.books_native_invoice_correction_reviews','update') and not has_table_privilege('service_role','public.books_native_invoice_correction_reviews','delete'),'review history is append-only');
select * from finish();
rollback;
