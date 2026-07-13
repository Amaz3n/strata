create index if not exists project_locations_parent_org_project_idx
  on public.project_locations (parent_id, org_id, project_id)
  where parent_id is not null;
