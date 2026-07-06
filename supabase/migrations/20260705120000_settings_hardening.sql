create or replace function public.merge_org_settings(
  p_org_id uuid,
  p_patch jsonb,
  p_delete_keys text[] default '{}'::text[]
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_settings jsonb;
begin
  insert into public.org_settings (org_id, settings)
  values (p_org_id, coalesce(p_patch, '{}'::jsonb))
  on conflict (org_id) do update
    set settings = coalesce(public.org_settings.settings, '{}'::jsonb) || coalesce(excluded.settings, '{}'::jsonb),
        updated_at = now()
  returning settings into v_settings;

  if p_delete_keys is not null and cardinality(p_delete_keys) > 0 then
    update public.org_settings
      set settings = coalesce(settings, '{}'::jsonb) - p_delete_keys,
          updated_at = now()
      where org_id = p_org_id
      returning settings into v_settings;
  end if;

  return coalesce(v_settings, '{}'::jsonb);
end;
$$;

revoke all on function public.merge_org_settings(uuid, jsonb, text[]) from public;
grant execute on function public.merge_org_settings(uuid, jsonb, text[]) to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'user-avatars',
  'user-avatars',
  true,
  5242880,
  array['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']::text[]
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;
