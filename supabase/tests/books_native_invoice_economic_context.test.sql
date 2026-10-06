begin;
select plan(4);
select ok(not has_function_privilege('authenticated','public.read_books_native_invoice_economic_context(uuid,uuid,text,uuid,uuid,date)','execute'),'invoice economics remain private');
select ok(not has_function_privilege('anon','public.read_books_native_invoice_economic_context(uuid,uuid,text,uuid,uuid,date)','execute'),'anonymous cannot inspect invoice economics');
select ok(has_function_privilege('service_role','public.read_books_native_invoice_economic_context(uuid,uuid,text,uuid,uuid,date)','execute'),'authorized server can read scoped invoice economics');
select ok(not (select prosecdef from pg_proc where oid='public.read_books_native_invoice_economic_context(uuid,uuid,text,uuid,uuid,date)'::regprocedure),'invoice economics retain invoker authority');
select * from finish();
rollback;
