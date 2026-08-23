-- Compliance becomes a first-class system rather than a document shelf.
--
-- Seven things change:
--   1. The payment-hold override CHECK catches up with the two AI-claim holds
--      the application has been offering an override button for since August.
--   2. Reviewing a compliance document earns its own permission. Approving a
--      certificate releases money; `org.member` was never the right bar.
--   3. An approval becomes reversible. `reviewComplianceDocument` refuses a
--      second decision, so a mistaken approval had no cure at all.
--   4. Document types gain a `kind`, and documents gain the license fields the
--      insurance-shaped columns could never carry.
--   5. Requirements gain a project layer, so an owner mandating $5M umbrella on
--      one job stops meaning "raise it for this vendor everywhere".
--   6. Autopilot can chase a rejection and escalate past the last reminder.
--   7. A vendor can carry a certificate between the builders they work for
--      instead of re-uploading it per org.

-- ── 1. Payment-hold override kinds ─────────────────────────────────────────
-- `insurance_verified` and `waiver_verified` were added to the policy and to
-- the override UI, but not here, so overriding either raised a raw constraint
-- error instead of releasing the bill.
alter table public.payment_hold_overrides
  drop constraint if exists payment_hold_overrides_hold_kind_check;
alter table public.payment_hold_overrides
  add constraint payment_hold_overrides_hold_kind_check
    check (hold_kind in (
      'insurance_current',
      'insurance_verified',
      'waiver_signed',
      'waiver_verified',
      'compliance_docs_approved',
      'retainage_rules_met',
      'funding_received'
    ));

alter table public.payment_hold_policies
  alter column conditions set default '{"insurance_current":"block","insurance_verified":"warn","waiver_signed":"block","waiver_verified":"warn","compliance_docs_approved":"block","retainage_rules_met":"warn","funding_received":"warn"}'::jsonb;

-- ── 2. Compliance permissions ──────────────────────────────────────────────
-- These are also declared in `20260708120500_rbac_catalog_seed.sql`, which is
-- the catalog source of truth and ends with a DELETE that prunes any grant not
-- in its list for exactly these roles. Grants added only here would survive
-- until the next time that catalog is regenerated, then vanish silently.
insert into public.permissions (key, description) values
  ('compliance.read', 'View vendor compliance requirements, documents, and status'),
  ('compliance.manage', 'Set vendor compliance requirements, waive them, and upload documents'),
  ('compliance.review', 'Approve or reject a vendor compliance document, and revoke an approval')
on conflict (key) do update set description = excluded.description;

-- Read is broad: anyone who can see the directory needs to know whether a
-- vendor is eligible before they commit work to them.
insert into public.role_permissions (role_id, permission_key)
select r.id, 'compliance.read'
from public.roles r
where r.key in (
  'org_owner','org_admin','org_office_admin','org_bookkeeper','org_project_lead',
  'org_purchasing_manager','org_superintendent','org_estimator','org_starts_coordinator',
  'org_warranty_manager','org_user','org_viewer'
)
on conflict (role_id, permission_key) do nothing;

-- Managing and reviewing stay with the roles that own the vendor relationship
-- and the money it unblocks.
insert into public.role_permissions (role_id, permission_key)
select r.id, p.permission_key
from public.roles r
cross join unnest(array['compliance.manage','compliance.review']) p(permission_key)
where r.key in ('org_owner','org_admin','org_office_admin','org_bookkeeper','org_purchasing_manager')
on conflict (role_id, permission_key) do nothing;

-- ── 3. A reviewed document can be superseded or revoked ────────────────────
alter table public.compliance_documents
  add column if not exists revoked_at timestamptz,
  add column if not exists revoked_by uuid references public.app_users(id) on delete set null,
  add column if not exists revoke_reason text,
  add column if not exists superseded_by_id uuid references public.compliance_documents(id) on delete set null;

comment on column public.compliance_documents.revoked_at is
  'Set when a builder withdraws a decision already made. The status stays as the record of what was decided; this is what stops the document satisfying its requirement, so the vendor is asked for a replacement rather than the same document being re-reviewed.';
comment on column public.compliance_documents.superseded_by_id is
  'The newer document that replaced this one for the same requirement. Kept so the submission history stays readable.';

create index if not exists compliance_documents_active_idx
  on public.compliance_documents (org_id, company_id, document_type_id, status)
  where revoked_at is null;

-- ── 4. Document kinds, and the fields insurance columns cannot carry ───────
alter table public.compliance_document_types
  add column if not exists kind text not null default 'other'
    check (kind in ('insurance','tax','license','safety','other'));

comment on column public.compliance_document_types.kind is
  'What shape of document this is. Decides which fields the upload form collects and which verification runs — never inferred from the name or code again.';

alter table public.compliance_documents
  add column if not exists license_number text,
  add column if not exists license_jurisdiction text,
  add column if not exists license_classification text;

-- Backfill the kind from the substring matching the application used to do at
-- three separate call sites, so no org loses insurance handling on deploy.
update public.compliance_document_types
set kind = 'insurance'
where kind = 'other'
  and (name ~* '(insurance|certificate|coi|umbrella|excess|liability|workers.?comp|auto)'
    or code ~* '(insurance|certificate|coi|umbrella|excess|liability|workers?_?comp|auto|^gl$|_gl$|^wc$|_wc$)');

update public.compliance_document_types
set kind = 'tax'
where kind = 'other' and (code in ('w9','w-9','w9_form') or name ~* 'w-?9');

update public.compliance_document_types
set kind = 'license'
where kind = 'other' and (name ~* '(license|licence|registration|certification)' or code ~* '(license|licence|registration)');

update public.compliance_document_types
set kind = 'safety'
where kind = 'other' and (name ~* '(safety|osha|emr|training)' or code ~* '(safety|osha|emr)');

-- ── 5. Project-level requirement overlays ──────────────────────────────────
-- The third resolution layer: org default -> vendor override -> project overlay.
-- A row here applies to every vendor on that project unless `company_id` names
-- one. Nothing here weakens a requirement; the waiver is still the only exit.
create table if not exists public.project_compliance_requirements (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  company_id uuid references public.companies(id) on delete cascade,
  document_type_id uuid not null references public.compliance_document_types(id) on delete cascade,
  is_required boolean not null default true,
  min_coverage_cents bigint check (min_coverage_cents is null or min_coverage_cents > 0),
  requires_additional_insured boolean not null default false,
  requires_primary_noncontributory boolean not null default false,
  requires_waiver_of_subrogation boolean not null default false,
  notes text,
  created_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists project_compliance_requirements_scope_idx
  on public.project_compliance_requirements (project_id, document_type_id, company_id)
  nulls not distinct;
create index if not exists project_compliance_requirements_org_idx
  on public.project_compliance_requirements (org_id, project_id);
create index if not exists project_compliance_requirements_company_idx
  on public.project_compliance_requirements (org_id, company_id)
  where company_id is not null;
create index if not exists project_compliance_requirements_type_idx
  on public.project_compliance_requirements (org_id, document_type_id);

alter table public.project_compliance_requirements enable row level security;
create policy project_compliance_requirements_read on public.project_compliance_requirements
  for select to authenticated
  using (public.has_org_permission(org_id, 'compliance.read'));
create policy project_compliance_requirements_write on public.project_compliance_requirements
  for all to authenticated
  using (public.has_org_permission(org_id, 'compliance.manage'))
  with check (public.has_org_permission(org_id, 'compliance.manage'));
grant select, insert, update, delete on public.project_compliance_requirements to authenticated;
grant all on public.project_compliance_requirements to service_role;
create trigger project_compliance_requirements_set_updated_at
  before update on public.project_compliance_requirements
  for each row execute function public.tg_set_updated_at();

-- ── 6. Autopilot can chase rejections and escalate ─────────────────────────
alter table public.compliance_autopilot_deliveries
  drop constraint if exists compliance_autopilot_deliveries_reminder_kind_check;
alter table public.compliance_autopilot_deliveries
  add constraint compliance_autopilot_deliveries_reminder_kind_check
    check (reminder_kind in ('missing','expiring','expired','rejected','escalation','pm_digest'));

-- `portal_url` was declared and never written. The link is computed per send.
alter table public.compliance_autopilot_deliveries
  drop column if exists portal_url;

-- ── 7. A certificate a vendor already gave another builder ─────────────────
-- The vendor is the one who consents, per builder, per document. The share
-- records that consent; the copy it produces is an ordinary document in the
-- receiving org that still has to pass that org's own review.
create table if not exists public.vendor_document_shares (
  id uuid primary key default gen_random_uuid(),
  source_org_id uuid not null references public.orgs(id) on delete cascade,
  source_document_id uuid not null references public.compliance_documents(id) on delete cascade,
  target_org_id uuid not null references public.orgs(id) on delete cascade,
  target_document_id uuid references public.compliance_documents(id) on delete set null,
  external_identity_id uuid references public.external_identities(id) on delete set null,
  shared_by_contact_email text,
  portal_token_id uuid references public.portal_access_tokens(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists vendor_document_shares_target_idx
  on public.vendor_document_shares (target_org_id, created_at desc);
create index if not exists vendor_document_shares_source_idx
  on public.vendor_document_shares (source_org_id, source_document_id);
create index if not exists vendor_document_shares_identity_idx
  on public.vendor_document_shares (external_identity_id)
  where external_identity_id is not null;

alter table public.vendor_document_shares enable row level security;
-- Both sides of a share can see it: the org that received the document, and the
-- org whose document travelled. Writes are service-role only — the vendor acts
-- through the portal, which has no authenticated org member behind it.
create policy vendor_document_shares_read on public.vendor_document_shares
  for select to authenticated
  using (
    public.has_org_permission(target_org_id, 'compliance.read')
    or public.has_org_permission(source_org_id, 'compliance.read')
  );
grant select on public.vendor_document_shares to authenticated;
grant all on public.vendor_document_shares to service_role;

comment on table public.vendor_document_shares is
  'One vendor-granted consent to carry a compliance document from the builder it was issued to into another builder''s org. The receiving org reviews the copy on its own terms.';
