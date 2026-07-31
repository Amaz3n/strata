-- Procore parity P2: shared structured forms, field/document parity steals,
-- and saved/scheduled report delivery.

alter table public.checklist_templates rename to structured_form_templates;
alter table public.checklist_template_items rename to structured_form_items;

-- Keep the currently deployed inspections build operational during the rolling
-- application deploy. These simple security-invoker views remain automatically
-- updatable while preserving the underlying tables' RLS policies. They can be
-- removed after every application instance uses the structured-form names.
create view public.checklist_templates
with (security_invoker = true)
as select * from public.structured_form_templates;

create view public.checklist_template_items
with (security_invoker = true)
as select * from public.structured_form_items;

grant select, insert, update, delete on public.checklist_templates,
  public.checklist_template_items to authenticated;
grant all on public.checklist_templates, public.checklist_template_items to service_role;

alter table public.structured_form_templates drop constraint if exists checklist_templates_kind_check;
alter table public.structured_form_templates add constraint structured_form_templates_kind_check
  check (kind in ('safety','quality','action_plan','general'));

alter table public.structured_form_items drop constraint if exists checklist_template_items_response_type_check;
alter table public.structured_form_items add constraint structured_form_items_response_type_check
  check (response_type in ('pass_fail','yes_no','checkbox','choice','number','text','photo','signature'));
alter table public.structured_form_items
  add column if not exists options jsonb not null default '[]'::jsonb check (jsonb_typeof(options) = 'array'),
  add column if not exists is_required boolean not null default false,
  add column if not exists blocks_completion boolean not null default false;

create table public.structured_form_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  template_id uuid not null references public.structured_form_templates(id) on delete restrict,
  project_id uuid references public.projects(id) on delete cascade,
  lot_id uuid references public.lots(id) on delete set null,
  company_id uuid references public.companies(id) on delete set null,
  title text not null,
  status text not null default 'draft' check (status in ('draft','in_progress','blocked','completed','void')),
  started_by uuid references public.app_users(id) on delete set null,
  completed_by uuid references public.app_users(id) on delete set null,
  completed_at timestamptz,
  pdf_file_id uuid references public.files(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.structured_form_responses (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  run_id uuid not null references public.structured_form_runs(id) on delete cascade,
  item_id uuid not null references public.structured_form_items(id) on delete restrict,
  response jsonb not null default 'null'::jsonb,
  is_failed boolean not null default false,
  note text,
  file_id uuid references public.files(id) on delete set null,
  signature_file_id uuid references public.files(id) on delete set null,
  spawned_entity_type text,
  spawned_entity_id uuid,
  answered_by uuid references public.app_users(id) on delete set null,
  answered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (run_id, item_id)
);

create index structured_form_templates_org_kind_idx on public.structured_form_templates (org_id, kind, is_active);
create index structured_form_items_template_idx on public.structured_form_items (org_id, template_id, sort_order);
create index structured_form_runs_scope_idx on public.structured_form_runs (org_id, project_id, status, created_at desc);
create index structured_form_responses_run_idx on public.structured_form_responses (org_id, run_id);
alter table public.structured_form_runs enable row level security;
alter table public.structured_form_responses enable row level security;
create policy structured_form_runs_access on public.structured_form_runs for all to authenticated
  using (public.has_org_permission(org_id, 'forms.read'))
  with check (public.has_org_permission(org_id, 'forms.write'));
create policy structured_form_responses_access on public.structured_form_responses for all to authenticated
  using (public.has_org_permission(org_id, 'forms.read'))
  with check (public.has_org_permission(org_id, 'forms.write'));
grant select, insert, update, delete on public.structured_form_runs, public.structured_form_responses to authenticated;
grant all on public.structured_form_runs, public.structured_form_responses to service_role;
create trigger structured_form_runs_set_updated_at before update on public.structured_form_runs
  for each row execute function public.tg_set_updated_at();
create trigger structured_form_responses_set_updated_at before update on public.structured_form_responses
  for each row execute function public.tg_set_updated_at();

-- Markup privacy/publishing already existed as is_private + share_with_*.
-- Only inheritance provenance is new.
alter table public.drawing_markups
  add column if not exists carried_from_markup_id uuid references public.drawing_markups(id) on delete set null,
  add column if not exists carried_from_revision_id uuid references public.drawing_sheet_versions(id) on delete set null;
create index drawing_markups_carried_from_idx on public.drawing_markups (org_id, carried_from_markup_id) where carried_from_markup_id is not null;
create unique index drawing_markups_inheritance_unique_idx on public.drawing_markups (sheet_version_id, carried_from_markup_id) where carried_from_markup_id is not null;

create table public.project_weather_cache (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  weather_date date not null,
  provider text not null,
  weather jsonb not null check (jsonb_typeof(weather) = 'object'),
  fetched_at timestamptz not null default now(),
  unique (project_id, weather_date)
);
create index project_weather_cache_org_date_idx on public.project_weather_cache (org_id, weather_date);
alter table public.project_weather_cache enable row level security;
create policy project_weather_cache_read on public.project_weather_cache for select to authenticated
  using (public.has_org_permission(org_id, 'daily_log.read'));
grant select on public.project_weather_cache to authenticated;
grant all on public.project_weather_cache to service_role;

alter table public.safety_incidents
  add column if not exists employee_name text,
  add column if not exists employee_job_title text,
  add column if not exists employee_date_of_birth date,
  add column if not exists date_of_death date,
  add column if not exists days_away_from_work integer not null default 0 check (days_away_from_work >= 0),
  add column if not exists days_job_transfer_restriction integer not null default 0 check (days_job_transfer_restriction >= 0),
  add column if not exists osha_case_type text check (osha_case_type in ('death','days_away','job_transfer_restriction','other_recordable')),
  add column if not exists injury_illness_type text check (injury_illness_type in ('injury','skin_disorder','respiratory_condition','poisoning','hearing_loss','other_illness'));

create table public.rfi_external_participants (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  rfi_id uuid not null references public.rfis(id) on delete cascade,
  email text not null,
  name text,
  portal_token_id uuid references public.portal_access_tokens(id) on delete set null,
  invited_by uuid references public.app_users(id) on delete set null,
  invited_at timestamptz not null default now(),
  last_replied_at timestamptz,
  unique (rfi_id, email)
);
create index rfi_external_participants_rfi_idx on public.rfi_external_participants (org_id, rfi_id);
alter table public.rfi_external_participants enable row level security;
create policy rfi_external_participants_access on public.rfi_external_participants for all to authenticated
  using (public.has_org_permission(org_id, 'rfi.read'))
  with check (public.has_org_permission(org_id, 'rfi.write'));
grant select, insert, update, delete on public.rfi_external_participants to authenticated;
grant all on public.rfi_external_participants to service_role;

create table public.invoice_auto_approval_rules (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  name text not null,
  is_active boolean not null default true,
  max_amount_cents bigint check (max_amount_cents is null or max_amount_cents >= 0),
  company_id uuid references public.companies(id) on delete cascade,
  vendor_trust_tiers text[] not null default '{}',
  require_no_duplicates boolean not null default true,
  created_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index invoice_auto_approval_rules_org_idx on public.invoice_auto_approval_rules (org_id, project_id, is_active);
alter table public.invoice_auto_approval_rules enable row level security;
create policy invoice_auto_approval_rules_access on public.invoice_auto_approval_rules for all to authenticated
  using (public.has_org_permission(org_id, 'bill.approve'))
  with check (public.has_org_permission(org_id, 'bill.approve'));
grant select, insert, update, delete on public.invoice_auto_approval_rules to authenticated;
grant all on public.invoice_auto_approval_rules to service_role;
create trigger invoice_auto_approval_rules_set_updated_at before update on public.invoice_auto_approval_rules
  for each row execute function public.tg_set_updated_at();

create table public.saved_report_configs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  user_id uuid not null references public.app_users(id) on delete cascade,
  name text not null,
  slug text not null,
  scope text not null check (scope in ('org','project')),
  project_id uuid references public.projects(id) on delete cascade,
  division_id uuid references public.divisions(id) on delete set null,
  community_id uuid references public.communities(id) on delete set null,
  params jsonb not null default '{}'::jsonb check (jsonb_typeof(params) = 'object'),
  format text not null default 'pdf' check (format in ('csv','pdf','json')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((scope = 'project' and project_id is not null) or (scope = 'org' and project_id is null))
);

create table public.report_schedules (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  saved_config_id uuid not null references public.saved_report_configs(id) on delete cascade,
  cadence text not null check (cadence in ('daily','weekly','monthly')),
  weekday smallint check (weekday is null or weekday between 0 and 6),
  month_day smallint check (month_day is null or month_day between 1 and 28),
  send_hour_utc smallint not null default 13 check (send_hour_utc between 0 and 23),
  recipient_emails text[] not null,
  is_active boolean not null default true,
  next_run_at timestamptz not null,
  last_run_at timestamptz,
  created_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.report_export_tokens (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  name text not null,
  token_hash text not null unique,
  created_by uuid references public.app_users(id) on delete set null,
  expires_at timestamptz,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index saved_report_configs_user_idx on public.saved_report_configs (org_id, user_id, updated_at desc);
create index report_schedules_due_idx on public.report_schedules (next_run_at) where is_active;
create index report_schedules_org_idx on public.report_schedules (org_id, saved_config_id);
create index report_export_tokens_org_idx on public.report_export_tokens (org_id, revoked_at);
alter table public.saved_report_configs enable row level security;
alter table public.report_schedules enable row level security;
alter table public.report_export_tokens enable row level security;
create policy saved_report_configs_access on public.saved_report_configs for all to authenticated
  using (public.has_org_permission(org_id, 'report.read') and user_id = (select auth.uid()))
  with check (public.has_org_permission(org_id, 'report.read') and user_id = (select auth.uid()));
create policy report_schedules_access on public.report_schedules for all to authenticated
  using (public.has_org_permission(org_id, 'report.schedule'))
  with check (public.has_org_permission(org_id, 'report.schedule'));
create policy report_export_tokens_access on public.report_export_tokens for all to authenticated
  using (public.has_org_permission(org_id, 'report.export.manage'))
  with check (public.has_org_permission(org_id, 'report.export.manage'));
grant select, insert, update, delete on public.saved_report_configs, public.report_schedules, public.report_export_tokens to authenticated;
grant all on public.saved_report_configs, public.report_schedules, public.report_export_tokens to service_role;
create trigger saved_report_configs_set_updated_at before update on public.saved_report_configs
  for each row execute function public.tg_set_updated_at();
create trigger report_schedules_set_updated_at before update on public.report_schedules
  for each row execute function public.tg_set_updated_at();

insert into public.permissions (key, description) values
  ('forms.read', 'Read structured form templates and completed runs'),
  ('forms.write', 'Manage and complete structured forms'),
  ('report.schedule', 'Schedule report delivery'),
  ('report.export.manage', 'Manage report export API tokens')
on conflict (key) do update set description = excluded.description;

insert into public.role_permissions (role_id, permission_key)
select distinct rp.role_id, case rp.permission_key when 'inspection.read' then 'forms.read' when 'inspection.write' then 'forms.write' end
from public.role_permissions rp where rp.permission_key in ('inspection.read','inspection.write')
on conflict (role_id, permission_key) do nothing;

insert into public.role_permissions (role_id, permission_key)
select id, permission_key from public.roles
cross join unnest(array['report.schedule','report.export.manage']) permission_key
where key in ('org_owner','org_admin','org_bookkeeper')
on conflict (role_id, permission_key) do nothing;
