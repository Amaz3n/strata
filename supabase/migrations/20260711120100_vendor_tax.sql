-- Workstream 07 Phase 2: W-9 identity metadata. Full TIN storage is deliberately omitted.

alter table public.companies
  add column if not exists tax_id_last4 text,
  add column if not exists tax_entity_type text,
  add column if not exists is_1099_eligible boolean,
  add column if not exists w9_file_id uuid references public.files(id) on delete set null,
  add column if not exists w9_received_at timestamptz;

alter table public.companies drop constraint if exists companies_tax_id_last4_check;
alter table public.companies add constraint companies_tax_id_last4_check
  check (tax_id_last4 is null or tax_id_last4 ~ '^[0-9]{4}$');
alter table public.companies drop constraint if exists companies_tax_entity_type_check;
alter table public.companies add constraint companies_tax_entity_type_check
  check (tax_entity_type is null or tax_entity_type in
    ('individual','sole_prop','partnership','c_corp','s_corp','llc','exempt'));

create index if not exists companies_org_1099_idx
  on public.companies (org_id, is_1099_eligible) where is_1099_eligible = true;

-- Make W-9 available in every org's compliance settings. Commercial orgs also
-- receive it as a default for newly created subcontractors and suppliers.
insert into public.compliance_document_types
  (org_id, name, code, description, has_expiry, expiry_warning_days, is_system, is_active)
select o.id, 'W-9', 'w9', 'IRS Form W-9 on file', false, 0, true, true
from public.orgs o
where not exists (
  select 1 from public.compliance_document_types d where d.org_id = o.id and d.code = 'w9'
);

update public.orgs o
set default_compliance_requirements = coalesce(o.default_compliance_requirements, '[]'::jsonb) ||
  jsonb_build_array(jsonb_build_object(
    'document_type_id', d.id,
    'is_required', true,
    'notes', 'W-9 required for vendor tax reporting'
  ))
from public.compliance_document_types d
where o.product_tier = 'commercial'
  and d.org_id = o.id and d.code = 'w9'
  and not exists (
    select 1 from jsonb_array_elements(coalesce(o.default_compliance_requirements, '[]'::jsonb)) item
    where item->>'document_type_id' = d.id::text
  );
