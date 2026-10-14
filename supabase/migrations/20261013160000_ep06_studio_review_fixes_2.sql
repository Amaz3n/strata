-- EP06 second review fixes for design studio sessions and buyer approvals:
-- a home with no division books into any studio of the org, a replacement
-- signing envelope never outlives the approval's deadline, and a studio's rooms
-- are replaced whole in one transaction. Re-runnable.

-- ---------------------------------------------------------------------------
-- 1. The appointment division wall binds a divided home to its own division's
--    studios. A home with no division belongs to no division's calendar, so no
--    division is exposed by it booking into any studio the caller's scope
--    reaches (row security already narrows that to the caller's divisions).
-- ---------------------------------------------------------------------------

create or replace function public.tg_design_studio_appointment_division_wall()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_studio_division uuid;
  v_home_division uuid;
begin
  if new.status <> 'scheduled' or new.location_id is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.location_id is not distinct from old.location_id and new.status is not distinct from old.status then
    return new;
  end if;
  select l.division_id into v_studio_division from public.design_studio_locations l where l.id = new.location_id and l.org_id = new.org_id;
  if v_studio_division is null then
    return new;
  end if;
  select p.division_id into v_home_division from public.projects p where p.id = new.project_id and p.org_id = new.org_id;
  if v_home_division is not null and v_home_division is distinct from v_studio_division then
    raise exception 'That studio belongs to another division; choose one of this home''s division' using errcode = '23514', detail = 'DESIGN_STUDIO_DIVISION';
  end if;
  return new;
end;
$$;

revoke all on function public.tg_design_studio_appointment_division_wall() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. A Resend reissues the signing envelope with the old envelope's day count,
--    which can run past the approval's own deadline. The replacement ends no
--    later than the approval does (so a signature after the deadline is refused
--    by the signing flow rather than landing as a signed copy with no approval),
--    and a resend after the deadline is refused.
-- ---------------------------------------------------------------------------

create or replace function public.tg_envelope_selection_approval_send()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_approval public.selection_approvals;
  v_replaces boolean;
begin
  select * into v_approval from public.selection_approvals where id = new.source_entity_id and org_id = new.org_id for update;
  if not found or v_approval.status <> 'sent' or v_approval.channel <> 'esign' then
    raise exception 'This signing document does not carry a request still waiting on the buyer' using errcode = '42501';
  end if;
  v_replaces := v_approval.document_id is distinct from new.document_id;
  if v_replaces and not (
    v_approval.envelope_id is not null
    and new.metadata->>'resend_of_envelope_id' = v_approval.envelope_id::text
    and exists (select 1 from public.envelopes o where o.id = v_approval.envelope_id and o.org_id = new.org_id and o.status = 'voided')
  ) then
    raise exception 'This signing document does not carry a request still waiting on the buyer' using errcode = '42501';
  end if;
  if v_approval.expires_at is not null then
    if v_approval.expires_at <= now() then
      raise exception 'The deadline for this approval has passed; send the selections again' using errcode = '23514';
    end if;
    if new.expires_at is null or new.expires_at > v_approval.expires_at then
      new.expires_at := v_approval.expires_at;
    end if;
  end if;
  new.metadata := coalesce(new.metadata, '{}'::jsonb)
    || jsonb_build_object('selection_approval_id', v_approval.id, 'selection_terms_hash', v_approval.terms_hash);
  if v_replaces then
    update public.selection_approvals set envelope_id = new.id, document_id = new.document_id where id = v_approval.id;
  end if;
  return new;
end;
$$;

revoke all on function public.tg_envelope_selection_approval_send() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. A studio's rooms are replaced whole: renames land in two phases (so two
--    rooms can swap names), a room left off the list is taken out of service,
--    and a refusal anywhere leaves every room as it was.
-- ---------------------------------------------------------------------------

create or replace function public.replace_studio_rooms(p_org_id uuid, p_location_id uuid, p_rooms jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_room record;
  v_listed uuid[];
  v_unlisted uuid[];
  v_name text;
begin
  if jsonb_typeof(p_rooms) is distinct from 'array' then
    raise exception 'Rooms are a list' using errcode = '22023';
  end if;
  perform 1 from public.design_studio_locations where id = p_location_id and org_id = p_org_id for update;
  if not found then
    raise exception 'Studio not found' using errcode = 'P0002';
  end if;

  select coalesce(array_agg((r->>'id')::uuid), '{}') into v_listed from jsonb_array_elements(p_rooms) r where r->>'id' is not null;
  if exists (
    select 1 from unnest(v_listed) as listed(id)
    where not exists (select 1 from public.design_studio_rooms x where x.id = listed.id and x.org_id = p_org_id and x.location_id = p_location_id)
  ) then
    raise exception 'A room on the list belongs to another studio' using errcode = '22023';
  end if;

  select coalesce(array_agg(x.id), '{}') into v_unlisted
    from public.design_studio_rooms x
    where x.org_id = p_org_id and x.location_id = p_location_id and x.is_active and not (x.id = any (v_listed));

  update public.design_studio_rooms set name = 'moving:' || id::text
    where org_id = p_org_id and location_id = p_location_id and id = any (v_listed);

  begin
    for v_room in
      select (r.value->>'id')::uuid as id, btrim(r.value->>'name') as name,
             coalesce((r.value->>'isActive')::boolean, true) as is_active, (r.ordinality - 1)::integer as sort_order
      from jsonb_array_elements(p_rooms) with ordinality r
    loop
      v_name := v_room.name;
      if v_room.id is null then
        insert into public.design_studio_rooms (org_id, location_id, name, is_active, sort_order)
        values (p_org_id, p_location_id, v_room.name, v_room.is_active, v_room.sort_order);
      else
        update public.design_studio_rooms set name = v_room.name, is_active = v_room.is_active, sort_order = v_room.sort_order
          where id = v_room.id and org_id = p_org_id and location_id = p_location_id;
      end if;
    end loop;
  exception when unique_violation then
    raise exception 'Two rooms are named %', v_name using errcode = '23505';
  end;

  update public.design_studio_rooms set is_active = false
    where org_id = p_org_id and location_id = p_location_id and is_active and id = any (v_unlisted);

  return jsonb_array_length(p_rooms);
end;
$$;

revoke all on function public.replace_studio_rooms(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.replace_studio_rooms(uuid, uuid, jsonb) to service_role;
