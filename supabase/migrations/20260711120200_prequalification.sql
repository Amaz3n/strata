-- Workstream 07 Phase 3: structured subcontractor prequalification workflow.

create table if not exists public.prequalifications (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  status text not null default 'requested'
    check (status in ('requested','submitted','under_review','approved','approved_with_limits','declined','expired')),
  requested_by uuid references public.app_users(id) on delete set null,
  requested_at timestamptz not null default now(),
  submitted_at timestamptz,
  reviewed_by uuid references public.app_users(id) on delete set null,
  reviewed_at timestamptz,
  expires_at date,
  single_project_limit_cents bigint,
  aggregate_limit_cents bigint,
  emr numeric,
  bonding_single_cents bigint,
  bonding_aggregate_cents bigint,
  years_in_business integer,
  annual_revenue_cents bigint,
  largest_project_cents bigint,
  trades text[],
  references_data jsonb not null default '[]'::jsonb,
  questionnaire jsonb not null default '{}'::jsonb,
  review_notes text,
  portal_token_id uuid references public.portal_access_tokens(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists prequalifications_org_company_idx
  on public.prequalifications (org_id, company_id, created_at desc);
create index if not exists prequalifications_org_status_expiry_idx
  on public.prequalifications (org_id, status, expires_at);
create index if not exists prequalifications_portal_token_idx
  on public.prequalifications (portal_token_id) where portal_token_id is not null;

drop trigger if exists prequalifications_set_updated_at on public.prequalifications;
create trigger prequalifications_set_updated_at before update on public.prequalifications
  for each row execute function public.tg_set_updated_at();

alter table public.prequalifications enable row level security;
drop policy if exists prequalifications_org_access on public.prequalifications;
create policy prequalifications_org_access on public.prequalifications for all to authenticated
  using (public.is_org_member(org_id)) with check (public.is_org_member(org_id));
grant all on table public.prequalifications to authenticated, service_role;

insert into public.permissions (key, description) values
  ('prequal.review', 'Review and approve subcontractor prequalifications')
on conflict (key) do update set description = excluded.description;

insert into public.role_permissions (role_id, permission_key)
select id, 'prequal.review' from public.roles
where key in ('org_owner', 'org_admin', 'org_office_admin', 'org_project_lead', 'pm', 'org_estimator')
on conflict (role_id, permission_key) do nothing;
