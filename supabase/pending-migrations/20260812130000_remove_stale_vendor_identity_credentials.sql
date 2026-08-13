-- DESTRUCTIVE — pending human approval.
-- Login credentials and activity are owned by external_identities. These
-- columns are stale compatibility copies and no application code reads them.

begin;

alter table public.vendor_portal_identities
  drop column if exists password_hash,
  drop column if exists last_authenticated_at;

commit;
