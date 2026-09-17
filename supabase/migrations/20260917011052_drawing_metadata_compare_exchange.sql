-- Render and label workers share a JSON document. Compare-and-swap prevents
-- lost updates without putting potentially large metadata in a REST URL.
create or replace function public.compare_exchange_drawing_metadata(
  p_org_id uuid,
  p_version_id uuid,
  p_expected jsonb,
  p_next jsonb
) returns boolean
language sql
security invoker
set search_path = public, pg_catalog
as $$
  with changed as (
    update public.drawing_sheet_versions
    set extracted_metadata = p_next
    where org_id = p_org_id and id = p_version_id
      and extracted_metadata is not distinct from p_expected
    returning id
  )
  select exists(select 1 from changed);
$$;

revoke all on function public.compare_exchange_drawing_metadata(uuid, uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.compare_exchange_drawing_metadata(uuid, uuid, jsonb, jsonb) to service_role;
