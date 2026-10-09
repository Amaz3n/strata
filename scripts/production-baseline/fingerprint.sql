-- One row per application schema object: kind, name and the md5 of its definition.
-- Read-only. Run it against production (Supabase MCP execute_sql) and against a
-- fresh replay; the rows must match. Names are text and ordering is collate "C"
-- so both sides hash the same rows the same way.
with app_schemas as (
  select n.oid, n.nspname from pg_namespace n
  where n.nspname not in ('pg_catalog','information_schema','pg_toast','extensions','graphql','graphql_public','realtime','supabase_functions','vault','net','cron','pgsodium','pgsodium_masks','supabase_migrations','pgbouncer','pg_temp_1','pg_toast_temp_1','books_acceptance','_realtime','_analytics','auth','storage')
    and n.nspname not like 'pg_temp%' and n.nspname not like 'pg_toast_temp%'
),
rels as (select c.oid, n.nspname||'.'||c.relname as name, c.relkind, c.relrowsecurity, c.relforcerowsecurity, c.relacl from pg_class c join app_schemas n on n.oid=c.relnamespace),
objs as (
  select 'schema'::text kind, nspname::text name, ''::text def from app_schemas
  union all select 'extension', extname, '' from pg_extension
  union all select 'relation', name, relkind::text||coalesce(relrowsecurity::text,'')||coalesce(relforcerowsecurity::text,'') from rels where relkind in ('r','p','v','m','S','f')
  union all select 'column', r.name||'.'||a.attname, format_type(a.atttypid,a.atttypmod)||'|'||a.attnotnull||'|'||coalesce(pg_get_expr(d.adbin,d.adrelid),'')||'|'||a.attgenerated::text||a.attidentity::text
    from rels r join pg_attribute a on a.attrelid=r.oid and a.attnum>0 and not a.attisdropped left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum where r.relkind in ('r','p','v','m','f')
  union all select 'column_order', r.name, string_agg(a.attname, ',' order by a.attnum)
    from rels r join pg_attribute a on a.attrelid=r.oid and a.attnum>0 and not a.attisdropped where r.relkind in ('r','p') group by r.name
  union all select 'constraint', r.name||'.'||co.conname, pg_get_constraintdef(co.oid) from pg_constraint co join rels r on r.oid=co.conrelid
  union all select 'index', r.name||'.'||i.relname, pg_get_indexdef(x.indexrelid) from pg_index x join pg_class i on i.oid=x.indexrelid join rels r on r.oid=x.indrelid
  union all select 'trigger', n.nspname||'.'||c.relname||'.'||t.tgname, pg_get_triggerdef(t.oid)||'|'||t.tgenabled::text from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where not t.tgisinternal and n.nspname not in ('pg_catalog','realtime','supabase_functions','net','cron','vault','pgsodium')
  union all select 'function', n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')', md5(pg_get_functiondef(p.oid))||'|'||p.prosecdef||'|'||coalesce(array_to_string(p.proconfig,','),'')
    from pg_proc p join app_schemas n on n.oid=p.pronamespace where p.prokind in ('f','p','w') and not exists (select 1 from pg_depend dp where dp.objid=p.oid and dp.deptype='e')
  union all select 'aggregate', n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')', '' from pg_proc p join app_schemas n on n.oid=p.pronamespace where p.prokind='a'
  union all select 'function_acl', n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')', coalesce((select string_agg(x::text,',' order by x::text) from unnest(p.proacl) x),'default')
    from pg_proc p join app_schemas n on n.oid=p.pronamespace where not exists (select 1 from pg_depend dp where dp.objid=p.oid and dp.deptype='e')
  union all select 'view', name, md5(pg_get_viewdef(oid,true)) from rels where relkind in ('v','m')
  union all select 'relation_acl', name, coalesce((select string_agg(x::text,',' order by x::text) from unnest(relacl) x),'default') from rels where relkind in ('r','p','v','m','S')
  union all select 'policy', schemaname||'.'||tablename||'.'||policyname, permissive||'|'||array_to_string(roles,',')||'|'||cmd::text||'|'||coalesce(qual,'')||'|'||coalesce(with_check,'') from pg_policies where schemaname not in ('realtime')
  union all select 'type', n.nspname||'.'||t.typname, t.typtype::text||'|'||coalesce((select string_agg(e.enumlabel,',' order by e.enumsortorder) from pg_enum e where e.enumtypid=t.oid),'')||'|'||coalesce(pg_catalog.format_type(t.typbasetype,t.typtypmod),'')
    from pg_type t join app_schemas n on n.oid=t.typnamespace where t.typtype in ('e','d','c') and (t.typtype<>'c' or exists(select 1 from pg_class c where c.oid=t.typrelid and c.relkind='c'))
  union all select 'bucket', id, public::text||'|'||coalesce(file_size_limit::text,'')||'|'||coalesce(array_to_string(allowed_mime_types,','),'') from storage.buckets
  union all select 'cron_job', jobname, md5(schedule||command) from cron.job where to_regclass('cron.job') is not null
)
select kind, name, md5(def) h from objs
