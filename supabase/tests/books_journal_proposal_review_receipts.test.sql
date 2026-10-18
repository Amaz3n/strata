begin;
select plan(3);
select ok(not has_function_privilege('authenticated','public.review_books_journal_proposal_atomic(uuid,uuid,uuid,text,text)','execute'),'independent journal review RPC is private');
select ok(not (select prosecdef from pg_proc where oid='public.review_books_journal_proposal_atomic(uuid,uuid,uuid,text,text)'::regprocedure),'journal review respects invoker privileges');
select is((select count(*)::integer from pg_constraint where conrelid='public.books_journal_proposals'::regclass and conname in('books_proposal_journal_owner','books_proposal_reversal_owner')),2,'proposal money receipts enforce organization ownership');
select * from finish();
rollback;
