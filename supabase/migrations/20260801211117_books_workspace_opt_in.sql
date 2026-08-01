-- Arc Books is an optional workspace. External accounting connections and their
-- normal sync posture are deliberately independent from this switch.
alter table public.books_settings
  add column workspace_enabled boolean not null default false;

-- An organization that has already completed the controlled Arc-authoritative
-- cutover cannot hide or suspend its official ledger. All external-authority
-- workspaces start disabled and may be opted in again from Settings.
update public.books_settings
set workspace_enabled = true
where ledger_authority = 'arc';

alter table public.books_settings
  add constraint books_settings_official_workspace_enabled_check
  check (ledger_authority <> 'arc' or workspace_enabled);

comment on column public.books_settings.workspace_enabled is
  'Controls the optional Arc Books workspace only; external accounting integrations remain available regardless.';
