alter table public.plans
  add column if not exists stripe_price_id text;

create index if not exists plans_stripe_price_id_idx on public.plans (stripe_price_id);
