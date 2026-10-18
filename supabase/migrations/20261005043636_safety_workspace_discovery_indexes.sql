-- Staged only: apply through the authorized database release process.
-- Supports own-home chronological keyset discovery; no data or grants change.
create index if not exists safety_incidents_org_project_created_id_idx
  on public.safety_incidents (org_id, project_id, created_at desc, id desc);
create index if not exists observations_org_project_created_id_idx
  on public.observations (org_id, project_id, created_at desc, id desc);
create index if not exists toolbox_talks_org_project_created_id_idx
  on public.toolbox_talks (org_id, project_id, created_at desc, id desc);
