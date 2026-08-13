create table if not exists public.qbo_import_cost_code_mappings (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  qbo_ref_type text not null check (qbo_ref_type in ('account', 'item')),
  qbo_ref_id text not null,
  qbo_ref_name text,
  cost_code_id uuid references public.cost_codes(id) on delete set null,
  created_by uuid references public.app_users(id) on delete set null,
  updated_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint qbo_import_cost_code_mappings_unique unique (org_id, qbo_ref_type, qbo_ref_id)
);

create index if not exists qbo_import_cost_code_mappings_org_idx
  on public.qbo_import_cost_code_mappings (org_id);

create index if not exists qbo_import_cost_code_mappings_cost_code_idx
  on public.qbo_import_cost_code_mappings (cost_code_id);

drop trigger if exists qbo_import_cost_code_mappings_set_updated_at on public.qbo_import_cost_code_mappings;
create trigger qbo_import_cost_code_mappings_set_updated_at
  before update on public.qbo_import_cost_code_mappings
  for each row
  execute function public.tg_set_updated_at();

alter table public.qbo_import_cost_code_mappings enable row level security;

drop policy if exists qbo_import_cost_code_mappings_access on public.qbo_import_cost_code_mappings;
create policy qbo_import_cost_code_mappings_access
  on public.qbo_import_cost_code_mappings
  using ((auth.role() = 'service_role') or public.is_org_member(org_id))
  with check ((auth.role() = 'service_role') or public.is_org_member(org_id));

grant all on table public.qbo_import_cost_code_mappings to authenticated, service_role;
