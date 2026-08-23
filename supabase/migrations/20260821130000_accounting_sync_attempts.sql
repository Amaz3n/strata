-- Per-attempt accounting sync trace.
--
-- `accounting_sync_records` is current state with the error overwritten in
-- place, so "why did this invoice post twice / why did the number change at
-- 03:14" was unanswerable from the product. This is the append-only log the
-- History tab and an on-call engineer can actually read. Rows are telemetry:
-- org-scoped read for members, writes only from the service role.
set lock_timeout = '5s';
set statement_timeout = '120s';

create table public.accounting_sync_attempts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  connection_id uuid references public.accounting_connections(id) on delete set null,
  provider text not null,
  entity_type text not null,
  -- Null for inbound events whose remote record has no Arc counterpart yet.
  entity_id uuid,
  external_id text,
  direction text not null check (direction in ('outbound', 'inbound')),
  outcome text not null check (outcome in ('synced', 'skipped', 'deferred', 'error', 'needs_review', 'conflict')),
  message text,
  created_at timestamptz not null default now()
);

create index accounting_sync_attempts_org_entity_idx
  on public.accounting_sync_attempts (org_id, entity_type, entity_id, created_at desc);
create index accounting_sync_attempts_org_created_idx
  on public.accounting_sync_attempts (org_id, created_at desc);
create index accounting_sync_attempts_connection_idx
  on public.accounting_sync_attempts (connection_id)
  where connection_id is not null;

alter table public.accounting_sync_attempts enable row level security;

-- Members can read their org's trace; only the service role writes it.
create policy "accounting_sync_attempts_select" on public.accounting_sync_attempts
  for select using (
    exists (
      select 1 from public.memberships m
      where m.org_id = accounting_sync_attempts.org_id
        and m.user_id = (select auth.uid())
        and m.status = 'active'
    )
  );

grant select on public.accounting_sync_attempts to authenticated;
grant all on public.accounting_sync_attempts to service_role;
