begin;
select plan(3);
select ok(not has_function_privilege('anon','public.capture_books_export_snapshot(uuid)','execute') and not has_function_privilege('authenticated','public.capture_books_export_snapshot(uuid)','execute'),'exact quantity export remains private');
select ok(not (select prosecdef from pg_proc where oid='public.capture_books_export_snapshot(uuid)'::regprocedure) and (select provolatile='s' from pg_proc where oid='public.capture_books_export_snapshot(uuid)'::regprocedure),'decimal export keeps INVOKER single-statement visibility');
select ok(to_regprocedure('public.capture_books_export_snapshot_before_exact_invoice_quantity(uuid)') is null,'no earlier capture remains to call');
select * from finish();
rollback;
