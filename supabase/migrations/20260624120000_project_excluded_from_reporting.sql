-- Per-project toggle to keep test / friends-and-family jobs out of org-wide
-- financial rollups. When true the project is omitted from Control Tower
-- metrics and org-wide reports, but stays fully usable in its own views
-- (its detail pages and single-project reports still include it).
alter table public.projects
  add column if not exists excluded_from_reporting boolean not null default false;

comment on column public.projects.excluded_from_reporting is
  'When true, omit this project from Control Tower metrics and org-wide financial reports. The project remains fully usable in its own views and single-project reports.';
