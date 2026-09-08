begin;
select plan(5);
select is(public.accounting_d2_sql_legacy_dependencies(),0::bigint,'rehearsed runtime functions have no legacy column dependency');
create function public.synthetic_unqualified_legacy_read() returns text language plpgsql as $$ begin return (select qbo_id from public.invoices limit 1); end $$;
select is(public.accounting_d2_sql_legacy_dependencies(),1::bigint,'unqualified legacy column reads are detected');
drop function public.synthetic_unqualified_legacy_read();
create function public.synthetic_record_legacy_read() returns text language plpgsql as $$ declare v_bill public.vendor_bills%rowtype; begin return v_bill.qbo_expense_account_name; end $$;
select is(public.accounting_d2_sql_legacy_dependencies(),1::bigint,'record field and names-only reads are detected');
drop function public.synthetic_record_legacy_read();
-- A harmless body change still invalidates the exact reviewed exception.
do $$ declare definition text; begin select pg_get_functiondef('public.refresh_vendor_tax_readiness(uuid,integer)'::regprocedure) into definition; execute replace(definition, E'\nbegin\n', E'\nbegin\n-- changed after rehearsal\n'); end $$;
select is(public.accounting_d2_sql_legacy_dependencies(),1::bigint,'a changed cached-output routine loses its reviewed exception');
select ok(not has_function_privilege('authenticated','public.accounting_d2_sql_legacy_dependencies()','execute'),'only the service collector can inspect routine census');
select * from finish();
rollback;
