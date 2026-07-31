# Procore parity migration notes

The Procore parity implementation is split into three unapplied migrations for human
review:

- `20260731120000_procore_parity_p0.sql` — change events/RFQs, payment hold policies
  and overrides, funding links, and forecast snapshot metadata.
- `20260731130000_procore_parity_p1.sql` — photo intelligence, quick capture,
  first-class submittal revisions/register drafts, and project correspondence.
- `20260731140000_procore_parity_p2.sql` — structured forms, drawing inheritance,
  weather, OSHA/RFI/approval additions, and saved/scheduled report exports.

All new mutable entities are organization-scoped and use row-level security. User
policies call `has_org_permission`; service-role-only pipelines still constrain every
read and write by `org_id`. The one user-identity policy uses `(select auth.uid())` so
Postgres can evaluate it once per statement. Portal RFQ access is narrowed to one RFQ
through `portal_access_tokens.scoped_change_event_rfq_id`, and report API tokens are
stored only as SHA-256 hashes.

The P2 migration intentionally renames `checklist_templates` and
`checklist_template_items` to the shared structured-form names. Foreign keys remain
attached through PostgreSQL's table rename semantics, and the inspections and plan
instantiation services switch names in the same release so there is no parallel path.

These migrations have not been applied by Codex. Review and apply them in timestamp
order using the repository's normal Supabase deployment process. After application,
regenerate database types if the deployment workflow does not already do so, then
smoke-test change-event conversion, portal RFQ submission, held bill payment, an
inspection run, and scheduled report delivery in a staging organization.
