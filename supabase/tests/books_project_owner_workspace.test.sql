begin;
select plan(3);
select ok(not has_function_privilege('authenticated','public.read_books_project_owner_workspace(uuid,uuid,uuid,uuid,uuid,uuid,integer)','execute'),'project ownership workspace stays private');
select ok(not (select prosecdef from pg_proc where oid='public.read_books_project_owner_workspace(uuid,uuid,uuid,uuid,uuid,uuid,integer)'::regprocedure),'project ownership workspace preserves invoker authority');
select ok(has_function_privilege('service_role','public.read_books_project_owner_workspace(uuid,uuid,uuid,uuid,uuid,uuid,integer)','execute'),'authorized server can load scoped project ownership workspace');
select * from finish();
rollback;
