-- Workstream 02 performance hardening: cover every newly introduced foreign key
-- that is not already the leading edge of a primary, unique, or regular index.

create index budget_template_lines_budget_template_idx
  on public.budget_template_lines (budget_template_id);
create index budget_templates_created_by_idx
  on public.budget_templates (created_by) where created_by is not null;
create index budget_templates_division_fk_idx
  on public.budget_templates (division_id) where division_id is not null;

create index community_plan_availability_elevation_idx
  on public.community_plan_availability (elevation_id) where elevation_id is not null;
create index community_plan_availability_house_plan_idx
  on public.community_plan_availability (house_plan_id);

create index house_plan_elevations_cover_file_idx
  on public.house_plan_elevations (cover_file_id) where cover_file_id is not null;

create index house_plan_takeoff_lines_elevation_idx
  on public.house_plan_takeoff_lines (elevation_id) where elevation_id is not null;
create index house_plan_takeoff_lines_version_idx
  on public.house_plan_takeoff_lines (house_plan_version_id);

create index house_plan_versions_budget_template_idx
  on public.house_plan_versions (budget_template_id) where budget_template_id is not null;
create index house_plan_versions_created_by_idx
  on public.house_plan_versions (created_by) where created_by is not null;
create index house_plan_versions_drawing_source_file_idx
  on public.house_plan_versions (drawing_source_file_id) where drawing_source_file_id is not null;
create index house_plan_versions_released_by_idx
  on public.house_plan_versions (released_by) where released_by is not null;
create index house_plan_versions_schedule_template_idx
  on public.house_plan_versions (schedule_template_id) where schedule_template_id is not null;

create index house_plans_cover_file_idx
  on public.house_plans (cover_file_id) where cover_file_id is not null;
create index house_plans_created_by_idx
  on public.house_plans (created_by) where created_by is not null;
create index house_plans_division_fk_idx
  on public.house_plans (division_id) where division_id is not null;

create index lots_house_plan_elevation_idx
  on public.lots (house_plan_elevation_id) where house_plan_elevation_id is not null;
create index lots_house_plan_idx
  on public.lots (house_plan_id) where house_plan_id is not null;
