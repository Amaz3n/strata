-- EP13-02: the app shell's project switcher embeds each home's financial settings
-- (PostgREST joins project_financial_settings on project_id alone). Every index on the
-- table leads with org_id, so each embedded row scanned the org's whole index: at the
-- first-builder size (3,000 homes) the shell's project list read ~400,000 buffers and
-- took ~550 ms on every page view. One row per project, looked up by project.
create index if not exists project_financial_settings_project_idx
  on public.project_financial_settings (project_id);
