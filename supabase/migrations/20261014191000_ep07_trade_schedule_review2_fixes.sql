-- EP07 review round 2: the reschedule notice never outgrows its handler, and
-- apply_schedule_reschedule / resolve_trade_response check the actor's division
-- inside the transaction (starts_actor_reaches_division, as 150000 does for
-- superintendent assignment).

create or replace function public.resolve_trade_response(
  p_org_id uuid,
  p_actor_id uuid,
  p_response_id uuid,
  p_resolution text,
  p_note text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.trade_work_responses%rowtype;
begin
  perform public.assert_starts_org_actor_permission(p_org_id, p_actor_id, 'start.write');
  select * into v_row from public.trade_work_responses
  where id = p_response_id and org_id = p_org_id
  for update;
  if not found then
    raise exception 'Trade response not found' using errcode = '42501';
  end if;
  if not public.starts_actor_reaches_division(p_org_id, p_actor_id,
       (select p.division_id from public.projects p where p.id = v_row.project_id and p.org_id = p_org_id)) then
    raise exception 'The house is outside your division access' using errcode = '42501';
  end if;
  if v_row.status <> 'open' then
    raise exception 'This answer was already closed' using errcode = '40001';
  end if;
  if p_resolution = 'reschedule_applied' then
    raise exception 'New dates are applied through the schedule, not recorded alone' using errcode = '22023';
  end if;
  update public.trade_work_responses
  set status = 'resolved', resolution = p_resolution, resolved_by = p_actor_id, resolved_at = now(),
      resolution_note = nullif(btrim(p_note), '')
  where id = p_response_id;
  insert into public.audit_log(org_id, actor_user_id, action, entity_type, entity_id, before_data, after_data, source)
  values (p_org_id, p_actor_id, 'update', 'trade_work_response', p_response_id,
    jsonb_build_object('status', 'open'),
    jsonb_build_object('status', 'resolved', 'resolution', p_resolution, 'note', nullif(btrim(p_note), '')),
    'trades.response_resolved');
  insert into public.events(org_id, event_type, entity_type, entity_id, payload, channel)
  values (p_org_id, 'trade_response.resolved', 'trade_work_response', p_response_id,
    jsonb_build_object('resolution', p_resolution, 'project_id', v_row.project_id, 'actor_id', p_actor_id), 'activity');
  return jsonb_build_object('id', p_response_id, 'resolution', p_resolution);
end;
$$;

create or replace function public.apply_schedule_reschedule(
  p_org_id uuid,
  p_actor_id uuid,
  p_changes jsonb,
  p_reason text,
  p_acknowledged jsonb,
  p_response_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_el jsonb;
  v_before public.schedule_items%rowtype;
  v_after public.schedule_items%rowtype;
  v_out jsonb := '[]'::jsonb;
  v_response public.trade_work_responses%rowtype;
  v_response_met boolean := false;
  v_dates_moved boolean := false;
  v_offset integer;
begin
  if jsonb_typeof(p_changes) <> 'array' or jsonb_array_length(p_changes) = 0 then
    raise exception 'There is nothing to move' using errcode = '22023';
  end if;
  perform public.assert_starts_org_actor_permission(p_org_id, p_actor_id, 'schedule.edit');
  if p_acknowledged is not null and jsonb_typeof(p_acknowledged) = 'array' and jsonb_array_length(p_acknowledged) > 0 then
    -- Accepting a breach of a promised close is a starts coordinator's call, with a reason.
    perform public.assert_starts_org_actor_permission(p_org_id, p_actor_id, 'start.release');
    if length(btrim(coalesce(p_reason, ''))) < 10 then
      raise exception 'Say why the date moves past a promised close' using errcode = '22023';
    end if;
  end if;
  if p_response_id is not null then
    perform public.assert_starts_org_actor_permission(p_org_id, p_actor_id, 'start.write');
    select * into v_response from public.trade_work_responses
    where id = p_response_id and org_id = p_org_id
    for update;
    if not found then
      raise exception 'Trade response not found' using errcode = '42501';
    end if;
    if v_response.status <> 'open' or v_response.response <> 'reschedule_requested' then
      raise exception 'This request was already closed' using errcode = '40001';
    end if;
  end if;

  for v_el in select e from jsonb_array_elements(p_changes) e order by e->>'id' loop
    select * into v_before from public.schedule_items
    where id = (v_el->>'id')::uuid and org_id = p_org_id
    for update;
    if not found then
      raise exception 'A task in this move no longer exists' using errcode = '40001';
    end if;
    if not public.starts_actor_reaches_division(p_org_id, p_actor_id,
         (select p.division_id from public.projects p where p.id = v_before.project_id and p.org_id = p_org_id)) then
      raise exception 'The house is outside your division access' using errcode = '42501';
    end if;
    if v_el->>'expected_updated_at' is null or v_before.updated_at is distinct from (v_el->>'expected_updated_at')::timestamptz then
      raise exception 'A task was changed by someone else; reload and try again' using errcode = '40001';
    end if;

    update public.schedule_items
    set start_date = case when v_el ? 'start_date' then (v_el->>'start_date')::date else start_date end,
        end_date = case when v_el ? 'end_date' then (v_el->>'end_date')::date else end_date end,
        sort_order = case when v_el ? 'sort_order' then (v_el->>'sort_order')::integer else sort_order end,
        progress = case when v_el ? 'progress' then (v_el->>'progress')::integer else progress end,
        status = case when v_el ? 'status' then v_el->>'status' else status end
    where id = v_before.id
    returning * into v_after;

    insert into public.audit_log(org_id, actor_user_id, action, entity_type, entity_id, before_data, after_data, source)
    values (p_org_id, p_actor_id, 'update', 'schedule_item', v_before.id,
      jsonb_build_object('start_date', v_before.start_date, 'end_date', v_before.end_date, 'sort_order', v_before.sort_order,
        'progress', v_before.progress, 'status', v_before.status),
      jsonb_build_object('start_date', v_after.start_date, 'end_date', v_after.end_date, 'sort_order', v_after.sort_order,
        'progress', v_after.progress, 'status', v_after.status,
        'reason', nullif(btrim(p_reason), ''), 'acknowledged_close_impacts', coalesce(p_acknowledged, '[]'::jsonb),
        'trade_response_id', p_response_id),
      'schedule.bulk_update');

    if v_after.start_date is distinct from v_before.start_date or v_after.end_date is distinct from v_before.end_date then
      v_dates_moved := true;
      insert into public.events(org_id, event_type, entity_type, entity_id, payload, channel)
      values (p_org_id, 'schedule_item.rescheduled', 'schedule_item', v_before.id,
        jsonb_build_object('project_id', v_before.project_id, 'name', v_before.name,
          'old_start', v_before.start_date, 'new_start', v_after.start_date,
          'old_end', v_before.end_date, 'new_end', v_after.end_date, 'actor_id', p_actor_id), 'activity');
    end if;

    if p_response_id is not null and v_before.id = v_response.schedule_item_id
       and v_after.start_date = v_response.proposed_start and v_after.end_date = v_response.proposed_end then
      v_response_met := true;
    end if;

    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'id', v_before.id, 'project_id', v_before.project_id,
      'old_start', v_before.start_date, 'new_start', v_after.start_date,
      'old_end', v_before.end_date, 'new_end', v_after.end_date));
  end loop;

  if v_dates_moved then
    -- One job per 500 moved tasks, so a large move (dependents included) never
    -- outgrows what the notice handler accepts.
    for v_offset in 0 .. greatest(jsonb_array_length(v_out) - 1, 0) by 500 loop
      insert into public.outbox(org_id, job_type, payload)
      select p_org_id, 'schedule_reschedule_notify',
        jsonb_build_object('actor_id', p_actor_id, 'moves', coalesce(jsonb_agg(t.m order by t.i), '[]'::jsonb))
      from jsonb_array_elements(v_out) with ordinality t(m, i)
      where t.i > v_offset and t.i <= v_offset + 500;
    end loop;
  end if;

  if p_response_id is not null then
    if not v_response_met then
      raise exception 'The move does not give the trade the dates it asked for' using errcode = '22023';
    end if;
    update public.trade_work_responses
    set status = 'resolved', resolution = 'reschedule_applied', resolved_by = p_actor_id, resolved_at = now(),
        resolution_note = nullif(btrim(p_reason), '')
    where id = p_response_id;
    insert into public.audit_log(org_id, actor_user_id, action, entity_type, entity_id, before_data, after_data, source)
    values (p_org_id, p_actor_id, 'update', 'trade_work_response', p_response_id,
      jsonb_build_object('status', 'open'),
      jsonb_build_object('status', 'resolved', 'resolution', 'reschedule_applied'),
      'trades.response_resolved');
    insert into public.events(org_id, event_type, entity_type, entity_id, payload, channel)
    values (p_org_id, 'trade_response.resolved', 'trade_work_response', p_response_id,
      jsonb_build_object('resolution', 'reschedule_applied', 'project_id', v_response.project_id, 'actor_id', p_actor_id), 'activity');
  end if;

  return v_out;
end;
$$;
