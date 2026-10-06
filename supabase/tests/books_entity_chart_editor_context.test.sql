begin;
select plan(3);
select ok(not has_function_privilege('authenticated','public.read_books_entity_chart_editor_context(uuid,uuid,uuid,integer,integer)','execute'),'browser cannot bypass entity chart editor context authorization');
select ok(not (select prosecdef from pg_proc where oid='public.read_books_entity_chart_editor_context(uuid,uuid,uuid,integer,integer)'::regprocedure),'editor context preserves invoker authority');
select is((select provolatile::text from pg_proc where oid='public.read_books_entity_chart_editor_context(uuid,uuid,uuid,integer,integer)'::regprocedure),'s','editor context shares one statement snapshot');
select * from finish();
rollback;
