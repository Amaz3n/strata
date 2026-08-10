-- Post-deploy advisor hardening for the Procore parity schema.
-- Split read and mutation policies so SELECT predicates do not overlap and so
-- read-only permissions can never authorize DELETE through a FOR ALL policy.

do $$
declare
  target record;
begin
  for target in
    select * from (values
      ('change_events', 'change_events_write', 'change_events.write'),
      ('change_event_lines', 'change_event_lines_write', 'change_events.write'),
      ('change_event_rfqs', 'change_event_rfqs_write', 'change_events.write'),
      ('payment_hold_policies', 'payment_hold_policies_write', 'payments.override_hold'),
      ('payment_hold_overrides', 'payment_hold_overrides_write', 'payments.override_hold'),
      ('photo_albums', 'photo_albums_write', 'docs.upload'),
      ('quick_capture_drafts', 'quick_capture_drafts_write', 'quick_capture.create'),
      ('project_emails', 'project_emails_write', 'correspondence.write')
    ) as policies(table_name, policy_name, permission_key)
  loop
    execute format('drop policy if exists %I on public.%I', target.policy_name, target.table_name);
    execute format(
      'create policy %I on public.%I for insert to authenticated with check (public.has_org_permission(org_id, %L))',
      target.policy_name || '_insert', target.table_name, target.permission_key
    );
    execute format(
      'create policy %I on public.%I for update to authenticated using (public.has_org_permission(org_id, %L)) with check (public.has_org_permission(org_id, %L))',
      target.policy_name || '_update', target.table_name, target.permission_key, target.permission_key
    );
    execute format(
      'create policy %I on public.%I for delete to authenticated using (public.has_org_permission(org_id, %L))',
      target.policy_name || '_delete', target.table_name, target.permission_key
    );
  end loop;
end $$;

drop policy if exists submittal_revisions_access on public.submittal_revisions;
create policy submittal_revisions_read on public.submittal_revisions for select to authenticated
  using (public.has_org_permission(org_id, 'submittal.read'));
create policy submittal_revisions_insert on public.submittal_revisions for insert to authenticated
  with check (public.has_org_permission(org_id, 'submittal.write'));
create policy submittal_revisions_update on public.submittal_revisions for update to authenticated
  using (public.has_org_permission(org_id, 'submittal.write'))
  with check (public.has_org_permission(org_id, 'submittal.write'));
create policy submittal_revisions_delete on public.submittal_revisions for delete to authenticated
  using (public.has_org_permission(org_id, 'submittal.write'));

drop policy if exists submittal_register_drafts_access on public.submittal_register_drafts;
create policy submittal_register_drafts_read on public.submittal_register_drafts for select to authenticated
  using (public.has_org_permission(org_id, 'submittal.read'));
create policy submittal_register_drafts_insert on public.submittal_register_drafts for insert to authenticated
  with check (public.has_org_permission(org_id, 'submittal.write'));
create policy submittal_register_drafts_update on public.submittal_register_drafts for update to authenticated
  using (public.has_org_permission(org_id, 'submittal.write'))
  with check (public.has_org_permission(org_id, 'submittal.write'));
create policy submittal_register_drafts_delete on public.submittal_register_drafts for delete to authenticated
  using (public.has_org_permission(org_id, 'submittal.write'));

drop policy if exists structured_form_runs_access on public.structured_form_runs;
create policy structured_form_runs_read on public.structured_form_runs for select to authenticated
  using (public.has_org_permission(org_id, 'forms.read'));
create policy structured_form_runs_insert on public.structured_form_runs for insert to authenticated
  with check (public.has_org_permission(org_id, 'forms.write'));
create policy structured_form_runs_update on public.structured_form_runs for update to authenticated
  using (public.has_org_permission(org_id, 'forms.write'))
  with check (public.has_org_permission(org_id, 'forms.write'));
create policy structured_form_runs_delete on public.structured_form_runs for delete to authenticated
  using (public.has_org_permission(org_id, 'forms.write'));

drop policy if exists structured_form_responses_access on public.structured_form_responses;
create policy structured_form_responses_read on public.structured_form_responses for select to authenticated
  using (public.has_org_permission(org_id, 'forms.read'));
create policy structured_form_responses_insert on public.structured_form_responses for insert to authenticated
  with check (public.has_org_permission(org_id, 'forms.write'));
create policy structured_form_responses_update on public.structured_form_responses for update to authenticated
  using (public.has_org_permission(org_id, 'forms.write'))
  with check (public.has_org_permission(org_id, 'forms.write'));
create policy structured_form_responses_delete on public.structured_form_responses for delete to authenticated
  using (public.has_org_permission(org_id, 'forms.write'));

drop policy if exists rfi_external_participants_access on public.rfi_external_participants;
create policy rfi_external_participants_read on public.rfi_external_participants for select to authenticated
  using (public.has_org_permission(org_id, 'rfi.read'));
create policy rfi_external_participants_insert on public.rfi_external_participants for insert to authenticated
  with check (public.has_org_permission(org_id, 'rfi.write'));
create policy rfi_external_participants_update on public.rfi_external_participants for update to authenticated
  using (public.has_org_permission(org_id, 'rfi.write'))
  with check (public.has_org_permission(org_id, 'rfi.write'));
create policy rfi_external_participants_delete on public.rfi_external_participants for delete to authenticated
  using (public.has_org_permission(org_id, 'rfi.write'));

drop index if exists public.structured_form_items_template_idx;
