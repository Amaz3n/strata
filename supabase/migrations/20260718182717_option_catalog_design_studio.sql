-- Workstream 03: lift residential selections into an org/community option
-- catalog with plan pricing, packages, schedule-derived cutoffs, and design
-- studio appointments. Existing ungrouped selections remain unchanged.

alter table public.selection_categories
  add column if not exists community_id uuid references public.communities(id) on delete cascade,
  add column if not exists parent_category_id uuid references public.selection_categories(id) on delete cascade,
  add column if not exists image_url text,
  add column if not exists is_archived boolean not null default false;

alter table public.selection_options
  add column if not exists option_scope text not null default 'design_studio'
    check (option_scope in ('structural','design_studio')),
  add column if not exists community_id uuid references public.communities(id) on delete cascade,
  add column if not exists parent_option_id uuid references public.selection_options(id) on delete cascade,
  add column if not exists cost_cents integer check (cost_cents is null or cost_cents >= 0),
  add column if not exists cost_code_id uuid references public.cost_codes(id),
  add column if not exists is_archived boolean not null default false;

create table public.selection_packages (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  community_id uuid references public.communities(id) on delete cascade,
  name text not null check (length(btrim(name)) > 0),
  description text,
  image_url text,
  price_cents integer not null check (price_cents >= 0),
  cost_cents integer check (cost_cents is null or cost_cents >= 0),
  is_available boolean not null default true,
  is_archived boolean not null default false,
  sort_order integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.selection_package_items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  package_id uuid not null references public.selection_packages(id) on delete cascade,
  option_id uuid not null references public.selection_options(id) on delete cascade,
  unique (package_id, option_id)
);

create table public.selection_catalog_prices (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  option_id uuid references public.selection_options(id) on delete cascade,
  package_id uuid references public.selection_packages(id) on delete cascade,
  house_plan_version_id uuid not null references public.house_plan_versions(id) on delete cascade,
  community_id uuid references public.communities(id) on delete cascade,
  price_cents integer not null check (price_cents >= 0),
  cost_cents integer check (cost_cents is null or cost_cents >= 0),
  is_available boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint selection_catalog_prices_one_subject check (num_nonnulls(option_id, package_id) = 1)
);

create table public.selection_groups (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  community_id uuid references public.communities(id) on delete cascade,
  name text not null check (length(btrim(name)) > 0),
  sort_order integer not null default 0,
  schedule_task_key text not null check (length(btrim(schedule_task_key)) > 0),
  cutoff_offset_days integer not null default 0 check (cutoff_offset_days between -365 and 365),
  cutoff_anchor text not null default 'start' check (cutoff_anchor in ('start','end')),
  is_archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.selection_group_categories (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  group_id uuid not null references public.selection_groups(id) on delete cascade,
  category_id uuid not null references public.selection_categories(id) on delete cascade,
  unique (group_id, category_id)
);

create table public.project_selection_groups (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  group_id uuid not null references public.selection_groups(id) on delete cascade,
  cutoff_date date,
  cutoff_source text not null default 'schedule' check (cutoff_source in ('schedule','manual_override')),
  override_reason text,
  overridden_by uuid references public.app_users(id) on delete set null,
  status text not null default 'open' check (status in ('open','locked')),
  locked_at timestamptz,
  matched_schedule_item_id uuid references public.schedule_items(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, group_id)
);

alter table public.project_selections
  add column if not exists group_id uuid references public.selection_groups(id),
  add column if not exists package_id uuid references public.selection_packages(id),
  add column if not exists price_cents_snapshot integer,
  add column if not exists cost_cents_snapshot integer,
  add column if not exists locked_at timestamptz,
  add column if not exists source_change_order_id uuid references public.change_orders(id);

create table public.design_studio_appointments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  community_id uuid references public.communities(id) on delete set null,
  project_id uuid not null references public.projects(id) on delete cascade,
  contact_id uuid references public.contacts(id) on delete set null,
  coordinator_user_id uuid references public.app_users(id) on delete set null,
  scheduled_at timestamptz not null,
  duration_minutes integer not null default 120 check (duration_minutes between 15 and 1440),
  location text,
  status text not null default 'scheduled' check (status in ('scheduled','completed','no_show','canceled')),
  group_ids uuid[] not null default '{}',
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.communities
  add column if not exists selection_change_fee_cents integer not null default 25000
    check (selection_change_fee_cents >= 0);

create index selection_categories_community_idx on public.selection_categories (community_id) where community_id is not null;
create index selection_categories_parent_idx on public.selection_categories (parent_category_id) where parent_category_id is not null;
create index selection_options_community_idx on public.selection_options (community_id) where community_id is not null;
create index selection_options_parent_idx on public.selection_options (parent_option_id) where parent_option_id is not null;
create index selection_options_cost_code_idx on public.selection_options (cost_code_id) where cost_code_id is not null;
create index selection_packages_org_community_idx on public.selection_packages (org_id, community_id, sort_order);
create index selection_package_items_org_package_idx on public.selection_package_items (org_id, package_id);
create unique index selection_catalog_prices_option_key on public.selection_catalog_prices
  (option_id, house_plan_version_id, coalesce(community_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where option_id is not null;
create unique index selection_catalog_prices_package_key on public.selection_catalog_prices
  (package_id, house_plan_version_id, coalesce(community_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where package_id is not null;
create index selection_catalog_prices_org_idx on public.selection_catalog_prices (org_id);
create index selection_catalog_prices_plan_idx on public.selection_catalog_prices (house_plan_version_id);
create index selection_groups_org_community_idx on public.selection_groups (org_id, community_id, sort_order);
create index selection_group_categories_org_group_idx on public.selection_group_categories (org_id, group_id);
create index project_selection_groups_project_idx on public.project_selection_groups (org_id, project_id);
create index project_selection_groups_cutoff_idx on public.project_selection_groups (org_id, cutoff_date) where status = 'open';
create index project_selections_group_idx on public.project_selections (org_id, group_id) where group_id is not null;
create index project_selections_source_co_idx on public.project_selections (source_change_order_id) where source_change_order_id is not null;
create index design_studio_appointments_org_time_idx on public.design_studio_appointments (org_id, scheduled_at);
create index design_studio_appointments_project_idx on public.design_studio_appointments (org_id, project_id);

create trigger selection_packages_set_updated_at before update on public.selection_packages
  for each row execute function public.tg_set_updated_at();
create trigger selection_catalog_prices_set_updated_at before update on public.selection_catalog_prices
  for each row execute function public.tg_set_updated_at();
create trigger selection_groups_set_updated_at before update on public.selection_groups
  for each row execute function public.tg_set_updated_at();
create trigger project_selection_groups_set_updated_at before update on public.project_selection_groups
  for each row execute function public.tg_set_updated_at();
create trigger design_studio_appointments_set_updated_at before update on public.design_studio_appointments
  for each row execute function public.tg_set_updated_at();

alter table public.selection_packages enable row level security;
alter table public.selection_package_items enable row level security;
alter table public.selection_catalog_prices enable row level security;
alter table public.selection_groups enable row level security;
alter table public.selection_group_categories enable row level security;
alter table public.project_selection_groups enable row level security;
alter table public.design_studio_appointments enable row level security;

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'selection_packages','selection_package_items','selection_catalog_prices',
    'selection_groups','selection_group_categories','project_selection_groups',
    'design_studio_appointments'
  ] loop
    execute format(
      'create policy %I_org_access on public.%I for all to authenticated using (org_id in (select org_id from public.memberships where user_id = (select auth.uid()) and status = ''active'')) with check (org_id in (select org_id from public.memberships where user_id = (select auth.uid()) and status = ''active''))',
      table_name, table_name
    );
  end loop;
end $$;

grant select, insert, update, delete on
  public.selection_packages,
  public.selection_package_items,
  public.selection_catalog_prices,
  public.selection_groups,
  public.selection_group_categories,
  public.project_selection_groups,
  public.design_studio_appointments
to authenticated;

grant all on
  public.selection_packages,
  public.selection_package_items,
  public.selection_catalog_prices,
  public.selection_groups,
  public.selection_group_categories,
  public.project_selection_groups,
  public.design_studio_appointments
to service_role;

comment on column public.selection_categories.is_template is
  'Retired for catalog mode; retained for backward compatibility with residential selections.';
comment on column public.project_selections.due_date is
  'Residential due date fallback. Catalog-mode selections derive effective deadlines from project_selection_groups.';
