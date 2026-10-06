begin;
select plan(4);
select ok(not has_function_privilege('authenticated','public.read_books_native_project_posting_context(uuid,uuid,text,uuid,uuid,date,text)','execute'),'native project routing stays private');
select ok(not has_function_privilege('anon','public.read_books_native_project_posting_context(uuid,uuid,text,uuid,uuid,date,text)','execute'),'anonymous cannot inspect native source routing');
select ok(has_function_privilege('service_role','public.read_books_native_project_posting_context(uuid,uuid,text,uuid,uuid,date,text)','execute'),'authorized server can inspect scoped native routing');
select ok(not (select prosecdef from pg_proc where oid='public.read_books_native_project_posting_context(uuid,uuid,text,uuid,uuid,date,text)'::regprocedure),'native source routing preserves invoker authority');
select * from finish();
rollback;
