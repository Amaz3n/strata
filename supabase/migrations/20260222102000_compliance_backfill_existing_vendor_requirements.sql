-- Backfill company compliance requirements for existing subcontractors/suppliers
-- based on org-level default_compliance_requirements.

insert into public.company_compliance_requirements (
  org_id,
  company_id,
  document_type_id,
  is_required,
  min_coverage_cents,
  requires_additional_insured,
  requires_primary_noncontributory,
  requires_waiver_of_subrogation,
  notes
)
select
  c.org_id,
  c.id as company_id,
  (req ->> 'document_type_id')::uuid as document_type_id,
  case lower(coalesce(req ->> 'is_required', 'true'))
    when 'false' then false
    else true
  end as is_required,
  case
    when (req ? 'min_coverage_cents') and (req ->> 'min_coverage_cents') ~ '^[0-9]+$'
      then (req ->> 'min_coverage_cents')::bigint
    else null
  end as min_coverage_cents,
  case lower(coalesce(req ->> 'requires_additional_insured', 'false'))
    when 'true' then true
    else false
  end as requires_additional_insured,
  case lower(coalesce(req ->> 'requires_primary_noncontributory', 'false'))
    when 'true' then true
    else false
  end as requires_primary_noncontributory,
  case lower(coalesce(req ->> 'requires_waiver_of_subrogation', 'false'))
    when 'true' then true
    else false
  end as requires_waiver_of_subrogation,
  nullif(req ->> 'notes', '') as notes
from public.companies c
join public.orgs o
  on o.id = c.org_id
cross join lateral jsonb_array_elements(o.default_compliance_requirements) req
left join public.company_compliance_requirements existing
  on existing.company_id = c.id
 and existing.document_type_id = (req ->> 'document_type_id')::uuid
where c.company_type in ('subcontractor', 'supplier')
  and c.org_id is not null
  and existing.id is null;
