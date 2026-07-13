-- Wave 2 WS-F: GC-owned compliance and sub-tier lien waiver collection.

alter table public.projects
  add column require_subtier_waivers boolean not null default false;

alter table public.portal_access_tokens
  add column can_upload_subtier_waivers boolean not null default true;

alter table public.lien_waivers
  add column tier integer not null default 1 check (tier in (1, 2)),
  add column through_company_id uuid references public.companies(id),
  add column claimant_company_name text,
  add column claimant_requirement_id uuid;

-- compliance_documents.company_id is intentionally retained as NOT NULL. GC-owned
-- documents use an org-scoped compatibility company created by the application and
-- tagged metadata->>'system_role' = 'org_self'. This keeps the migration additive
-- and lets the existing compliance review/expiry engine operate on one table.
alter table public.compliance_documents
  add column subject text not null default 'company' check (subject in ('company', 'org')),
  add column project_id uuid references public.projects(id) on delete cascade;

create unique index if not exists projects_id_org_uidx on public.projects (id, org_id);
create unique index if not exists companies_id_org_uidx on public.companies (id, org_id);
create unique index if not exists commitments_id_org_uidx on public.commitments (id, org_id);

alter table public.compliance_documents
  add constraint compliance_documents_project_org_fkey foreign key (project_id, org_id) references public.projects(id, org_id),
  add constraint compliance_documents_company_org_fkey foreign key (company_id, org_id) references public.companies(id, org_id);

alter table public.compliance_documents
  add constraint compliance_documents_subject_shape_check check (
    (subject = 'company' and project_id is null)
    or (subject = 'org' and project_id is not null)
  );

alter table public.lien_waivers
  add constraint lien_waivers_tier_shape_check check (
    (tier = 1 and through_company_id is null)
    or (tier = 2 and through_company_id is not null and length(btrim(claimant_company_name)) > 0)
  );

create table public.subtier_waiver_requirements (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  project_id uuid not null references public.projects(id),
  commitment_id uuid not null references public.commitments(id) on delete cascade,
  through_company_id uuid not null references public.companies(id),
  claimant_company_name text not null check (length(btrim(claimant_company_name)) > 0),
  amount_cents integer not null default 0 check (amount_cents >= 0),
  waiver_type text not null default 'conditional' check (waiver_type in ('conditional', 'unconditional', 'final')),
  period_start date,
  period_end date not null,
  is_active boolean not null default true,
  created_by uuid references public.app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (commitment_id, claimant_company_name, period_end, waiver_type),
  unique (id, org_id)
);

alter table public.subtier_waiver_requirements
  add constraint subtier_requirements_project_org_fkey foreign key (project_id, org_id) references public.projects(id, org_id),
  add constraint subtier_requirements_commitment_org_fkey foreign key (commitment_id, org_id) references public.commitments(id, org_id),
  add constraint subtier_requirements_company_org_fkey foreign key (through_company_id, org_id) references public.companies(id, org_id);

alter table public.lien_waivers
  add constraint lien_waivers_through_company_org_fkey foreign key (through_company_id, org_id) references public.companies(id, org_id);

alter table public.lien_waivers
  add constraint lien_waivers_claimant_requirement_org_fkey
  foreign key (claimant_requirement_id, org_id)
  references public.subtier_waiver_requirements(id, org_id);

create index compliance_documents_org_project_subject_idx on public.compliance_documents (org_id, project_id, subject, expiry_date)
  where subject = 'org';
create index subtier_waiver_requirements_org_project_idx on public.subtier_waiver_requirements (org_id, project_id, period_end);
create index subtier_waiver_requirements_commitment_idx on public.subtier_waiver_requirements (commitment_id, period_end);
create index lien_waivers_tier_period_idx on public.lien_waivers (org_id, project_id, tier, through_date);
create index lien_waivers_through_company_idx on public.lien_waivers (through_company_id, through_date) where tier = 2;
create index lien_waivers_claimant_requirement_idx on public.lien_waivers (claimant_requirement_id) where claimant_requirement_id is not null;

create trigger subtier_waiver_requirements_set_updated_at before update on public.subtier_waiver_requirements
  for each row execute function public.tg_set_updated_at();

alter table public.subtier_waiver_requirements enable row level security;

create policy subtier_waiver_requirements_org_access on public.subtier_waiver_requirements
  for all to authenticated
  using (exists (select 1 from public.memberships membership where membership.org_id = subtier_waiver_requirements.org_id and membership.user_id = (select auth.uid()) and membership.status = 'active'))
  with check (exists (select 1 from public.memberships membership where membership.org_id = subtier_waiver_requirements.org_id and membership.user_id = (select auth.uid()) and membership.status = 'active'));

grant select, insert, update, delete on public.subtier_waiver_requirements to authenticated;
grant all on public.subtier_waiver_requirements to service_role;
