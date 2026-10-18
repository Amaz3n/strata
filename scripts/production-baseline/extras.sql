-- What production has that `supabase db dump` does not carry, as one JSON value
-- for build.cjs. Read-only; run it against production (Supabase MCP
-- execute_sql) and save the JSON row it returns.
--   roles:            the application's own database roles (dumps never include roles)
--   buckets:          storage buckets (the dump skips the storage schema)
--   storage_policies: policies on storage.objects (same)
--   cron:             pg_cron jobs (the dump skips the cron schema)
select json_build_object(
  'roles', (select coalesce(json_agg(rolname order by rolname), '[]') from pg_roles where rolname like 'arc\_%'),
  'buckets', (select coalesce(json_agg(json_build_object('id', id, 'name', name, 'public', public, 'limit', file_size_limit, 'mimes', allowed_mime_types) order by id), '[]') from storage.buckets),
  'storage_policies', (select coalesce(json_agg(json_build_object('name', policyname, 'permissive', permissive, 'roles', roles, 'cmd', cmd, 'qual', qual, 'with_check', with_check) order by policyname), '[]') from pg_policies where schemaname = 'storage' and tablename = 'objects'),
  'cron', (select coalesce(json_agg(json_build_object('name', jobname, 'schedule', schedule, 'command', command) order by jobname), '[]') from cron.job)
) j
