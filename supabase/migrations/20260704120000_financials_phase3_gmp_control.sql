alter table public.contracts
  add column if not exists contingency_cents integer;

alter table public.contracts
  drop constraint if exists contracts_contingency_cents_check,
  add constraint contracts_contingency_cents_check
    check (contingency_cents is null or contingency_cents >= 0);

comment on column public.contracts.contingency_cents is
  'GMP contingency allowance in cents. Drawdowns are recorded in gmp_contingency_entries.';

create table if not exists public.gmp_contingency_entries (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  contract_id uuid references public.contracts(id) on delete set null,
  amount_cents integer not null,
  reason text not null,
  approved_by uuid references public.app_users(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint gmp_contingency_entries_amount_nonzero check (amount_cents <> 0),
  constraint gmp_contingency_entries_reason_present check (length(trim(reason)) > 0)
);

comment on table public.gmp_contingency_entries is
  'Signed GMP contingency ledger. Drawdowns are stored as negative amount_cents entries.';

comment on column public.gmp_contingency_entries.amount_cents is
  'Signed amount in cents. Negative values reduce contingency remaining.';

create index if not exists gmp_contingency_entries_project_idx
  on public.gmp_contingency_entries (org_id, project_id, created_at desc);

create index if not exists gmp_contingency_entries_contract_idx
  on public.gmp_contingency_entries (contract_id)
  where contract_id is not null;

create index if not exists gmp_contingency_entries_approved_by_idx
  on public.gmp_contingency_entries (approved_by)
  where approved_by is not null;

alter table public.gmp_contingency_entries enable row level security;

drop policy if exists gmp_contingency_entries_access on public.gmp_contingency_entries;
create policy gmp_contingency_entries_access
  on public.gmp_contingency_entries
  using ((auth.role() = 'service_role') or public.is_org_member(org_id))
  with check ((auth.role() = 'service_role') or public.is_org_member(org_id));

grant all on table public.gmp_contingency_entries to authenticated, service_role;
