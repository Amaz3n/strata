-- Serialize PO generation and make generated PO numbers unique.
--
-- Idempotency was a read-then-write fingerprint comparison with no lock: two
-- simultaneous releases (retry storm, overlapping cron, a double-clicked button)
-- both saw no matching prior run and both committed a full PO set, and the
-- `prior_run_id` delete-and-recreate path had each one deleting the other's
-- commitments. The advisory lock below makes the check-then-commit atomic; the
-- fingerprint index is the backstop if a caller ever bypasses the check.
--
-- Numbers were `'PO-' || lot_number || '-' || index`, so Lot 42 in two
-- communities collided and a regeneration reissued numbers an approved PO
-- already carried. The service now builds community-qualified, sequence-suffixed
-- numbers; this index is what makes a collision fail loudly instead of silently.

create unique index if not exists po_generation_runs_commit_fingerprint_uidx
  on public.po_generation_runs (org_id, project_id, input_fingerprint)
  where mode = 'commit' and status in ('succeeded', 'succeeded_with_exceptions');

create unique index if not exists commitments_generated_po_number_uidx
  on public.commitments (org_id, contract_number)
  where contract_number is not null and metadata->>'source' = 'po_generation';

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
  v_prior_run_id uuid;
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
  select * into v_run from public.po_generation_runs
    where org_id = p_org_id and id = p_run_id for update;
  if not found or v_run.mode <> 'commit' or v_run.status <> 'running' then
    raise exception 'PO generation run is not commit-ready';
  end if;

  -- One committing run per project at a time. Held to end of transaction, so a
  -- second release waits here and then sees the first run's commitments.
  perform pg_advisory_xact_lock(hashtextextended(p_org_id::text || ':' || v_run.project_id::text, 0));

  v_prior_run_id := nullif(p_payload->>'prior_run_id', '')::uuid;
  if v_prior_run_id is not null then
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
    delete from public.commitments where org_id = p_org_id
      and metadata->>'source_generation_run_id' = v_prior_run_id::text;
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
