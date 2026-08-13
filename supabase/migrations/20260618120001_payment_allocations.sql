-- Allow one receivable payment to be applied across multiple invoices/draws.

create table if not exists public.payment_allocations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid references public.projects(id) on delete set null,
  payment_id uuid not null references public.payments(id) on delete cascade,
  invoice_id uuid references public.invoices(id) on delete cascade,
  bill_id uuid references public.vendor_bills(id) on delete cascade,
  amount_cents integer not null check (amount_cents > 0),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payment_allocations_one_target_chk check (
    (invoice_id is not null and bill_id is null)
    or (invoice_id is null and bill_id is not null)
  )
);

create unique index if not exists payment_allocations_invoice_uq
  on public.payment_allocations (payment_id, invoice_id)
  where invoice_id is not null;

create unique index if not exists payment_allocations_bill_uq
  on public.payment_allocations (payment_id, bill_id)
  where bill_id is not null;

create index if not exists payment_allocations_org_invoice_idx
  on public.payment_allocations (org_id, invoice_id);

create index if not exists payment_allocations_org_bill_idx
  on public.payment_allocations (org_id, bill_id);

create index if not exists payment_allocations_org_payment_idx
  on public.payment_allocations (org_id, payment_id);

drop trigger if exists payment_allocations_set_updated_at on public.payment_allocations;
create trigger payment_allocations_set_updated_at
  before update on public.payment_allocations
  for each row execute function public.tg_set_updated_at();

alter table public.payment_allocations enable row level security;

drop policy if exists payment_allocations_access on public.payment_allocations;
create policy payment_allocations_access on public.payment_allocations
  for all
  using ((auth.role() = 'service_role'::text) or public.is_org_member(org_id))
  with check ((auth.role() = 'service_role'::text) or public.is_org_member(org_id));

grant all on table public.payment_allocations to anon, authenticated, service_role;
