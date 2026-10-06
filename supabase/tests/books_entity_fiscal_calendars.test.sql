begin;
select plan(4);
select ok(not has_function_privilege('authenticated','public.prepare_books_entity_calendar(uuid,uuid,uuid,uuid,uuid,integer,text)','execute'),'entity calendar preparation RPC is private');
select ok(not (select prosecdef from pg_proc where oid='public.review_books_entity_calendar(uuid,uuid,uuid,uuid,uuid,text)'::regprocedure),'calendar review preserves invoker authority');
select ok(not has_table_privilege('authenticated','public.books_entity_fiscal_periods','insert'),'browser cannot invent entity fiscal periods');
select ok(exists(select 1 from pg_trigger where tgrelid='public.books_entity_calendar_years'::regclass and tgname='books_entity_calendar_complete' and tgdeferrable and tginitdeferred),'calendar completeness is enforced at commit');
select * from finish();
rollback;
