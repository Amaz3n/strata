-- PO generation: one living generation per house, reconciled per source line.
--
-- EP08-06 / EP08-07. Three defects in how generated purchase orders were
-- written:
--
-- 1. Any org member could write po_generation_runs and po_generation_exceptions
--    through the data API (a permissive ALL policy on is_org_member). A forged
--    `resolved_manual` exception is read by the next generation as a
--    vendor-and-price override, and a forged succeeded commit run blocks the
--    real commit or makes it return "already generated". Both tables are now
--    read-only to signed-in members; the service writes them after it has
--    authorized the caller.
--
-- 2. A regeneration replaced only the LATEST run's artifacts and refused the
--    whole regeneration the moment any of those orders had been approved or
--    billed. After one scoped exception resolution the latest run was the
--    scoped one, so the earlier runs' orders stayed and every line was ordered
--    twice. run_po_generation_commit now reconciles per source line across
--    every run of the house: a line with no order is created, a line on an
--    order that is still a draft is replaced in place, and a line on an order
--    that has been sent, approved or billed is never touched -- when its vendor
--    or amount would now differ it is reported back (`preserved_changed`) so
--    purchasing raises a variance order instead of being told "no". Draft
--    artifacts of every prior run are replaced together, so nothing is
--    ordered twice.
--
-- 3. Every scoped resolution wrote a whole new budget version, so one house
--    carried several "generated" draft budgets and no single one carried all
--    its commitments. The commit now keeps ONE living draft budget per house
--    and rewrites its lines from the commitment lines themselves (generated
--    plus preserved), so budget lines always equal what is committed. A
--    budget that is no longer a draft is not edited; it is reported.
--
-- Also here: order numbers are assigned under the project lock, an exception
-- is marked resolved in the same transaction that creates its order, and an
-- identical commit that loses a race returns the run that won instead of
-- failing. Generated orders are no longer stamped issued at insert (a draft is
-- not issued). Nothing about orders that are not generated is touched.
--
-- Supersedes run_po_generation_commit from
-- 20261010111000_po_generation_commit_rejects_stale_prior_run. The payload is
-- the full desired line set (not pre-grouped purchase orders and budget
-- lines); `prior_run_id` stays as an optimistic guard on a whole-house
-- commit. service_role only, as before.
--
-- RBAC: no new keys. po.generate and po_exception.resolve are unchanged.

set local lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- 1. Runs and exceptions are written by the service, read by members.
-- ---------------------------------------------------------------------------

create or replace function public.tg_po_generation_member_write_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user <> 'authenticated' then
    return coalesce(new, old);
  end if;
  raise exception 'Purchase order generation is written by the generation service' using errcode = '42501';
end;
$$;

revoke all on function public.tg_po_generation_member_write_guard() from public, anon, authenticated;

drop trigger if exists po_generation_runs_member_write_guard on public.po_generation_runs;
create trigger po_generation_runs_member_write_guard
  before insert or update or delete on public.po_generation_runs
  for each row execute function public.tg_po_generation_member_write_guard();

drop trigger if exists po_generation_exceptions_member_write_guard on public.po_generation_exceptions;
create trigger po_generation_exceptions_member_write_guard
  before insert or update or delete on public.po_generation_exceptions
  for each row execute function public.tg_po_generation_member_write_guard();

drop policy if exists po_generation_runs_org_access on public.po_generation_runs;
drop policy if exists po_generation_runs_read on public.po_generation_runs;
create policy po_generation_runs_read on public.po_generation_runs
  for select
  to authenticated
  using (public.is_org_member(org_id));

drop policy if exists po_generation_exceptions_org_access on public.po_generation_exceptions;
drop policy if exists po_generation_exceptions_read on public.po_generation_exceptions;
create policy po_generation_exceptions_read on public.po_generation_exceptions
  for select
  to authenticated
  using (public.is_org_member(org_id));

revoke insert, update, delete, truncate on table public.po_generation_runs from anon, authenticated;
revoke insert, update, delete, truncate on table public.po_generation_exceptions from anon, authenticated;
grant select on table public.po_generation_runs to authenticated;
grant select on table public.po_generation_exceptions to authenticated;

-- ---------------------------------------------------------------------------
-- 2. The commit.
-- ---------------------------------------------------------------------------

create or replace function public.run_po_generation_commit(
  p_org_id uuid,
  p_run_id uuid,
  p_payload jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.po_generation_runs%rowtype;
  v_project_id uuid;
  v_worker_package public.start_packages%rowtype;
  v_latest public.po_generation_runs%rowtype;
  v_scope text[];
  v_full boolean;
  v_resolve jsonb;
  v_prefix text := nullif(p_payload->>'po_number_prefix', '');
  v_line jsonb;
  v_meta jsonb;
  v_key text;
  v_company uuid;
  v_desired_keys text[] := '{}';
  v_existing record;
  v_progressed record;
  v_has_progressed boolean;
  v_first_draft record;
  v_has_draft boolean;
  v_draft_ids uuid[];
  v_po_id uuid;
  v_number integer;
  v_touched uuid[] := '{}';
  v_commitment_ids uuid[] := '{}';
  v_created integer := 0;
  v_replaced integer := 0;
  v_removed integer := 0;
  v_preserved integer := 0;
  v_preserved_changed jsonb := '[]'::jsonb;
  v_preserved_orphaned jsonb := '[]'::jsonb;
  v_orphan record;
  v_budget public.budgets%rowtype;
  v_budget_editable boolean;
  v_kept uuid[] := '{}';
  v_group record;
  v_budget_line_id uuid;
  v_budget_total bigint := 0;
  v_budget_line_count integer := 0;
  v_exception jsonb;
  v_exception_count integer;
  v_unchanged boolean;
begin
  -- All starts writes take job/package locks before domain row locks. Taking
  -- run locks first would invert the trigger's ownership lock order.
  v_worker_package := public.lock_starts_release_write_scope(p_org_id);
  select project_id into v_project_id from public.po_generation_runs
    where org_id = p_org_id and id = p_run_id;
  if not found then raise exception 'PO generation run is not commit-ready'; end if;
  if v_worker_package.id is not null
    and v_worker_package.project_id is distinct from v_project_id then
    raise exception 'Starts worker project mismatch' using errcode = '42501';
  end if;

  -- Serialize before locking the run. Every commit, scoped resolution,
  -- approval-vs-regeneration decision and number assignment for a house waits
  -- here, so what follows sees a settled house.
  perform pg_advisory_xact_lock(hashtextextended(p_org_id::text || ':' || v_project_id::text, 0));
  select * into v_run from public.po_generation_runs
    where org_id = p_org_id and id = p_run_id for update;
  if not found or v_run.mode <> 'commit' or v_run.status <> 'running'
    or v_run.project_id is distinct from v_project_id then
    raise exception 'PO generation run is not commit-ready';
  end if;
  if v_worker_package.id is not null
    and v_worker_package.lot_id is distinct from v_run.lot_id then
    raise exception 'Starts worker lot mismatch' using errcode = '42501';
  end if;

  if jsonb_typeof(p_payload->'scope_source_keys') = 'array' then
    v_scope := array(select jsonb_array_elements_text(p_payload->'scope_source_keys'));
  end if;
  v_full := v_scope is null;

  -- A resolution that lost the race to another resolution or a dismissal
  -- creates nothing and says so; the caller turns it into a plain refusal.
  v_resolve := case when jsonb_typeof(p_payload->'resolve_exception') = 'object' then p_payload->'resolve_exception' end;
  if v_resolve is not null then
    perform 1 from public.po_generation_exceptions
      where org_id = p_org_id and project_id = v_run.project_id
        and id = (v_resolve->>'id')::uuid and status = 'open'
      for update;
    if not found then
      update public.po_generation_runs set status = 'superseded', completed_at = now(),
        error = 'The exception was resolved or dismissed first'
        where org_id = p_org_id and id = p_run_id;
      return jsonb_build_object('run_id', p_run_id, 'refused', 'exception_closed');
    end if;
  end if;

  if v_full then
    select * into v_latest from public.po_generation_runs
      where org_id = p_org_id and project_id = v_run.project_id and id <> v_run.id
        and mode = 'commit' and status in ('succeeded', 'succeeded_with_exceptions')
      order by created_at desc, id desc limit 1;
    -- The same inputs were generated while this commit waited: that run is
    -- the answer, there is nothing left to do.
    if v_latest.id is not null and v_latest.input_fingerprint = v_run.input_fingerprint then
      update public.po_generation_runs set status = 'superseded', completed_at = now(),
        error = 'Identical purchase orders were generated by another request'
        where org_id = p_org_id and id = p_run_id;
      return jsonb_build_object('run_id', v_latest.id, 'already_generated', true);
    end if;
    if v_latest.id is distinct from nullif(p_payload->>'prior_run_id', '')::uuid then
      raise exception 'Purchase orders for this home were generated by another run since this one was prepared; preview again'
        using errcode = '40001';
    end if;
  end if;

  -- Orders and their bills settle before anything is judged: an approval or a
  -- bill that is mid-flight finishes first, or waits for this commit.
  perform 1 from public.commitments
    where org_id = p_org_id and project_id = v_run.project_id
      and commitment_type = 'purchase_order' and metadata->>'source' = 'po_generation'
    order by id for update;

  -- Reconcile each wanted line against every generated line of the house,
  -- whichever run wrote it.
  for v_line in select value from jsonb_array_elements(coalesce(p_payload->'lines', '[]'::jsonb))
  loop
    v_key := (v_line->>'source_kind') || ':' || (v_line->>'source_id');
    if not v_full and not (v_key = any(v_scope)) then continue; end if;
    if v_key = any(v_desired_keys) then continue; end if;
    v_desired_keys := array_append(v_desired_keys, v_key);

    v_company := (v_line->>'company_id')::uuid;
    perform 1 from public.companies where org_id = p_org_id and id = v_company;
    if not found then
      raise exception 'Purchase order vendor is not in this organization' using errcode = '42501';
    end if;

    v_meta := jsonb_build_object(
      'source', v_line->>'source_kind',
      'source_ref', v_line->>'source_id',
      'option_descriptor', v_line->'option_descriptor',
      'cost_type', nullif(v_line->>'cost_type', ''),
      'scope_text', nullif(v_line->>'scope_text', ''),
      'source_agreement_id', v_line->>'agreement_id'
    );

    v_has_progressed := false;
    v_has_draft := false;
    v_unchanged := false;
    v_draft_ids := '{}';
    for v_existing in
      select cl.id as line_id, cl.commitment_id, c.company_id, c.contract_number, c.status,
        cl.description, cl.cost_code_id, cl.quantity, cl.unit, cl.unit_cost_cents,
        coalesce(cl.scheduled_value_cents, 0) as cents, cl.metadata,
        (c.status in ('sent', 'approved') or exists (
          select 1 from public.vendor_bills vb where vb.org_id = p_org_id and vb.commitment_id = c.id
        )) as progressed
      from public.commitment_lines cl
      join public.commitments c on c.id = cl.commitment_id and c.org_id = cl.org_id
      where cl.org_id = p_org_id and c.project_id = v_run.project_id
        and c.commitment_type = 'purchase_order' and c.metadata->>'source' = 'po_generation'
        and c.status not in ('voided', 'rejected')
        and cl.metadata->>'source' = v_line->>'source_kind'
        and cl.metadata->>'source_ref' = v_line->>'source_id'
      order by progressed desc, cl.id
    loop
      if v_existing.progressed then
        if not v_has_progressed then
          v_has_progressed := true;
          v_progressed := v_existing;
        end if;
      else
        if not v_has_draft then
          v_has_draft := true;
          v_first_draft := v_existing;
        end if;
        v_draft_ids := array_append(v_draft_ids, v_existing.line_id);
      end if;
    end loop;

    if v_has_progressed then
      v_preserved := v_preserved + 1;
      if v_progressed.company_id is distinct from v_company
        or v_progressed.cents <> (v_line->>'total_cents')::integer then
        v_preserved_changed := v_preserved_changed || jsonb_build_array(jsonb_build_object(
          'source_key', v_key,
          'commitment_id', v_progressed.commitment_id,
          'contract_number', v_progressed.contract_number,
          'description', v_progressed.description,
          'was_company_id', v_progressed.company_id,
          'now_company_id', v_company,
          'was_cents', v_progressed.cents,
          'now_cents', (v_line->>'total_cents')::integer
        ));
      end if;
      -- Any draft copy beside an order already in progress is a double order.
    elsif v_has_draft then
      v_unchanged := v_first_draft.company_id is not distinct from v_company
        and v_first_draft.cost_code_id is not distinct from nullif(v_line->>'cost_code_id', '')::uuid
        and v_first_draft.description = (v_line->>'description')
        and v_first_draft.quantity = (v_line->>'quantity')::numeric
        and v_first_draft.unit is not distinct from (v_line->>'unit')
        and v_first_draft.unit_cost_cents is not distinct from (v_line->>'unit_cost_cents')::integer
        and v_first_draft.cents = (v_line->>'total_cents')::integer
        and (v_first_draft.metadata - 'source_generation_run_id') = v_meta;
      if v_unchanged then
        v_draft_ids := array_remove(v_draft_ids, v_first_draft.line_id);
      else
        v_replaced := v_replaced + 1;
      end if;
    end if;

    if cardinality(v_draft_ids) > 0 then
      v_touched := v_touched || array(
        select commitment_id from public.commitment_lines where org_id = p_org_id and id = any(v_draft_ids));
      delete from public.commitment_lines where org_id = p_org_id and id = any(v_draft_ids);
      v_removed := v_removed + cardinality(v_draft_ids);
    end if;

    if not v_has_progressed and not v_unchanged then
      select c.id into v_po_id from public.commitments c
        where c.org_id = p_org_id and c.project_id = v_run.project_id
          and c.commitment_type = 'purchase_order' and c.metadata->>'source' = 'po_generation'
          and c.company_id = v_company and c.status = 'draft'
          and not exists (select 1 from public.vendor_bills vb where vb.org_id = p_org_id and vb.commitment_id = c.id)
        order by c.created_at, c.id limit 1;
      if v_po_id is null then
        select coalesce(max(substring(contract_number from '-([0-9]+)$')::integer), 0) + 1 into v_number
          from public.commitments
          where org_id = p_org_id and project_id = v_run.project_id and metadata->>'source' = 'po_generation';
        insert into public.commitments (
          org_id, project_id, company_id, title, status, total_cents, currency,
          contract_number, commitment_type, metadata
        ) values (
          p_org_id, v_run.project_id, v_company,
          'PO — ' || coalesce(nullif(v_line->>'description', ''), nullif(p_payload->>'plan_name', ''), 'Trade')
            || ' — ' || coalesce(nullif(p_payload->>'lot_label', ''), 'Home'),
          'draft', 0, 'usd',
          case when v_prefix is null then null else v_prefix || '-' || lpad(v_number::text, 2, '0') end,
          'purchase_order',
          jsonb_build_object('source', 'po_generation')
        ) returning id into v_po_id;
        insert into public.project_vendors (org_id, project_id, company_id, role, scope, status, notes)
        values (
          p_org_id, v_run.project_id, v_company, 'subcontractor',
          nullif(v_line->>'scope_text', ''), 'active', concat('Generated from PO run ', p_run_id::text)
        )
        on conflict (project_id, company_id) do update set
          status = 'active',
          scope = coalesce(public.project_vendors.scope, excluded.scope),
          notes = coalesce(public.project_vendors.notes, excluded.notes);
      end if;
      insert into public.commitment_lines (
        org_id, commitment_id, cost_code_id, description, quantity, unit,
        unit_cost_cents, scheduled_value_cents, sort_order, metadata
      ) values (
        p_org_id, v_po_id, nullif(v_line->>'cost_code_id', '')::uuid, v_line->>'description',
        (v_line->>'quantity')::numeric, v_line->>'unit', (v_line->>'unit_cost_cents')::integer,
        (v_line->>'total_cents')::integer,
        (select count(*)::integer from public.commitment_lines where org_id = p_org_id and commitment_id = v_po_id),
        v_meta || jsonb_build_object('source_generation_run_id', p_run_id)
      );
      v_touched := array_append(v_touched, v_po_id);
      if not v_has_draft then v_created := v_created + 1; end if;
    end if;
  end loop;

  -- A whole-house commit also retires what is no longer wanted: draft lines
  -- go, lines on orders in progress stay and are reported.
  if v_full then
    for v_orphan in
      select cl.id as line_id, cl.commitment_id, c.contract_number, c.company_id,
        cl.description, coalesce(cl.scheduled_value_cents, 0) as cents,
        (cl.metadata->>'source') || ':' || (cl.metadata->>'source_ref') as source_key,
        (c.status in ('sent', 'approved') or exists (
          select 1 from public.vendor_bills vb where vb.org_id = p_org_id and vb.commitment_id = c.id
        )) as progressed
      from public.commitment_lines cl
      join public.commitments c on c.id = cl.commitment_id and c.org_id = cl.org_id
      where cl.org_id = p_org_id and c.project_id = v_run.project_id
        and c.commitment_type = 'purchase_order' and c.metadata->>'source' = 'po_generation'
        and c.status not in ('voided', 'rejected')
        and cl.metadata->>'source' is not null and cl.metadata->>'source_ref' is not null
        and (cl.metadata->>'source') || ':' || (cl.metadata->>'source_ref') <> all (v_desired_keys)
      order by cl.id
    loop
      if v_orphan.progressed then
        v_preserved_orphaned := v_preserved_orphaned || jsonb_build_array(jsonb_build_object(
          'source_key', v_orphan.source_key,
          'commitment_id', v_orphan.commitment_id,
          'contract_number', v_orphan.contract_number,
          'description', v_orphan.description,
          'company_id', v_orphan.company_id,
          'cents', v_orphan.cents
        ));
      else
        v_touched := array_append(v_touched, v_orphan.commitment_id);
        delete from public.commitment_lines where org_id = p_org_id and id = v_orphan.line_id;
        v_removed := v_removed + 1;
      end if;
    end loop;
  end if;

  -- Re-total every draft order that changed; an order left with no lines goes.
  for v_po_id in select distinct unnest(v_touched) loop
    if (select count(*) from public.commitment_lines where org_id = p_org_id and commitment_id = v_po_id) = 0 then
      delete from public.commitments where org_id = p_org_id and id = v_po_id and status = 'draft';
    else
      update public.commitments c set
        total_cents = (select coalesce(sum(coalesce(cl.scheduled_value_cents, 0)), 0)::integer
          from public.commitment_lines cl where cl.org_id = p_org_id and cl.commitment_id = c.id),
        scope = coalesce(nullif((select string_agg(cl.metadata->>'scope_text', E'\n' order by cl.sort_order, cl.id)
          from public.commitment_lines cl
          where cl.org_id = p_org_id and cl.commitment_id = c.id and coalesce(cl.metadata->>'scope_text', '') <> ''), ''), c.scope),
        metadata = c.metadata || jsonb_build_object(
          'source_generation_run_id', p_run_id,
          'source_agreement_ids', coalesce((select jsonb_agg(distinct cl.metadata->>'source_agreement_id')
            from public.commitment_lines cl
            where cl.org_id = p_org_id and cl.commitment_id = c.id and cl.metadata->>'source_agreement_id' is not null), '[]'::jsonb))
      where c.org_id = p_org_id and c.id = v_po_id and c.status = 'draft';
      v_commitment_ids := array_append(v_commitment_ids, v_po_id);
    end if;
  end loop;

  -- One living budget per house. Its lines are the commitment lines grouped by
  -- cost code and type, so the budget always equals what is committed.
  select * into v_budget from public.budgets
    where org_id = p_org_id and project_id = v_run.project_id and metadata->>'source' = 'po_generation'
    order by version desc, id desc limit 1
    for update;
  if not found then
    insert into public.budgets (org_id, project_id, version, status, total_cents, metadata)
    values (
      p_org_id, v_run.project_id,
      (select coalesce(max(version), 0) + 1 from public.budgets where org_id = p_org_id and project_id = v_run.project_id),
      'draft', 0, jsonb_build_object('source', 'po_generation', 'source_generation_run_id', p_run_id)
    ) returning * into v_budget;
  end if;
  v_budget_editable := v_budget.status = 'draft' and v_budget.baseline_locked_at is null;

  if v_budget_editable then
    for v_group in
      select g.cost_code_id, g.cost_type, g.description, g.amount,
        (row_number() over (order by g.cost_code_id, g.cost_type) - 1)::integer as sort_order
      from (
        select cl.cost_code_id,
          coalesce(cl.metadata->>'cost_type', obl.cost_type::text) as cost_type,
          (array_agg(cl.description order by cl.sort_order, cl.id))[1] as description,
          sum(coalesce(cl.scheduled_value_cents, 0)) as amount
        from public.commitment_lines cl
        join public.commitments c on c.id = cl.commitment_id and c.org_id = cl.org_id
        left join public.budget_lines obl on obl.id = cl.budget_line_id and obl.org_id = cl.org_id
        where cl.org_id = p_org_id and c.project_id = v_run.project_id
          and c.commitment_type = 'purchase_order' and c.metadata->>'source' = 'po_generation'
          and c.status not in ('voided', 'rejected')
        group by cl.cost_code_id, coalesce(cl.metadata->>'cost_type', obl.cost_type::text)
      ) g
      order by g.cost_code_id, g.cost_type
    loop
      select bl.id into v_budget_line_id from public.budget_lines bl
        where bl.org_id = p_org_id and bl.budget_id = v_budget.id
          and bl.cost_code_id is not distinct from v_group.cost_code_id
          and bl.cost_type::text is not distinct from v_group.cost_type
          and bl.metadata->>'source' = 'po_generation'
        order by bl.sort_order, bl.id limit 1;
      if v_budget_line_id is null then
        insert into public.budget_lines (
          org_id, budget_id, cost_code_id, description, amount_cents, sort_order, cost_type, metadata
        ) values (
          p_org_id, v_budget.id, v_group.cost_code_id, v_group.description, v_group.amount::integer,
          v_group.sort_order, v_group.cost_type::public.cost_type,
          jsonb_build_object('source', 'po_generation')
        ) returning id into v_budget_line_id;
      else
        update public.budget_lines set amount_cents = v_group.amount::integer,
          description = v_group.description, sort_order = v_group.sort_order
          where org_id = p_org_id and id = v_budget_line_id
            and (amount_cents is distinct from v_group.amount::integer
              or description is distinct from v_group.description
              or sort_order is distinct from v_group.sort_order);
      end if;
      v_kept := array_append(v_kept, v_budget_line_id);
      v_budget_total := v_budget_total + v_group.amount;
    end loop;
    v_budget_line_count := cardinality(v_kept);
  end if;

  -- Point every live generated line at the living budget's matching line.
  -- Lines on orders in progress move only when they are unlinked or sit on
  -- another budget; a line already on the living budget is never rewritten.
  with live as (
    select cl.id, cl.cost_code_id, cl.budget_line_id, c.status,
      coalesce(cl.metadata->>'cost_type', obl.cost_type::text) as cost_type,
      obl.budget_id as current_budget_id
    from public.commitment_lines cl
    join public.commitments c on c.id = cl.commitment_id and c.org_id = cl.org_id
    left join public.budget_lines obl on obl.id = cl.budget_line_id and obl.org_id = cl.org_id
    where cl.org_id = p_org_id and c.project_id = v_run.project_id
      and c.commitment_type = 'purchase_order' and c.metadata->>'source' = 'po_generation'
      and c.status not in ('voided', 'rejected')
  )
  update public.commitment_lines cl set budget_line_id = target.id
  from live
  join lateral (
    select bl.id from public.budget_lines bl
    where bl.org_id = p_org_id and bl.budget_id = v_budget.id
      and bl.cost_code_id is not distinct from live.cost_code_id
      and bl.cost_type::text is not distinct from live.cost_type
      and bl.metadata->>'source' = 'po_generation'
    order by bl.sort_order, bl.id limit 1
  ) target on true
  where cl.org_id = p_org_id and cl.id = live.id
    and cl.budget_line_id is distinct from target.id
    and (live.status = 'draft' or live.budget_line_id is null or live.current_budget_id is distinct from v_budget.id)
    and (v_budget_editable or live.budget_line_id is null);

  if v_budget_editable then
    delete from public.budget_lines
      where org_id = p_org_id and budget_id = v_budget.id
        and metadata->>'source' = 'po_generation' and id <> all (v_kept);
    update public.budgets set total_cents = v_budget_total::integer
      where org_id = p_org_id and id = v_budget.id and total_cents is distinct from v_budget_total::integer;
  end if;

  if v_full then
    for v_exception in select value from jsonb_array_elements(coalesce(p_payload->'exceptions', '[]'::jsonb))
    loop
      insert into public.po_generation_exceptions (
        org_id, run_id, project_id, cost_code_id, source_kind, source_ref,
        description, quantity, uom, reason, candidates
      ) values (
        p_org_id, p_run_id, v_run.project_id,
        nullif(v_exception->>'cost_code_id', '')::uuid,
        v_exception->>'source_kind', coalesce(v_exception->'source_ref', '{}'::jsonb),
        v_exception->>'description', nullif(v_exception->>'quantity', '')::numeric,
        nullif(v_exception->>'uom', ''), v_exception->>'reason',
        coalesce(v_exception->'candidates', '[]'::jsonb)
      );
    end loop;
  end if;

  if v_resolve is not null then
    update public.po_generation_exceptions set
      status = v_resolve->>'status', resolution = v_resolve->'resolution',
      resolved_by = nullif(v_resolve->>'resolved_by', '')::uuid, resolved_at = now()
      where org_id = p_org_id and id = (v_resolve->>'id')::uuid and status = 'open';
  end if;

  -- Older commit runs of the house are history now; only a whole-house
  -- commit retires them (a scoped one adds to the same generation).
  if v_full then
    update public.po_generation_runs set status = 'superseded', completed_at = coalesce(completed_at, now())
      where org_id = p_org_id and project_id = v_run.project_id and id <> p_run_id
        and mode = 'commit' and status in ('succeeded', 'succeeded_with_exceptions');
  end if;

  -- The payload only carries exceptions that are not already open for the same
  -- source line, so the run's status comes from the summary's true count.
  v_exception_count := coalesce(
    (p_payload->'summary'->>'exception_count')::integer,
    jsonb_array_length(coalesce(p_payload->'exceptions', '[]'::jsonb))
  );
  update public.po_generation_runs set
    status = case when v_exception_count > 0 then 'succeeded_with_exceptions' else 'succeeded' end,
    summary = coalesce(p_payload->'summary', '{}'::jsonb) || jsonb_build_object(
      'created_line_count', v_created,
      'replaced_line_count', v_replaced,
      'removed_line_count', v_removed,
      'preserved_line_count', v_preserved,
      'preserved_changed', v_preserved_changed,
      'preserved_orphaned', v_preserved_orphaned,
      'budget_id', v_budget.id,
      'budget_editable', v_budget_editable
    ),
    completed_at = now()
  where org_id = p_org_id and id = p_run_id;

  return jsonb_build_object(
    'run_id', p_run_id,
    'budget_id', v_budget.id,
    'budget_editable', v_budget_editable,
    'budget_line_count', v_budget_line_count,
    'commitment_ids', to_jsonb(v_commitment_ids),
    'created_line_count', v_created,
    'replaced_line_count', v_replaced,
    'removed_line_count', v_removed,
    'preserved_line_count', v_preserved,
    'preserved_changed', v_preserved_changed,
    'preserved_orphaned', v_preserved_orphaned
  );
end;
$$;

revoke all on function public.run_po_generation_commit(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.run_po_generation_commit(uuid, uuid, jsonb) to service_role;
