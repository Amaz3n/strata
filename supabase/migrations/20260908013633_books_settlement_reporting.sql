-- PurchaseAgreementSettlement persists finalPriceCents. Retain read compatibility
-- for older snake-case snapshots across all production reporting RPCs.
do $$
declare routine record; definition text; updated_definition text;
begin
  for routine in select p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.prokind='f' and p.proname in ('get_sales_backlog_report','get_sales_deals','warranty_cost_summary','production_home_stat_rollup')
  loop
    definition:=pg_get_functiondef(routine.oid);
    if position('finalPriceCents' in definition)>0 then continue; end if;
    updated_definition:=regexp_replace(definition,
      '([[:alnum:]_]+\.settlement)[[:space:]]*->>[[:space:]]*''final_price_cents''',
      'coalesce(\1->>''finalPriceCents'', \1->>''final_price_cents'')','g');
    if updated_definition<>definition then execute updated_definition; end if;
  end loop;
end;
$$;
