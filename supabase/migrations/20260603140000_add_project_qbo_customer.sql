alter table if exists public.projects
  add column if not exists qbo_customer_id text,
  add column if not exists qbo_customer_name text;
