begin;
select plan(4);
select ok(not has_function_privilege('authenticated','public.resolve_books_journal_request_atomic(uuid,uuid,uuid,text,jsonb,text)','execute'),'journal resolution RPC is private');
select ok(not (select prosecdef from pg_proc where oid='public.resolve_books_journal_request_atomic(uuid,uuid,uuid,text,jsonb,text)'::regprocedure),'journal resolution respects invoker privileges');
select ok(not has_table_privilege('authenticated','public.books_journal_request_resolutions','insert'),'browser cannot fabricate a journal cancellation receipt');
select ok(exists(select 1 from pg_trigger where tgrelid='public.books_journal_proposals'::regclass and tgname='books_journal_resolution_writer_fence'),'original writers enforce durable cancelled intents');
select * from finish();
rollback;
