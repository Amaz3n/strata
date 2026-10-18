-- EP07 review round 1 fixes for trade responses and bulk reschedules
-- (20261014120000_trade_responses_and_bulk_schedule.sql stays as applied).
--
-- 1. RBAC: org_starts_coordinator receives schedule.edit. The coordinator is the
--    Trades-desk persona who approves a trade's reschedule request, and the move
--    is applied under schedule.edit on the home; start.release still gates a move
--    that pushes a promised close. (Catalog-as-code: the permission already
--    exists; this seeds the grant.)
-- 2. schedule_assignments: re-pointing a confirmed assignment to another
--    company, task or home drops the confirmation instead of transferring it, and
--    every write is refused unless the task belongs to the assignment's home and
--    the company to its organization (read_trade_lookahead_workspace raises on
--    such a row for the whole org).
-- 3. record_trade_response: a task with no end date is answered against its start
--    date, the way the portal shows it, and the answer locks its open predecessor
--    before the task so it cannot deadlock apply_schedule_reschedule.
-- 4. resolve_trade_response and apply_schedule_reschedule check the actor's
--    authority inside the transaction (schedule.edit; start.write to close an
--    answer; start.release and a reason when a close breach is accepted), so a
--    permission revoked after the service checked cannot still commit.
-- 5. apply_schedule_reschedule writes the notice job (trades told, selection
--    cutoffs recomputed) in the same transaction, so a committed move cannot lose
--    its notices.

insert into public.role_permissions (role_id, permission_key)
select r.id, 'schedule.edit'
from public.roles r
where r.key = 'org_starts_coordinator'
on conflict (role_id, permission_key) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Assignments.
-- ---------------------------------------------------------------------------

create or replace function public.tg_schedule_assignment_confirmation_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user <> 'authenticated' then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.confirmed_at is not null then
      raise exception 'A trade confirms its own work on the portal' using errcode = '42501';
    end if;
    return new;
  end if;
  if old.confirmed_at is not null
     and row(new.company_id, new.schedule_item_id, new.project_id)
         is distinct from row(old.company_id, old.schedule_item_id, old.project_id) then
    -- A confirmation belongs to the company and task that gave it.
    new.confirmed_at := null;
  elsif new.confirmed_at is distinct from old.confirmed_at then
    raise exception 'A trade confirms its own work on the portal' using errcode = '42501';
  end if;
  return new;
end;
$$;

create or replace function public.tg_schedule_assignment_consistency()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.schedule_items i
    where i.id = new.schedule_item_id and i.org_id = new.org_id and i.project_id = new.project_id
  ) then
    raise exception 'The task does not belong to this home' using errcode = '23503';
  end if;
  if new.company_id is not null
     and not exists (select 1 from public.companies c where c.id = new.company_id and c.org_id = new.org_id) then
    raise exception 'The company does not belong to this organization' using errcode = '23503';
  end if;
  return new;
end;
$$;

revoke all on function public.tg_schedule_assignment_consistency() from public, anon, authenticated;

drop trigger if exists schedule_assignments_consistency on public.schedule_assignments;
create trigger schedule_assignments_consistency
  before insert or update of org_id, project_id, schedule_item_id, company_id on public.schedule_assignments
  for each row execute function public.tg_schedule_assignment_consistency();

-- ---------------------------------------------------------------------------
-- 3. Answers.
-- ---------------------------------------------------------------------------

create or replace function public.record_trade_response(
  p_org_id uuid,
  p_portal_token_id uuid,
  p_company_id uuid,
  p_schedule_item_id uuid,
  p_response text,
  p_issued_start date,
  p_issued_end date,
  p_proposed_start date,
  p_proposed_end date,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item public.schedule_items%rowtype;
  v_id uuid;
begin
  -- Same order as apply_schedule_reschedule: the open answer, then the task.
  perform 1 from public.trade_work_responses
  where schedule_item_id = p_schedule_item_id and company_id = p_company_id and org_id = p_org_id and status = 'open'
  for update;

  select * into v_item from public.schedule_items
  where id = p_schedule_item_id and org_id = p_org_id
  for update;
  if not found
     or not exists (
       select 1 from public.schedule_assignments a
       where a.org_id = p_org_id and a.schedule_item_id = p_schedule_item_id and a.company_id = p_company_id
     ) then
    raise exception 'That work is not assigned to your company' using errcode = '42501';
  end if;
  if v_item.status in ('cancelled', 'completed') then
    raise exception 'That work is no longer scheduled' using errcode = '40001';
  end if;
  if v_item.start_date is distinct from p_issued_start
     or coalesce(v_item.end_date, v_item.start_date) is distinct from p_issued_end then
    raise exception 'The dates changed; reload to see the current schedule' using errcode = '40001';
  end if;

  update public.trade_work_responses
  set status = 'superseded'
  where schedule_item_id = p_schedule_item_id and company_id = p_company_id and status = 'open';

  insert into public.trade_work_responses(
    org_id, project_id, schedule_item_id, company_id, issued_start, issued_end,
    response, proposed_start, proposed_end, reason, portal_token_id
  ) values (
    p_org_id, v_item.project_id, p_schedule_item_id, p_company_id, p_issued_start, p_issued_end,
    p_response, p_proposed_start, p_proposed_end, nullif(btrim(p_reason), ''), p_portal_token_id
  ) returning id into v_id;

  update public.schedule_assignments
  set confirmed_at = case when p_response = 'accepted' then now() else null end
  where org_id = p_org_id and schedule_item_id = p_schedule_item_id and company_id = p_company_id;

  insert into public.audit_log(org_id, actor_user_id, action, entity_type, entity_id, after_data, source)
  values (p_org_id, null, 'insert', 'trade_work_response', v_id,
    jsonb_build_object('schedule_item_id', p_schedule_item_id, 'company_id', p_company_id, 'project_id', v_item.project_id,
      'response', p_response, 'issued_start', p_issued_start, 'issued_end', p_issued_end,
      'proposed_start', p_proposed_start, 'proposed_end', p_proposed_end, 'portal_token_id', p_portal_token_id),
    'sub_portal');
  insert into public.events(org_id, event_type, entity_type, entity_id, payload, channel)
  values (p_org_id, 'trade_response.recorded', 'trade_work_response', v_id,
    jsonb_build_object('schedule_item_id', p_schedule_item_id, 'company_id', p_company_id, 'project_id', v_item.project_id,
      'response', p_response), 'activity');

  return jsonb_build_object('id', v_id, 'project_id', v_item.project_id, 'schedule_item_name', v_item.name);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Closing answers and applying moves, under the actor's own authority.
-- ---------------------------------------------------------------------------

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
    insert into public.outbox(org_id, job_type, payload)
    values (p_org_id, 'schedule_reschedule_notify', jsonb_build_object('actor_id', p_actor_id, 'moves', v_out));
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
