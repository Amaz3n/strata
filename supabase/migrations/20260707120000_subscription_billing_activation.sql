alter table public.subscriptions
  add column if not exists checkout_url text,
  add column if not exists collection_method text
    check (collection_method in ('checkout', 'invoice')),
  add column if not exists net_days integer;
