-- Improve team list performance
create index if not exists memberships_org_created_at_idx on public.memberships (org_id, created_at);
create index if not exists memberships_org_status_idx on public.memberships (org_id, status);

-- Speed project count aggregation by org/user
create index if not exists project_members_org_user_idx on public.project_members (org_id, user_id);
