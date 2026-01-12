alter table public.invoices add column if not exists viewed_at timestamptz;
create index if not exists invoices_viewed_at_idx on public.invoices(viewed_at);
;
