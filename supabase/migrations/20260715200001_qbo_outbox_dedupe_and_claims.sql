alter table public.outbox
  add column if not exists dedupe_key text;

create unique index if not exists outbox_pending_dedupe_key_idx
  on public.outbox (org_id, dedupe_key)
  where status = 'pending' and dedupe_key is not null;

do $$
declare
  constraint_name text;
begin
  select conname into constraint_name
  from pg_constraint
  where conrelid = 'public.qbo_sync_records'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) like '%status%'
    and pg_get_constraintdef(oid) like '%synced%';

  if constraint_name is not null then
    execute format('alter table public.qbo_sync_records drop constraint %I', constraint_name);
  end if;
end $$;

alter table public.qbo_sync_records
  add constraint qbo_sync_records_status_check
  check (status in ('synced', 'pending', 'processing', 'error', 'conflict', 'needs_review'));

create or replace function public.qbo_claim_sync_create(
  p_org_id uuid,
  p_connection_id uuid,
  p_entity_type text,
  p_entity_id uuid,
  p_stale_after interval default interval '15 minutes'
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed_id uuid;
begin
  insert into public.qbo_sync_records (
    org_id,
    connection_id,
    entity_type,
    entity_id,
    qbo_id,
    last_synced_at,
    status,
    error_message,
    metadata
  )
  values (
    p_org_id,
    p_connection_id,
    p_entity_type,
    p_entity_id,
    '',
    now(),
    'processing',
    null,
    jsonb_build_object('claim_started_at', now())
  )
  on conflict (org_id, entity_type, entity_id)
  do update set
    connection_id = excluded.connection_id,
    status = 'processing',
    error_message = null,
    last_synced_at = now(),
    metadata = coalesce(public.qbo_sync_records.metadata, '{}'::jsonb)
      || jsonb_build_object('claim_started_at', now())
  where coalesce(public.qbo_sync_records.qbo_id, '') = ''
    and (
      public.qbo_sync_records.status is distinct from 'processing'
      or public.qbo_sync_records.last_synced_at < now() - p_stale_after
    )
  returning id into claimed_id;

  return claimed_id is not null;
end;
$$;

grant execute on function public.qbo_claim_sync_create(uuid, uuid, text, uuid, interval) to service_role;
