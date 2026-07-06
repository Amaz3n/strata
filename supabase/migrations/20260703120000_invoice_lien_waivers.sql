-- Client-facing (receivables) lien waiver exchange on invoices: builders attach a waiver to an invoice;
-- conditional waivers are visible to the payer immediately, and waivers
-- auto-release when the invoice is paid in full.

create table if not exists public.invoice_lien_waivers (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid references public.projects(id) on delete set null,
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  waiver_type text not null default 'conditional_progress',
  status text not null default 'pending_payment',
  amount_cents bigint not null default 0,
  through_date date,
  claimant_name text,
  customer_name text,
  property_description text,
  released_at timestamptz,
  released_by_payment_id uuid references public.payments(id) on delete set null,
  created_by uuid references public.app_users(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint invoice_lien_waivers_type_check
    check (waiver_type in ('conditional_progress', 'unconditional_progress', 'conditional_final', 'unconditional_final')),
  constraint invoice_lien_waivers_status_check
    check (status in ('pending_payment', 'released', 'void'))
);

create index if not exists invoice_lien_waivers_org_idx on public.invoice_lien_waivers (org_id);
create index if not exists invoice_lien_waivers_invoice_idx on public.invoice_lien_waivers (invoice_id);
create index if not exists invoice_lien_waivers_project_idx on public.invoice_lien_waivers (project_id);

alter table public.invoice_lien_waivers enable row level security;

-- Applied to prod via Supabase MCP on 2026-07-03; kept idempotent so a later
-- `db push` replay is harmless.
drop policy if exists "invoice_lien_waivers_org_access" on public.invoice_lien_waivers;
create policy "invoice_lien_waivers_org_access"
  on public.invoice_lien_waivers
  for all
  to authenticated
  using (
    org_id in (
      select memberships.org_id
      from public.memberships
      where memberships.user_id = auth.uid()
        and memberships.status = 'active'
    )
  )
  with check (
    org_id in (
      select memberships.org_id
      from public.memberships
      where memberships.user_id = auth.uid()
        and memberships.status = 'active'
    )
  );

grant all on table public.invoice_lien_waivers to service_role;
