-- Serialize measurement changes and accept only the snapshot reviewed by the
-- server's geometry checks. No extension, destructive change or data backfill.
create or replace function public.lock_takeoff_measurement_scope()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_keys text[] := '{}';
  v_key text;
begin
  if tg_op <> 'INSERT' and old.condition_id is not null then
    v_keys := array_append(v_keys, old.org_id::text || ':' || old.sheet_version_id::text || ':' || old.condition_id::text);
  end if;
  if tg_op <> 'DELETE' and new.condition_id is not null then
    v_keys := array_append(v_keys, new.org_id::text || ':' || new.sheet_version_id::text || ':' || new.condition_id::text);
  end if;
  for v_key in select distinct k from unnest(v_keys) k order by k loop
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('takeoff-area:' || v_key, 0));
  end loop;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
revoke all on function public.lock_takeoff_measurement_scope() from public, anon, authenticated;
create trigger drawing_markups_lock_measurement_scope
before insert or update or delete on public.drawing_markups
for each row execute function public.lock_takeoff_measurement_scope();

create or replace function public.accept_takeoff_area_snapshot(
  p_org_id uuid, p_version_id uuid, p_condition_id uuid,
  p_snapshot jsonb, p_rows jsonb
) returns integer language plpgsql security invoker set search_path = '' as $$
declare
  v_snapshot jsonb;
  v_sheet_id uuid;
  v_count integer;
begin
  if jsonb_typeof(p_snapshot) is distinct from 'array'
     or jsonb_typeof(p_rows) is distinct from 'array'
     or jsonb_array_length(p_rows) not between 1 and 1050 then
    raise exception 'Invalid area acceptance batch';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'takeoff-area:' || p_org_id::text || ':' || p_version_id::text || ':' || p_condition_id::text, 0));
  select v.drawing_sheet_id into v_sheet_id
  from public.drawing_sheet_versions v join public.drawing_sheets s on s.id = v.drawing_sheet_id and s.org_id = v.org_id
  where v.id = p_version_id and v.org_id = p_org_id and s.current_revision_id = v.drawing_revision_id;
  if v_sheet_id is null or not exists(select 1 from public.takeoff_conditions where id = p_condition_id and org_id = p_org_id) then
    raise exception 'Drawing or condition changed. Reopen the current drawing.';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'data', data) order by id), '[]'::jsonb)
    into v_snapshot from public.drawing_markups
    where org_id = p_org_id and sheet_version_id = p_version_id and condition_id = p_condition_id;
  if v_snapshot <> p_snapshot then
    raise exception 'Measurements changed during review. Detect and review areas again.' using errcode = '40001';
  end if;
  if exists(select 1 from jsonb_array_elements(p_rows) r where
    (r->>'org_id')::uuid is distinct from p_org_id or
    (r->>'sheet_version_id')::uuid is distinct from p_version_id or
    (r->>'drawing_sheet_id')::uuid is distinct from v_sheet_id or
    (r->>'condition_id')::uuid is distinct from p_condition_id or
    r->'data'->>'type' is distinct from 'area') then
    raise exception 'Area batch scope mismatch';
  end if;
  insert into public.drawing_markups (id,org_id,drawing_sheet_id,sheet_version_id,condition_id,data,label,quantity,uom,created_by,is_private,share_with_clients,share_with_subs)
  select id,org_id,drawing_sheet_id,sheet_version_id,condition_id,data,label,quantity,uom,created_by,is_private,share_with_clients,share_with_subs
  from jsonb_to_recordset(p_rows) as r(id uuid,org_id uuid,drawing_sheet_id uuid,sheet_version_id uuid,condition_id uuid,data jsonb,label text,quantity numeric,uom text,created_by uuid,is_private boolean,share_with_clients boolean,share_with_subs boolean)
  on conflict (id) do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function public.accept_takeoff_area_snapshot(uuid,uuid,uuid,jsonb,jsonb) from public, anon;
grant execute on function public.accept_takeoff_area_snapshot(uuid,uuid,uuid,jsonb,jsonb) to authenticated, service_role;
