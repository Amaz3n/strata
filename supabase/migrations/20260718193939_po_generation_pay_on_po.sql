-- Workstream 04 phases 4-5: auditable PO generation, exception queue, and
-- completion-triggered AP records. Purchase orders remain commitments.

create table public.po_generation_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  project_id uuid not null references public.projects(id),
  lot_id uuid not null references public.lots(id),
  house_plan_version_id uuid not null references public.house_plan_versions(id),
  mode text not null check (mode in ('dry_run','commit')),
  status text not null default 'running'
    check (status in ('running','succeeded','succeeded_with_exceptions','failed','superseded')),
  as_of_date date not null default current_date,
  input_fingerprint text not null check (length(input_fingerprint) = 64),
  summary jsonb not null default '{}'::jsonb,
  error text,
  created_by uuid references public.app_users(id),
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create table public.po_generation_exceptions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  run_id uuid not null references public.po_generation_runs(id) on delete cascade,
  project_id uuid not null references public.projects(id),
  cost_code_id uuid references public.cost_codes(id),
  source_kind text not null check (source_kind in ('takeoff_line','option')),
  source_ref jsonb not null,
  description text not null,
  quantity numeric,
  uom text,
  reason text not null check (reason in (
    'no_agreement','expired_agreement','ambiguous_agreement','uom_mismatch',
    'no_vendor','no_cost_code'
  )),
  candidates jsonb not null default '[]'::jsonb,
  status text not null default 'open'
    check (status in ('open','resolved_agreement','resolved_manual','dismissed')),
  resolution jsonb,
  resolved_by uuid references public.app_users(id),
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.po_completions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  project_id uuid not null references public.projects(id),
  commitment_id uuid not null references public.commitments(id),
  commitment_line_ids uuid[],
  status text not null default 'reported'
    check (status in ('reported','verified','approved','rejected','billed','void')),
  reported_source text not null check (reported_source in ('trade_portal','super_mobile','office')),
  reported_by_contact_id uuid references public.contacts(id),
  reported_by_user_id uuid references public.app_users(id),
  reported_at timestamptz not null default now(),
  notes text,
  photo_file_ids uuid[] not null default '{}',
  verified_by uuid references public.app_users(id),
  verified_at timestamptz,
  approved_by uuid references public.app_users(id),
  approved_at timestamptz,
  rejected_reason text,
  vendor_bill_id uuid references public.vendor_bills(id),
  amount_cents bigint,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint po_completion_reporter check (
    (reported_source = 'trade_portal' and reported_by_contact_id is not null)
    or (reported_source <> 'trade_portal' and reported_by_user_id is not null)
  )
);

alter table public.communities add column if not exists pay_on_po_enabled boolean;
alter table public.portal_access_tokens
  add column if not exists can_view_purchase_orders boolean not null default false,
  add column if not exists can_report_po_completion boolean not null default false;

create index po_gen_runs_project_idx on public.po_generation_runs (org_id, project_id, created_at desc);
create index po_gen_runs_lot_idx on public.po_generation_runs (lot_id, created_at desc);
create index po_gen_runs_plan_version_idx on public.po_generation_runs (house_plan_version_id);
create index po_gen_runs_created_by_idx on public.po_generation_runs (created_by) where created_by is not null;
create index po_gen_exceptions_open_idx on public.po_generation_exceptions (org_id, status, project_id);
create index po_gen_exceptions_run_idx on public.po_generation_exceptions (run_id);
create index po_gen_exceptions_cost_code_idx on public.po_generation_exceptions (cost_code_id) where cost_code_id is not null;
create index po_gen_exceptions_resolved_by_idx on public.po_generation_exceptions (resolved_by) where resolved_by is not null;
create index po_completions_queue_idx on public.po_completions (org_id, status, project_id);
create index po_completions_commitment_idx on public.po_completions (org_id, commitment_id);
create index po_completions_vendor_bill_idx on public.po_completions (vendor_bill_id) where vendor_bill_id is not null;
create index po_completions_contact_idx on public.po_completions (reported_by_contact_id) where reported_by_contact_id is not null;

create trigger po_completions_set_updated_at before update on public.po_completions
  for each row execute function public.tg_set_updated_at();

alter table public.po_generation_runs enable row level security;
alter table public.po_generation_exceptions enable row level security;
alter table public.po_completions enable row level security;
create policy po_generation_runs_org_access on public.po_generation_runs
  for all to authenticated using (public.is_org_member(org_id)) with check (public.is_org_member(org_id));
create policy po_generation_exceptions_org_access on public.po_generation_exceptions
  for all to authenticated using (public.is_org_member(org_id)) with check (public.is_org_member(org_id));
create policy po_completions_org_access on public.po_completions
  for all to authenticated using (public.is_org_member(org_id)) with check (public.is_org_member(org_id));

grant select, insert, update, delete on public.po_generation_runs,
  public.po_generation_exceptions, public.po_completions to authenticated;
grant all on public.po_generation_runs, public.po_generation_exceptions,
  public.po_completions to service_role;

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

  update public.po_generation_runs set
    status = case when jsonb_array_length(coalesce(p_payload->'exceptions', '[]')) > 0
      then 'succeeded_with_exceptions' else 'succeeded' end,
    summary = coalesce(p_payload->'summary', '{}'::jsonb), completed_at = now()
  where org_id = p_org_id and id = p_run_id;

  return jsonb_build_object('run_id', p_run_id, 'budget_id', v_budget_id,
    'commitment_ids', to_jsonb(v_commitment_ids));
end;
$$;

revoke all on function public.run_po_generation_commit(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.run_po_generation_commit(uuid, uuid, jsonb) to service_role;

create or replace function public.approve_po_completion(
  p_org_id uuid,
  p_completion_id uuid,
  p_actor_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_completion public.po_completions%rowtype;
  v_commitment public.commitments%rowtype;
  v_settings public.purchasing_settings%rowtype;
  v_bill_id uuid;
  v_amount bigint := 0;
  v_revised_total bigint := 0;
  v_already_billed bigint := 0;
  v_line record;
begin
  select * into v_completion from public.po_completions
    where org_id = p_org_id and id = p_completion_id for update;
  if not found then raise exception 'PO completion not found'; end if;
  if v_completion.status = 'billed' and v_completion.vendor_bill_id is not null then
    return jsonb_build_object('completion_id', v_completion.id, 'vendor_bill_id', v_completion.vendor_bill_id, 'amount_cents', v_completion.amount_cents);
  end if;

  select * into v_commitment from public.commitments
    where org_id = p_org_id and id = v_completion.commitment_id for update;
  if not found or v_commitment.commitment_type <> 'purchase_order' or v_commitment.status <> 'approved' then
    raise exception 'Only approved purchase orders can be completed';
  end if;
  select * into v_settings from public.purchasing_settings where org_id = p_org_id;
  if coalesce(v_settings.po_completion_requires_verification, true) and v_completion.status <> 'verified' then
    raise exception 'PO completion must be verified before approval';
  end if;
  if not coalesce(v_settings.po_completion_requires_verification, true)
      and v_completion.status not in ('reported','verified') then
    raise exception 'PO completion is not approval-ready';
  end if;

  select coalesce(sum(round(cl.quantity * cl.unit_cost_cents)), 0)::bigint into v_amount
  from public.commitment_lines cl
  where cl.org_id = p_org_id and cl.commitment_id = v_commitment.id
    and (v_completion.commitment_line_ids is null or cl.id = any(v_completion.commitment_line_ids));

  if v_completion.commitment_line_ids is null then
    select v_amount + coalesce(sum(cco.total_cents), 0)::bigint into v_amount
    from public.commitment_change_orders cco
    where cco.org_id = p_org_id and cco.commitment_id = v_commitment.id and cco.status = 'approved';
  end if;

  select coalesce(sum(cco.total_cents), 0)::bigint into v_revised_total
  from public.commitment_change_orders cco
  where cco.org_id = p_org_id and cco.commitment_id = v_commitment.id and cco.status = 'approved';
  v_revised_total := coalesce(v_commitment.total_cents, 0)::bigint + v_revised_total;
  select coalesce(sum(vb.total_cents), 0)::bigint into v_already_billed
  from public.vendor_bills vb where vb.org_id = p_org_id and vb.commitment_id = v_commitment.id;
  if v_amount <= 0 then raise exception 'PO completion has no positive payable amount'; end if;
  if v_already_billed + v_amount > v_revised_total then
    raise exception 'Completion exceeds the revised PO total; create a VPO first';
  end if;

  insert into public.vendor_bills (
    org_id, project_id, commitment_id, company_id, bill_number, status,
    bill_date, due_date, total_cents, currency, metadata, approved_at, approved_by
  ) values (
    p_org_id, v_completion.project_id, v_commitment.id, v_commitment.company_id,
    concat('PO-', coalesce(v_commitment.contract_number, left(v_commitment.id::text, 8)), '-', left(v_completion.id::text, 8)),
    'approved', current_date, current_date, v_amount::integer, 'usd',
    jsonb_build_object('source', 'pay_on_po', 'po_completion_id', v_completion.id),
    now(), p_actor_id
  ) returning id into v_bill_id;

  for v_line in
    select cl.* from public.commitment_lines cl
    where cl.org_id = p_org_id and cl.commitment_id = v_commitment.id
      and (v_completion.commitment_line_ids is null or cl.id = any(v_completion.commitment_line_ids))
    order by cl.sort_order
  loop
    insert into public.bill_lines (
      org_id, bill_id, project_id, cost_code_id, budget_line_id, description,
      quantity, unit, unit_cost_cents, sort_order, metadata
    ) values (
      p_org_id, v_bill_id, v_completion.project_id, v_line.cost_code_id,
      v_line.budget_line_id, v_line.description, v_line.quantity, v_line.unit,
      v_line.unit_cost_cents, v_line.sort_order,
      jsonb_build_object('source', 'pay_on_po', 'commitment_line_id', v_line.id)
    );
  end loop;

  if v_completion.commitment_line_ids is null then
    for v_line in
      select ccol.* from public.commitment_change_order_lines ccol
      join public.commitment_change_orders cco on cco.id = ccol.commitment_change_order_id and cco.org_id = ccol.org_id
      where ccol.org_id = p_org_id and cco.commitment_id = v_commitment.id and cco.status = 'approved'
      order by cco.created_at, ccol.sort_order
    loop
      insert into public.bill_lines (
        org_id, bill_id, project_id, cost_code_id, budget_line_id, description,
        quantity, unit, unit_cost_cents, sort_order, metadata
      ) values (
        p_org_id, v_bill_id, v_completion.project_id, v_line.cost_code_id,
        v_line.budget_line_id, v_line.description, v_line.quantity, v_line.unit,
        v_line.unit_cost_cents, 10000 + v_line.sort_order,
        jsonb_build_object('source', 'pay_on_po_vpo', 'commitment_change_order_line_id', v_line.id)
      );
    end loop;
  end if;

  update public.po_completions set
    status = 'billed', approved_by = p_actor_id, approved_at = now(),
    vendor_bill_id = v_bill_id, amount_cents = v_amount
  where org_id = p_org_id and id = v_completion.id;

  return jsonb_build_object('completion_id', v_completion.id, 'vendor_bill_id', v_bill_id, 'amount_cents', v_amount);
end;
$$;

revoke all on function public.approve_po_completion(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.approve_po_completion(uuid, uuid, uuid) to service_role;
