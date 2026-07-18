create or replace function public.update_qbo_cdc_cursor(
  p_connection_id uuid,
  p_cursor timestamptz
)
returns void
language sql
security definer
set search_path = public
as $$
  update public.qbo_connections
  set settings = coalesce(settings, '{}'::jsonb)
    || jsonb_build_object('qbo_cdc_last_synced_at', p_cursor)
  where id = p_connection_id;
$$;

grant execute on function public.update_qbo_cdc_cursor(uuid, timestamptz) to service_role;
