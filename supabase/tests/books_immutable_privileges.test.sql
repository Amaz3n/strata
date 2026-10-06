begin;
select plan(1);
select is(
 (select coalesce(array_agg(distinct tg.tgrelid::regclass::text order by tg.tgrelid::regclass::text),'{}') from pg_trigger tg join pg_proc p on p.oid=tg.tgfoid
  where not tg.tgisinternal and p.proname='books_entity_immutable'
  and (has_table_privilege('service_role',tg.tgrelid,'delete') or has_table_privilege('service_role',tg.tgrelid,'truncate'))),
 '{}'::text[],
 'immutable Books history cannot be deleted or truncated by the server role');
select * from finish();
rollback;
