-- Procore parity P0: change-event exposure, payment release gates, and
-- append-only forecast snapshots. This migration is intentionally additive;
-- production selection changes keep their existing selection-CO workflow.

create table public.change_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  event_number integer not null,
  title text not null,
  description text,
  origin_type text not null default 'manual'
    check (origin_type in ('manual','rfi','drawing_revision','selection','email','tm_ticket','inspection')),
  origin_id uuid,
  scope text not null default 'tbd' check (scope in ('in_scope','out_of_scope','tbd')),
  status text not null default 'open'
    check (status in ('open','pricing','pending_approval','converted','void')),
  rom_cents bigint not null default 0 check (rom_cents >= 0),
  latest_price_cents bigint not null default 0 check (latest_price_cents >= 0),
  created_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, event_number)
);

create table public.change_event_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  change_event_id uuid not null references public.change_events(id) on delete cascade,
  cost_code_id uuid references public.cost_codes(id) on delete set null,
  budget_line_id uuid references public.budget_lines(id) on delete set null,
  description text not null,
  quantity numeric(14,4) not null default 1 check (quantity >= 0),
  uom text,
  unit_cost_cents bigint not null default 0 check (unit_cost_cents >= 0),
  rom_cents bigint not null default 0 check (rom_cents >= 0),
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.change_event_rfqs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  change_event_id uuid not null references public.change_events(id) on delete cascade,
  commitment_id uuid not null references public.commitments(id) on delete cascade,
  status text not null default 'draft'
    check (status in ('draft','sent','responded','declined','expired')),
  due_date date,
  sent_at timestamptz,
  responded_at timestamptz,
  response_amount_cents bigint check (response_amount_cents is null or response_amount_cents >= 0),
  response_notes text,
  created_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (change_event_id, commitment_id)
);

alter table public.change_orders
  add column if not exists change_event_id uuid references public.change_events(id) on delete set null;

alter table public.portal_access_tokens
  add column if not exists scoped_change_event_rfq_id uuid
    references public.change_event_rfqs(id) on delete cascade;

create or replace function public.next_change_event_number(p_project_id uuid)
returns integer
language sql
security invoker
set search_path = public
as $$
  select coalesce(max(event_number), 0) + 1
  from public.change_events
  where project_id = p_project_id;
$$;

create index change_events_org_project_idx on public.change_events (org_id, project_id, status);
create index change_events_origin_idx on public.change_events (org_id, origin_type, origin_id) where origin_id is not null;
create index change_event_lines_event_idx on public.change_event_lines (org_id, change_event_id, sort_order);
create index change_event_lines_cost_code_idx on public.change_event_lines (org_id, cost_code_id) where cost_code_id is not null;
create index change_event_rfqs_event_idx on public.change_event_rfqs (org_id, change_event_id, status);
create index change_event_rfqs_commitment_idx on public.change_event_rfqs (org_id, commitment_id);
create index change_orders_change_event_idx on public.change_orders (org_id, change_event_id) where change_event_id is not null;
create index portal_access_tokens_change_event_rfq_idx on public.portal_access_tokens (scoped_change_event_rfq_id)
  where scoped_change_event_rfq_id is not null;

alter table public.change_events enable row level security;
alter table public.change_event_lines enable row level security;
alter table public.change_event_rfqs enable row level security;

create policy change_events_read on public.change_events for select to authenticated
  using (public.has_org_permission(org_id, 'change_events.read'));
create policy change_events_write on public.change_events for all to authenticated
  using (public.has_org_permission(org_id, 'change_events.write'))
  with check (public.has_org_permission(org_id, 'change_events.write'));
create policy change_event_lines_read on public.change_event_lines for select to authenticated
  using (public.has_org_permission(org_id, 'change_events.read'));
create policy change_event_lines_write on public.change_event_lines for all to authenticated
  using (public.has_org_permission(org_id, 'change_events.write'))
  with check (public.has_org_permission(org_id, 'change_events.write'));
create policy change_event_rfqs_read on public.change_event_rfqs for select to authenticated
  using (public.has_org_permission(org_id, 'change_events.read'));
create policy change_event_rfqs_write on public.change_event_rfqs for all to authenticated
  using (public.has_org_permission(org_id, 'change_events.write'))
  with check (public.has_org_permission(org_id, 'change_events.write'));

grant select, insert, update, delete on public.change_events, public.change_event_lines, public.change_event_rfqs to authenticated;
grant all on public.change_events, public.change_event_lines, public.change_event_rfqs to service_role;
grant execute on function public.next_change_event_number(uuid) to authenticated, service_role;

create trigger change_events_set_updated_at before update on public.change_events
  for each row execute function public.tg_set_updated_at();
create trigger change_event_lines_set_updated_at before update on public.change_event_lines
  for each row execute function public.tg_set_updated_at();
create trigger change_event_rfqs_set_updated_at before update on public.change_event_rfqs
  for each row execute function public.tg_set_updated_at();

-- Holds remain derived. Only policy and human overrides are persisted.
create table public.payment_hold_policies (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  conditions jsonb not null default '{"insurance_current":"block","waiver_signed":"block","compliance_docs_approved":"block","retainage_rules_met":"warn","funding_received":"warn"}'::jsonb
    check (jsonb_typeof(conditions) = 'object'),
  waiver_auto_chase boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index payment_hold_policies_org_default_idx on public.payment_hold_policies (org_id) where project_id is null;
create unique index payment_hold_policies_project_idx on public.payment_hold_policies (org_id, project_id) where project_id is not null;

create table public.payment_hold_overrides (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  bill_id uuid not null references public.vendor_bills(id) on delete cascade,
  hold_kind text not null check (hold_kind in ('insurance_current','waiver_signed','compliance_docs_approved','retainage_rules_met','funding_received')),
  overridden_by uuid not null references public.app_users(id) on delete restrict,
  reason text not null check (length(trim(reason)) >= 8),
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  unique nulls not distinct (bill_id, hold_kind, revoked_at)
);

alter table public.vendor_bills
  add column if not exists funding_invoice_id uuid references public.invoices(id) on delete set null;

create index payment_hold_overrides_bill_idx on public.payment_hold_overrides (org_id, bill_id) where revoked_at is null;
create index vendor_bills_funding_invoice_idx on public.vendor_bills (org_id, funding_invoice_id) where funding_invoice_id is not null;

alter table public.payment_hold_policies enable row level security;
alter table public.payment_hold_overrides enable row level security;
create policy payment_hold_policies_read on public.payment_hold_policies for select to authenticated
  using (public.has_org_permission(org_id, 'payment.release'));
create policy payment_hold_policies_write on public.payment_hold_policies for all to authenticated
  using (public.has_org_permission(org_id, 'payments.override_hold'))
  with check (public.has_org_permission(org_id, 'payments.override_hold'));
create policy payment_hold_overrides_read on public.payment_hold_overrides for select to authenticated
  using (public.has_org_permission(org_id, 'payment.release'));
create policy payment_hold_overrides_write on public.payment_hold_overrides for all to authenticated
  using (public.has_org_permission(org_id, 'payments.override_hold'))
  with check (public.has_org_permission(org_id, 'payments.override_hold'));
grant select on public.payment_hold_policies, public.payment_hold_overrides to authenticated;
grant insert, update, delete on public.payment_hold_policies, public.payment_hold_overrides to authenticated;
grant all on public.payment_hold_policies, public.payment_hold_overrides to service_role;
create trigger payment_hold_policies_set_updated_at before update on public.payment_hold_policies
  for each row execute function public.tg_set_updated_at();

-- Existing by_cost_code JSON is the line-grain snapshot. These columns separate
-- nightly evidence from named/formal close snapshots without another table.
alter table public.budget_snapshots
  add column if not exists source text not null default 'manual' check (source in ('manual','nightly')),
  add column if not exists label text,
  add column if not exists status text not null default 'captured' check (status in ('captured','formal')),
  add column if not exists captured_at timestamptz not null default now();

drop index if exists public.budget_snapshots_unique_idx;
create unique index budget_snapshots_nightly_unique_idx
  on public.budget_snapshots (budget_id, snapshot_date)
  where source = 'nightly';
create index budget_snapshots_compare_idx
  on public.budget_snapshots (org_id, project_id, captured_at desc);

-- Catalog-as-code permission deltas. Change-event grants mirror change orders;
-- hold overrides are intentionally limited to owners/admins/bookkeepers.
insert into public.permissions (key, description) values
  ('change_events.read', 'Read project change events and RFQs'),
  ('change_events.write', 'Create and price project change events and RFQs'),
  ('change_events.convert', 'Convert a change event into a change order'),
  ('payments.override_hold', 'Override a compliance or waiver payment hold')
on conflict (key) do update set description = excluded.description;

insert into public.role_permissions (role_id, permission_key)
select distinct rp.role_id,
  case rp.permission_key
    when 'change_order.read' then 'change_events.read'
    when 'change_order.write' then 'change_events.write'
    when 'change_order.approve' then 'change_events.convert'
  end
from public.role_permissions rp
where rp.permission_key in ('change_order.read','change_order.write','change_order.approve')
on conflict (role_id, permission_key) do nothing;

insert into public.role_permissions (role_id, permission_key)
select id, 'payments.override_hold' from public.roles
where key in ('org_owner','org_admin','org_office_admin')
on conflict (role_id, permission_key) do nothing;
