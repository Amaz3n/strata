-- Workstream 09: covering indexes for onboarding/import actor foreign keys.

create index if not exists onboarding_runs_created_by_idx
  on public.onboarding_runs (created_by) where created_by is not null;
create index if not exists import_batches_created_by_idx
  on public.import_batches (created_by) where created_by is not null;
create index if not exists import_mapping_profiles_created_by_idx
  on public.import_mapping_profiles (created_by) where created_by is not null;
