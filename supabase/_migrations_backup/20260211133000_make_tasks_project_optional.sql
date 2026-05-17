-- Allow personal/global tasks not tied to a project.
alter table public.tasks
  alter column project_id drop not null;
