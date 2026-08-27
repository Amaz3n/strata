-- Vendor compliance is opt-in from this point forward.
--
-- Preserve the obligations existing vendors see today by materializing each
-- org template item as a company requirement. The application no longer
-- resolves org defaults directly onto every company with a vendor role, so a
-- vendor created after this migration starts with no requirements until a
-- builder explicitly selects them on the Compliance tab.

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
  c.id,
  dt.id,
  true,
  case
    when (template.item ? 'min_coverage_cents')
      and (template.item ->> 'min_coverage_cents') ~ '^[0-9]+$'
      then (template.item ->> 'min_coverage_cents')::bigint
    else null
  end,
  lower(coalesce(template.item ->> 'requires_additional_insured', 'false')) = 'true',
  lower(coalesce(template.item ->> 'requires_primary_noncontributory', 'false')) = 'true',
  lower(coalesce(template.item ->> 'requires_waiver_of_subrogation', 'false')) = 'true',
  nullif(template.item ->> 'notes', '')
from public.directory_entries d
join public.companies c
  on c.id = d.id
 and c.org_id = d.org_id
join public.orgs o
  on o.id = c.org_id
cross join lateral jsonb_array_elements(coalesce(o.default_compliance_requirements, '[]'::jsonb))
  as template(item)
join public.compliance_document_types dt
  on dt.id = (template.item ->> 'document_type_id')::uuid
 and dt.org_id = c.org_id
where d.kind = 'company'
  and d.archived_at is null
  and 'vendor' = any(d.role_categories)
  and lower(coalesce(template.item ->> 'is_required', 'true')) <> 'false'
on conflict (company_id, document_type_id) do nothing;

comment on column public.orgs.default_compliance_requirements is
  'Reusable templates offered when configuring vendor compliance. They are not automatically assigned when a company gains a vendor role.';
