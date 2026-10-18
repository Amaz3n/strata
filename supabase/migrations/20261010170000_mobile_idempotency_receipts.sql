-- STAGED, UNAPPLIED. Durable receipts for the mobile API's Idempotency-Key
-- header: a replay with the same key and body returns the stored result instead
-- of re-applying the mutation. Written and read only by the service role
-- (lib/mobile/idempotency.ts); the mobile API is not a browser client.
create table public.mobile_idempotency_receipts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  user_id uuid not null,
  idempotency_key text not null check (length(idempotency_key) between 1 and 200),
  request_hash text not null check (length(request_hash) = 64),
  response jsonb,
  status_code integer,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '30 days'),
  unique (org_id, user_id, idempotency_key)
);

-- Retention: lib/mobile/idempotency.ts deletes an org's expired rows each time
-- it claims a new key; this index keeps that purge a range scan.
create index mobile_idempotency_receipts_expiry_idx
  on public.mobile_idempotency_receipts (org_id, expires_at);

alter table public.mobile_idempotency_receipts enable row level security;

create policy mobile_idempotency_receipts_service_access
  on public.mobile_idempotency_receipts
  for all to service_role
  using (true) with check (true);

revoke all on public.mobile_idempotency_receipts from public, anon, authenticated;
grant select, insert, update, delete on public.mobile_idempotency_receipts to service_role;
