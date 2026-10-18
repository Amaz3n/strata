-- EP06 review fixes 3: hours cannot strand a booked session; the signed-copy
-- reuse check runs under the home's selections lock.

create or replace function public.replace_consultant_hours(p_org_id uuid, p_location_id uuid, p_user_id uuid, p_windows jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
  v_zone text;
  v_stranded integer;
begin
  if jsonb_typeof(p_windows) is distinct from 'array' then
    raise exception 'Hours are a list of windows' using errcode = '22023';
  end if;
  select l.time_zone into v_zone from public.design_studio_locations l where l.id = p_location_id and l.org_id = p_org_id;
  if v_zone is null then
    raise exception 'Studio not found' using errcode = 'P0002';
  end if;
  delete from public.design_studio_consultant_hours
  where org_id = p_org_id and location_id = p_location_id and user_id = p_user_id;
  insert into public.design_studio_consultant_hours (org_id, user_id, location_id, weekday, start_minute, end_minute)
  select p_org_id, p_user_id, p_location_id, (w->>'weekday')::smallint, (w->>'startMinute')::smallint, (w->>'endMinute')::smallint
  from jsonb_array_elements(p_windows) w;
  get diagnostics v_count = row_count;

  -- A session still ahead must stay inside the consultant's hours, as a room
  -- with sessions ahead cannot leave service.
  select count(*) into v_stranded
  from public.design_studio_appointments a
  where a.org_id = p_org_id and a.location_id = p_location_id and a.coordinator_user_id = p_user_id
    and a.status = 'scheduled' and a.ends_at > now()
    and not exists (
      select 1 from public.design_studio_consultant_hours h
      where h.org_id = a.org_id and h.user_id = a.coordinator_user_id and h.location_id = a.location_id
        and h.weekday = extract(dow from (a.scheduled_at at time zone v_zone))::integer
        and h.start_minute <= extract(hour from (a.scheduled_at at time zone v_zone))::integer * 60 + extract(minute from (a.scheduled_at at time zone v_zone))::integer
        and h.end_minute >= (extract(epoch from ((a.ends_at at time zone v_zone) - date_trunc('day', a.scheduled_at at time zone v_zone))) / 60)::integer
    );
  if v_stranded > 0 then
    raise exception 'Move or cancel the % session(s) this consultant has booked outside those hours first', v_stranded
      using errcode = '23514', detail = 'DESIGN_STUDIO_HOURS_BOOKED';
  end if;
  return v_count;
end;
$$;

revoke all on function public.replace_consultant_hours(uuid, uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.replace_consultant_hours(uuid, uuid, uuid, jsonb) to service_role;

create or replace function public.approve_selection_terms(
  p_org_id uuid, p_project_id uuid, p_group_id uuid, p_channel text, p_terms_hash text,
  p_contact_id uuid default null, p_user_id uuid default null, p_signed_copy_file_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_terms jsonb;
  v_pending public.selection_approvals;
  v_approval public.selection_approvals;
begin
  if p_channel = 'portal' then
    if p_contact_id is null then
      raise exception 'A portal approval names the buyer who gave it' using errcode = '22023';
    end if;
  elsif p_channel = 'in_person' then
    if p_user_id is null or p_signed_copy_file_id is null then
      raise exception 'An in-person approval needs the buyer''s signed copy filed on the home' using errcode = '22023', detail = 'SELECTION_SIGNED_COPY_REQUIRED';
    end if;
    if not exists (
      select 1 from public.files f
      where f.id = p_signed_copy_file_id and f.org_id = p_org_id and f.project_id = p_project_id and f.archived_at is null
        and f.category = 'contracts'
        and (f.mime_type = 'application/pdf' or f.mime_type like 'image/%')
        and f.uploaded_by is not distinct from p_user_id
        and f.created_at > now() - interval '1 hour'
        and coalesce(f.source, '') <> 'generated'
    ) then
      raise exception 'Attach the buyer''s signed copy as a new upload (a PDF or photo) filed with this approval' using errcode = '23514', detail = 'SELECTION_SIGNED_COPY_REQUIRED';
    end if;
  else
    raise exception 'E-signed approvals are recorded by the signing document' using errcode = '22023';
  end if;
  if not exists (select 1 from public.projects where id = p_project_id and org_id = p_org_id) then
    raise exception 'Home not found' using errcode = 'P0002';
  end if;
  perform public.lock_project_selections(p_org_id, p_project_id);
  -- Under the home's lock, so two concurrent approvals cannot both claim one file.
  if p_channel = 'in_person' and exists (
    select 1 from public.selection_approvals a
    where a.signed_copy_file_id = p_signed_copy_file_id or a.executed_file_id = p_signed_copy_file_id
  ) then
    raise exception 'Attach the buyer''s signed copy as a new upload (a PDF or photo) filed with this approval' using errcode = '23514', detail = 'SELECTION_SIGNED_COPY_REQUIRED';
  end if;
  v_terms := public.assert_selection_terms_approvable(p_org_id, p_project_id, p_group_id, p_terms_hash);

  select * into v_pending from public.selection_approvals a
  where a.org_id = p_org_id and a.project_id = p_project_id and a.group_id is not distinct from p_group_id and a.status = 'sent'
  for update;
  if found then
    if v_pending.channel = 'esign' then
      raise exception 'These selections are out for e-signature; sign the document, or void it first' using errcode = '23505', detail = 'SELECTION_APPROVAL_PENDING';
    end if;
    if v_pending.channel <> p_channel then
      raise exception 'A request to approve these selections is already out; void it first' using errcode = '23505', detail = 'SELECTION_APPROVAL_PENDING';
    end if;
    if v_pending.terms_hash is distinct from p_terms_hash then
      raise exception 'These selections changed since they were shown; review them and try again' using errcode = '40001', detail = 'SELECTION_TERMS_CHANGED';
    end if;
    v_approval := v_pending;
  else
    v_approval := public.insert_selection_approval(p_org_id, p_project_id, p_group_id, p_channel, 'sent', v_terms, p_user_id, null);
  end if;

  return to_jsonb(public.confirm_selection_approval(v_approval.id, now(), jsonb_build_object(
    'contact_id', p_contact_id, 'user_id', p_user_id, 'signed_copy_file_id', p_signed_copy_file_id
  )));
end;
$$;

revoke all on function public.approve_selection_terms(uuid, uuid, uuid, text, text, uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.approve_selection_terms(uuid, uuid, uuid, text, text, uuid, uuid, uuid) to service_role;
