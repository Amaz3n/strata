begin;
select plan(4);
select ok(not has_function_privilege('authenticated','public.review_books_project_entity(uuid,uuid,uuid,uuid,uuid,uuid,text)','execute'),'project ownership review is private');
select ok(not (select prosecdef from pg_proc where oid='public.prepare_books_project_entity(uuid,uuid,uuid,uuid,uuid,uuid,date,jsonb,text)'::regprocedure),'project ownership preparation preserves invoker authority');
select ok(not has_table_privilege('authenticated','public.books_project_entity_reviews','insert'),'browser cannot assign actual project owners directly');
select ok(exists(select 1 from pg_trigger where tgrelid='public.accounting_facts'::regclass and tgname='books_project_entity_legacy_fact_guard'),'entity-owned projects are fenced from legacy fact insertion');
select * from finish();
rollback;
