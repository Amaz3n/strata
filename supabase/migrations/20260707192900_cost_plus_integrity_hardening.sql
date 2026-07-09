-- Cost-plus integrity hardening:
-- - Carry budget-line linkage on billable_costs so cost-driven billing can
--   reconcile against budget-line projects without relying only on cost codes.
-- - Backfill GMP classification from posted budget revisions so outside-GMP
--   billable costs can bypass the owner cap intentionally.
-- - Make retainage-on-fee an explicit contract policy instead of implicit math.

alter table public.contracts
  add column if not exists retainage_applies_to_fee boolean not null default false;

comment on column public.contracts.retainage_applies_to_fee is
  'When true, retainage is held on cost-plus builder fee and markup lines as well as reimbursable costs.';

alter table public.billable_costs
  add column if not exists budget_line_id uuid references public.budget_lines(id) on delete set null;

create index if not exists billable_costs_org_project_budget_line_idx
  on public.billable_costs (org_id, project_id, budget_line_id)
  where budget_line_id is not null;

update public.billable_costs bc
set budget_line_id = bl.budget_line_id
from public.bill_lines bl
where bc.source_type = 'vendor_bill_line'
  and bc.source_id = bl.id::text
  and bc.org_id = bl.org_id
  and bc.budget_line_id is null
  and bl.budget_line_id is not null;

update public.billable_costs bc
set budget_line_id = pe.budget_line_id
from public.project_expenses pe
where bc.source_type = 'project_expense'
  and bc.source_id = pe.id::text
  and bc.org_id = pe.org_id
  and bc.budget_line_id is null
  and pe.budget_line_id is not null;

update public.billable_costs bc
set budget_line_id = pel.budget_line_id
from public.project_expense_lines pel
where bc.source_type = 'project_expense_line'
  and bc.source_id = pel.id::text
  and bc.org_id = pel.org_id
  and bc.budget_line_id is null
  and pel.budget_line_id is not null;

update public.billable_costs bc
set budget_line_id = te.budget_line_id
from public.time_entries te
where bc.source_type = 'time_entry'
  and bc.source_id = te.id::text
  and bc.org_id = te.org_id
  and bc.budget_line_id is null
  and te.budget_line_id is not null;

update public.billable_costs bc
set
  gmp_classification = 'outside_gmp',
  metadata = jsonb_set(coalesce(bc.metadata, '{}'::jsonb), '{gmp_classification}', '"outside_gmp"', true)
from public.budget_revision_lines brl
join public.budget_revisions br
  on br.id = brl.budget_revision_id
  and br.org_id = brl.org_id
where bc.org_id = brl.org_id
  and bc.project_id = br.project_id
  and br.status = 'posted'
  and brl.gmp_classification = 'outside_gmp'
  and bc.budget_line_id = brl.budget_line_id
  and bc.gmp_classification <> 'outside_gmp';

update public.billable_costs bc
set
  gmp_classification = 'outside_gmp',
  metadata = jsonb_set(coalesce(bc.metadata, '{}'::jsonb), '{gmp_classification}', '"outside_gmp"', true)
from public.budget_revision_lines brl
join public.budget_revisions br
  on br.id = brl.budget_revision_id
  and br.org_id = brl.org_id
where bc.org_id = brl.org_id
  and bc.project_id = br.project_id
  and br.status = 'posted'
  and brl.gmp_classification = 'outside_gmp'
  and bc.cost_code_id = brl.cost_code_id
  and bc.gmp_classification <> 'outside_gmp'
  and not exists (
    select 1
    from public.budget_revision_lines budget_line_brl
    join public.budget_revisions budget_line_br
      on budget_line_br.id = budget_line_brl.budget_revision_id
      and budget_line_br.org_id = budget_line_brl.org_id
    where budget_line_brl.org_id = bc.org_id
      and budget_line_br.project_id = bc.project_id
      and budget_line_br.status = 'posted'
      and budget_line_brl.budget_line_id = bc.budget_line_id
  );

comment on column public.billable_costs.budget_line_id is
  'Budget-line bucket used to reconcile cost-driven billable ledger rows and resolve GMP classification.';
