begin;
select plan(5);
select ok(not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in('prepare_books_native_adjustment','review_books_native_adjustment','read_books_native_adjustment','set_books_native_period_hold') and (p.prosecdef or has_function_privilege('authenticated',p.oid,'execute') or has_function_privilege('anon',p.oid,'execute'))),'native money remains private and invoker governed');
select ok((select count(*)=4 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in('prepare_books_native_adjustment','review_books_native_adjustment','read_books_native_adjustment','set_books_native_period_hold') and has_function_privilege('service_role',p.oid,'execute')),'authorized server owns four scoped monetary operations');
select ok(not exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname in('books_native_adjustment_facts','books_native_adjustment_reviews','books_native_journal_entries','books_native_journal_lines','books_native_period_holds','books_native_entity_fences') and (not c.relrowsecurity or has_table_privilege('authenticated',c.oid,'select') or has_table_privilege('anon',c.oid,'select'))),'native facts money holds and fences are private');
select ok((select count(*)=2 from pg_trigger where tgname in('books_native_review_complete','books_native_journal_complete') and tgdeferrable and tginitdeferred),'native approval and journal completeness are deferred atomic constraints');
select ok((select count(*)=5 from pg_trigger where tgname='books_native_immutable' and not tgisinternal),'all five native financial history families are immutable');
select * from finish();
rollback;
