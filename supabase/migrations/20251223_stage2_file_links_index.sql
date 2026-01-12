-- Stage 2 (Unified MVP Gameplan): Documents as Platform Feature - Missing File Links Index
-- Add index on (org_id, project_id) for project-scoped file link queries

create index if not exists file_links_org_project_idx on file_links (org_id, project_id);



