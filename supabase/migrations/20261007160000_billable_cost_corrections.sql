-- B11.2: a cost already billed to the customer is never rewritten. When its
-- source changes (the vendor bill is returned to pending or re-coded), the billed
-- row stays on its invoice and is credited exactly once by a correction row that
-- carries an explicit billing decision: credit the customer on the next invoice,
-- or absorb it (the builder keeps the billed amount and nothing is credited). The
-- credited original frees its source, so the corrected cost bills again.

alter table public.billable_costs
  add column correction_of uuid references public.billable_costs(id) on delete restrict,
  add column credited_at timestamptz,
  add column billing_decision text check (billing_decision in ('credit_customer','absorb')),
  add column billing_decided_by uuid references public.app_users(id),
  add column billing_decided_at timestamptz,
  add column billing_decision_note text,
  add constraint billable_costs_correction_decision_check check (correction_of is not null or billing_decision is null);

-- One live credit per billed cost.
create unique index billable_costs_one_correction_uq on public.billable_costs (correction_of) where correction_of is not null and status <> 'voided';
create index billable_costs_billing_decided_by_idx on public.billable_costs (billing_decided_by) where billing_decided_by is not null;

-- A credited original no longer holds its source, so the corrected source bills again.
drop index public.billable_costs_source_uq;
create unique index billable_costs_source_uq on public.billable_costs (source_type, source_id) where status <> 'voided' and credited_at is null;

-- What was billed stays as billed. Voiding or revising the invoice may release
-- or re-point the cost; nothing may change what it was or how much it billed.
create or replace function public.billable_costs_billed_fence()
returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    if old.status = 'billed' then raise exception 'A billed cost cannot be deleted; credit it instead'; end if;
    return old;
  end if;
  if old.status = 'billed' and (new.cost_cents, new.markup_cents, new.markup_percent_resolved, new.project_id, new.source_type, new.source_id, new.cost_code_id, new.is_billable, new.occurred_on, new.correction_of)
    is distinct from (old.cost_cents, old.markup_cents, old.markup_percent_resolved, old.project_id, old.source_type, old.source_id, old.cost_code_id, old.is_billable, old.occurred_on, old.correction_of) then
    raise exception 'A billed cost cannot change; credit it and bill the corrected cost';
  end if;
  if old.credited_at is not null and new.credited_at is distinct from old.credited_at then
    raise exception 'A credited cost stays credited';
  end if;
  -- Its invoice was voided: the original billing is undone, so it does not bill
  -- again (the corrected cost bills from its own row) and its credit is withdrawn.
  if old.status = 'billed' and old.credited_at is not null and new.status = 'open' then
    if exists(select 1 from public.billable_costs c where c.correction_of = old.id and c.status in ('locked','billed')) then
      raise exception 'This cost''s credit is already on another invoice; void or credit that invoice first';
    end if;
    update public.billable_costs set status = 'voided' where correction_of = old.id and status in ('open','excluded');
    new.status := 'voided';
  end if;
  return new;
end;
$$;
revoke all on function public.billable_costs_billed_fence() from public, anon, authenticated;
create trigger billable_costs_billed_fence before update or delete on public.billable_costs
  for each row execute function public.billable_costs_billed_fence();

-- Credit a billed cost exactly once. Returns the correction row (new or existing).
create or replace function public.credit_billed_cost(p_org_id uuid, p_billable_cost_id uuid, p_reason text, p_actor_id uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_cost public.billable_costs%rowtype; v_id uuid;
begin
  select * into v_cost from public.billable_costs where id = p_billable_cost_id and org_id = p_org_id for update;
  if not found then raise exception 'Billable cost not found'; end if;
  select id into v_id from public.billable_costs where org_id = p_org_id and correction_of = v_cost.id and status <> 'voided';
  if v_id is not null then return v_id; end if;
  if v_cost.status <> 'billed' then raise exception 'Only a billed cost is credited; an unbilled cost is voided'; end if;
  insert into public.billable_costs(org_id, project_id, cost_code_id, budget_line_id, source_type, source_id, source_company_id, occurred_on, description,
    cost_cents, markup_percent_resolved, markup_cents, is_billable, gmp_classification, status, correction_of, billing_decision, metadata)
  values (p_org_id, v_cost.project_id, v_cost.cost_code_id, v_cost.budget_line_id, 'manual_adjustment', gen_random_uuid(), v_cost.source_company_id,
    (now() at time zone 'UTC')::date, 'Credit for billed cost: ' || coalesce(v_cost.description, 'cost'),
    -v_cost.cost_cents, v_cost.markup_percent_resolved, -v_cost.markup_cents, true, v_cost.gmp_classification, 'open', v_cost.id, 'credit_customer',
    -- The credit reverses exactly what was billed: its markup is a snapshot, never re-priced.
    coalesce(v_cost.metadata, '{}'::jsonb) - 'bill_id' || jsonb_build_object('adjustment_reason', p_reason, 'original_billable_cost_id', v_cost.id, 'original_invoice_id', v_cost.invoice_id, 'credited_by', p_actor_id, 'markup_source', 'line'))
  returning id into v_id;
  update public.billable_costs set credited_at = clock_timestamp() where id = v_cost.id;
  return v_id;
end;
$$;
revoke all on function public.credit_billed_cost(uuid,uuid,text,uuid) from public, anon, authenticated;
grant execute on function public.credit_billed_cost(uuid,uuid,text,uuid) to service_role;

-- The billing decision on a correction that has not been invoiced yet.
create or replace function public.decide_billable_correction(p_org_id uuid, p_billable_cost_id uuid, p_decision text, p_note text, p_actor_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_cost public.billable_costs%rowtype;
begin
  select * into v_cost from public.billable_costs where id = p_billable_cost_id and org_id = p_org_id for update;
  if not found or v_cost.correction_of is null then raise exception 'Billing correction not found'; end if;
  if v_cost.status not in ('open', 'excluded') then raise exception 'This correction is already on an invoice; credit or revise that invoice instead'; end if;
  if p_decision not in ('credit_customer', 'absorb') then raise exception 'Choose to credit the customer or absorb the correction'; end if;
  if length(trim(coalesce(p_note, ''))) < 10 then raise exception 'Say why'; end if;
  update public.billable_costs set billing_decision = p_decision, billing_decided_by = p_actor_id, billing_decided_at = clock_timestamp(),
    billing_decision_note = trim(p_note), status = case when p_decision = 'absorb' then 'excluded' else 'open' end
    where id = v_cost.id;
  return jsonb_build_object('billableCostId', v_cost.id, 'projectId', v_cost.project_id, 'decision', p_decision);
end;
$$;
revoke all on function public.decide_billable_correction(uuid,uuid,text,text,uuid) from public, anon, authenticated;
grant execute on function public.decide_billable_correction(uuid,uuid,text,text,uuid) to service_role;
