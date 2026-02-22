-- Unify compliance on the document-based system and extend builder-focused coverage.

-- 1) Extend requirement granularity for insurance endorsements.
alter table if exists public.company_compliance_requirements
  add column if not exists requires_additional_insured boolean not null default false,
  add column if not exists requires_primary_noncontributory boolean not null default false,
  add column if not exists requires_waiver_of_subrogation boolean not null default false;

-- 2) Capture endorsement details on uploaded compliance documents.
alter table if exists public.compliance_documents
  add column if not exists additional_insured boolean not null default false,
  add column if not exists primary_noncontributory boolean not null default false,
  add column if not exists waiver_of_subrogation boolean not null default false;

-- 3) Seed additional builder-relevant compliance document types for existing orgs.
insert into public.compliance_document_types (org_id, name, code, description, has_expiry, is_system)
select
  o.id,
  t.name,
  t.code,
  t.description,
  t.has_expiry,
  true
from public.orgs o
cross join (
  values
    ('W-9 Form', 'w9', 'IRS tax identification form', false),
    ('Certificate of Insurance (COI)', 'coi', 'General liability insurance certificate', true),
    ('Workers Compensation Certificate', 'workers_comp', 'Workers compensation insurance proof', true),
    ('Contractor License', 'license', 'State or local contractor license', true),
    ('Auto Insurance Certificate', 'auto_insurance', 'Commercial auto insurance certificate', true),
    ('Umbrella / Excess Liability', 'umbrella', 'Excess liability policy documentation', true),
    ('Performance / Payment Bond', 'bond', 'Surety bond certificate when required by contract', true),
    ('Business License Registration', 'business_license', 'State/local business registration certificate', true),
    ('Safety Program / OSHA', 'safety_program', 'Safety manual, OSHA logs, and training proof', false),
    ('Signed Subcontract Agreement', 'signed_subcontract', 'Executed subcontract agreement and terms', false)
) as t(name, code, description, has_expiry)
on conflict (org_id, code) do nothing;

-- 4) Ensure new orgs receive the same expanded system set.
create or replace function public.seed_compliance_document_types()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.compliance_document_types (org_id, name, code, description, has_expiry, is_system)
  values
    (new.id, 'W-9 Form', 'w9', 'IRS tax identification form', false, true),
    (new.id, 'Certificate of Insurance (COI)', 'coi', 'General liability insurance certificate', true, true),
    (new.id, 'Workers Compensation Certificate', 'workers_comp', 'Workers compensation insurance proof', true, true),
    (new.id, 'Contractor License', 'license', 'State or local contractor license', true, true),
    (new.id, 'Auto Insurance Certificate', 'auto_insurance', 'Commercial auto insurance certificate', true, true),
    (new.id, 'Umbrella / Excess Liability', 'umbrella', 'Excess liability policy documentation', true, true),
    (new.id, 'Performance / Payment Bond', 'bond', 'Surety bond certificate when required by contract', true, true),
    (new.id, 'Business License Registration', 'business_license', 'State/local business registration certificate', true, true),
    (new.id, 'Safety Program / OSHA', 'safety_program', 'Safety manual, OSHA logs, and training proof', false, true),
    (new.id, 'Signed Subcontract Agreement', 'signed_subcontract', 'Executed subcontract agreement and terms', false, true)
  on conflict (org_id, code) do nothing;

  return new;
end;
$$;

-- 5) Normalize org compliance rules to the canonical app keys.
with normalized as (
  select
    id,
    case lower(coalesce(compliance_rules ->> 'require_lien_waiver', ''))
      when 'true' then true
      when 'false' then false
      else false
    end as require_lien_waiver,
    case lower(coalesce(compliance_rules ->> 'block_payment_on_missing_docs', ''))
      when 'true' then true
      when 'false' then false
      else true
    end as block_payment_on_missing_docs
  from public.orgs
)
update public.orgs o
set compliance_rules = jsonb_build_object(
  'require_lien_waiver', n.require_lien_waiver,
  'block_payment_on_missing_docs', n.block_payment_on_missing_docs
)
from normalized n
where o.id = n.id;

-- 6) Provide sensible builder defaults for new subcontractor/supplier creation where absent.
update public.orgs o
set default_compliance_requirements = coalesce((
  select jsonb_agg(
    jsonb_build_object(
      'document_type_id', dt.id,
      'is_required', true
    )
    order by dt.code
  )
  from public.compliance_document_types dt
  where dt.org_id = o.id
    and dt.code in ('w9', 'coi', 'workers_comp', 'license', 'auto_insurance')
), '[]'::jsonb)
where coalesce(jsonb_array_length(o.default_compliance_requirements), 0) = 0;
