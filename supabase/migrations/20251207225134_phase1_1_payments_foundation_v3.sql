-- Phase 1.1 payments foundation schema changes (policyname fix)
-- Add invoice financial columns
alter table if exists invoices add column if not exists balance_due_cents integer;
alter table if exists invoices add column if not exists tax_rate numeric;

-- Draw schedules
do $$ begin
  create table if not exists draw_schedules (
    id uuid primary key default gen_random_uuid(),
    org_id uuid not null references orgs(id) on delete cascade,
    project_id uuid not null references projects(id) on delete cascade,
    invoice_id uuid references invoices(id) on delete set null,
    contract_id uuid references contracts(id) on delete set null,
    draw_number integer not null,
    title text not null,
    description text,
    amount_cents integer not null check (amount_cents >= 0),
    percent_of_contract numeric,
    due_date date,
    due_trigger text,
    milestone_id uuid references schedule_items(id) on delete set null,
    status text not null default 'pending' check (status in ('pending','invoiced','partial','paid')),
    invoiced_at timestamptz,
    paid_at timestamptz,
    metadata jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  );
end $$;
create index if not exists draw_schedules_org_idx on draw_schedules (org_id);
create index if not exists draw_schedules_project_idx on draw_schedules (project_id);
create index if not exists draw_schedules_status_idx on draw_schedules (status);
create unique index if not exists draw_schedules_project_number_idx on draw_schedules (project_id, draw_number);

-- Lien waivers
create table if not exists lien_waivers (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  payment_id uuid references payments(id) on delete set null,
  company_id uuid references companies(id) on delete set null,
  contact_id uuid references contacts(id) on delete set null,
  waiver_type text not null check (waiver_type in ('conditional','unconditional','final')),
  status text not null default 'pending' check (status in ('pending','sent','signed','rejected','expired')),
  amount_cents integer not null check (amount_cents >= 0),
  through_date date not null,
  claimant_name text not null,
  property_description text,
  document_file_id uuid references files(id) on delete set null,
  signed_file_id uuid references files(id) on delete set null,
  signature_data jsonb,
  sent_at timestamptz,
  signed_at timestamptz,
  expires_at timestamptz,
  token_hash text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists lien_waivers_org_idx on lien_waivers (org_id);
create index if not exists lien_waivers_project_idx on lien_waivers (project_id);
create index if not exists lien_waivers_payment_idx on lien_waivers (payment_id);
create index if not exists lien_waivers_status_idx on lien_waivers (status);
create unique index if not exists lien_waivers_token_idx on lien_waivers (token_hash) where token_hash is not null;

-- Payment schedules (recurring/plan)
create table if not exists payment_schedules (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  contact_id uuid references contacts(id) on delete set null,
  payment_method_id uuid references payment_methods(id) on delete set null,
  total_amount_cents integer not null check (total_amount_cents > 0),
  installment_amount_cents integer not null check (installment_amount_cents > 0),
  installments_total integer not null check (installments_total > 0),
  installments_paid integer not null default 0,
  frequency text not null default 'monthly' check (frequency in ('weekly','biweekly','monthly')),
  next_charge_date date,
  status text not null default 'active' check (status in ('active','paused','completed','canceled','failed')),
  auto_charge boolean not null default false,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists payment_schedules_org_idx on payment_schedules (org_id);
create index if not exists payment_schedules_next_charge_idx on payment_schedules (next_charge_date) where status = 'active';

-- Reminder delivery tracking (with immutable generated date column)
create table if not exists reminder_deliveries (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  reminder_id uuid not null references reminders(id) on delete cascade,
  invoice_id uuid not null references invoices(id) on delete cascade,
  channel text not null,
  status text not null default 'pending' check (status in ('pending','sent','delivered','failed','clicked')),
  sent_at timestamptz,
  delivered_at timestamptz,
  clicked_at timestamptz,
  error_message text,
  provider_message_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  created_on date generated always as ((created_at at time zone 'utc')::date) stored
);
create index if not exists reminder_deliveries_org_idx on reminder_deliveries (org_id);
create index if not exists reminder_deliveries_invoice_idx on reminder_deliveries (invoice_id);
create unique index if not exists reminder_deliveries_unique_idx on reminder_deliveries (reminder_id, invoice_id, channel, created_on);

-- Late fee applications
create table if not exists late_fee_applications (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  invoice_id uuid not null references invoices(id) on delete cascade,
  late_fee_rule_id uuid not null references late_fees(id) on delete cascade,
  invoice_line_id uuid references invoice_lines(id) on delete set null,
  amount_cents integer not null check (amount_cents > 0),
  applied_at timestamptz not null default now(),
  application_number integer not null,
  metadata jsonb not null default '{}'::jsonb
);
create index if not exists late_fee_applications_org_idx on late_fee_applications (org_id);
create index if not exists late_fee_applications_invoice_idx on late_fee_applications (invoice_id);
create unique index if not exists late_fee_applications_unique_idx on late_fee_applications (invoice_id, late_fee_rule_id, application_number);

-- updated_at triggers (idempotent guards)
do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'draw_schedules_set_updated_at') then
    create trigger draw_schedules_set_updated_at before update on draw_schedules for each row execute function public.tg_set_updated_at();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'lien_waivers_set_updated_at') then
    create trigger lien_waivers_set_updated_at before update on lien_waivers for each row execute function public.tg_set_updated_at();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'payment_schedules_set_updated_at') then
    create trigger payment_schedules_set_updated_at before update on payment_schedules for each row execute function public.tg_set_updated_at();
  end if;
end $$;

-- Enable RLS
alter table if exists draw_schedules enable row level security;
alter table if exists lien_waivers enable row level security;
alter table if exists payment_schedules enable row level security;
alter table if exists reminder_deliveries enable row level security;
alter table if exists late_fee_applications enable row level security;

-- RLS policies (idempotent)
do $$ begin
  if not exists (select 1 from pg_policies where policyname = 'draw_schedules_access') then
    create policy "draw_schedules_access" on draw_schedules for all using (auth.role() = 'service_role' or is_org_member(org_id)) with check (auth.role() = 'service_role' or is_org_member(org_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'lien_waivers_access') then
    create policy "lien_waivers_access" on lien_waivers for all using (auth.role() = 'service_role' or is_org_member(org_id)) with check (auth.role() = 'service_role' or is_org_member(org_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'payment_schedules_access') then
    create policy "payment_schedules_access" on payment_schedules for all using (auth.role() = 'service_role' or is_org_member(org_id)) with check (auth.role() = 'service_role' or is_org_member(org_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'reminder_deliveries_access') then
    create policy "reminder_deliveries_access" on reminder_deliveries for all using (auth.role() = 'service_role' or is_org_member(org_id)) with check (auth.role() = 'service_role' or is_org_member(org_id));
  end if;
  if not exists (select 1 from pg_policies where policyname = 'late_fee_applications_access') then
    create policy "late_fee_applications_access" on late_fee_applications for all using (auth.role() = 'service_role' or is_org_member(org_id)) with check (auth.role() = 'service_role' or is_org_member(org_id));
  end if;
end $$;;
