begin;
select plan(2);
select ok(not has_function_privilege('authenticated','public.prepare_books_journal_proposal_atomic(uuid,uuid,uuid,date,text,date,jsonb)','execute'),'journal preparation RPC is private');
select ok(not (select prosecdef from pg_proc where oid='public.prepare_books_journal_proposal_atomic(uuid,uuid,uuid,date,text,date,jsonb)'::regprocedure),'journal preparation respects invoker privileges');
select * from finish();
rollback;
