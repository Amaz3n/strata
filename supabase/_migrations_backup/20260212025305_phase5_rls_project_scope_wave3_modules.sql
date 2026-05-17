-- RBAC Phase 5 (Wave 3): tighten remaining project-bound modules
-- (drawings, documents/e-sign, closeout, selections, warranty).

begin;

do $$
declare
  rec record;
begin
  for rec in
    select policyname, tablename
    from pg_policies
    where schemaname = 'public'
      and tablename = any (array[
        'drawing_sets',
        'drawing_sheets',
        'drawing_revisions',
        'drawing_pins',
        'drawing_sheet_versions',
        'drawing_markups',
        'documents',
        'envelopes',
        'closeout_packages',
        'closeout_items',
        'project_selections',
        'warranty_requests',
        'document_fields',
        'document_signing_requests',
        'document_signatures',
        'envelope_recipients',
        'envelope_events'
      ])
  loop
    execute format('drop policy if exists %I on public.%I', rec.policyname, rec.tablename);
  end loop;
end
$$;

do $$
declare
  table_name text;
  policy_name text;
begin
  foreach table_name in array array[
    'drawing_sets',
    'drawing_sheets',
    'drawing_revisions',
    'drawing_pins',
    'documents',
    'envelopes',
    'closeout_packages',
    'closeout_items',
    'project_selections',
    'warranty_requests'
  ] loop
    if to_regclass(format('public.%I', table_name)) is null then
      continue;
    end if;

    policy_name := table_name || '_access';

    execute format(
      $policy$
      create policy %I
      on public.%I
      for all
      using (
        (auth.role() = 'service_role')
        or (
          is_org_member(org_id)
          and (
            project_id is null
            or is_project_member(project_id)
            or is_org_admin_member(org_id)
          )
        )
      )
      with check (
        (auth.role() = 'service_role')
        or (
          is_org_member(org_id)
          and (
            project_id is null
            or is_project_member(project_id)
            or is_org_admin_member(org_id)
          )
        )
      )
      $policy$,
      policy_name,
      table_name
    );
  end loop;
end
$$;

create policy drawing_sheet_versions_access
on public.drawing_sheet_versions
for all
using (
  (auth.role() = 'service_role')
  or (
    is_org_member(org_id)
    and exists (
      select 1
      from public.drawing_sheets ds
      where ds.id = drawing_sheet_versions.drawing_sheet_id
        and ds.org_id = drawing_sheet_versions.org_id
        and (
          ds.project_id is null
          or is_project_member(ds.project_id)
          or is_org_admin_member(drawing_sheet_versions.org_id)
        )
    )
  )
)
with check (
  (auth.role() = 'service_role')
  or (
    is_org_member(org_id)
    and exists (
      select 1
      from public.drawing_sheets ds
      where ds.id = drawing_sheet_versions.drawing_sheet_id
        and ds.org_id = drawing_sheet_versions.org_id
        and (
          ds.project_id is null
          or is_project_member(ds.project_id)
          or is_org_admin_member(drawing_sheet_versions.org_id)
        )
    )
  )
);

create policy drawing_markups_access
on public.drawing_markups
for all
using (
  (auth.role() = 'service_role')
  or (
    is_org_member(org_id)
    and exists (
      select 1
      from public.drawing_sheets ds
      where ds.id = drawing_markups.drawing_sheet_id
        and ds.org_id = drawing_markups.org_id
        and (
          ds.project_id is null
          or is_project_member(ds.project_id)
          or is_org_admin_member(drawing_markups.org_id)
        )
    )
  )
)
with check (
  (auth.role() = 'service_role')
  or (
    is_org_member(org_id)
    and exists (
      select 1
      from public.drawing_sheets ds
      where ds.id = drawing_markups.drawing_sheet_id
        and ds.org_id = drawing_markups.org_id
        and (
          ds.project_id is null
          or is_project_member(ds.project_id)
          or is_org_admin_member(drawing_markups.org_id)
        )
    )
  )
);

create policy document_fields_access
on public.document_fields
for all
using (
  (auth.role() = 'service_role')
  or (
    is_org_member(org_id)
    and exists (
      select 1
      from public.documents d
      where d.id = document_fields.document_id
        and d.org_id = document_fields.org_id
        and (
          d.project_id is null
          or is_project_member(d.project_id)
          or is_org_admin_member(document_fields.org_id)
        )
    )
  )
)
with check (
  (auth.role() = 'service_role')
  or (
    is_org_member(org_id)
    and exists (
      select 1
      from public.documents d
      where d.id = document_fields.document_id
        and d.org_id = document_fields.org_id
        and (
          d.project_id is null
          or is_project_member(d.project_id)
          or is_org_admin_member(document_fields.org_id)
        )
    )
  )
);

create policy document_signing_requests_access
on public.document_signing_requests
for all
using (
  (auth.role() = 'service_role')
  or (
    is_org_member(org_id)
    and exists (
      select 1
      from public.documents d
      where d.id = document_signing_requests.document_id
        and d.org_id = document_signing_requests.org_id
        and (
          d.project_id is null
          or is_project_member(d.project_id)
          or is_org_admin_member(document_signing_requests.org_id)
        )
    )
  )
)
with check (
  (auth.role() = 'service_role')
  or (
    is_org_member(org_id)
    and exists (
      select 1
      from public.documents d
      where d.id = document_signing_requests.document_id
        and d.org_id = document_signing_requests.org_id
        and (
          d.project_id is null
          or is_project_member(d.project_id)
          or is_org_admin_member(document_signing_requests.org_id)
        )
    )
  )
);

create policy document_signatures_access
on public.document_signatures
for all
using (
  (auth.role() = 'service_role')
  or (
    is_org_member(org_id)
    and exists (
      select 1
      from public.documents d
      where d.id = document_signatures.document_id
        and d.org_id = document_signatures.org_id
        and (
          d.project_id is null
          or is_project_member(d.project_id)
          or is_org_admin_member(document_signatures.org_id)
        )
    )
  )
)
with check (
  (auth.role() = 'service_role')
  or (
    is_org_member(org_id)
    and exists (
      select 1
      from public.documents d
      where d.id = document_signatures.document_id
        and d.org_id = document_signatures.org_id
        and (
          d.project_id is null
          or is_project_member(d.project_id)
          or is_org_admin_member(document_signatures.org_id)
        )
    )
  )
);

create policy envelope_recipients_access
on public.envelope_recipients
for all
using (
  (auth.role() = 'service_role')
  or (
    is_org_member(org_id)
    and exists (
      select 1
      from public.envelopes e
      where e.id = envelope_recipients.envelope_id
        and e.org_id = envelope_recipients.org_id
        and (
          e.project_id is null
          or is_project_member(e.project_id)
          or is_org_admin_member(envelope_recipients.org_id)
        )
    )
  )
)
with check (
  (auth.role() = 'service_role')
  or (
    is_org_member(org_id)
    and exists (
      select 1
      from public.envelopes e
      where e.id = envelope_recipients.envelope_id
        and e.org_id = envelope_recipients.org_id
        and (
          e.project_id is null
          or is_project_member(e.project_id)
          or is_org_admin_member(envelope_recipients.org_id)
        )
    )
  )
);

create policy envelope_events_access
on public.envelope_events
for all
using (
  (auth.role() = 'service_role')
  or (
    is_org_member(org_id)
    and exists (
      select 1
      from public.envelopes e
      where e.id = envelope_events.envelope_id
        and e.org_id = envelope_events.org_id
        and (
          e.project_id is null
          or is_project_member(e.project_id)
          or is_org_admin_member(envelope_events.org_id)
        )
    )
  )
)
with check (
  (auth.role() = 'service_role')
  or (
    is_org_member(org_id)
    and exists (
      select 1
      from public.envelopes e
      where e.id = envelope_events.envelope_id
        and e.org_id = envelope_events.org_id
        and (
          e.project_id is null
          or is_project_member(e.project_id)
          or is_org_admin_member(envelope_events.org_id)
        )
    )
  )
);

commit;
