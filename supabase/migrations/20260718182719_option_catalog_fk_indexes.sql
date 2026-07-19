-- Workstream 03 performance hardening: cover foreign-key paths introduced by
-- the option catalog and design studio schema. Existing indexes are retained.

create index design_studio_appointments_community_fk_idx
  on public.design_studio_appointments (community_id);
create index design_studio_appointments_contact_fk_idx
  on public.design_studio_appointments (contact_id);
create index design_studio_appointments_coordinator_fk_idx
  on public.design_studio_appointments (coordinator_user_id);
create index design_studio_appointments_project_fk_idx
  on public.design_studio_appointments (project_id);

create index project_selection_groups_group_fk_idx
  on public.project_selection_groups (group_id);
create index project_selection_groups_schedule_item_fk_idx
  on public.project_selection_groups (matched_schedule_item_id);
create index project_selection_groups_overridden_by_fk_idx
  on public.project_selection_groups (overridden_by);

create index selection_catalog_prices_community_fk_idx
  on public.selection_catalog_prices (community_id);
create index selection_group_categories_category_fk_idx
  on public.selection_group_categories (category_id);
create index selection_groups_community_fk_idx
  on public.selection_groups (community_id);
create index selection_package_items_option_fk_idx
  on public.selection_package_items (option_id);
create index selection_packages_community_fk_idx
  on public.selection_packages (community_id);

create index project_selections_group_fk_idx
  on public.project_selections (group_id);
create index project_selections_package_fk_idx
  on public.project_selections (package_id);
