begin;
select plan(4);
select ok(not has_function_privilege('authenticated','public.read_books_project_entity_proposal(uuid,uuid,uuid,uuid,uuid,text)','execute'),'project owner recovery cannot be invoked by browser credentials');
select ok(not has_function_privilege('anon','public.read_books_project_entity_proposal(uuid,uuid,uuid,uuid,uuid,text)','execute'),'anonymous project owner recovery denied');
select ok(not (select prosecdef from pg_proc where oid='public.read_books_project_entity_proposal(uuid,uuid,uuid,uuid,uuid,text)'::regprocedure),'recovery preserves invoker authority');
select ok(has_function_privilege('service_role','public.read_books_project_entity_proposal(uuid,uuid,uuid,uuid,uuid,text)','execute'),'authorized server can recover project owner requests');
select * from finish();
rollback;
