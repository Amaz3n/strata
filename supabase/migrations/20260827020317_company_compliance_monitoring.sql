-- Compliance enrollment belongs to the vendor relationship, not to the mere
-- existence of a company in the directory. Existing vendors with explicitly
-- assigned requirements stay enrolled; new directory companies start paused.

alter table public.companies
  add column if not exists compliance_monitoring_enabled boolean not null default false,
  add column if not exists compliance_monitoring_updated_at timestamptz,
  add column if not exists compliance_monitoring_updated_by uuid references public.app_users(id) on delete set null;

update public.companies c
set compliance_monitoring_enabled = true,
    compliance_monitoring_updated_at = now()
where exists (
  select 1
  from public.company_compliance_requirements requirement
  where requirement.org_id = c.org_id
    and requirement.company_id = c.id
    and requirement.is_required = true
);

comment on column public.companies.compliance_monitoring_enabled is
  'Whether standing and project compliance requirements are actively evaluated and compliance autopilot may contact this vendor. Defaults off for new companies.';

comment on column public.companies.compliance_monitoring_updated_at is
  'When compliance monitoring was last explicitly changed or backfilled.';

comment on column public.companies.compliance_monitoring_updated_by is
  'Builder who last explicitly changed compliance monitoring; null for migration backfills.';
