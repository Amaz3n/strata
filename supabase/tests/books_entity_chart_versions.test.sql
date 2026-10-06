begin;
select plan(5);
select ok(not has_function_privilege('authenticated','public.prepare_books_entity_chart(uuid,uuid,uuid,uuid,uuid,uuid,date,jsonb,text)','execute'),'entity chart preparation RPC is private');
select ok(not (select prosecdef from pg_proc where oid='public.review_books_entity_chart(uuid,uuid,uuid,uuid,uuid,text)'::regprocedure),'chart review preserves invoker authority');
select ok(not has_table_privilege('authenticated','public.books_entity_accounts','insert'),'browser cannot invent canonical entity accounts');
select ok(exists(select 1 from pg_trigger where tgrelid='public.books_entity_chart_versions'::regclass and tgname='books_entity_chart_complete' and tgdeferrable and tginitdeferred),'chart completeness is enforced at commit');
select ok(not has_function_privilege('anon','public.read_books_entity_chart(uuid,uuid,uuid,uuid)','execute'),'entity chart details require gated service authority');
select * from finish();
rollback;
