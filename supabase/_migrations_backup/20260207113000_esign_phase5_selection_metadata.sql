alter table public.project_selections
  add column if not exists metadata jsonb not null default '{}'::jsonb;
