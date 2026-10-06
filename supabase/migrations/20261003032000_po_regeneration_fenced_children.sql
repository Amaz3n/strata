-- STAGED, UNAPPLIED. Preserve starts ancestry fences during PO regeneration.
-- Replaces the existing serialized commit RPC; claim consumers remain inactive.
-- Restrict source-run probes/locks to the generated set at national scale.
create index commitments_generation_run_idx on public.commitments
  (org_id,(metadata->>'source_generation_run_id'),id)
  where metadata->>'source_generation_run_id' is not null;
create index budgets_generation_run_idx on public.budgets
  (org_id,(metadata->>'source_generation_run_id'),id)
  where metadata->>'source_generation_run_id' is not null;

create or replace function public.run_po_generation_commit(
  p_org_id uuid,
  p_run_id uuid,
  p_payload jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_run public.po_generation_runs%rowtype;
  v_project_id uuid;
  v_worker_package public.start_packages%rowtype;
  v_prior_run_id uuid;
  v_prior_run public.po_generation_runs%rowtype;
  v_budget_id uuid;
  v_budget_version integer;
  v_budget_line jsonb;
  v_po jsonb;
  v_line jsonb;
  v_commitment_id uuid;
  v_budget_line_id uuid;
  v_commitment_ids uuid[] := '{}';
  v_exception jsonb;
begin
  -- All starts writes take job/package locks before domain row locks. Taking
  -- run locks first would invert the trigger's ownership lock order.
  v_worker_package:=public.lock_starts_release_write_scope(p_org_id);
  select project_id into v_project_id from public.po_generation_runs
    where org_id=p_org_id and id=p_run_id;
  if not found then raise exception 'PO generation run is not commit-ready'; end if;
  if v_worker_package.id is not null
    and v_worker_package.project_id is distinct from v_project_id then
    raise exception 'Starts worker project mismatch' using errcode='42501';
  end if;

  -- Serialize before locking either run. Otherwise competing requests can
  -- hold each other's new/prior run while waiting for this project lock.
  perform pg_advisory_xact_lock(hashtextextended(p_org_id::text || ':' || v_project_id::text, 0));
  select * into v_run from public.po_generation_runs
    where org_id=p_org_id and id=p_run_id for update;
  if not found or v_run.mode<>'commit' or v_run.status<>'running'
    or v_run.project_id is distinct from v_project_id then
    raise exception 'PO generation run is not commit-ready';
  end if;
  if v_worker_package.id is not null
    and v_worker_package.lot_id is distinct from v_run.lot_id then
    raise exception 'Starts worker lot mismatch' using errcode='42501';
  end if;

  v_prior_run_id := nullif(p_payload->>'prior_run_id', '')::uuid;
  if v_prior_run_id is not null then
    select * into v_prior_run from public.po_generation_runs
      where org_id=p_org_id and id=v_prior_run_id for update;
    if not found or v_prior_run.id=v_run.id
      or v_prior_run.project_id is distinct from v_run.project_id
      or v_prior_run.lot_id is distinct from v_run.lot_id
      or v_prior_run.mode<>'commit'
      or v_prior_run.status not in ('succeeded','succeeded_with_exceptions') then
      raise exception 'Prior PO generation run is not replaceable for this home';
    end if;
    -- Lock the records before checking status/bills, retaining these locks
    -- through replacement. Approval updates and bill FK key-share acquisition
    -- must finish before the check or wait until the replacement commits.
    perform 1 from public.commitments where org_id=p_org_id
      and metadata->>'source_generation_run_id'=v_prior_run_id::text
      order by id for update;
    perform 1 from public.budgets where org_id=p_org_id
      and metadata->>'source_generation_run_id'=v_prior_run_id::text
      order by id for update;
    if exists (select 1 from public.commitments where org_id=p_org_id
        and metadata->>'source_generation_run_id'=v_prior_run_id::text
        and project_id is distinct from v_run.project_id)
      or exists (select 1 from public.budgets where org_id=p_org_id
        and metadata->>'source_generation_run_id'=v_prior_run_id::text
        and project_id is distinct from v_run.project_id) then
      raise exception 'Prior PO generation artifacts belong to another home';
    end if;
    if exists (
      select 1 from public.commitments c
      where c.org_id = p_org_id
        and c.metadata->>'source_generation_run_id' = v_prior_run_id::text
        and (c.status <> 'draft' or exists (
          select 1 from public.vendor_bills vb
          where vb.org_id = p_org_id and vb.commitment_id = c.id
        ))
    ) then
      raise exception 'Generated purchase orders have progressed; use the VPO workflow';
    end if;
    -- Delete fenced children while their parent still exists. FK cascades run
    -- after the parent is gone and cannot establish ownership from ancestry.
    delete from public.commitment_lines cl using public.commitments c
      where cl.org_id=p_org_id and c.org_id=p_org_id and cl.commitment_id=c.id
        and c.metadata->>'source_generation_run_id'=v_prior_run_id::text;
    delete from public.commitments where org_id = p_org_id
      and metadata->>'source_generation_run_id' = v_prior_run_id::text;
    delete from public.budget_lines bl using public.budgets b
      where bl.org_id=p_org_id and b.org_id=p_org_id and bl.budget_id=b.id
        and b.metadata->>'source_generation_run_id'=v_prior_run_id::text;
    delete from public.budgets where org_id = p_org_id
      and metadata->>'source_generation_run_id' = v_prior_run_id::text;
    update public.po_generation_runs set status = 'superseded', completed_at = now()
      where org_id = p_org_id and id = v_prior_run_id;
  end if;

  select coalesce(max(version), 0) + 1 into v_budget_version
  from public.budgets where org_id = p_org_id and project_id = v_run.project_id;
  insert into public.budgets (org_id, project_id, version, status, total_cents, metadata)
  values (
    p_org_id, v_run.project_id, v_budget_version, 'draft',
    coalesce((p_payload->>'total_cents')::integer, 0),
    jsonb_build_object('source', 'po_generation', 'source_generation_run_id', p_run_id)
  ) returning id into v_budget_id;

  for v_budget_line in select value from jsonb_array_elements(coalesce(p_payload->'budget_lines', '[]'))
  loop
    insert into public.budget_lines (
      org_id, budget_id, cost_code_id, description, amount_cents, sort_order, cost_type, metadata
    ) values (
      p_org_id, v_budget_id, nullif(v_budget_line->>'cost_code_id', '')::uuid,
      v_budget_line->>'description', (v_budget_line->>'amount_cents')::integer,
      coalesce((v_budget_line->>'sort_order')::integer, 0),
      nullif(v_budget_line->>'cost_type', '')::public.cost_type,
      jsonb_build_object('source', 'po_generation', 'source_generation_run_id', p_run_id)
    );
  end loop;

  for v_po in select value from jsonb_array_elements(coalesce(p_payload->'purchase_orders', '[]'))
  loop
    insert into public.commitments (
      org_id, project_id, company_id, title, status, total_cents, currency,
      contract_number, scope, issued_at, commitment_type, metadata
    ) values (
      p_org_id, v_run.project_id, (v_po->>'company_id')::uuid, v_po->>'title', 'draft',
      (v_po->>'total_cents')::integer, 'usd', nullif(v_po->>'contract_number', ''),
      nullif(v_po->>'scope', ''), now(), 'purchase_order',
      jsonb_build_object(
        'source', 'po_generation',
        'source_generation_run_id', p_run_id,
        'source_agreement_ids', coalesce(v_po->'source_agreement_ids', '[]'::jsonb)
      )
    ) returning id into v_commitment_id;
    v_commitment_ids := array_append(v_commitment_ids, v_commitment_id);

    insert into public.project_vendors (org_id, project_id, company_id, role, scope, status, notes)
    values (
      p_org_id, v_run.project_id, (v_po->>'company_id')::uuid, 'subcontractor',
      nullif(v_po->>'scope', ''), 'active', concat('Generated from PO run ', p_run_id::text)
    )
    on conflict (project_id, company_id) do update set
      status = 'active',
      scope = coalesce(public.project_vendors.scope, excluded.scope),
      notes = coalesce(public.project_vendors.notes, excluded.notes);

    for v_line in select value from jsonb_array_elements(coalesce(v_po->'lines', '[]'))
    loop
      select bl.id into v_budget_line_id from public.budget_lines bl
      where bl.org_id = p_org_id and bl.budget_id = v_budget_id
        and bl.cost_code_id is not distinct from nullif(v_line->>'cost_code_id', '')::uuid
        and bl.cost_type is not distinct from nullif(v_line->>'cost_type', '')::public.cost_type
      order by bl.sort_order limit 1;

      insert into public.commitment_lines (
        org_id, commitment_id, cost_code_id, budget_line_id, description,
        quantity, unit, unit_cost_cents, scheduled_value_cents, sort_order, metadata
      ) values (
        p_org_id, v_commitment_id, nullif(v_line->>'cost_code_id', '')::uuid,
        v_budget_line_id, v_line->>'description', (v_line->>'quantity')::numeric,
        v_line->>'unit', (v_line->>'unit_cost_cents')::integer,
        (v_line->>'total_cents')::integer, coalesce((v_line->>'sort_order')::integer, 0),
        coalesce(v_line->'metadata', '{}'::jsonb) || jsonb_build_object(
          'source_generation_run_id', p_run_id,
          'source_agreement_id', v_line->>'source_agreement_id'
        )
      );
    end loop;
  end loop;

  for v_exception in select value from jsonb_array_elements(coalesce(p_payload->'exceptions', '[]'))
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

  -- The payload only carries exceptions that are not already open for the same
  -- source line, so the run's status comes from the summary's true count rather
  -- than from how many rows this run happened to need to insert.
  update public.po_generation_runs set
    status = case when coalesce(
        (p_payload->'summary'->>'exception_count')::integer,
        jsonb_array_length(coalesce(p_payload->'exceptions', '[]'))
      ) > 0
      then 'succeeded_with_exceptions' else 'succeeded' end,
    summary = coalesce(p_payload->'summary', '{}'::jsonb), completed_at = now()
  where org_id = p_org_id and id = p_run_id;

  return jsonb_build_object('run_id', p_run_id, 'budget_id', v_budget_id,
    'commitment_ids', to_jsonb(v_commitment_ids));
end;
$$;

revoke all on function public.run_po_generation_commit(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.run_po_generation_commit(uuid, uuid, jsonb) to service_role;
