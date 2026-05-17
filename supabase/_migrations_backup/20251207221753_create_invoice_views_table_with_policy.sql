create table if not exists public.invoice_views (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  token text,
  user_agent text,
  ip_address text,
  viewed_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists invoice_views_invoice_idx on public.invoice_views(invoice_id);
create index if not exists invoice_views_org_idx on public.invoice_views(org_id);
create index if not exists invoice_views_viewed_at_idx on public.invoice_views(viewed_at);

alter table public.invoice_views enable row level security;

create policy invoice_views_access on public.invoice_views
  for select using (auth.role() = 'service_role' or is_org_member(org_id));
;
