-- PO generation, review round 1.
--
-- 1. Progressed orders. The reconcile treated only 'sent' and 'approved' as
--    progressed, but purchase orders are draft / approved / complete / canceled:
--    a complete order with no bill yet was stripped of its lines and re-ordered
--    as a new draft, and canceled orders still counted as live lines and as
--    budget. Now anything that is not a draft and not canceled is progressed
--    (never rewritten, reported when it would price differently) and canceled
--    orders are not live.
-- 2. The same reconcile is readable without writing
--    (po_generation_reconcile_report), so a preview can show which orders in
--    progress would price differently, which lines are orphaned, and how many
--    changes a commit would make. An identical commit is "already generated"
--    only when that report finds nothing to repair, so a draft a member deleted
--    is re-created instead of the last run being trusted.
-- 3. Exceptions are reconciled: a generation that orders a line closes that
--    line's open exception, a dismissed exception is not raised again for the
--    same reason, and one open exception per source line is enforced by a
--    unique index (duplicates are closed first).
-- 4. PO numbers are never given twice: each run records the highest number it
--    assigned, and the next number continues past it even when that order was
--    deleted.
--
-- Supersedes run_po_generation_commit from 20261015110000_po_generation_reconcile.
-- Provenance (metadata.source / source_ref on orders and lines) is what
-- reconciliation reads; it is written only here and by the starts release.
-- Keeping members from rewriting it on an issued order is the approved-PO lock.

set local lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- 1. One open exception per source line.
-- ---------------------------------------------------------------------------

update public.po_generation_exceptions e set status = 'dismissed',
  resolution = jsonb_build_object('note', 'Duplicate of an exception already open for this line'), resolved_at = now()
where e.status = 'open' and exists (
  select 1 from public.po_generation_exceptions o
  where o.org_id = e.org_id and o.project_id = e.project_id and o.source_kind = e.source_kind
    and o.source_ref = e.source_ref and o.status = 'open'
    and (o.created_at, o.id) < (e.created_at, e.id));

create unique index if not exists po_generation_exceptions_open_source_uidx
  on public.po_generation_exceptions (org_id, project_id, source_kind, source_ref)
  where status = 'open';

-- ---------------------------------------------------------------------------
-- 2. The reconcile, read-only.
-- ---------------------------------------------------------------------------

-- What committing these lines would do to the house, without doing it. `changes`
-- counts lines that would be created, replaced or removed; orders in progress
-- are never counted, only reported.
create or replace function public.po_generation_reconcile_report(
  p_org_id uuid,
  p_project_id uuid,
  p_lines jsonb,
  p_scope text[]
) returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with desired as (
    select (v.value->>'source_kind') || ':' || (v.value->>'source_id') as k,
      (v.value->>'company_id')::uuid as company_id,
      nullif(v.value->>'cost_code_id', '')::uuid as cost_code_id,
      v.value->>'description' as description,
      (v.value->>'quantity')::numeric as quantity,
      v.value->>'unit' as unit,
      (v.value->>'unit_cost_cents')::integer as unit_cost_cents,
      (v.value->>'total_cents')::integer as cents,
      v.value->>'agreement_id' as agreement_id,
      nullif(v.value->>'scope_text', '') as scope_text
    from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) v
    where p_scope is null or (v.value->>'source_kind') || ':' || (v.value->>'source_id') = any (p_scope)
  ), live as (
    select (cl.metadata->>'source') || ':' || (cl.metadata->>'source_ref') as k,
      cl.id as line_id, cl.commitment_id, c.company_id, c.contract_number, cl.description,
      cl.cost_code_id, cl.quantity, cl.unit, cl.unit_cost_cents,
      coalesce(cl.scheduled_value_cents, 0) as cents, cl.metadata,
      (c.status not in ('draft', 'canceled') or exists (
        select 1 from public.vendor_bills vb where vb.org_id = p_org_id and vb.commitment_id = c.id)) as progressed
    from public.commitment_lines cl
    join public.commitments c on c.id = cl.commitment_id and c.org_id = cl.org_id
    where cl.org_id = p_org_id and c.project_id = p_project_id
      and c.commitment_type = 'purchase_order' and c.metadata->>'source' = 'po_generation'
      and c.status <> 'canceled'
      and cl.metadata->>'source' is not null and cl.metadata->>'source_ref' is not null
  ), judged as (
    select d.k, d.company_id, d.cents,
      (select count(*) from live l where l.k = d.k and not l.progressed) as drafts,
      pl.line_id is not null as has_progressed,
      fd.line_id is not null as has_draft,
      pl.commitment_id as p_commitment_id, pl.contract_number as p_number, pl.description as p_description,
      pl.company_id as p_company_id, pl.cents as p_cents,
      (fd.line_id is not null
        and fd.company_id is not distinct from d.company_id
        and fd.cost_code_id is not distinct from d.cost_code_id
        and fd.description = d.description
        and fd.quantity = d.quantity
        and fd.unit is not distinct from d.unit
        and fd.unit_cost_cents is not distinct from d.unit_cost_cents
        and fd.cents = d.cents
        and fd.metadata->>'source_agreement_id' is not distinct from d.agreement_id
        and nullif(fd.metadata->>'scope_text', '') is not distinct from d.scope_text) as draft_unchanged
    from desired d
    left join lateral (select * from live l where l.k = d.k and l.progressed order by l.line_id limit 1) pl on true
    left join lateral (select * from live l where l.k = d.k and not l.progressed order by l.line_id limit 1) fd on true
  ), orphans as (
    select l.* from live l
    where p_scope is null and l.k <> all (coalesce((select array_agg(d.k) from desired d), '{}'::text[]))
  )
  select jsonb_build_object(
    'changes',
      (select count(*) from judged where not has_progressed and not has_draft)
      + (select count(*) from judged where not has_progressed and has_draft and not draft_unchanged)
      + (select coalesce(sum(case when has_progressed then drafts when drafts > 1 then drafts - 1 else 0 end), 0) from judged)
      + (select count(*) from orphans where not progressed),
    'preserved_changed', coalesce((
      select jsonb_agg(jsonb_build_object(
        'source_key', k, 'commitment_id', p_commitment_id, 'contract_number', p_number, 'description', p_description,
        'was_company_id', p_company_id, 'now_company_id', company_id, 'was_cents', p_cents, 'now_cents', cents) order by k)
      from judged where has_progressed and (p_company_id is distinct from company_id or p_cents <> cents)), '[]'::jsonb),
    'preserved_orphaned', coalesce((
      select jsonb_agg(jsonb_build_object(
        'source_key', k, 'commitment_id', commitment_id, 'contract_number', contract_number,
        'description', description, 'company_id', company_id, 'cents', cents) order by k, line_id)
      from orphans where progressed), '[]'::jsonb)
  );
$$;

revoke all on function public.po_generation_reconcile_report(uuid, uuid, jsonb, text[]) from public, anon, authenticated;
grant execute on function public.po_generation_reconcile_report(uuid, uuid, jsonb, text[]) to service_role;

-- ---------------------------------------------------------------------------
-- 3. The commit.
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
  v_floor integer;
  v_last_number integer := 0;
  v_report jsonb;
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
    -- ...unless a member deleted a draft order since: then the house is
    -- repaired from the same lines instead of trusting the last run.
    if v_latest.id is not null and v_latest.input_fingerprint = v_run.input_fingerprint
      and (public.po_generation_reconcile_report(p_org_id, v_run.project_id, p_payload->'lines', null)->>'changes')::integer = 0 then
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

  -- A number once given is never given again, even when its order was deleted:
  -- every run records the highest number it assigned.
  select coalesce(max((summary->>'last_po_number')::integer), 0) into v_floor
    from public.po_generation_runs
    where org_id = p_org_id and project_id = v_run.project_id and summary ? 'last_po_number';

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
        (c.status not in ('draft', 'canceled') or exists (
          select 1 from public.vendor_bills vb where vb.org_id = p_org_id and vb.commitment_id = c.id
        )) as progressed
      from public.commitment_lines cl
      join public.commitments c on c.id = cl.commitment_id and c.org_id = cl.org_id
      where cl.org_id = p_org_id and c.project_id = v_run.project_id
        and c.commitment_type = 'purchase_order' and c.metadata->>'source' = 'po_generation'
        and c.status <> 'canceled'
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
        select greatest(coalesce(max(substring(contract_number from '-([0-9]+)$')::integer), 0), v_floor, v_last_number) + 1 into v_number
          from public.commitments
          where org_id = p_org_id and project_id = v_run.project_id and metadata->>'source' = 'po_generation';
        v_last_number := v_number;
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
        (c.status not in ('draft', 'canceled') or exists (
          select 1 from public.vendor_bills vb where vb.org_id = p_org_id and vb.commitment_id = c.id
        )) as progressed
      from public.commitment_lines cl
      join public.commitments c on c.id = cl.commitment_id and c.org_id = cl.org_id
      where cl.org_id = p_org_id and c.project_id = v_run.project_id
        and c.commitment_type = 'purchase_order' and c.metadata->>'source' = 'po_generation'
        and c.status <> 'canceled'
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
          and c.status <> 'canceled'
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
      and c.status <> 'canceled'
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
    -- An exception whose line is now ordered is closed by the generation that
    -- ordered it; leaving it open would let a later resolution replace the order.
    update public.po_generation_exceptions set status = 'resolved_agreement',
      resolution = jsonb_build_object('kind', 'auto', 'note', 'Priced by a later generation'), resolved_at = now()
      where org_id = p_org_id and project_id = v_run.project_id and status = 'open'
        and source_kind || ':' || coalesce(source_ref->>'takeoff_line_id', source_ref->>'project_selection_id', '') = any (v_desired_keys);
    for v_exception in select value from jsonb_array_elements(coalesce(p_payload->'exceptions', '[]'::jsonb))
    loop
      -- A dismissed exception stays dismissed while it would be raised for the same reason.
      continue when exists (
        select 1 from public.po_generation_exceptions x
        where x.org_id = p_org_id and x.project_id = v_run.project_id and x.status = 'dismissed'
          and x.source_kind = v_exception->>'source_kind'
          and x.source_ref = coalesce(v_exception->'source_ref', '{}'::jsonb)
          and x.reason = v_exception->>'reason');
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
      ) on conflict do nothing;
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
      'budget_editable', v_budget_editable,
      'last_po_number', greatest(v_floor, v_last_number, (
        select coalesce(max(substring(contract_number from '-([0-9]+)$')::integer), 0)
        from public.commitments
        where org_id = p_org_id and project_id = v_run.project_id and metadata->>'source' = 'po_generation'))
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
