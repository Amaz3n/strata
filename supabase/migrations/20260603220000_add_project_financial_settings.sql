-- Phase 3 financial ecosystem:
-- persist project financial setup rules independently from contract inference.

create table if not exists public.project_financial_settings (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  billing_model text not null default 'fixed_price'
    check (billing_model in ('fixed_price', 'cost_plus_percent', 'cost_plus_fixed_fee', 'cost_plus_gmp', 'time_and_materials')),
  paid_costs_required boolean not null default false,
  proof_required boolean not null default false,
  client_cost_approval_required boolean not null default false,
  open_book_required boolean not null default false,
  setup_completed_at timestamptz,
  setup_completed_by uuid references public.app_users(id) on delete set null,
  created_by uuid references public.app_users(id) on delete set null,
  updated_by uuid references public.app_users(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint project_financial_settings_project_unique unique (org_id, project_id)
);

create index if not exists project_financial_settings_org_project_idx
  on public.project_financial_settings (org_id, project_id);

create index if not exists project_financial_settings_billing_model_idx
  on public.project_financial_settings (org_id, billing_model);

drop trigger if exists project_financial_settings_set_updated_at on public.project_financial_settings;
create trigger project_financial_settings_set_updated_at
  before update on public.project_financial_settings
  for each row
  execute function public.tg_set_updated_at();

alter table public.project_financial_settings enable row level security;

drop policy if exists project_financial_settings_access on public.project_financial_settings;
create policy project_financial_settings_access
  on public.project_financial_settings
  using ((auth.role() = 'service_role') or public.is_org_member(org_id))
  with check ((auth.role() = 'service_role') or public.is_org_member(org_id));

grant all on table public.project_financial_settings to authenticated, service_role;

insert into public.project_financial_settings (
  org_id,
  project_id,
  billing_model,
  paid_costs_required,
  proof_required,
  client_cost_approval_required,
  open_book_required,
  metadata
)
select
  p.org_id,
  p.id,
  case
    when c.snapshot->>'billing_model' in ('fixed_price', 'cost_plus_percent', 'cost_plus_fixed_fee', 'cost_plus_gmp', 'time_and_materials')
      then c.snapshot->>'billing_model'
    when c.contract_type = 'time_materials'
      then 'time_and_materials'
    when c.contract_type = 'cost_plus' and c.gmp_cents is not null
      then 'cost_plus_gmp'
    when c.contract_type = 'cost_plus'
      then 'cost_plus_percent'
    else 'fixed_price'
  end as billing_model,
  case when c.snapshot->>'paid_costs_required' in ('true', 'false') then (c.snapshot->>'paid_costs_required')::boolean else false end as paid_costs_required,
  case when c.snapshot->>'proof_required' in ('true', 'false') then (c.snapshot->>'proof_required')::boolean else false end as proof_required,
  coalesce(c.requires_client_cost_approval, false) as client_cost_approval_required,
  coalesce(c.open_book, true) and (
    case
      when c.snapshot->>'billing_model' in ('cost_plus_percent', 'cost_plus_fixed_fee', 'cost_plus_gmp') then true
      when c.contract_type = 'cost_plus' then true
      else false
    end
  ) as open_book_required,
  jsonb_build_object(
    'backfilled_from_contract_id', c.id,
    'backfilled_at', now(),
    'billing_setup_source', 'phase_3_backfill'
  )
from public.projects p
left join lateral (
  select *
  from public.contracts c
  where c.org_id = p.org_id
    and c.project_id = p.id
    and c.status = 'active'
  order by c.created_at desc
  limit 1
) c on true
on conflict (org_id, project_id)
do update set
  billing_model = excluded.billing_model,
  paid_costs_required = excluded.paid_costs_required,
  proof_required = excluded.proof_required,
  client_cost_approval_required = excluded.client_cost_approval_required,
  open_book_required = excluded.open_book_required,
  metadata = public.project_financial_settings.metadata || excluded.metadata;
