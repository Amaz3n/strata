-- Warranty coverage for residential/commercial projects.
--
-- Production homes start the coverage clock at closings.actual_date. Residential
-- and commercial projects have no closing, so their clock starts at substantial
-- completion — stamped when the closeout package flips to complete.

alter table public.closeout_packages
  add column if not exists substantial_completion_date date;

comment on column public.closeout_packages.substantial_completion_date is
  'Date the package first reached complete. Starts the warranty coverage clock for non-production projects.';

alter table public.project_warranty_coverage
  drop constraint if exists project_warranty_coverage_effective_source_check;

alter table public.project_warranty_coverage
  add constraint project_warranty_coverage_effective_source_check
  check (effective_source = any (array['closing'::text, 'completion'::text, 'manual'::text]));
