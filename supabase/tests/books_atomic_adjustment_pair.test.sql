begin;
select plan(2);
select ok(not has_function_privilege('authenticated','public.post_books_adjustment_pair(uuid,uuid,date,text,text,integer,jsonb,date)','execute'),'direct adjustment pair RPC is private');
select ok(not (select prosecdef from pg_proc where oid='public.post_books_adjustment_pair(uuid,uuid,date,text,text,integer,jsonb,date)'::regprocedure),'direct pair respects invoker privileges');
select * from finish();
rollback;
