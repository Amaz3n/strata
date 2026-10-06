begin;
select plan(1);
select is(
  (select coalesce(array_agg(distinct c.relname||'.'||a.attname||' -> '||p.oid::regprocedure::text order by c.relname||'.'||a.attname||' -> '||p.oid::regprocedure::text),'{}')
   from pg_attrdef ad join pg_attribute a on a.attrelid=ad.adrelid and a.attnum=ad.adnum and a.attgenerated='s'
   join pg_class c on c.oid=ad.adrelid
   join pg_depend d on d.classid='pg_attrdef'::regclass and d.objid=ad.oid and d.refclassid='pg_proc'::regclass
   join pg_proc p on p.oid=d.refobjid
   where c.relnamespace='public'::regnamespace and p.pronamespace='public'::regnamespace
     and not has_function_privilege('authenticated',p.oid,'execute')
     and (has_table_privilege('authenticated',c.oid,'insert') or has_table_privilege('authenticated',c.oid,'update'))),
  '{}'::text[],
  'generated columns on user-writable tables only use functions users can execute');
select * from finish();
rollback;
