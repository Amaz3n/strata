create table if not exists public.company_compliance_requirement_waivers (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  document_type_id uuid not null references public.compliance_document_types(id) on delete cascade,
  reason text,
  expires_at date,
  waived_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by uuid references public.app_users(id) on delete set null,
  revoke_reason text
);

create unique index if not exists company_compliance_requirement_waivers_active_key
  on public.company_compliance_requirement_waivers (company_id, document_type_id)
  where revoked_at is null;

create index if not exists company_compliance_requirement_waivers_org_idx
  on public.company_compliance_requirement_waivers (org_id);

create index if not exists company_compliance_requirement_waivers_company_idx
  on public.company_compliance_requirement_waivers (company_id);

create index if not exists company_compliance_requirement_waivers_expires_idx
  on public.company_compliance_requirement_waivers (expires_at)
  where revoked_at is null and expires_at is not null;

alter table public.company_compliance_requirement_waivers enable row level security;

create policy "company_compliance_waivers_org_access"
  on public.company_compliance_requirement_waivers
  for all
  to authenticated
  using (
    org_id in (
      select memberships.org_id
      from public.memberships
      where memberships.user_id = auth.uid()
        and memberships.status = 'active'
    )
  )
  with check (
    org_id in (
      select memberships.org_id
      from public.memberships
      where memberships.user_id = auth.uid()
        and memberships.status = 'active'
    )
  );

grant all on table public.company_compliance_requirement_waivers to authenticated;
grant all on table public.company_compliance_requirement_waivers to service_role;
