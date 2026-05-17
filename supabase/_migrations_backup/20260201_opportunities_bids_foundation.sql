-- Opportunities + Bid Management foundation (Stage A)

do $$ begin
  create type opportunity_status as enum (
    'new',
    'contacted',
    'qualified',
    'estimating',
    'proposed',
    'won',
    'lost'
  );
exception when duplicate_object then null;
end $$;

create table if not exists opportunities (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  client_contact_id uuid not null references contacts(id),
  name text not null,
  status opportunity_status not null default 'new',
  owner_user_id uuid references app_users(id) on delete set null,
  jobsite_location jsonb,
  project_type text,
  budget_range text,
  timeline_preference text,
  source text,
  tags text[],
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists opportunities_org_status_idx on opportunities (org_id, status);
create index if not exists opportunities_org_client_idx on opportunities (org_id, client_contact_id);
create index if not exists opportunities_org_owner_idx on opportunities (org_id, owner_user_id);

alter table projects
  add column if not exists opportunity_id uuid references opportunities(id) on delete set null;

create index if not exists projects_opportunity_id_idx on projects (opportunity_id);
create unique index if not exists projects_opportunity_id_unique on projects (opportunity_id)
  where opportunity_id is not null;

alter table estimates
  add column if not exists opportunity_id uuid references opportunities(id) on delete set null;

create index if not exists estimates_opportunity_id_idx on estimates (opportunity_id);

alter table proposals
  add column if not exists opportunity_id uuid references opportunities(id) on delete set null;

create index if not exists proposals_opportunity_id_idx on proposals (opportunity_id);

create table if not exists bid_packages (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  title text not null,
  trade text,
  scope text,
  instructions text,
  due_at timestamptz,
  status text not null default 'draft'
    check (status in ('draft', 'sent', 'open', 'closed', 'awarded', 'cancelled')),
  created_by uuid references app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists bid_packages_org_project_status_idx on bid_packages (org_id, project_id, status);
create index if not exists bid_packages_project_due_idx on bid_packages (project_id, due_at);

create table if not exists bid_invites (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  bid_package_id uuid not null references bid_packages(id) on delete cascade,
  company_id uuid not null references companies(id) on delete cascade,
  contact_id uuid references contacts(id) on delete set null,
  invite_email citext,
  status text not null default 'draft'
    check (status in ('draft', 'sent', 'viewed', 'declined', 'submitted', 'withdrawn')),
  sent_at timestamptz,
  last_viewed_at timestamptz,
  submitted_at timestamptz,
  declined_at timestamptz,
  created_by uuid references app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (bid_package_id, company_id)
);

create unique index if not exists bid_invites_package_contact_uidx on bid_invites (bid_package_id, contact_id)
  where contact_id is not null;
create unique index if not exists bid_invites_package_email_uidx on bid_invites (bid_package_id, invite_email)
  where invite_email is not null;

create table if not exists bid_access_tokens (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  bid_invite_id uuid not null references bid_invites(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz,
  max_access_count int,
  access_count int not null default 0,
  last_accessed_at timestamptz,
  pin_required boolean not null default false,
  pin_hash text,
  pin_attempts int not null default 0,
  pin_locked_until timestamptz,
  revoked_at timestamptz,
  created_by uuid references app_users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists bid_access_tokens_invite_idx on bid_access_tokens (bid_invite_id);

create table if not exists bid_submissions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  bid_invite_id uuid not null references bid_invites(id) on delete cascade,
  status text not null default 'submitted'
    check (status in ('draft', 'submitted', 'revised', 'withdrawn')),
  version int not null default 1,
  is_current boolean not null default true,
  total_cents int,
  currency text not null default 'usd',
  valid_until date,
  lead_time_days int,
  duration_days int,
  start_available_on date,
  exclusions text,
  clarifications text,
  notes text,
  submitted_by_name text,
  submitted_by_email citext,
  submitted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists bid_submissions_current_uidx on bid_submissions (bid_invite_id)
  where is_current = true;

create table if not exists bid_awards (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  bid_package_id uuid not null references bid_packages(id) on delete cascade,
  awarded_submission_id uuid not null references bid_submissions(id),
  awarded_commitment_id uuid references commitments(id) on delete set null,
  awarded_by uuid references app_users(id) on delete set null,
  awarded_at timestamptz not null default now(),
  notes text
);

create unique index if not exists bid_awards_package_uidx on bid_awards (bid_package_id);

create table if not exists bid_addenda (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  bid_package_id uuid not null references bid_packages(id) on delete cascade,
  number int not null,
  title text,
  message text,
  issued_at timestamptz not null default now(),
  created_by uuid references app_users(id) on delete set null
);

create unique index if not exists bid_addenda_package_number_uidx on bid_addenda (bid_package_id, number);

create table if not exists bid_addendum_acknowledgements (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  bid_addendum_id uuid not null references bid_addenda(id) on delete cascade,
  bid_invite_id uuid not null references bid_invites(id) on delete cascade,
  acknowledged_at timestamptz not null default now(),
  unique (bid_addendum_id, bid_invite_id)
);

create index if not exists bid_addendum_ack_invite_idx on bid_addendum_acknowledgements (bid_invite_id);

alter table opportunities enable row level security;
alter table bid_packages enable row level security;
alter table bid_invites enable row level security;
alter table bid_access_tokens enable row level security;
alter table bid_submissions enable row level security;
alter table bid_awards enable row level security;
alter table bid_addenda enable row level security;
alter table bid_addendum_acknowledgements enable row level security;

create policy opportunities_access on opportunities
  for all using (auth.role() = 'service_role' or is_org_member(org_id))
  with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy bid_packages_access on bid_packages
  for all using (auth.role() = 'service_role' or is_org_member(org_id))
  with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy bid_invites_access on bid_invites
  for all using (auth.role() = 'service_role' or is_org_member(org_id))
  with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy bid_access_tokens_access on bid_access_tokens
  for all using (auth.role() = 'service_role' or is_org_member(org_id))
  with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy bid_submissions_access on bid_submissions
  for all using (auth.role() = 'service_role' or is_org_member(org_id))
  with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy bid_awards_access on bid_awards
  for all using (auth.role() = 'service_role' or is_org_member(org_id))
  with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy bid_addenda_access on bid_addenda
  for all using (auth.role() = 'service_role' or is_org_member(org_id))
  with check (auth.role() = 'service_role' or is_org_member(org_id));

create policy bid_addendum_acknowledgements_access on bid_addendum_acknowledgements
  for all using (auth.role() = 'service_role' or is_org_member(org_id))
  with check (auth.role() = 'service_role' or is_org_member(org_id));
