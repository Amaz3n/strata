-- Workstream 06 phases 1-2: lot reservations, sales incentives, and
-- generated asking-price overrides for spec inventory.

create table public.lot_reservations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  community_id uuid not null references public.communities(id),
  lot_id uuid not null references public.lots(id),
  buyer_contact_id uuid not null references public.contacts(id),
  co_buyer_contact_id uuid references public.contacts(id),
  prospect_id uuid references public.prospects(id) on delete set null,
  status text not null default 'hold'
    check (status in ('hold','reserved','converted','released','expired')),
  expires_at timestamptz,
  asking_price_cents bigint check (asking_price_cents is null or asking_price_cents >= 0),
  deposit_required_cents bigint not null default 0 check (deposit_required_cents >= 0),
  deposit_invoice_id uuid references public.invoices(id) on delete set null,
  contract_id uuid references public.contracts(id) on delete set null,
  converted_at timestamptz,
  released_at timestamptz,
  release_reason text,
  notes text,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint lot_reservations_hold_expiry check (status <> 'hold' or expires_at is not null)
);

create index lot_reservations_org_community_idx
  on public.lot_reservations (org_id, community_id, status, created_at desc);
create index lot_reservations_lot_idx on public.lot_reservations (lot_id);
create index lot_reservations_buyer_idx on public.lot_reservations (buyer_contact_id);
create index lot_reservations_co_buyer_idx on public.lot_reservations (co_buyer_contact_id)
  where co_buyer_contact_id is not null;
create index lot_reservations_prospect_idx on public.lot_reservations (prospect_id)
  where prospect_id is not null;
create index lot_reservations_invoice_idx on public.lot_reservations (deposit_invoice_id)
  where deposit_invoice_id is not null;
create index lot_reservations_contract_idx on public.lot_reservations (contract_id)
  where contract_id is not null;
create unique index lot_reservations_live_lot_uniq on public.lot_reservations (lot_id)
  where status in ('hold','reserved','converted');
create index lot_reservations_expiry_idx on public.lot_reservations (org_id, expires_at)
  where status = 'hold';
create index lot_reservations_created_by_idx on public.lot_reservations (created_by)
  where created_by is not null;

create table public.incentives (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  community_id uuid references public.communities(id) on delete cascade,
  name text not null check (length(btrim(name)) > 0),
  incentive_type text not null default 'fixed_amount'
    check (incentive_type in ('fixed_amount','percent_of_base')),
  amount_cents bigint,
  percent numeric(5,2),
  applies_to text not null default 'price'
    check (applies_to in ('price','design_credit')),
  status text not null default 'active'
    check (status in ('draft','active','ended')),
  effective_start date,
  effective_end date,
  max_uses integer check (max_uses is null or max_uses > 0),
  requires_approval boolean not null default false,
  notes text,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint incentives_value_shape check (
    (incentive_type = 'fixed_amount' and amount_cents is not null and amount_cents >= 0 and percent is null)
    or (incentive_type = 'percent_of_base' and percent is not null and percent between 0 and 100 and amount_cents is null)
  ),
  constraint incentives_effective_dates check (
    effective_start is null or effective_end is null or effective_end >= effective_start
  )
);

create index incentives_org_idx on public.incentives (org_id, status, effective_start, effective_end);
create index incentives_community_idx on public.incentives (org_id, community_id, status)
  where community_id is not null;
create index incentives_created_by_idx on public.incentives (created_by)
  where created_by is not null;

alter table public.lots
  add column if not exists asking_price_override_cents bigint
    check (asking_price_override_cents is null or asking_price_override_cents >= 0);

create trigger lot_reservations_set_updated_at before update on public.lot_reservations
  for each row execute function public.tg_set_updated_at();
create trigger incentives_set_updated_at before update on public.incentives
  for each row execute function public.tg_set_updated_at();

alter table public.lot_reservations enable row level security;
alter table public.incentives enable row level security;
create policy lot_reservations_org_access on public.lot_reservations
  for all to authenticated
  using (org_id in (select org_id from public.memberships where user_id = (select auth.uid()) and status = 'active'))
  with check (org_id in (select org_id from public.memberships where user_id = (select auth.uid()) and status = 'active'));
create policy incentives_org_access on public.incentives
  for all to authenticated
  using (org_id in (select org_id from public.memberships where user_id = (select auth.uid()) and status = 'active'))
  with check (org_id in (select org_id from public.memberships where user_id = (select auth.uid()) and status = 'active'));

grant select, insert, update, delete on public.lot_reservations, public.incentives to authenticated;
grant all on public.lot_reservations, public.incentives to service_role;

comment on column public.lots.asking_price_override_cents is
  'Optional sales-manager asking price override; null means derive base price plus lot premium and installed structural options.';
