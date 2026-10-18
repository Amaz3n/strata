-- EP06 review fixes (selections): the guarantees hold for every writer.
--
-- 1. A selection change order is approved only by someone holding
--    change_order.approve, in their own name. A member's direct write can no
--    longer flip its signature requirement or days, nor approve it without
--    that authority, and the apply trigger itself refuses an approval written
--    by a signed-in member without it. A change that needs a cost code and has
--    none fails the approval rather than posting an uncoded budget line.
-- 2. A member deletes a pending selection only with selections.write and only
--    while its group is open, and inserts one only into the group its category
--    belongs to on that home, so a row never escapes a locked or cut-off group.
--    The row policy asks for selections.write on every write.
-- 3. A schedule impact is the system's: only the selection approval records
--    one and only apply_schedule_item_change_order stamps it applied; the
--    service paths that link or remove one run as the service role after the
--    schedule.edit check.
-- 4. The cutoff reminder reads each home's days to cutoff in the community's
--    day, in the database, like the lock sweep.

-- ---------------------------------------------------------------------------
-- 1. Approving a selection change order.
-- ---------------------------------------------------------------------------

create or replace function public.tg_change_order_selection_member_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user <> 'authenticated' or not (old.metadata ? 'selection_change') then
    return new;
  end if;
  if new.requires_signature is distinct from old.requires_signature or new.days_impact is distinct from old.days_impact then
    raise exception 'A selection change order''s signature requirement and schedule impact are fixed as raised' using errcode = '42501';
  end if;
  if (new.status = 'approved' and old.status is distinct from 'approved')
     or (coalesce(new.lifecycle, 'draft') = 'approved' and coalesce(old.lifecycle, 'draft') <> 'approved') then
    if not public.has_org_permission(new.org_id, 'change_order.approve') then
      raise exception 'Approving a selection change order needs change_order.approve' using errcode = '42501';
    end if;
    if new.approved_by is distinct from (select auth.uid()) then
      raise exception 'An approval is recorded in the approver''s own name' using errcode = '42501';
    end if;
  elsif (new.approved_by, new.approved_at) is distinct from (old.approved_by, old.approved_at) then
    raise exception 'A selection change order''s approval is recorded only when it is approved' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.tg_change_order_selection_member_guard() from public, anon, authenticated;

drop trigger if exists change_orders_selection_member_guard on public.change_orders;
create trigger change_orders_selection_member_guard
  before update on public.change_orders
  for each row execute function public.tg_change_order_selection_member_guard();

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
  -- A signed-in member's approval needs the authority and their own name even
  -- when a guard on the change order did not run first.
  if coalesce((select auth.role()), '') = 'authenticated'
     and (not public.has_org_permission(new.org_id, 'change_order.approve') or new.approved_by is distinct from (select auth.uid())) then
    raise exception 'Approving a selection change order needs change_order.approve, in the approver''s own name' using errcode = '42501';
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

  -- (c) The budget, one line per cost delta. Where costs are coded, an
  -- uncoded delta fails the approval rather than posting an uncoded line.
  if exists (
    select 1 from jsonb_array_elements(v_deltas) d
    where nullif(d->>'cost_code_id', '') is null
  ) and (
    select coalesce(pfs.cost_codes_enabled, nullif(os.settings->>'cost_codes_enabled', '')::boolean, true)
    from (select 1) one
    left join public.project_financial_settings pfs on pfs.org_id = new.org_id and pfs.project_id = new.project_id
    left join public.org_settings os on os.org_id = new.org_id
  ) then
    raise exception 'A cost change on this selection change order has no cost code; code the option and raise the change order again'
      using detail = 'SELECTION_COST_CODE_REQUIRED';
  end if;
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

-- ---------------------------------------------------------------------------
-- 2. A selection stays in its group.
-- ---------------------------------------------------------------------------

-- Whether a group still takes changes, in the community's day. Callable by a
-- signed-in member so the write guard can ask it; it reveals one boolean about
-- a home the caller can already read.
create or replace function public.project_selection_group_is_open(p_org_id uuid, p_project_id uuid, p_group_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select g.status = 'open' and (g.cutoff_date is null or g.cutoff_date >= public.project_selection_today(p_org_id, p_project_id))
    from public.project_selection_groups g
    where g.org_id = p_org_id and g.project_id = p_project_id and g.group_id = p_group_id
  ), true)
$$;

revoke all on function public.project_selection_group_is_open(uuid, uuid, uuid) from public, anon;
grant execute on function public.project_selection_group_is_open(uuid, uuid, uuid) to authenticated, service_role;

create or replace function public.tg_project_selections_member_write_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_group uuid;
begin
  if current_user <> 'authenticated' then
    return coalesce(new, old);
  end if;
  if tg_op = 'DELETE' then
    if old.status <> 'pending' then
      raise exception 'A % selection is kept; change it through the selection service', old.status using errcode = '42501';
    end if;
    if not public.has_org_permission(old.org_id, 'selections.write') then
      raise exception 'Withdrawing a selection needs selections.write' using errcode = '42501';
    end if;
    if old.locked_at is not null
       or (old.group_id is not null and not public.project_selection_group_is_open(old.org_id, old.project_id, old.group_id)) then
      raise exception 'This selection''s group is closed; it is kept' using errcode = '42501';
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
    if not public.has_org_permission(new.org_id, 'selections.write') then
      raise exception 'Opening a selection needs selections.write' using errcode = '42501';
    end if;
    select g.group_id into v_group
    from public.project_selection_groups g
    join public.selection_group_categories c on c.org_id = g.org_id and c.group_id = g.group_id
    where g.org_id = new.org_id and g.project_id = new.project_id and c.category_id = new.category_id
    order by g.group_id
    limit 1;
    if new.group_id is distinct from v_group then
      raise exception 'A selection belongs to the deadline group its category is in on this home' using errcode = '42501';
    end if;
    if v_group is not null and not public.project_selection_group_is_open(new.org_id, new.project_id, v_group) then
      raise exception 'This selection''s group is closed; a new choice needs a change order' using errcode = '42501';
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

drop policy if exists project_selections_access on public.project_selections;
drop policy if exists project_selections_select on public.project_selections;
drop policy if exists project_selections_write on public.project_selections;
create policy project_selections_select on public.project_selections
  for select to authenticated
  using (public.is_org_member(org_id) and (project_id is null or public.is_project_member(project_id) or public.is_org_admin_member(org_id)));
create policy project_selections_write on public.project_selections
  for all to authenticated
  using (
    public.is_org_member(org_id) and public.has_org_permission(org_id, 'selections.write')
    and (project_id is null or public.is_project_member(project_id) or public.is_org_admin_member(org_id))
  )
  with check (
    public.is_org_member(org_id) and public.has_org_permission(org_id, 'selections.write')
    and (project_id is null or public.is_project_member(project_id) or public.is_org_admin_member(org_id))
  );

-- ---------------------------------------------------------------------------
-- 3. A schedule impact is the system's.
-- ---------------------------------------------------------------------------

create or replace function public.tg_schedule_item_change_order_member_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user <> 'authenticated' then
    return coalesce(new, old);
  end if;
  raise exception 'A schedule impact is recorded by a change order''s approval and applied by the superintendent, never written directly' using errcode = '42501';
end;
$$;

revoke all on function public.tg_schedule_item_change_order_member_guard() from public, anon, authenticated;

drop trigger if exists schedule_item_change_orders_member_guard on public.schedule_item_change_orders;
create trigger schedule_item_change_orders_member_guard
  before insert or update or delete on public.schedule_item_change_orders
  for each row execute function public.tg_schedule_item_change_order_member_guard();

drop policy if exists "Org members can insert schedule CO impacts" on public.schedule_item_change_orders;
drop policy if exists "Org members can update schedule CO impacts" on public.schedule_item_change_orders;
drop policy if exists "Org members can delete schedule CO impacts" on public.schedule_item_change_orders;

-- ---------------------------------------------------------------------------
-- 4. The reminder's day is the community's.
-- ---------------------------------------------------------------------------

create or replace function public.selection_cutoff_reminder_groups(p_days integer[], p_limit integer)
returns table (
  id uuid, org_id uuid, project_id uuid, group_id uuid, cutoff_date date, metadata jsonb,
  days_remaining integer, group_name text, project_name text
)
language sql
stable
security definer
set search_path = ''
as $$
  select g.id, g.org_id, g.project_id, g.group_id, g.cutoff_date, g.metadata,
    (g.cutoff_date - public.project_selection_today(g.org_id, g.project_id))::integer,
    sg.name, p.name
  from public.project_selection_groups g
  join public.selection_groups sg on sg.id = g.group_id
  join public.projects p on p.id = g.project_id and p.org_id = g.org_id
  where g.status = 'open'
    -- No zone is more than a day from UTC, so this bounds the candidates.
    and g.cutoff_date between (now() at time zone 'UTC')::date - 1 and (now() at time zone 'UTC')::date + (select coalesce(max(d), 0) from unnest(p_days) d) + 1
    and (g.cutoff_date - public.project_selection_today(g.org_id, g.project_id))::integer = any(p_days)
  order by g.cutoff_date, g.id
  limit greatest(coalesce(p_limit, 1000), 1)
$$;

revoke all on function public.selection_cutoff_reminder_groups(integer[], integer) from public, anon, authenticated;
grant execute on function public.selection_cutoff_reminder_groups(integer[], integer) to service_role;
