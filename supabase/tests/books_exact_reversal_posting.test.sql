begin;
select plan(3);
select ok(not exists(select 1 from pg_proc where pronamespace='public'::regnamespace and proname in('books_reversal_line_signature','books_guard_exact_reversal','books_complete_exact_reversal','reverse_books_journal_entry') and prosecdef),'reversal validation and completion are invokers');
select is((select count(*)::integer from pg_trigger where tgrelid='public.journal_entries'::regclass and tgname in('journal_entries_exact_reversal_guard','journal_entries_exact_reversal_complete')),2,'reversal posting validates money and completes original lifecycle');
select ok(not has_function_privilege('authenticated','public.reverse_books_journal_entry(uuid,uuid,jsonb,jsonb)','execute'),'reversal RPC remains private');
select * from finish();
rollback;
