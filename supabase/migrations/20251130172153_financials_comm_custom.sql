-- Financials, billing documents, communication, customization
create table if not exists cost_codes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  parent_id uuid references cost_codes(id) on delete set null,
  code text not null,
  name text not null,
  category text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(org_id, code)
);
create index if not exists cost_codes_org_idx on cost_codes(org_id);
create trigger cost_codes_set_updated_at before update on cost_codes for each row execute function public.tg_set_updated_at();

create table if not exists estimates (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  title text not null,
  status text not null default 'draft',
  version integer not null default 1,
  subtotal_cents integer,
  tax_cents integer,
  total_cents integer,
  currency text not null default 'usd',
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists estimates_org_idx on estimates(org_id);
create index if not exists estimates_project_idx on estimates(project_id);
create trigger estimates_set_updated_at before update on estimates for each row execute function public.tg_set_updated_at();

create table if not exists estimate_items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  estimate_id uuid not null references estimates(id) on delete cascade,
  cost_code_id uuid references cost_codes(id) on delete set null,
  item_type text not null default 'line',
  description text not null,
  quantity numeric not null default 1,
  unit text,
  unit_cost_cents integer,
  markup_pct numeric,
  sort_order integer default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists estimate_items_org_idx on estimate_items(org_id);
create index if not exists estimate_items_estimate_idx on estimate_items(estimate_id);

create table if not exists proposals (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  estimate_id uuid references estimates(id) on delete set null,
  recipient_contact_id uuid references contacts(id) on delete set null,
  status text not null default 'draft',
  sent_at timestamptz,
  accepted_at timestamptz,
  rejected_at timestamptz,
  snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists proposals_org_idx on proposals(org_id);
create index if not exists proposals_project_idx on proposals(project_id);
create trigger proposals_set_updated_at before update on proposals for each row execute function public.tg_set_updated_at();

create table if not exists contracts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  proposal_id uuid references proposals(id) on delete set null,
  title text not null,
  status text not null default 'draft',
  total_cents integer,
  currency text not null default 'usd',
  signed_at timestamptz,
  effective_date date,
  terms text,
  snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists contracts_org_idx on contracts(org_id);
create index if not exists contracts_project_idx on contracts(project_id);
create trigger contracts_set_updated_at before update on contracts for each row execute function public.tg_set_updated_at();

create table if not exists change_orders (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  contract_id uuid references contracts(id) on delete set null,
  title text not null,
  description text,
  status text not null default 'draft',
  reason text,
  total_cents integer,
  currency text not null default 'usd',
  requested_by uuid references app_users(id),
  approved_by uuid references app_users(id),
  approved_at timestamptz,
  rejected_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists change_orders_org_idx on change_orders(org_id);
create index if not exists change_orders_project_idx on change_orders(project_id);
create trigger change_orders_set_updated_at before update on change_orders for each row execute function public.tg_set_updated_at();

create table if not exists change_order_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  change_order_id uuid not null references change_orders(id) on delete cascade,
  cost_code_id uuid references cost_codes(id) on delete set null,
  description text not null,
  quantity numeric not null default 1,
  unit text,
  unit_cost_cents integer,
  metadata jsonb not null default '{}'::jsonb,
  sort_order integer default 0
);
create index if not exists change_order_lines_org_idx on change_order_lines(org_id);
create index if not exists change_order_lines_change_order_idx on change_order_lines(change_order_id);

create table if not exists budgets (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  version integer not null default 1,
  status text not null default 'draft',
  total_cents integer,
  currency text not null default 'usd',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists budgets_org_idx on budgets(org_id);
create index if not exists budgets_project_idx on budgets(project_id);
create trigger budgets_set_updated_at before update on budgets for each row execute function public.tg_set_updated_at();

create table if not exists budget_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  budget_id uuid not null references budgets(id) on delete cascade,
  cost_code_id uuid references cost_codes(id) on delete set null,
  description text not null,
  amount_cents integer,
  metadata jsonb not null default '{}'::jsonb,
  sort_order integer default 0
);
create index if not exists budget_lines_org_idx on budget_lines(org_id);
create index if not exists budget_lines_budget_idx on budget_lines(budget_id);

create table if not exists commitments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  company_id uuid references companies(id) on delete set null,
  title text not null,
  status text not null default 'draft',
  total_cents integer,
  currency text not null default 'usd',
  issued_at timestamptz,
  start_date date,
  end_date date,
  external_reference text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists commitments_org_idx on commitments(org_id);
create index if not exists commitments_project_idx on commitments(project_id);
create trigger commitments_set_updated_at before update on commitments for each row execute function public.tg_set_updated_at();

create table if not exists commitment_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  commitment_id uuid not null references commitments(id) on delete cascade,
  cost_code_id uuid references cost_codes(id) on delete set null,
  description text not null,
  quantity numeric not null default 1,
  unit text,
  unit_cost_cents integer,
  metadata jsonb not null default '{}'::jsonb,
  sort_order integer default 0
);
create index if not exists commitment_lines_org_idx on commitment_lines(org_id);
create index if not exists commitment_lines_commitment_idx on commitment_lines(commitment_id);

create table if not exists vendor_bills (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  commitment_id uuid references commitments(id) on delete set null,
  bill_number text,
  status text not null default 'pending',
  bill_date date,
  due_date date,
  total_cents integer,
  currency text not null default 'usd',
  submitted_by_contact_id uuid references contacts(id) on delete set null,
  file_id uuid references files(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists vendor_bills_org_idx on vendor_bills(org_id);
create index if not exists vendor_bills_project_idx on vendor_bills(project_id);
create trigger vendor_bills_set_updated_at before update on vendor_bills for each row execute function public.tg_set_updated_at();

create table if not exists bill_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  bill_id uuid not null references vendor_bills(id) on delete cascade,
  cost_code_id uuid references cost_codes(id) on delete set null,
  description text not null,
  quantity numeric not null default 1,
  unit text,
  unit_cost_cents integer,
  metadata jsonb not null default '{}'::jsonb,
  sort_order integer default 0
);
create index if not exists bill_lines_org_idx on bill_lines(org_id);
create index if not exists bill_lines_bill_idx on bill_lines(bill_id);

create table if not exists invoices (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  invoice_number text,
  status text not null default 'draft',
  issue_date date,
  due_date date,
  total_cents integer,
  currency text not null default 'usd',
  recipient_contact_id uuid references contacts(id) on delete set null,
  file_id uuid references files(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists invoices_org_idx on invoices(org_id);
create index if not exists invoices_project_idx on invoices(project_id);
create trigger invoices_set_updated_at before update on invoices for each row execute function public.tg_set_updated_at();

create table if not exists invoice_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  invoice_id uuid not null references invoices(id) on delete cascade,
  cost_code_id uuid references cost_codes(id) on delete set null,
  description text not null,
  quantity numeric not null default 1,
  unit text,
  unit_price_cents integer,
  metadata jsonb not null default '{}'::jsonb,
  sort_order integer default 0
);
create index if not exists invoice_lines_org_idx on invoice_lines(org_id);
create index if not exists invoice_lines_invoice_idx on invoice_lines(invoice_id);

create table if not exists payments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  invoice_id uuid references invoices(id) on delete set null,
  bill_id uuid references vendor_bills(id) on delete set null,
  amount_cents integer not null,
  currency text not null default 'usd',
  method text,
  reference text,
  received_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists payments_org_idx on payments(org_id);
create index if not exists payments_project_idx on payments(project_id);

create table if not exists receipts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  payment_id uuid references payments(id) on delete cascade,
  file_id uuid references files(id) on delete set null,
  issued_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);
create index if not exists receipts_org_idx on receipts(org_id);

create table if not exists conversations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  subject text,
  channel conversation_channel not null default 'internal',
  created_by uuid references app_users(id),
  created_at timestamptz not null default now()
);
create index if not exists conversations_org_idx on conversations(org_id);
create index if not exists conversations_project_idx on conversations(project_id);

create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  conversation_id uuid not null references conversations(id) on delete cascade,
  sender_id uuid references app_users(id),
  message_type text not null default 'text',
  body text,
  payload jsonb not null default '{}'::jsonb,
  sent_at timestamptz not null default now()
);
create index if not exists messages_org_idx on messages(org_id);
create index if not exists messages_conversation_idx on messages(conversation_id);

create table if not exists mentions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  message_id uuid not null references messages(id) on delete cascade,
  user_id uuid references app_users(id) on delete set null,
  contact_id uuid references contacts(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists mentions_org_idx on mentions(org_id);

create table if not exists notifications (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  user_id uuid not null references app_users(id) on delete cascade,
  notification_type text not null,
  payload jsonb not null default '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists notifications_org_idx on notifications(org_id);
create index if not exists notifications_user_idx on notifications(user_id);

create table if not exists notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  notification_id uuid not null references notifications(id) on delete cascade,
  channel notification_channel not null default 'in_app',
  status text not null default 'pending',
  sent_at timestamptz,
  response jsonb not null default '{}'::jsonb
);
create index if not exists notification_deliveries_org_idx on notification_deliveries(org_id);

create table if not exists custom_fields (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  entity_type text not null,
  key text not null,
  label text not null,
  field_type text not null,
  required boolean not null default false,
  options jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(org_id, entity_type, key)
);
create index if not exists custom_fields_org_idx on custom_fields(org_id);
create trigger custom_fields_set_updated_at before update on custom_fields for each row execute function public.tg_set_updated_at();

create table if not exists custom_field_values (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  field_id uuid not null references custom_fields(id) on delete cascade,
  entity_type text not null,
  entity_id uuid not null,
  value jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(field_id, entity_id)
);
create index if not exists custom_field_values_org_idx on custom_field_values(org_id);
create trigger custom_field_values_set_updated_at before update on custom_field_values for each row execute function public.tg_set_updated_at();

create table if not exists form_templates (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  name text not null,
  entity_type text,
  version integer not null default 1,
  schema jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists form_templates_org_idx on form_templates(org_id);
create trigger form_templates_set_updated_at before update on form_templates for each row execute function public.tg_set_updated_at();

create table if not exists form_instances (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  template_id uuid references form_templates(id) on delete set null,
  entity_type text,
  entity_id uuid,
  status text not null default 'draft',
  created_by uuid references app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists form_instances_org_idx on form_instances(org_id);
create trigger form_instances_set_updated_at before update on form_instances for each row execute function public.tg_set_updated_at();

create table if not exists form_responses (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  form_instance_id uuid references form_instances(id) on delete cascade,
  responder_id uuid references app_users(id),
  responses jsonb not null default '{}'::jsonb,
  submitted_at timestamptz not null default now()
);
create index if not exists form_responses_org_idx on form_responses(org_id);

create table if not exists workflows (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  name text not null,
  trigger text not null,
  conditions jsonb not null default '{}'::jsonb,
  actions jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  created_by uuid references app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists workflows_org_idx on workflows(org_id);
create trigger workflows_set_updated_at before update on workflows for each row execute function public.tg_set_updated_at();

create table if not exists workflow_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  workflow_id uuid not null references workflows(id) on delete cascade,
  status text not null default 'pending',
  payload jsonb not null default '{}'::jsonb,
  result jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  completed_at timestamptz
);
create index if not exists workflow_runs_org_idx on workflow_runs(org_id);
create index if not exists workflow_runs_workflow_idx on workflow_runs(workflow_id);

create table if not exists audit_log (
  id bigserial primary key,
  org_id uuid not null references orgs(id) on delete cascade,
  actor_user_id uuid references app_users(id),
  action audit_action not null,
  entity_type text not null,
  entity_id uuid,
  before_data jsonb,
  after_data jsonb,
  source text,
  ip_address inet,
  created_at timestamptz not null default now()
);
create index if not exists audit_log_org_idx on audit_log(org_id);

create table if not exists events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  event_type text not null,
  entity_type text,
  entity_id uuid,
  payload jsonb not null default '{}'::jsonb,
  channel event_channel not null default 'activity',
  created_at timestamptz not null default now(),
  processed_at timestamptz
);
create index if not exists events_org_idx on events(org_id);

create table if not exists outbox (
  id bigserial primary key,
  org_id uuid not null references orgs(id) on delete cascade,
  event_id uuid references events(id) on delete cascade,
  job_type text not null,
  status text not null default 'pending',
  run_at timestamptz not null default now(),
  retry_count integer not null default 0,
  last_error text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists outbox_org_idx on outbox(org_id);
create trigger outbox_set_updated_at before update on outbox for each row execute function public.tg_set_updated_at();;
