-- EP06-03/04/05: selection cutoffs, supply eligibility and change propagation
-- held by the database.
--
-- 1. The cutoff day is the community's day. `project_selection_today` is the
--    date in the home's zone (`selection_home_time_zone`, EP06-02); every
--    cutoff check below uses it, so a Florida buyer keeps the evening of their
--    cutoff day.
-- 2. Supply facts. An option's order-by date is the start of the schedule task
--    its group is anchored to minus the option's lead time; a selection's
--    procurement is released once a non-draft purchase order carries its line.
-- 3. Selection exceptions: an unavailable, too-late or already-bought choice is
--    a persisted record with a resolution (alternate, change order, waiver),
--    not only a refusal. A lead-time waiver is the only way past the order-by
--    date; a cutoff override never lifts it.
-- 4. `apply_project_selection_writes` re-checks the cutoff, the selection lock,
--    the lead time and released procurement inside its transaction, under the
--    home lock, for every write that moves a choice. The service's pre-check
--    explains; this enforces.
-- 5. Cutoff overrides, reverts, schedule moves and the lock sweep each change
--    the group and its selections in one transaction under the home lock
--    (an extension reopens what the sweep closed; the sweep locks both), and
--    return the before and after the service audits.
-- 6. Member write guards: a signed-in member never writes a group's cutoff,
--    status or override, nor a selection's lock, group, change order, metadata
--    or confirmation. Service-role and definer paths pass.
-- 7. A selection change order: its `selection_change` is attached once (never
--    by a member), never edited (nor are its lines or price by a member), and
--    claims its selections so one selection has at most one open change order. The claim is checked against the home's
--    current choice, so a change priced on a stale home is refused.
-- 8. Approval applies the selection change in the approval's own transaction:
--    the selections (against the state the change order was priced on), the
--    variance orders on the owning purchase orders, the budget revision and a
--    pending schedule impact for the superintendent; the buyer's earlier
--    approval of those selections is voided. Any refusal fails the
--    approval, so the agreement version, selections, purchase orders and budget
--    land together or not at all. Followers (events, notifications) are an
--    outbox job.
-- 9. Variance orders raised from a change order are the system's: a member
--    never creates, re-prices, re-targets or deletes one (re-pricing goes
--    through the purchasing service with a reason).
-- 10. A pending schedule impact is applied by the superintendent in one step
--    that shifts the task by whole days and stamps it applied.

-- ---------------------------------------------------------------------------
-- 1. The community's day.
-- ---------------------------------------------------------------------------

create or replace function public.project_selection_today(p_org_id uuid, p_project_id uuid)
returns date
language sql
stable
security definer
set search_path = ''
as $$
  select (now() at time zone public.selection_home_time_zone(p_org_id, p_project_id))::date
$$;

revoke all on function public.project_selection_today(uuid, uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Supply facts.
-- ---------------------------------------------------------------------------

-- The last day an option can still be ordered for this home: the start of the
-- task the selection's group is anchored to, less the option's lead time (a
-- community version without its own lead time inherits its parent's). Null
-- when the option has no lead time or the group has no anchored task.
create or replace function public.project_selection_order_by(p_org_id uuid, p_project_id uuid, p_group_id uuid, p_option_id uuid)
returns date
language sql
stable
security definer
set search_path = ''
as $$
  select si.start_date - coalesce(o.lead_time_days, parent.lead_time_days)
  from public.selection_options o
  left join public.selection_options parent on parent.id = o.parent_option_id and parent.org_id = o.org_id
  join public.project_selection_groups g on g.org_id = p_org_id and g.project_id = p_project_id and g.group_id = p_group_id
  join public.schedule_items si on si.id = g.matched_schedule_item_id and si.org_id = p_org_id
  where o.org_id = p_org_id and o.id = p_option_id
    and coalesce(o.lead_time_days, parent.lead_time_days) > 0
    and si.start_date is not null
$$;

revoke all on function public.project_selection_order_by(uuid, uuid, uuid, uuid) from public, anon, authenticated, service_role;

-- The purchase order that has already bought this selection: a purchase order
-- past draft (and not canceled) carrying the selection's option line.
create or replace function public.project_selection_released_purchase_order(p_org_id uuid, p_project_id uuid, p_selection_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select c.id
  from public.commitments c
  where c.org_id = p_org_id and c.project_id = p_project_id and c.commitment_type = 'purchase_order'
    and c.status not in ('draft', 'canceled', 'cancelled', 'void', 'voided', 'rejected')
    and exists (
      select 1 from public.commitment_lines l
      where l.org_id = c.org_id and l.commitment_id = c.id
        and l.metadata->>'source' = 'option' and l.metadata->>'source_ref' = p_selection_id::text)
  order by c.created_at, c.id
  limit 1
$$;

revoke all on function public.project_selection_released_purchase_order(uuid, uuid, uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Selection exceptions.
-- ---------------------------------------------------------------------------

create table public.selection_exceptions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  selection_id uuid not null references public.project_selections(id) on delete cascade,
  option_id uuid references public.selection_options(id) on delete set null,
  change_order_id uuid references public.change_orders(id) on delete set null,
  reason text not null check (reason in ('option_unavailable', 'lead_time_exceeded', 'procurement_released', 'variance_unrouted')),
  status text not null default 'open'
    check (status in ('open', 'resolved_alternate', 'resolved_change_order', 'resolved_manual', 'waived', 'void')),
  detail jsonb not null default '{}'::jsonb check (jsonb_typeof(detail) = 'object'),
  opened_by uuid references public.app_users(id) on delete set null,
  opened_at timestamptz not null default now(),
  resolved_by uuid references public.app_users(id) on delete set null,
  resolved_at timestamptz,
  resolution_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint selection_exceptions_resolution_check check ((status = 'open') = (resolved_at is null)),
  -- Expediting past a lead time is a person's decision, with a reason.
  constraint selection_exceptions_waiver_check check (
    status <> 'waived'
    or (reason = 'lead_time_exceeded' and option_id is not null and resolved_by is not null
        and length(btrim(coalesce(resolution_reason, ''))) >= 5)),
  constraint selection_exceptions_manual_check check (
    status not in ('resolved_manual', 'void')
    or length(btrim(coalesce(resolution_reason, ''))) >= 5)
);

create index selection_exceptions_project_idx on public.selection_exceptions (org_id, project_id);
create index selection_exceptions_open_idx on public.selection_exceptions (org_id, status, opened_at) where status = 'open';
create index selection_exceptions_selection_idx on public.selection_exceptions (selection_id);
create index selection_exceptions_option_idx on public.selection_exceptions (option_id) where option_id is not null;
create index selection_exceptions_change_order_idx on public.selection_exceptions (change_order_id) where change_order_id is not null;
create index selection_exceptions_opened_by_idx on public.selection_exceptions (opened_by) where opened_by is not null;
create index selection_exceptions_resolved_by_idx on public.selection_exceptions (resolved_by) where resolved_by is not null;
create unique index selection_exceptions_open_supply_key on public.selection_exceptions (selection_id, reason)
  where status = 'open' and reason <> 'variance_unrouted';
create unique index selection_exceptions_open_variance_key on public.selection_exceptions (change_order_id, selection_id)
  where status = 'open' and reason = 'variance_unrouted';
create index selection_exceptions_waiver_idx on public.selection_exceptions (selection_id, option_id) where status = 'waived';

create trigger selection_exceptions_set_updated_at before update on public.selection_exceptions
  for each row execute function public.tg_set_updated_at();

alter table public.selection_exceptions enable row level security;

create policy selection_exceptions_select on public.selection_exceptions
  for select to authenticated
  using (public.has_org_permission(org_id, 'selections.read'));

create policy selection_exceptions_division_scope on public.selection_exceptions
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

grant select on public.selection_exceptions to authenticated;
grant all on public.selection_exceptions to service_role;

-- A lead-time waiver for exactly this option on this selection.
create or replace function public.project_selection_lead_time_waived(p_org_id uuid, p_selection_id uuid, p_option_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.selection_exceptions e
    where e.org_id = p_org_id and e.selection_id = p_selection_id and e.option_id = p_option_id
      and e.reason = 'lead_time_exceeded' and e.status = 'waived')
$$;

revoke all on function public.project_selection_lead_time_waived(uuid, uuid, uuid) from public, anon, authenticated, service_role;

-- Opens (or returns the already-open) exception for a selection, saying which.
create or replace function public.open_selection_exception(
  p_org_id uuid,
  p_project_id uuid,
  p_selection_id uuid,
  p_option_id uuid,
  p_reason text,
  p_detail jsonb,
  p_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_reason not in ('option_unavailable', 'lead_time_exceeded', 'procurement_released') then
    raise exception 'Unknown selection exception reason %', p_reason using errcode = '22023';
  end if;
  perform 1 from public.project_selections s where s.org_id = p_org_id and s.project_id = p_project_id and s.id = p_selection_id;
  if not found then
    raise exception 'Selection is not on this home' using errcode = 'P0002';
  end if;
  insert into public.selection_exceptions (org_id, project_id, selection_id, option_id, reason, detail, opened_by)
  values (p_org_id, p_project_id, p_selection_id, p_option_id, p_reason, coalesce(p_detail, '{}'::jsonb), p_actor_id)
  on conflict (selection_id, reason) where status = 'open' and reason <> 'variance_unrouted' do nothing
  returning id into v_id;
  if v_id is not null then
    return jsonb_build_object('id', v_id, 'opened', true);
  end if;
  select e.id into v_id from public.selection_exceptions e
  where e.org_id = p_org_id and e.selection_id = p_selection_id and e.reason = p_reason and e.status = 'open';
  return jsonb_build_object('id', v_id, 'opened', false);
end;
$$;

revoke all on function public.open_selection_exception(uuid, uuid, uuid, uuid, text, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.open_selection_exception(uuid, uuid, uuid, uuid, text, jsonb, uuid) to service_role;

-- Closes an open exception. The service has already checked the actor's
-- authority on the home; the rules on which closing fits which reason live here.
create or replace function public.resolve_selection_exception(
  p_org_id uuid,
  p_exception_id uuid,
  p_status text,
  p_reason text,
  p_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_before public.selection_exceptions;
  v_after public.selection_exceptions;
begin
  select * into v_before from public.selection_exceptions e where e.org_id = p_org_id and e.id = p_exception_id for update;
  if not found then
    raise exception 'Selection exception not found' using errcode = 'P0002';
  end if;
  if v_before.status <> 'open' then
    raise exception 'This exception was already closed' using detail = 'SELECTION_EXCEPTION_CLOSED';
  end if;
  if p_status = 'waived' and v_before.reason <> 'lead_time_exceeded' then
    raise exception 'Only a lead time can be waived (an expedite the vendor confirmed); choose an alternate or raise a change order'
      using detail = 'SELECTION_EXCEPTION_NOT_WAIVABLE';
  end if;
  if p_status = 'resolved_manual' and v_before.reason <> 'variance_unrouted' then
    raise exception 'Resolve a supply exception with an alternate, a change order or a waiver' using errcode = '22023';
  end if;
  if p_status not in ('waived', 'resolved_manual', 'void', 'resolved_alternate') then
    raise exception 'Unknown resolution %', p_status using errcode = '22023';
  end if;
  update public.selection_exceptions e set
    status = p_status,
    resolved_by = p_actor_id,
    resolved_at = now(),
    resolution_reason = nullif(btrim(coalesce(p_reason, '')), '')
  where e.id = v_before.id
  returning * into v_after;
  return jsonb_build_object('before', to_jsonb(v_before), 'after', to_jsonb(v_after));
end;
$$;

revoke all on function public.resolve_selection_exception(uuid, uuid, text, text, uuid) from public, anon, authenticated;
grant execute on function public.resolve_selection_exception(uuid, uuid, text, text, uuid) to service_role;

-- Opens exceptions for chosen, unconfirmed selections that can no longer be
-- had as chosen: the option went off sale, or its order-by date passed while
-- the group was still open (a schedule pull-in). Returns the ones it opened.
create or replace function public.refresh_project_selection_exceptions(p_org_id uuid, p_project_id uuid)
returns setof public.selection_exceptions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_today date := public.project_selection_today(p_org_id, p_project_id);
begin
  return query
  with candidates as (
    select s.id selection_id, s.selected_option_id option_id,
      case
        when o.is_archived or not o.is_available then 'option_unavailable'
        when public.project_selection_order_by(p_org_id, p_project_id, s.group_id, s.selected_option_id) < v_today
             and not public.project_selection_lead_time_waived(p_org_id, s.id, s.selected_option_id) then 'lead_time_exceeded'
      end reason,
      public.project_selection_order_by(p_org_id, p_project_id, s.group_id, s.selected_option_id) order_by
    from public.project_selections s
    join public.selection_options o on o.id = s.selected_option_id and o.org_id = s.org_id
    left join public.project_selection_groups g on g.org_id = s.org_id and g.project_id = s.project_id and g.group_id = s.group_id
    where s.org_id = p_org_id and s.project_id = p_project_id and s.status = 'selected' and s.locked_at is null
      and (g.id is null or (g.status = 'open' and (g.cutoff_date is null or g.cutoff_date >= v_today)))
  )
  insert into public.selection_exceptions (org_id, project_id, selection_id, option_id, reason, detail)
  select p_org_id, p_project_id, c.selection_id, c.option_id, c.reason,
    jsonb_strip_nulls(jsonb_build_object('order_by', c.order_by, 'opened_by_system', true))
  from candidates c
  where c.reason is not null
  on conflict (selection_id, reason) where status = 'open' and reason <> 'variance_unrouted' do nothing
  returning *;
end;
$$;

revoke all on function public.refresh_project_selection_exceptions(uuid, uuid) from public, anon, authenticated;
grant execute on function public.refresh_project_selection_exceptions(uuid, uuid) to service_role;

-- What the service needs to explain a choice before trying it: the same facts
-- the write checks, for several candidate options at once.
create or replace function public.project_selection_choice_facts(p_org_id uuid, p_project_id uuid, p_selection_id uuid, p_option_ids uuid[])
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  s public.project_selections;
  g public.project_selection_groups;
  v_today date := public.project_selection_today(p_org_id, p_project_id);
  v_po uuid;
  v_needed_by date;
begin
  select * into s from public.project_selections x where x.org_id = p_org_id and x.project_id = p_project_id and x.id = p_selection_id;
  if not found then
    raise exception 'Selection is not on this home' using errcode = 'P0002';
  end if;
  select * into g from public.project_selection_groups x where x.org_id = p_org_id and x.project_id = p_project_id and x.group_id = s.group_id;
  select si.start_date into v_needed_by from public.schedule_items si where si.org_id = p_org_id and si.id = g.matched_schedule_item_id;
  v_po := public.project_selection_released_purchase_order(p_org_id, p_project_id, s.id);
  return jsonb_build_object(
    'today', v_today,
    'time_zone', public.selection_home_time_zone(p_org_id, p_project_id),
    'selection_locked', s.locked_at is not null,
    'group_status', g.status,
    'cutoff_date', g.cutoff_date,
    'needed_by', v_needed_by,
    'released_purchase_order_id', v_po,
    'released_purchase_order_title', (select c.title from public.commitments c where c.id = v_po),
    'options', coalesce((
      select jsonb_agg(jsonb_build_object(
        'option_id', o.id,
        'lead_time_days', coalesce(o.lead_time_days, parent.lead_time_days),
        'order_by', public.project_selection_order_by(p_org_id, p_project_id, s.group_id, o.id),
        'waived', public.project_selection_lead_time_waived(p_org_id, s.id, o.id)))
      from public.selection_options o
      left join public.selection_options parent on parent.id = o.parent_option_id and parent.org_id = o.org_id
      where o.org_id = p_org_id and o.id = any (coalesce(p_option_ids, '{}'::uuid[]))), '[]'::jsonb));
end;
$$;

revoke all on function public.project_selection_choice_facts(uuid, uuid, uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.project_selection_choice_facts(uuid, uuid, uuid, uuid[]) to service_role;

-- ---------------------------------------------------------------------------
-- 4. The write re-checks the deadline and supply inside its own transaction.
-- ---------------------------------------------------------------------------

create or replace function public.assert_project_selection_open(p_org_id uuid, p_project_id uuid, p_selection public.project_selections, p_today date)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  g record;
begin
  if p_selection.locked_at is not null then
    raise exception 'This selection is locked; changes need a change order' using detail = 'SELECTION_LOCKED_CUTOFF';
  end if;
  if p_selection.group_id is null then
    return;
  end if;
  select pg.status, pg.cutoff_date, sg.name into g
  from public.project_selection_groups pg
  join public.selection_groups sg on sg.id = pg.group_id
  where pg.org_id = p_org_id and pg.project_id = p_project_id and pg.group_id = p_selection.group_id;
  if found and (g.status = 'locked' or g.cutoff_date < p_today) then
    raise exception 'The selection deadline for % was %; changes now need a change order', g.name, coalesce(to_char(g.cutoff_date, 'YYYY-MM-DD'), 'reached')
      using detail = 'SELECTION_LOCKED_CUTOFF';
  end if;
end;
$$;

revoke all on function public.assert_project_selection_open(uuid, uuid, public.project_selections, date) from public, anon, authenticated, service_role;

create or replace function public.assert_project_selection_supply(p_org_id uuid, p_project_id uuid, p_selection public.project_selections, p_option_id uuid, p_today date)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_order_by date;
  v_po uuid;
begin
  v_po := public.project_selection_released_purchase_order(p_org_id, p_project_id, p_selection.id);
  if v_po is not null then
    raise exception 'This selection has already been bought on a released purchase order; changing it needs a change order'
      using detail = 'SELECTION_PROCUREMENT_RELEASED', hint = v_po::text;
  end if;
  if p_option_id is null or p_selection.group_id is null then
    return;
  end if;
  v_order_by := public.project_selection_order_by(p_org_id, p_project_id, p_selection.group_id, p_option_id);
  if v_order_by < p_today and not public.project_selection_lead_time_waived(p_org_id, p_selection.id, p_option_id) then
    raise exception 'This option had to be ordered by % to arrive in time', to_char(v_order_by, 'YYYY-MM-DD')
      using detail = 'SELECTION_LEAD_TIME', hint = to_char(v_order_by, 'YYYY-MM-DD');
  end if;
end;
$$;

revoke all on function public.assert_project_selection_supply(uuid, uuid, public.project_selections, uuid, date) from public, anon, authenticated, service_role;

create or replace function public.apply_project_selection_writes(
  p_org_id uuid,
  p_project_id uuid,
  p_writes jsonb,
  p_expected_catalog_revision text,
  p_expected_home_state text
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  w jsonb;
  s public.project_selections;
  total integer := 0;
  current_revision bigint;
  v_today date;
  v_option uuid;
  v_package uuid;
  v_status text;
begin
  if jsonb_typeof(p_writes) is distinct from 'array' or jsonb_array_length(p_writes) = 0 then
    raise exception 'No selection writes to apply' using errcode = '22023';
  end if;
  if p_expected_catalog_revision is null or p_expected_catalog_revision !~ '^[1-9][0-9]{0,18}$'
     or p_expected_home_state is null or p_expected_home_state !~ '^[0-9a-f]{32}$' then
    raise exception 'Selection writes require the catalog revision and home state they were validated on' using errcode = '22023';
  end if;

  -- One writer per home at a time; everything below is read under the lock.
  perform pg_advisory_xact_lock(hashtextextended('project-selections:' || p_org_id::text || ':' || p_project_id::text, 0));

  select r.revision into current_revision from public.agreement_catalog_revisions r where r.org_id = p_org_id for share;
  if not found then raise exception 'Catalog revision is unavailable'; end if;
  if current_revision::text is distinct from p_expected_catalog_revision then
    raise exception 'The catalog changed while you were choosing; review and try again' using detail = 'SELECTION_CATALOG_CHANGED';
  end if;
  if public.project_selection_home_state(p_org_id, p_project_id) is distinct from p_expected_home_state then
    raise exception 'This home''s selections changed while you were choosing; review and try again' using detail = 'SELECTION_HOME_CHANGED';
  end if;

  v_today := public.project_selection_today(p_org_id, p_project_id);

  for w in select value from jsonb_array_elements(p_writes) loop
    select * into s from public.project_selections x
    where x.org_id = p_org_id and x.project_id = p_project_id and x.id = (w ->> 'id')::uuid
    for update;
    if not found then
      raise exception 'Selection % is not on this home', w ->> 'id' using errcode = 'P0002';
    end if;

    v_option := case when w ? 'selected_option_id' then (w ->> 'selected_option_id')::uuid else s.selected_option_id end;
    v_package := case when w ? 'package_id' then (w ->> 'package_id')::uuid else s.package_id end;
    v_status := case when w ? 'status' then w ->> 'status' else s.status end;
    -- A write that moves the choice (or its status) meets the deadline and the
    -- supply rules here, whatever the caller checked before.
    if (v_option, v_package, v_status) is distinct from (s.selected_option_id, s.package_id, s.status) then
      perform public.assert_project_selection_open(p_org_id, p_project_id, s, v_today);
      if (v_option, v_package) is distinct from (s.selected_option_id, s.package_id) then
        perform public.assert_project_selection_supply(p_org_id, p_project_id, s, v_option, v_today);
      end if;
    end if;

    update public.project_selections x set
      selected_option_id = v_option,
      package_id = v_package,
      status = v_status,
      selected_at = case when w ? 'selected_at' then (w ->> 'selected_at')::timestamptz else x.selected_at end,
      selected_by_contact_id = case when w ? 'selected_by_contact_id' then (w ->> 'selected_by_contact_id')::uuid else x.selected_by_contact_id end,
      price_cents_snapshot = case when w ? 'price_cents_snapshot' then (w ->> 'price_cents_snapshot')::integer else x.price_cents_snapshot end,
      cost_cents_snapshot = case when w ? 'cost_cents_snapshot' then (w ->> 'cost_cents_snapshot')::integer else x.cost_cents_snapshot end,
      confirmed_at = case when w ? 'confirmed_at' then (w ->> 'confirmed_at')::timestamptz else x.confirmed_at end,
      source_change_order_id = case when w ? 'source_change_order_id' then (w ->> 'source_change_order_id')::uuid else x.source_change_order_id end,
      metadata = x.metadata || coalesce(w -> 'metadata', '{}'::jsonb)
    where x.id = s.id;

    -- Choosing something else answers the supply exceptions open on the old choice.
    if v_option is distinct from s.selected_option_id then
      update public.selection_exceptions e set
        status = 'resolved_alternate', resolved_at = now(),
        detail = e.detail || jsonb_build_object('resolved_option_id', v_option)
      where e.org_id = p_org_id and e.selection_id = s.id and e.status = 'open'
        and e.reason in ('option_unavailable', 'lead_time_exceeded', 'procurement_released');
    end if;
    total := total + 1;
  end loop;

  return total;
end;
$$;

revoke all on function public.apply_project_selection_writes(uuid, uuid, jsonb, text, text) from public, anon, authenticated;
grant execute on function public.apply_project_selection_writes(uuid, uuid, jsonb, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- 5. Cutoff writes: the group and its selections move together.
-- ---------------------------------------------------------------------------

-- Opens or closes a group's selections to match its status: an open group
-- reopens the choices a sweep closed (confirmed choices stay locked: the buyer
-- signed those off); a locked group stamps every choice it closes.
create or replace function public.settle_project_selection_group(p_org_id uuid, p_project_id uuid, p_group_id uuid, p_status text, p_at timestamptz)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if p_status = 'open' then
    update public.project_selections s set locked_at = null
    where s.org_id = p_org_id and s.project_id = p_project_id and s.group_id = p_group_id
      and s.status in ('pending', 'selected') and s.locked_at is not null;
  else
    update public.project_selections s set locked_at = p_at
    where s.org_id = p_org_id and s.project_id = p_project_id and s.group_id = p_group_id and s.locked_at is null;
  end if;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.settle_project_selection_group(uuid, uuid, uuid, text, timestamptz) from public, anon, authenticated, service_role;

create or replace function public.override_project_selection_group_cutoff(
  p_org_id uuid,
  p_project_id uuid,
  p_group_id uuid,
  p_cutoff_date date,
  p_reason text,
  p_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_before public.project_selection_groups;
  v_after public.project_selection_groups;
  v_status text;
  v_now timestamptz := now();
  v_settled integer;
begin
  if p_cutoff_date is null or length(btrim(coalesce(p_reason, ''))) < 5 or p_actor_id is null then
    raise exception 'An override needs a date, a reason and the person making it' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('project-selections:' || p_org_id::text || ':' || p_project_id::text, 0));
  select * into v_before from public.project_selection_groups g
  where g.org_id = p_org_id and g.project_id = p_project_id and g.group_id = p_group_id for update;
  if not found then
    raise exception 'Selection group not found on this home' using errcode = 'P0002';
  end if;
  v_status := case when p_cutoff_date >= public.project_selection_today(p_org_id, p_project_id) then 'open' else 'locked' end;
  update public.project_selection_groups g set
    cutoff_date = p_cutoff_date,
    cutoff_source = 'manual_override',
    override_reason = btrim(p_reason),
    overridden_by = p_actor_id,
    status = v_status,
    locked_at = case when v_status = 'locked' then coalesce(g.locked_at, v_now) end
  where g.id = v_before.id
  returning * into v_after;
  -- An extension reopens what a sweep closed; a past date locks the group, and
  -- the database write refuses on the group's status as on a choice's lock.
  if v_status = 'open' then
    v_settled := public.settle_project_selection_group(p_org_id, p_project_id, p_group_id, 'open', v_now);
  end if;
  return jsonb_build_object(
    'id', v_after.id,
    'before', jsonb_build_object('cutoff_date', v_before.cutoff_date, 'cutoff_source', v_before.cutoff_source,
      'override_reason', v_before.override_reason, 'overridden_by', v_before.overridden_by, 'status', v_before.status),
    'after', jsonb_build_object('cutoff_date', v_after.cutoff_date, 'cutoff_source', v_after.cutoff_source,
      'override_reason', v_after.override_reason, 'overridden_by', v_after.overridden_by, 'status', v_after.status),
    'reopened', coalesce(v_settled, 0));
end;
$$;

revoke all on function public.override_project_selection_group_cutoff(uuid, uuid, uuid, date, text, uuid) from public, anon, authenticated;
grant execute on function public.override_project_selection_group_cutoff(uuid, uuid, uuid, date, text, uuid) to service_role;

-- Drops a manual override and puts back the schedule-derived date (derived by
-- the service from the schedule template rules), in one step.
create or replace function public.restore_project_selection_group_cutoff(
  p_org_id uuid,
  p_project_id uuid,
  p_group_id uuid,
  p_cutoff_date date,
  p_matched_schedule_item_id uuid,
  p_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_before public.project_selection_groups;
  v_after public.project_selection_groups;
  v_status text;
  v_now timestamptz := now();
  v_settled integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('project-selections:' || p_org_id::text || ':' || p_project_id::text, 0));
  select * into v_before from public.project_selection_groups g
  where g.org_id = p_org_id and g.project_id = p_project_id and g.group_id = p_group_id for update;
  if not found then
    raise exception 'Selection group not found on this home' using errcode = 'P0002';
  end if;
  if v_before.cutoff_source <> 'manual_override' then
    raise exception 'This cutoff already follows the schedule' using detail = 'SELECTION_CUTOFF_NOT_OVERRIDDEN';
  end if;
  -- A schedule date still ahead reopens the group; one already behind it is
  -- left for the sweep to lock, as any schedule-derived cutoff is.
  v_status := case when p_cutoff_date is null or p_cutoff_date >= public.project_selection_today(p_org_id, p_project_id) then 'open' else v_before.status end;
  update public.project_selection_groups g set
    cutoff_date = p_cutoff_date,
    matched_schedule_item_id = p_matched_schedule_item_id,
    cutoff_source = 'schedule',
    override_reason = null,
    overridden_by = null,
    status = v_status,
    locked_at = case when v_status = 'open' then null else g.locked_at end
  where g.id = v_before.id
  returning * into v_after;
  if v_status = 'open' then
    v_settled := public.settle_project_selection_group(p_org_id, p_project_id, p_group_id, 'open', v_now);
  end if;
  return jsonb_build_object(
    'id', v_after.id,
    'before', jsonb_build_object('cutoff_date', v_before.cutoff_date, 'cutoff_source', v_before.cutoff_source,
      'override_reason', v_before.override_reason, 'overridden_by', v_before.overridden_by, 'status', v_before.status),
    'after', jsonb_build_object('cutoff_date', v_after.cutoff_date, 'cutoff_source', v_after.cutoff_source, 'status', v_after.status),
    'reopened', coalesce(v_settled, 0));
end;
$$;

revoke all on function public.restore_project_selection_group_cutoff(uuid, uuid, uuid, date, uuid, uuid) from public, anon, authenticated;
grant execute on function public.restore_project_selection_group_cutoff(uuid, uuid, uuid, date, uuid, uuid) to service_role;

-- A schedule move re-derives a schedule-sourced cutoff; a manual override is
-- left alone (re-read under the lock). Moving the date forward past today
-- reopens a locked group with its selections; the sweep locks, this does not.
create or replace function public.move_project_selection_group_cutoff(
  p_org_id uuid,
  p_project_id uuid,
  p_group_id uuid,
  p_cutoff_date date,
  p_matched_schedule_item_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_before public.project_selection_groups;
  v_reopen boolean;
  v_reopened integer := 0;
begin
  perform pg_advisory_xact_lock(hashtextextended('project-selections:' || p_org_id::text || ':' || p_project_id::text, 0));
  select * into v_before from public.project_selection_groups g
  where g.org_id = p_org_id and g.project_id = p_project_id and g.group_id = p_group_id for update;
  if not found then
    raise exception 'Selection group not found on this home' using errcode = 'P0002';
  end if;
  if v_before.cutoff_source = 'manual_override' then
    return jsonb_build_object('changed', false, 'reopened', 0, 'old', v_before.cutoff_date, 'new', v_before.cutoff_date);
  end if;
  v_reopen := v_before.status = 'locked' and p_cutoff_date is not null
    and p_cutoff_date >= public.project_selection_today(p_org_id, p_project_id);
  if v_before.cutoff_date is not distinct from p_cutoff_date
     and v_before.matched_schedule_item_id is not distinct from p_matched_schedule_item_id and not v_reopen then
    return jsonb_build_object('changed', false, 'reopened', 0, 'old', v_before.cutoff_date, 'new', p_cutoff_date);
  end if;
  update public.project_selection_groups g set
    cutoff_date = p_cutoff_date,
    matched_schedule_item_id = p_matched_schedule_item_id,
    status = case when v_reopen then 'open' else g.status end,
    locked_at = case when v_reopen then null else g.locked_at end
  where g.id = v_before.id;
  if v_reopen then
    v_reopened := public.settle_project_selection_group(p_org_id, p_project_id, p_group_id, 'open', now());
  end if;
  return jsonb_build_object('changed', true, 'reopened', v_reopened, 'old', v_before.cutoff_date, 'new', p_cutoff_date);
end;
$$;

revoke all on function public.move_project_selection_group_cutoff(uuid, uuid, uuid, date, uuid) from public, anon, authenticated;
grant execute on function public.move_project_selection_group_cutoff(uuid, uuid, uuid, date, uuid) to service_role;

-- The nightly sweep: every open group past its cutoff in its community's day
-- is locked with its selections in one step per home. Returns what it locked
-- and how many choices it left unconfirmed, for the coordinators' notice.
create or replace function public.lock_due_selection_groups(p_org_id uuid, p_limit integer)
returns table (id uuid, org_id uuid, project_id uuid, group_id uuid, metadata jsonb, unconfirmed integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  c record;
  v_now timestamptz := now();
  v_group public.project_selection_groups;
begin
  for c in
    select g.id, g.org_id, g.project_id, g.group_id
    from public.project_selection_groups g
    where g.status = 'open'
      and (p_org_id is null or g.org_id = p_org_id)
      -- No zone is more than a day ahead of UTC, so this bounds the candidates.
      and g.cutoff_date < (now() at time zone 'UTC')::date + 1
      and g.cutoff_date < public.project_selection_today(g.org_id, g.project_id)
    order by g.cutoff_date, g.id
    limit greatest(coalesce(p_limit, 200), 1)
  loop
    perform pg_advisory_xact_lock(hashtextextended('project-selections:' || c.org_id::text || ':' || c.project_id::text, 0));
    update public.project_selection_groups g set status = 'locked', locked_at = v_now
    where g.id = c.id and g.status = 'open'
    returning * into v_group;
    if not found then
      continue;
    end if;
    perform public.settle_project_selection_group(c.org_id, c.project_id, c.group_id, 'locked', v_now);
    id := v_group.id;
    org_id := v_group.org_id;
    project_id := v_group.project_id;
    group_id := v_group.group_id;
    metadata := v_group.metadata;
    select count(*)::integer into unconfirmed from public.project_selections s
    where s.org_id = c.org_id and s.project_id = c.project_id and s.group_id = c.group_id and s.status in ('pending', 'selected');
    return next;
  end loop;
end;
$$;

revoke all on function public.lock_due_selection_groups(uuid, integer) from public, anon, authenticated;
grant execute on function public.lock_due_selection_groups(uuid, integer) to service_role;

-- ---------------------------------------------------------------------------
-- 6. Member write guards.
-- ---------------------------------------------------------------------------

create or replace function public.tg_project_selection_groups_member_write_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user <> 'authenticated' then
    return coalesce(new, old);
  end if;
  if tg_op <> 'UPDATE' then
    raise exception 'A home''s selection groups are set up by the selection service' using errcode = '42501';
  end if;
  if (to_jsonb(new) - array['metadata', 'updated_at']) is distinct from (to_jsonb(old) - array['metadata', 'updated_at']) then
    raise exception 'A selection cutoff moves through an override with a reason, never by a direct write' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.tg_project_selection_groups_member_write_guard() from public, anon, authenticated;

drop trigger if exists project_selection_groups_member_write_guard on public.project_selection_groups;
create trigger project_selection_groups_member_write_guard
  before insert or update or delete on public.project_selection_groups
  for each row execute function public.tg_project_selection_groups_member_write_guard();

drop policy if exists project_selection_groups_org_access on public.project_selection_groups;
create policy project_selection_groups_select on public.project_selection_groups
  for select to authenticated
  using (public.is_org_member(org_id));
create policy project_selection_groups_update on public.project_selection_groups
  for update to authenticated
  using (public.has_org_permission(org_id, 'selections.write'))
  with check (public.has_org_permission(org_id, 'selections.write'));

create or replace function public.tg_project_selections_member_write_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user <> 'authenticated' then
    return coalesce(new, old);
  end if;
  if tg_op = 'DELETE' then
    if old.status <> 'pending' then
      raise exception 'A % selection is kept; change it through the selection service', old.status using errcode = '42501';
    end if;
    return old;
  end if;
  if tg_op = 'INSERT' then
    if new.status <> 'pending'
       or new.selected_option_id is not null
       or new.package_id is not null
       or new.price_cents_snapshot is not null
       or new.cost_cents_snapshot is not null
       or new.locked_at is not null
       or new.confirmed_at is not null
       or new.source_change_order_id is not null
       or coalesce(new.metadata, '{}'::jsonb) <> '{}'::jsonb then
      raise exception 'A selection is chosen and priced through the selection service' using errcode = '42501';
    end if;
    return new;
  end if;
  if (new.org_id, new.project_id) is distinct from (old.org_id, old.project_id) then
    raise exception 'A selection stays with its home' using errcode = '42501';
  end if;
  if (new.status, new.selected_option_id, new.package_id, new.price_cents_snapshot, new.cost_cents_snapshot)
     is distinct from (old.status, old.selected_option_id, old.package_id, old.price_cents_snapshot, old.cost_cents_snapshot) then
    raise exception 'A selection is chosen and priced through the selection service' using errcode = '42501';
  end if;
  if (new.locked_at, new.group_id, new.source_change_order_id, new.confirmed_at, new.metadata)
     is distinct from (old.locked_at, old.group_id, old.source_change_order_id, old.confirmed_at, old.metadata) then
    raise exception 'A selection''s lock, deadline group, approval and change order are kept by the selection service' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.tg_project_selections_member_write_guard() from public, anon, authenticated;

drop trigger if exists project_selections_member_write_guard on public.project_selections;
create trigger project_selections_member_write_guard
  before insert or delete or update of org_id, project_id, status, selected_option_id, package_id, price_cents_snapshot,
    cost_cents_snapshot, locked_at, group_id, source_change_order_id, confirmed_at, metadata on public.project_selections
  for each row execute function public.tg_project_selections_member_write_guard();

-- ---------------------------------------------------------------------------
-- 7. A selection change order: attached once, frozen, one open per selection.
-- ---------------------------------------------------------------------------

create table public.selection_change_claims (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  selection_id uuid not null references public.project_selections(id) on delete cascade,
  change_order_id uuid not null references public.change_orders(id) on delete cascade,
  released_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (change_order_id, selection_id)
);

create unique index selection_change_claims_open_key on public.selection_change_claims (selection_id) where released_at is null;
create index selection_change_claims_project_idx on public.selection_change_claims (org_id, project_id);

create trigger selection_change_claims_set_updated_at before update on public.selection_change_claims
  for each row execute function public.tg_set_updated_at();

alter table public.selection_change_claims enable row level security;

create policy selection_change_claims_select on public.selection_change_claims
  for select to authenticated
  using (public.has_org_permission(org_id, 'selections.read'));

create policy selection_change_claims_division_scope on public.selection_change_claims
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

grant select on public.selection_change_claims to authenticated;
grant all on public.selection_change_claims to service_role;

-- The change orders already out for a selection keep their claim; where two
-- open ones share a selection, the older keeps it and the newer is refused at
-- approval by its prior-state check.
insert into public.selection_change_claims (org_id, project_id, selection_id, change_order_id)
select co.org_id, co.project_id, s.id, co.id
from public.change_orders co
cross join lateral jsonb_array_elements(
  case when jsonb_typeof(co.metadata->'selection_change'->'changes') = 'array' then co.metadata->'selection_change'->'changes' else '[]'::jsonb end) c
join public.project_selections s
  on s.org_id = co.org_id and s.project_id = co.project_id
  and s.id::text = c->>'selection_id'
where co.metadata ? 'selection_change'
  and co.status not in ('approved', 'rejected', 'cancelled')
  and coalesce(co.lifecycle, 'draft') not in ('approved', 'rejected', 'void')
order by co.created_at, co.id
on conflict do nothing;

create or replace function public.tg_change_order_selection_change_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.metadata ? 'selection_change' then
      raise exception 'A selection change is attached to its change order by the design studio, never written with it' using errcode = '42501';
    end if;
    return new;
  end if;
  if (old.metadata -> 'selection_change') is not distinct from (new.metadata -> 'selection_change') then
    -- The price a selection change order carries is its selections' prices.
    if old.metadata ? 'selection_change' and current_user = 'authenticated' and new.total_cents is distinct from old.total_cents then
      raise exception 'A selection change order''s price is its selections'' prices; void it and raise a new one' using errcode = '42501';
    end if;
    return new;
  end if;
  if old.metadata ? 'selection_change' then
    raise exception 'A change order''s selection change is fixed once raised; void it and raise a new one' using errcode = '42501';
  end if;
  if current_user = 'authenticated' then
    raise exception 'A selection change is attached through the design studio' using errcode = '42501';
  end if;
  if new.status in ('approved', 'rejected', 'cancelled') or coalesce(new.lifecycle, 'draft') in ('approved', 'rejected', 'void') then
    raise exception 'A selection change is attached to a draft change order' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.tg_change_order_selection_change_guard() from public, anon, authenticated;

drop trigger if exists change_orders_selection_change_guard on public.change_orders;
create trigger change_orders_selection_change_guard
  before insert or update on public.change_orders
  for each row execute function public.tg_change_order_selection_change_guard();

-- Attaching claims every selection it changes, against the home's choice as
-- it stands now: a change priced on a stale home, or one that would be a
-- second open change order on a selection, is refused.
create or replace function public.tg_change_order_selection_change_claims()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_changes jsonb := new.metadata->'selection_change'->'changes';
  v_change jsonb;
  s public.project_selections;
  v_old_price bigint;
  v_claimed uuid;
  v_holder text;
begin
  if jsonb_typeof(v_changes) is distinct from 'array' or jsonb_array_length(v_changes) = 0 then
    raise exception 'A selection change needs at least one change' using errcode = '22023';
  end if;
  if (select count(distinct c->>'selection_id') from jsonb_array_elements(v_changes) c) <> jsonb_array_length(v_changes) then
    raise exception 'A selection change names each selection once' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('project-selections:' || new.org_id::text || ':' || new.project_id::text, 0));
  for v_change in select value from jsonb_array_elements(v_changes) loop
    select * into s from public.project_selections x
    where x.org_id = new.org_id and x.project_id = new.project_id and x.id::text = v_change->>'selection_id';
    if not found then
      raise exception 'A selection on this change order is not on its home' using errcode = 'P0002';
    end if;
    v_old_price := coalesce((v_change->>'old_price_cents')::bigint,
      (v_change->>'price_cents')::bigint - (v_change->>'price_delta_cents')::bigint);
    if s.selected_option_id is distinct from nullif(v_change->>'old_option_id', '')::uuid
       or coalesce(s.price_cents_snapshot, 0) is distinct from coalesce(v_old_price, 0) then
      raise exception '% changed while this change order was being priced; price it again', coalesce(v_change->>'category_name', 'A selection')
        using detail = 'SELECTION_CHANGED_SINCE_PRICING';
    end if;
    insert into public.selection_change_claims (org_id, project_id, selection_id, change_order_id)
    values (new.org_id, new.project_id, s.id, new.id)
    on conflict (selection_id) where released_at is null do nothing
    returning id into v_claimed;
    if v_claimed is null then
      select coalesce('CO #' || co.co_number::text, 'another change order') into v_holder
      from public.selection_change_claims k join public.change_orders co on co.id = k.change_order_id
      where k.selection_id = s.id and k.released_at is null;
      raise exception '% already has an open change order (%); finish or void it first', coalesce(v_change->>'category_name', 'This selection'), v_holder
        using detail = 'SELECTION_CHANGE_ALREADY_OPEN';
    end if;
  end loop;
  return null;
end;
$$;

revoke all on function public.tg_change_order_selection_change_claims() from public, anon, authenticated;

drop trigger if exists change_order_selection_change_claims on public.change_orders;
create trigger change_order_selection_change_claims
  after update on public.change_orders
  for each row
  when (new.metadata ? 'selection_change' and not (old.metadata ? 'selection_change'))
  execute function public.tg_change_order_selection_change_claims();

-- Its lines are the selections' prices, fixed with the selection change.
create or replace function public.tg_change_order_line_selection_change_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user <> 'authenticated' then
    return coalesce(new, old);
  end if;
  if exists (
    select 1 from public.change_orders c
    where c.id in (new.change_order_id, old.change_order_id) and c.metadata ? 'selection_change'
  ) then
    raise exception 'A selection change order''s lines are its selections'' prices; void it and raise a new one' using errcode = '42501';
  end if;
  return coalesce(new, old);
end;
$$;

revoke all on function public.tg_change_order_line_selection_change_guard() from public, anon, authenticated;

drop trigger if exists change_order_lines_selection_change_guard on public.change_order_lines;
create trigger change_order_lines_selection_change_guard
  before insert or update or delete on public.change_order_lines
  for each row execute function public.tg_change_order_line_selection_change_guard();

-- A rejected or voided change order lets its selections go.
create or replace function public.tg_change_order_selection_claims_release()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.selection_change_claims k set released_at = now()
  where k.change_order_id = new.id and k.released_at is null;
  return null;
end;
$$;

revoke all on function public.tg_change_order_selection_claims_release() from public, anon, authenticated;

drop trigger if exists change_order_selection_claims_release on public.change_orders;
create trigger change_order_selection_claims_release
  after update on public.change_orders
  for each row
  when ((new.status in ('rejected', 'cancelled') or coalesce(new.lifecycle, 'draft') in ('rejected', 'void'))
        and (old.status, coalesce(old.lifecycle, 'draft')) is distinct from (new.status, coalesce(new.lifecycle, 'draft')))
  execute function public.tg_change_order_selection_claims_release();

-- ---------------------------------------------------------------------------
-- 8. Approval applies the selection change in the approval's transaction.
-- ---------------------------------------------------------------------------

-- The trade half of an executed change: each cost delta lands on the purchase
-- order that owns it (the one carrying the selection's line; else the oldest
-- live purchase order on its cost code) as a draft variance order. A delta
-- with nowhere to land is returned, never dropped. Idempotent per change order.
create or replace function public.create_change_order_variance_orders(
  p_org_id uuid,
  p_project_id uuid,
  p_change_order_id uuid,
  p_subject jsonb,
  p_deltas jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reason uuid;
  v_routed jsonb;
  v_order record;
  v_vpo uuid;
  v_created jsonb := '[]'::jsonb;
begin
  if jsonb_typeof(p_deltas) is distinct from 'array' then
    raise exception 'Variance deltas must be a list' using errcode = '22023';
  end if;
  if exists (select 1 from public.commitment_change_orders v
             where v.org_id = p_org_id and v.prime_change_order_id = p_change_order_id and v.origin = 'design_studio_co') then
    return jsonb_build_object('idempotent', true, 'created', '[]'::jsonb, 'unrouted', '[]'::jsonb);
  end if;

  with deltas as (
    select x.ord, x.d->>'selection_id' as source_ref, nullif(x.d->>'cost_code_id', '')::uuid as cost_code_id,
      round((x.d->>'cost_delta_cents')::numeric)::bigint as delta, coalesce(nullif(x.d->>'description', ''), 'Change') as description
    from jsonb_array_elements(p_deltas) with ordinality as x(d, ord)
    where round(coalesce((x.d->>'cost_delta_cents')::numeric, 0)) <> 0
  ), owners as (
    select d.*,
      (select l.commitment_id from public.commitment_lines l
         join public.commitments c on c.id = l.commitment_id and c.org_id = l.org_id
        where l.org_id = p_org_id and c.project_id = p_project_id and c.commitment_type = 'purchase_order'
          and c.status not in ('canceled', 'cancelled', 'void', 'voided', 'rejected')
          and l.metadata->>'source_ref' = d.source_ref
        order by c.created_at, c.id limit 1) as owning_commitment,
      (select l.cost_code_id from public.commitment_lines l
         join public.commitments c on c.id = l.commitment_id and c.org_id = l.org_id
        where l.org_id = p_org_id and c.project_id = p_project_id and c.commitment_type = 'purchase_order'
          and c.status not in ('canceled', 'cancelled', 'void', 'voided', 'rejected')
          and l.metadata->>'source_ref' = d.source_ref
        order by c.created_at, c.id limit 1) as owning_cost_code,
      (select c.id from public.commitments c
        where d.cost_code_id is not null and c.org_id = p_org_id and c.project_id = p_project_id
          and c.commitment_type = 'purchase_order' and c.status not in ('canceled', 'cancelled', 'void', 'voided', 'rejected')
          and exists (select 1 from public.commitment_lines l where l.org_id = p_org_id and l.commitment_id = c.id and l.cost_code_id = d.cost_code_id)
        order by c.created_at, c.id limit 1) as code_commitment
    from deltas d
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'ord', o.ord, 'source_ref', o.source_ref, 'delta', o.delta, 'description', o.description,
      'cost_code_id', coalesce(o.cost_code_id, case when o.owning_commitment is not null then o.owning_cost_code end),
      'commitment_id', coalesce(o.owning_commitment, o.code_commitment),
      'unrouted_reason', case when coalesce(o.owning_commitment, o.code_commitment) is not null then null
                              when o.cost_code_id is null then 'no_cost_code' else 'no_commitment' end)
    order by o.ord), '[]'::jsonb)
  into v_routed
  from owners o;

  if exists (select 1 from jsonb_array_elements(v_routed) r where r->>'commitment_id' is not null) then
    insert into public.variance_reason_codes (org_id, code, label, sort_order)
    values (p_org_id, p_subject->>'reason_code', p_subject->>'reason_label', 3)
    on conflict (org_id, code) do nothing;
    select r.id into v_reason from public.variance_reason_codes r where r.org_id = p_org_id and r.code = p_subject->>'reason_code';
  end if;

  for v_order in
    select (r->>'commitment_id')::uuid as commitment_id, jsonb_agg(r order by (r->>'ord')::bigint) as lines
    from jsonb_array_elements(v_routed) r
    where r->>'commitment_id' is not null
    group by r->>'commitment_id'
    order by min((r->>'ord')::bigint)
  loop
    insert into public.commitment_change_orders (
      org_id, project_id, commitment_id, company_id, title, description, status, total_cents, currency,
      reason_code_id, origin, prime_change_order_id, photo_file_ids, metadata)
    select p_org_id, p_project_id, c.id, c.company_id, coalesce(p_subject->>'title', 'Change order variance'),
      (select string_agg(l->>'description', '; ' order by (l->>'ord')::bigint) from jsonb_array_elements(v_order.lines) l),
      'draft',
      (select sum((l->>'delta')::bigint) from jsonb_array_elements(v_order.lines) l)::integer,
      'usd', v_reason, 'design_studio_co', p_change_order_id, '{}'::uuid[],
      jsonb_build_object('source', p_subject->>'source',
        'selection_ids', (select jsonb_agg(l->>'source_ref' order by (l->>'ord')::bigint) from jsonb_array_elements(v_order.lines) l))
    from public.commitments c where c.org_id = p_org_id and c.id = v_order.commitment_id
    returning id into v_vpo;

    insert into public.commitment_change_order_lines (
      org_id, commitment_change_order_id, cost_code_id, description, quantity, unit, unit_cost_cents, amount_cents, sort_order, metadata)
    select p_org_id, v_vpo, nullif(l->>'cost_code_id', '')::uuid, l->>'description', 1, 'ls',
      (l->>'delta')::integer, (l->>'delta')::integer, (row_number() over (order by (l->>'ord')::bigint) - 1)::integer,
      jsonb_build_object('selection_id', l->>'source_ref')
    from jsonb_array_elements(v_order.lines) l;

    v_created := v_created || jsonb_build_array(jsonb_build_object('id', v_vpo, 'commitment_id', v_order.commitment_id,
      'total_cents', (select sum((l->>'delta')::bigint) from jsonb_array_elements(v_order.lines) l)));
  end loop;

  return jsonb_build_object(
    'idempotent', false,
    'created', v_created,
    'unrouted', coalesce((
      select jsonb_agg(jsonb_build_object('selection_id', r->>'source_ref', 'cost_code_id', r->'cost_code_id',
        'cost_delta_cents', (r->>'delta')::bigint, 'description', r->>'description', 'reason', r->>'unrouted_reason') order by (r->>'ord')::bigint)
      from jsonb_array_elements(v_routed) r where r->>'commitment_id' is null), '[]'::jsonb));
end;
$$;

revoke all on function public.create_change_order_variance_orders(uuid, uuid, uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.create_change_order_variance_orders(uuid, uuid, uuid, jsonb, jsonb) to service_role;

create or replace function public.tg_change_order_selection_apply()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_changes jsonb := new.metadata->'selection_change'->'changes';
  v_change jsonb;
  s public.project_selections;
  v_old_price bigint;
  v_now timestamptz := now();
  v_deltas jsonb := '[]'::jsonb;
  v_total bigint := 0;
  v_variance jsonb;
  v_unrouted jsonb;
  v_revision uuid;
  v_item uuid;
begin
  if jsonb_typeof(v_changes) is distinct from 'array' then
    raise exception 'This change order''s selection change is malformed' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('project-selections:' || new.org_id::text || ':' || new.project_id::text, 0));

  -- (a) The selections, against the state the change order was priced on.
  for v_change in select value from jsonb_array_elements(v_changes) loop
    select * into s from public.project_selections x
    where x.org_id = new.org_id and x.project_id = new.project_id and x.id::text = v_change->>'selection_id'
    for update;
    if not found then
      raise exception 'A selection on this change order is no longer on its home' using detail = 'SELECTION_CHANGED_SINCE_CHANGE_ORDER';
    end if;
    v_old_price := coalesce((v_change->>'old_price_cents')::bigint,
      (v_change->>'price_cents')::bigint - (v_change->>'price_delta_cents')::bigint);
    if s.selected_option_id is distinct from nullif(v_change->>'old_option_id', '')::uuid
       or coalesce(s.price_cents_snapshot, 0) is distinct from coalesce(v_old_price, 0) then
      raise exception '% changed after this change order was priced; void it and raise a new one', coalesce(v_change->>'category_name', 'A selection')
        using detail = 'SELECTION_CHANGED_SINCE_CHANGE_ORDER';
    end if;
    -- The buyer signed these terms, so they land as signed: no catalog re-check.
    update public.project_selections x set
      selected_option_id = (v_change->>'new_option_id')::uuid,
      package_id = nullif(v_change->>'new_package_id', '')::uuid,
      status = 'confirmed',
      selected_at = v_now,
      confirmed_at = v_now,
      price_cents_snapshot = (v_change->>'price_cents')::integer,
      cost_cents_snapshot = (v_change->>'cost_cents')::integer,
      source_change_order_id = new.id,
      metadata = x.metadata || jsonb_build_object('change_order_id', new.id)
    where x.id = s.id;
    if round(coalesce((v_change->>'cost_delta_cents')::numeric, 0)) <> 0 then
      v_deltas := v_deltas || jsonb_build_array(jsonb_build_object(
        'selection_id', s.id,
        'cost_code_id', nullif(v_change->>'cost_code_id', ''),
        'cost_delta_cents', round((v_change->>'cost_delta_cents')::numeric)::bigint,
        'description', concat_ws(' — ', coalesce(v_change->>'category_name', 'Selection'), coalesce(v_change->>'option_name', 'New option'))));
      v_total := v_total + round((v_change->>'cost_delta_cents')::numeric)::bigint;
    end if;
  end loop;

  -- The buyer's earlier approval of these selections no longer describes the
  -- home: this change order is now what they agreed to (EP06-02).
  update public.selection_approvals a set
    status = 'voided', voided_at = v_now,
    void_reason = coalesce('CO #' || new.co_number::text, 'A change order') || ' changed these selections after they were approved'
  where a.org_id = new.org_id and a.project_id = new.project_id and a.status = 'approved'
    and exists (
      select 1 from public.selection_approval_lines l
      where l.approval_id = a.id
        and l.selection_id::text in (select c->>'selection_id' from jsonb_array_elements(v_changes) c)
    );

  -- (b) The purchase orders that own the cost.
  v_variance := public.create_change_order_variance_orders(new.org_id, new.project_id, new.id,
    jsonb_build_object('title', 'Selection change after cutoff', 'reason_code', 'selection_after_cutoff',
      'reason_label', 'Selection after cutoff', 'source', 'design_studio_co'),
    v_deltas);
  for v_unrouted in select value from jsonb_array_elements(v_variance->'unrouted') loop
    insert into public.selection_exceptions (org_id, project_id, selection_id, change_order_id, reason, detail)
    values (new.org_id, new.project_id, (v_unrouted->>'selection_id')::uuid, new.id, 'variance_unrouted', v_unrouted)
    on conflict (change_order_id, selection_id) where status = 'open' and reason = 'variance_unrouted' do nothing;
  end loop;

  -- (c) The budget, one line per cost delta.
  if jsonb_array_length(v_deltas) > 0 then
    insert into public.budget_revisions (org_id, project_id, change_order_id, revision_type, status, title, total_cents, posted_by, posted_at, metadata)
    values (new.org_id, new.project_id, new.id, 'change_order', 'posted', new.title, v_total::integer, new.approved_by, v_now,
      jsonb_build_object('source', 'selection_change', 'billing_status', 'ready_to_bill'))
    on conflict (org_id, change_order_id) do update set
      status = 'posted', total_cents = excluded.total_cents, posted_at = excluded.posted_at, posted_by = excluded.posted_by,
      metadata = public.budget_revisions.metadata || excluded.metadata
    returning id into v_revision;
    delete from public.budget_revision_lines l where l.org_id = new.org_id and l.budget_revision_id = v_revision;
    insert into public.budget_revision_lines (org_id, budget_revision_id, cost_code_id, description, amount_cents, sort_order, metadata)
    select new.org_id, v_revision, nullif(d->>'cost_code_id', '')::uuid, d->>'description', (d->>'cost_delta_cents')::integer,
      (ord - 1)::integer, jsonb_build_object('selection_id', d->>'selection_id')
    from jsonb_array_elements(v_deltas) with ordinality as x(d, ord);
  end if;

  -- (d) The schedule: a pending impact on the earliest task the changed groups
  -- are anchored to, for the superintendent to apply. Nothing moves here.
  if coalesce(new.days_impact, 0) <> 0 then
    select g.matched_schedule_item_id into v_item
    from public.project_selection_groups g
    join public.schedule_items si on si.id = g.matched_schedule_item_id and si.org_id = g.org_id
    where g.org_id = new.org_id and g.project_id = new.project_id
      and g.group_id::text in (select c->>'group_id' from jsonb_array_elements(v_changes) c)
    order by si.start_date nulls last, si.id
    limit 1;
    if v_item is not null then
      insert into public.schedule_item_change_orders (org_id, schedule_item_id, change_order_id, days_adjusted, notes)
      values (new.org_id, v_item, new.id, new.days_impact, 'Selection change: pending the superintendent')
      on conflict (schedule_item_id, change_order_id) do nothing;
    end if;
  end if;

  -- (e) The selections are free for their next change; their supply
  -- exceptions are answered by this change order.
  update public.selection_change_claims k set released_at = v_now where k.change_order_id = new.id and k.released_at is null;
  update public.selection_exceptions e set status = 'resolved_change_order', resolved_at = v_now, change_order_id = new.id
  where e.org_id = new.org_id and e.status = 'open'
    and e.reason in ('option_unavailable', 'lead_time_exceeded', 'procurement_released')
    and e.selection_id::text in (select c->>'selection_id' from jsonb_array_elements(v_changes) c);

  -- (f) Events and notices follow the commit.
  insert into public.outbox (org_id, job_type, payload, dedupe_key)
  values (new.org_id, 'selection_change_applied',
    jsonb_build_object('change_order_id', new.id, 'project_id', new.project_id, 'schedule_item_id', v_item,
      'variance_orders', v_variance->'created', 'unrouted', v_variance->'unrouted'),
    'selection_change_applied:' || new.id::text)
  on conflict do nothing;
  return null;
end;
$$;

revoke all on function public.tg_change_order_selection_apply() from public, anon, authenticated;

-- Named to fire after change_order_agreement_amendment: the agreement version
-- and the selections it amends are written in the same approval.
drop trigger if exists change_order_selection_apply on public.change_orders;
create trigger change_order_selection_apply
  after update on public.change_orders
  for each row
  when (new.status = 'approved' and old.status is distinct from 'approved' and new.metadata ? 'selection_change')
  execute function public.tg_change_order_selection_apply();

-- ---------------------------------------------------------------------------
-- 9. Variance orders raised from a change order are the system's.
-- ---------------------------------------------------------------------------

create or replace function public.tg_commitment_change_order_system_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user <> 'authenticated' then
    return coalesce(new, old);
  end if;
  -- Linking an office variance order to the owner change order it passes
  -- through stays the member's; only the executed change order's own are kept.
  if tg_op = 'INSERT' then
    if new.origin = 'design_studio_co' then
      raise exception 'A variance order for an executed change order is raised by the change order' using errcode = '42501';
    end if;
    return new;
  end if;
  if old.origin is distinct from 'design_studio_co' then
    if tg_op = 'UPDATE' and new.origin = 'design_studio_co' then
      raise exception 'A variance order for an executed change order is raised by the change order' using errcode = '42501';
    end if;
    return coalesce(new, old);
  end if;
  if tg_op = 'DELETE' then
    raise exception 'A variance order raised by a change order is kept; void it instead' using errcode = '42501';
  end if;
  if (new.org_id, new.project_id, new.commitment_id, new.total_cents, new.origin, new.prime_change_order_id, new.reason_code_id)
     is distinct from (old.org_id, old.project_id, old.commitment_id, old.total_cents, old.origin, old.prime_change_order_id, old.reason_code_id) then
    raise exception 'A variance order raised by a change order is re-priced through purchasing with a reason' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.tg_commitment_change_order_system_guard() from public, anon, authenticated;

drop trigger if exists commitment_change_orders_system_guard on public.commitment_change_orders;
create trigger commitment_change_orders_system_guard
  before insert or update or delete on public.commitment_change_orders
  for each row execute function public.tg_commitment_change_order_system_guard();

create or replace function public.tg_commitment_change_order_line_system_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_order uuid := coalesce(new.commitment_change_order_id, old.commitment_change_order_id);
begin
  if current_user <> 'authenticated' then
    return coalesce(new, old);
  end if;
  if tg_op = 'UPDATE' and new.commitment_change_order_id is distinct from old.commitment_change_order_id
     and exists (select 1 from public.commitment_change_orders v where v.id = new.commitment_change_order_id and v.origin = 'design_studio_co') then
    raise exception 'A variance order raised by a change order is re-priced through purchasing with a reason' using errcode = '42501';
  end if;
  if exists (select 1 from public.commitment_change_orders v where v.id = v_order and v.origin = 'design_studio_co') then
    raise exception 'A variance order raised by a change order is re-priced through purchasing with a reason' using errcode = '42501';
  end if;
  return coalesce(new, old);
end;
$$;

revoke all on function public.tg_commitment_change_order_line_system_guard() from public, anon, authenticated;

drop trigger if exists commitment_change_order_lines_system_guard on public.commitment_change_order_lines;
create trigger commitment_change_order_lines_system_guard
  before insert or update or delete on public.commitment_change_order_lines
  for each row execute function public.tg_commitment_change_order_line_system_guard();

-- ---------------------------------------------------------------------------
-- 10. The superintendent applies a pending schedule impact.
-- ---------------------------------------------------------------------------

create or replace function public.apply_schedule_item_change_order(p_org_id uuid, p_impact_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_impact public.schedule_item_change_orders;
  v_before record;
  v_status text;
begin
  select * into v_impact from public.schedule_item_change_orders i where i.org_id = p_org_id and i.id = p_impact_id for update;
  if not found then
    raise exception 'Schedule impact not found' using errcode = 'P0002';
  end if;
  if v_impact.applied_at is not null then
    raise exception 'This schedule impact was already applied' using detail = 'SCHEDULE_IMPACT_APPLIED';
  end if;
  select c.status into v_status from public.change_orders c where c.org_id = p_org_id and c.id = v_impact.change_order_id;
  if v_status is distinct from 'approved' then
    raise exception 'Only an approved change order moves the schedule' using detail = 'SCHEDULE_IMPACT_NOT_APPROVED';
  end if;
  select si.start_date, si.end_date into v_before from public.schedule_items si
  where si.org_id = p_org_id and si.id = v_impact.schedule_item_id for update;
  if not found then
    raise exception 'Schedule item not found' using errcode = 'P0002';
  end if;
  update public.schedule_items si set
    start_date = si.start_date + coalesce(v_impact.days_adjusted, 0),
    end_date = si.end_date + coalesce(v_impact.days_adjusted, 0)
  where si.id = v_impact.schedule_item_id;
  update public.schedule_item_change_orders i set applied_at = now() where i.id = v_impact.id;
  return jsonb_build_object('schedule_item_id', v_impact.schedule_item_id, 'change_order_id', v_impact.change_order_id,
    'days_adjusted', v_impact.days_adjusted, 'before', jsonb_build_object('start_date', v_before.start_date, 'end_date', v_before.end_date),
    'after', jsonb_build_object('start_date', v_before.start_date + coalesce(v_impact.days_adjusted, 0),
      'end_date', v_before.end_date + coalesce(v_impact.days_adjusted, 0)));
end;
$$;

revoke all on function public.apply_schedule_item_change_order(uuid, uuid) from public, anon, authenticated;
grant execute on function public.apply_schedule_item_change_order(uuid, uuid) to service_role;
