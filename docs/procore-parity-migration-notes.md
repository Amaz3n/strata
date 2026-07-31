# Procore parity migration notes

The Procore parity implementation was deployed to the Arc production Supabase project
on July 31, 2026 through four migrations:

- `20260731120000_procore_parity_p0.sql` — change events/RFQs, payment hold policies
  and overrides, funding links, and forecast snapshot metadata.
- `20260731130000_procore_parity_p1.sql` — photo intelligence, quick capture,
  first-class submittal revisions/register drafts, and project correspondence.
- `20260731140000_procore_parity_p2.sql` — structured forms, drawing inheritance,
  weather, OSHA/RFI/approval additions, and saved/scheduled report exports.
- `20260731150000_procore_parity_advisor_hardening.sql` — splits read and mutation
  policies after the production advisor pass and removes a duplicate renamed index.

All new mutable entities are organization-scoped and use row-level security. User
policies call `has_org_permission`; service-role-only pipelines still constrain every
read and write by `org_id`. The one user-identity policy uses `(select auth.uid())` so
Postgres can evaluate it once per statement. Portal RFQ access is narrowed to one RFQ
through `portal_access_tokens.scoped_change_event_rfq_id`, and report API tokens are
stored only as SHA-256 hashes.

The P2 migration intentionally renames `checklist_templates` and
`checklist_template_items` to the shared structured-form names. Foreign keys remain
attached through PostgreSQL's table rename semantics, and the inspections and plan
instantiation services switch names in the same release. Security-invoker,
automatically-updatable compatibility views keep older application instances working
during the rolling deployment; remove those views after all instances use the new names.

The production migration history records all four migrations. Post-deploy verification
confirmed the new tables, RLS policies, the `project_locations` photo foreign key, and
security-invoker compatibility views. The Supabase advisor reported no security notices
or warning-level performance findings for the new entities after hardening.
