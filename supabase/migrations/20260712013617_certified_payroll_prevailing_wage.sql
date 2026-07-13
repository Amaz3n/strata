-- Wave 2: prevailing-wage setup and certified payroll reporting.

alter table public.projects
  add column is_public_work boolean not null default false;

create table public.wage_determinations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  project_id uuid not null references public.projects(id),
  determination_number text not null check (length(btrim(determination_number)) > 0),
  source text,
  effective_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, determination_number),
  unique (id, org_id)
);

create table public.wage_classifications (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  determination_id uuid not null,
  classification text not null check (length(btrim(classification)) > 0),
  base_rate_cents integer not null check (base_rate_cents >= 0),
  fringe_rate_cents integer not null default 0 check (fringe_rate_cents >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (determination_id, classification),
  unique (id, org_id),
  constraint wage_classifications_determination_org_fkey
    foreign key (determination_id, org_id) references public.wage_determinations(id, org_id)
);

create table public.payroll_worker_profiles (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  user_id uuid references public.app_users(id),
  display_name text not null check (length(btrim(display_name)) > 0),
  address text,
  tax_id_last4 text check (tax_id_last4 is null or tax_id_last4 ~ '^[0-9]{4}$'),
  default_classification_id uuid,
  fringe_paid_in_cash boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, org_id),
  constraint payroll_worker_profiles_classification_org_fkey
    foreign key (default_classification_id, org_id) references public.wage_classifications(id, org_id)
);

create table public.certified_payroll_reports (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  project_id uuid not null references public.projects(id),
  payroll_number integer not null check (payroll_number > 0),
  week_ending date not null,
  status text not null default 'draft' check (status in ('draft', 'finalized')),
  is_no_work boolean not null default false,
  is_final boolean not null default false,
  pdf_file_id uuid references public.files(id),
  finalized_at timestamptz,
  finalized_by uuid references public.app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint certified_payroll_reports_project_id_payroll_number_key unique (project_id, payroll_number),
  unique (project_id, week_ending),
  unique (id, org_id)
);

create table public.certified_payroll_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  report_id uuid not null,
  worker_profile_id uuid not null,
  classification_id uuid,
  day_hours jsonb not null check (jsonb_typeof(day_hours) = 'object'),
  st_rate_cents integer not null check (st_rate_cents >= 0),
  ot_rate_cents integer not null check (ot_rate_cents >= 0),
  fringe_rate_cents integer not null default 0 check (fringe_rate_cents >= 0),
  gross_this_project_cents integer not null check (gross_this_project_cents >= 0),
  gross_all_projects_cents integer check (gross_all_projects_cents is null or gross_all_projects_cents >= 0),
  deductions jsonb check (deductions is null or jsonb_typeof(deductions) = 'object'),
  net_pay_cents integer check (net_pay_cents is null or net_pay_cents >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (report_id, worker_profile_id),
  constraint certified_payroll_lines_report_org_fkey
    foreign key (report_id, org_id) references public.certified_payroll_reports(id, org_id) on delete cascade,
  constraint certified_payroll_lines_worker_org_fkey
    foreign key (worker_profile_id, org_id) references public.payroll_worker_profiles(id, org_id),
  constraint certified_payroll_lines_classification_org_fkey
    foreign key (classification_id, org_id) references public.wage_classifications(id, org_id)
);

create unique index payroll_worker_profiles_org_user_uidx
  on public.payroll_worker_profiles (org_id, user_id)
  where user_id is not null;
create index wage_determinations_org_project_idx on public.wage_determinations (org_id, project_id);
create index wage_classifications_org_determination_idx on public.wage_classifications (org_id, determination_id);
create index payroll_worker_profiles_org_active_idx on public.payroll_worker_profiles (org_id, is_active, display_name);
create index certified_payroll_reports_org_project_idx on public.certified_payroll_reports (org_id, project_id, payroll_number desc);
create index certified_payroll_reports_pdf_file_idx on public.certified_payroll_reports (pdf_file_id) where pdf_file_id is not null;
create index certified_payroll_lines_org_report_idx on public.certified_payroll_lines (org_id, report_id);
create index certified_payroll_lines_worker_idx on public.certified_payroll_lines (worker_profile_id);
create index certified_payroll_lines_classification_idx on public.certified_payroll_lines (classification_id) where classification_id is not null;

create trigger wage_determinations_set_updated_at before update on public.wage_determinations
  for each row execute function public.tg_set_updated_at();
create trigger wage_classifications_set_updated_at before update on public.wage_classifications
  for each row execute function public.tg_set_updated_at();
create trigger payroll_worker_profiles_set_updated_at before update on public.payroll_worker_profiles
  for each row execute function public.tg_set_updated_at();
create trigger certified_payroll_reports_set_updated_at before update on public.certified_payroll_reports
  for each row execute function public.tg_set_updated_at();
create trigger certified_payroll_lines_set_updated_at before update on public.certified_payroll_lines
  for each row execute function public.tg_set_updated_at();

alter table public.wage_determinations enable row level security;
alter table public.wage_classifications enable row level security;
alter table public.payroll_worker_profiles enable row level security;
alter table public.certified_payroll_reports enable row level security;
alter table public.certified_payroll_lines enable row level security;

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'wage_determinations', 'wage_classifications', 'payroll_worker_profiles',
    'certified_payroll_reports', 'certified_payroll_lines'
  ] loop
    execute format(
      'create policy %I_read on public.%I for select to authenticated using (
        exists (select 1 from public.memberships membership
          where membership.org_id = %I.org_id
            and membership.user_id = (select auth.uid())
            and membership.status = ''active'')
        and public.has_org_permission(%I.org_id, ''payroll.write''))',
      table_name, table_name, table_name, table_name
    );
    execute format(
      'create policy %I_insert on public.%I for insert to authenticated with check (
        exists (select 1 from public.memberships membership
          where membership.org_id = %I.org_id
            and membership.user_id = (select auth.uid())
            and membership.status = ''active'')
        and public.has_org_permission(%I.org_id, ''payroll.write''))',
      table_name, table_name, table_name, table_name
    );
    execute format(
      'create policy %I_update on public.%I for update to authenticated using (
        exists (select 1 from public.memberships membership
          where membership.org_id = %I.org_id
            and membership.user_id = (select auth.uid())
            and membership.status = ''active'')
        and public.has_org_permission(%I.org_id, ''payroll.write''))
       with check (public.has_org_permission(%I.org_id, ''payroll.write''))',
      table_name, table_name, table_name, table_name, table_name
    );
    execute format(
      'create policy %I_delete on public.%I for delete to authenticated using (
        exists (select 1 from public.memberships membership
          where membership.org_id = %I.org_id
            and membership.user_id = (select auth.uid())
            and membership.status = ''active'')
        and public.has_org_permission(%I.org_id, ''payroll.write''))',
      table_name, table_name, table_name, table_name
    );
  end loop;
end $$;

create or replace function public.next_certified_payroll_number(p_project_id uuid)
returns integer
language sql
security invoker
set search_path = public, pg_catalog
as $$
  select coalesce(max(payroll_number), 0) + 1
  from public.certified_payroll_reports
  where project_id = p_project_id;
$$;

grant select, insert, update, delete on table
  public.wage_determinations, public.wage_classifications, public.payroll_worker_profiles,
  public.certified_payroll_reports, public.certified_payroll_lines
  to authenticated;
grant all on table
  public.wage_determinations, public.wage_classifications, public.payroll_worker_profiles,
  public.certified_payroll_reports, public.certified_payroll_lines
  to service_role;
revoke all on function public.next_certified_payroll_number(uuid) from public, anon;
grant execute on function public.next_certified_payroll_number(uuid) to authenticated, service_role;

insert into public.permissions (key, description) values
  ('payroll.write', 'Configure prevailing wages and manage certified payroll')
on conflict (key) do update set description = excluded.description;

insert into public.role_permissions (role_id, permission_key)
select id, 'payroll.write'
from public.roles
where key in ('org_owner', 'org_admin', 'org_office_admin', 'org_bookkeeper', 'pm')
on conflict (role_id, permission_key) do nothing;
