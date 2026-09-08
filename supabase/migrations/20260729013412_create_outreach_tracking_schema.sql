-- RECOVERED FROM PRODUCTION 2026-09-02.
--
-- Applied directly in production and recovered from the Supabase migration
-- ledger so a from-zero replay reproduces the live outreach schema.

create schema if not exists outreach;

create table if not exists outreach.prospects (
  id uuid primary key default gen_random_uuid(),
  token text not null unique,
  company text not null,
  contact_name text,
  contact_email text,
  channel text not null default 'email',
  target_path text not null default '/',
  notes text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  archived_at timestamptz
);

create table if not exists outreach.sessions (
  id uuid primary key default gen_random_uuid(),
  token text not null references outreach.prospects(token) on delete cascade,
  visitor_key text not null,
  is_forward boolean not null default false,
  verdict text not null default 'pending',
  bot_reason text,
  ip_hash text,
  ip_city text,
  ip_region text,
  ip_country text,
  ip_timezone text,
  geo jsonb not null default '{}'::jsonb,
  user_agent text,
  device text,
  os text,
  browser text,
  referrer text,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  unique (token, visitor_key)
);

create table if not exists outreach.events (
  id bigint generated always as identity primary key,
  session_id uuid not null references outreach.sessions(id) on delete cascade,
  token text not null,
  type text not null,
  path text,
  label text,
  value numeric,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists prospects_created_idx on outreach.prospects (created_at desc);
create index if not exists sessions_token_idx on outreach.sessions (token, first_seen desc);
create index if not exists sessions_verdict_idx on outreach.sessions (verdict);
create index if not exists events_session_idx on outreach.events (session_id, created_at);
create index if not exists events_token_idx on outreach.events (token, created_at desc);
create index if not exists events_type_idx on outreach.events (type);

alter table outreach.prospects enable row level security;
alter table outreach.sessions enable row level security;
alter table outreach.events enable row level security;
