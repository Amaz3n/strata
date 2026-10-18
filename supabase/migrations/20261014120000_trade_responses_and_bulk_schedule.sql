-- Trades answer the work they are given, and a schedule move lands whole or not
-- at all.
--
-- 1. trade_work_responses: a trade's answer to ONE task it is assigned,
--    given on the sub portal against the dates the portal showed (issued_start
--    / issued_end). accepted, declined, or reschedule_requested with the dates
--    the trade can do. One open answer per task and company; answering again
--    supersedes the last. An answer is stale when the task's dates no longer
--    equal the issued dates (derived, never stored). The coordinator closes an
--    answer: acknowledged (accepted/declined), reschedule_applied (the dates
--    were moved through apply_schedule_reschedule below) or reschedule_declined.
--    Writes are service-role RPCs only; members read.
-- 2. schedule_assignments.confirmed_at is the trade's confirmation, so it moves
--    only through record_trade_response (a definer path). Any member could
--    previously write it over the data API, and it is cleared when the task's
--    dates move, because a confirmation is of the dates it was given for.
-- 3. apply_schedule_reschedule: the one transaction that lands a bulk move.
--    Every moved row is locked, checked against the updated_at the actor saw,
--    updated, audited and announced; a trade's reschedule request is closed in
--    the same transaction. Any mismatch aborts the whole move.
--
-- RBAC: no new key. Coordinators close answers with start.write; applying a
-- reschedule additionally needs schedule.edit on the project; a move that pushes
-- a promised close past its date needs start.release. All three are checked by
-- lib/services (the RPCs are service-role only). Held today by:
--   start.write   org_owner, org_admin, org_office_admin, org_project_lead, org_starts_coordinator, pm
--   start.release org_owner, org_admin, org_starts_coordinator
--   schedule.edit org_owner, org_admin, org_office_admin, org_project_lead, org_superintendent, org_user, pm, field

-- ---------------------------------------------------------------------------
-- 1. The answers.
-- ---------------------------------------------------------------------------

create table if not exists public.trade_work_responses (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  schedule_item_id uuid not null references public.schedule_items(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  issued_start date not null,
  issued_end date not null,
  response text not null,
  proposed_start date,
  proposed_end date,
  reason text,
  portal_token_id uuid references public.portal_access_tokens(id) on delete set null,
  responded_at timestamptz not null default now(),
  status text not null default 'open',
  resolution text,
  resolved_by uuid references public.app_users(id),
  resolved_at timestamptz,
  resolution_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint trade_work_responses_response_check check (response in ('accepted', 'declined', 'reschedule_requested')),
  constraint trade_work_responses_status_check check (status in ('open', 'resolved', 'superseded')),
  constraint trade_work_responses_resolution_check check (resolution is null or resolution in ('acknowledged', 'reschedule_applied', 'reschedule_declined')),
  constraint trade_work_responses_issued_check check (issued_end >= issued_start),
  constraint trade_work_responses_proposal_check check (
    (response = 'reschedule_requested' and proposed_start is not null and proposed_end is not null and proposed_end >= proposed_start)
    or (response <> 'reschedule_requested' and proposed_start is null and proposed_end is null)
  ),
  constraint trade_work_responses_reason_check check (
    (reason is null or length(reason) <= 2000)
    and (response = 'accepted' or length(btrim(coalesce(reason, ''))) >= 3)
  ),
  constraint trade_work_responses_resolved_check check (
    (status = 'resolved') = (resolution is not null and resolved_at is not null and resolved_by is not null)
  ),
  constraint trade_work_responses_resolution_kind_check check (
    resolution is null
    or (resolution = 'acknowledged' and response in ('accepted', 'declined'))
    or (resolution in ('reschedule_applied', 'reschedule_declined') and response = 'reschedule_requested')
  ),
  constraint trade_work_responses_note_check check (resolution_note is null or length(resolution_note) <= 2000)
);

-- One live answer per task and company: answering again supersedes the last.
create unique index if not exists trade_work_responses_open_key
  on public.trade_work_responses (schedule_item_id, company_id) where status = 'open';
create index if not exists trade_work_responses_queue_idx
  on public.trade_work_responses (org_id, status, responded_at desc);
create index if not exists trade_work_responses_org_project_idx
  on public.trade_work_responses (org_id, project_id);
create index if not exists trade_work_responses_project_idx on public.trade_work_responses (project_id);
create index if not exists trade_work_responses_company_idx on public.trade_work_responses (company_id);
create index if not exists trade_work_responses_item_idx on public.trade_work_responses (schedule_item_id);
create index if not exists trade_work_responses_token_idx
  on public.trade_work_responses (portal_token_id) where portal_token_id is not null;
create index if not exists trade_work_responses_resolved_by_idx
  on public.trade_work_responses (resolved_by) where resolved_by is not null;

comment on table public.trade_work_responses is
  'A trade''s answer (accept, decline, ask for other dates) to one task it is assigned, against the dates the sub portal issued. Written by record_trade_response, closed by resolve_trade_response / apply_schedule_reschedule (lib/services/trade-responses.ts).';

-- Every reference stays inside the organization and names a real assignment.
create or replace function public.guard_trade_work_response_references()
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
  if not exists (select 1 from public.companies c where c.id = new.company_id and c.org_id = new.org_id) then
    raise exception 'The company does not belong to this organization' using errcode = '23503';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_trade_work_response_references() from public, anon, authenticated;

drop trigger if exists trade_work_responses_references on public.trade_work_responses;
create trigger trade_work_responses_references
  before insert or update of org_id, project_id, schedule_item_id, company_id on public.trade_work_responses
  for each row execute function public.guard_trade_work_response_references();

-- What the trade said, and about which dates, is a record.
create or replace function public.guard_trade_work_response_record()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if row(new.org_id, new.project_id, new.schedule_item_id, new.company_id, new.issued_start, new.issued_end,
         new.response, new.proposed_start, new.proposed_end, new.reason, new.responded_at)
     is distinct from
     row(old.org_id, old.project_id, old.schedule_item_id, old.company_id, old.issued_start, old.issued_end,
         old.response, old.proposed_start, old.proposed_end, old.reason, old.responded_at) then
    raise exception 'A trade''s answer cannot be changed; answer again instead' using errcode = '42501';
  end if;
  if old.status <> 'open' and new.status is distinct from old.status then
    raise exception 'This answer is already closed' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_trade_work_response_record() from public, anon, authenticated;

drop trigger if exists trade_work_responses_record on public.trade_work_responses;
create trigger trade_work_responses_record
  before update on public.trade_work_responses
  for each row execute function public.guard_trade_work_response_record();

drop trigger if exists trade_work_responses_set_updated_at on public.trade_work_responses;
create trigger trade_work_responses_set_updated_at
  before update on public.trade_work_responses
  for each row execute function public.tg_set_updated_at();

alter table public.trade_work_responses enable row level security;

drop policy if exists trade_work_responses_read on public.trade_work_responses;
create policy trade_work_responses_read on public.trade_work_responses
  for select
  to authenticated
  using (public.has_org_permission(org_id, 'start.write') or public.has_org_permission(org_id, 'schedule.edit'));

-- The division wall: an answer is reachable when its home is.
drop policy if exists trade_work_responses_division_scope on public.trade_work_responses;
create policy trade_work_responses_division_scope on public.trade_work_responses
  as restrictive
  for all
  to authenticated
  using (
    org_id = any ((select public.member_unscoped_org_ids())::uuid[])
    or project_id in (select public.member_reachable_project_ids())
  )
  with check (
    org_id = any ((select public.member_unscoped_org_ids())::uuid[])
    or project_id in (select public.member_reachable_project_ids())
  );

revoke all on table public.trade_work_responses from anon, authenticated;
grant select on table public.trade_work_responses to authenticated;
grant all on table public.trade_work_responses to service_role;

-- ---------------------------------------------------------------------------
-- 2. A confirmation is the trade's, not a member's.
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
  elsif new.confirmed_at is distinct from old.confirmed_at then
    raise exception 'A trade confirms its own work on the portal' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists schedule_assignments_confirmation_guard on public.schedule_assignments;
create trigger schedule_assignments_confirmation_guard
  before insert or update on public.schedule_assignments
  for each row execute function public.tg_schedule_assignment_confirmation_guard();

-- A confirmation is of the dates it was given for: move them and it lapses.
create or replace function public.tg_schedule_item_dates_lapse_confirmation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.start_date is distinct from old.start_date or new.end_date is distinct from old.end_date then
    update public.schedule_assignments
    set confirmed_at = null
    where schedule_item_id = new.id and org_id = new.org_id and confirmed_at is not null;
  end if;
  return null;
end;
$$;

revoke all on function public.tg_schedule_item_dates_lapse_confirmation() from public, anon, authenticated;

drop trigger if exists schedule_items_dates_lapse_confirmation on public.schedule_items;
create trigger schedule_items_dates_lapse_confirmation
  after update of start_date, end_date on public.schedule_items
  for each row execute function public.tg_schedule_item_dates_lapse_confirmation();

-- ---------------------------------------------------------------------------
-- 3. Recording and closing answers.
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
  if v_item.start_date is distinct from p_issued_start or v_item.end_date is distinct from p_issued_end then
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

revoke all on function public.record_trade_response(uuid, uuid, uuid, uuid, text, date, date, date, date, text) from public, anon, authenticated;
grant execute on function public.record_trade_response(uuid, uuid, uuid, uuid, text, date, date, date, date, text) to service_role;

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

revoke all on function public.resolve_trade_response(uuid, uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.resolve_trade_response(uuid, uuid, uuid, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- 4. A bulk move lands whole or not at all.
--
-- p_changes is an array of {id, expected_updated_at, start_date?, end_date?,
-- sort_order?, progress?, status?}: only the keys present are written. p_reason
-- and p_acknowledged (the houses whose promised close the actor accepted a breach
-- of) are recorded with every audit row. p_response_id closes a trade's
-- reschedule request in the same transaction, provided the move gives the trade
-- the dates it asked for.
-- ---------------------------------------------------------------------------

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
begin
  if jsonb_typeof(p_changes) <> 'array' or jsonb_array_length(p_changes) = 0 then
    raise exception 'There is nothing to move' using errcode = '22023';
  end if;
  if p_response_id is not null then
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

revoke all on function public.apply_schedule_reschedule(uuid, uuid, jsonb, text, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.apply_schedule_reschedule(uuid, uuid, jsonb, text, jsonb, uuid) to service_role;
