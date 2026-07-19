-- Workstream 08 / Phase B2: physical sync-ledger rename plus an updatable
-- compatibility view for old application instances during the deploy window.
set lock_timeout = '5s';
set statement_timeout = '120s';

alter table public.qbo_sync_records rename to accounting_sync_records;
alter table public.accounting_sync_records rename column qbo_id to external_id;
alter table public.accounting_sync_records rename column qbo_sync_token to external_version;
alter table public.accounting_sync_records add column provider text not null default 'qbo';
alter table public.accounting_sync_records
  add constraint accounting_sync_records_provider_check check (provider in ('qbo'));

alter table public.accounting_sync_records
  drop constraint if exists qbo_sync_records_connection_id_fkey;
alter table public.accounting_sync_records
  add constraint accounting_sync_records_connection_id_fkey
  foreign key (connection_id) references public.accounting_connections(id) on delete cascade;

alter index if exists qbo_sync_records_pkey rename to accounting_sync_records_pkey;
alter index if exists qbo_sync_records_entity_idx
  rename to accounting_sync_records_entity_idx;
alter index if exists qbo_sync_records_qbo_idx
  rename to accounting_sync_records_connection_id_external_id_idx;

create index accounting_sync_records_status_idx
  on public.accounting_sync_records (org_id, entity_type, status);

create view public.qbo_sync_records with (security_invoker = true) as
select
  id, org_id, connection_id, entity_type, entity_id,
  external_id as qbo_id, external_version as qbo_sync_token,
  last_synced_at, sync_direction, status, error_message, metadata, created_at,
  pushable
from public.accounting_sync_records;

grant select, insert, update, delete on public.qbo_sync_records to authenticated;
grant all on public.qbo_sync_records to service_role;
grant select, insert, update, delete on public.accounting_sync_records to authenticated;
grant all on public.accounting_sync_records to service_role;

create or replace function public.accounting_claim_sync_create(
  p_org_id uuid,
  p_connection_id uuid,
  p_entity_type text,
  p_entity_id uuid,
  p_stale_after interval default interval '15 minutes'
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed_id uuid;
begin
  if not exists (
    select 1 from public.accounting_connections c
    where c.id = p_connection_id and c.org_id = p_org_id and c.status = 'active'
  ) then
    return false;
  end if;

  insert into public.accounting_sync_records (
    org_id, connection_id, provider, entity_type, entity_id, external_id,
    last_synced_at, status, error_message, metadata
  ) values (
    p_org_id, p_connection_id, 'qbo', p_entity_type, p_entity_id, '',
    now(), 'processing', null, jsonb_build_object('claim_started_at', now())
  )
  on conflict (org_id, entity_type, entity_id)
  do update set
    connection_id = excluded.connection_id,
    provider = excluded.provider,
    status = 'processing',
    error_message = null,
    last_synced_at = now(),
    metadata = coalesce(public.accounting_sync_records.metadata, '{}'::jsonb)
      || jsonb_build_object('claim_started_at', now())
  where coalesce(public.accounting_sync_records.external_id, '') = ''
    and (
      public.accounting_sync_records.status is distinct from 'processing'
      or public.accounting_sync_records.last_synced_at < now() - p_stale_after
    )
  returning id into claimed_id;

  return claimed_id is not null;
end;
$$;

create or replace function public.qbo_claim_sync_create(
  p_org_id uuid,
  p_connection_id uuid,
  p_entity_type text,
  p_entity_id uuid,
  p_stale_after interval default interval '15 minutes'
) returns boolean
language sql
security definer
set search_path = public
as $$
  select public.accounting_claim_sync_create(
    p_org_id, p_connection_id, p_entity_type, p_entity_id, p_stale_after
  );
$$;

revoke all on function public.accounting_claim_sync_create(uuid, uuid, text, uuid, interval) from public;
revoke all on function public.qbo_claim_sync_create(uuid, uuid, text, uuid, interval) from public;
revoke execute on function public.accounting_claim_sync_create(uuid, uuid, text, uuid, interval) from anon, authenticated;
revoke execute on function public.qbo_claim_sync_create(uuid, uuid, text, uuid, interval) from anon, authenticated;
grant execute on function public.accounting_claim_sync_create(uuid, uuid, text, uuid, interval) to service_role;
grant execute on function public.qbo_claim_sync_create(uuid, uuid, text, uuid, interval) to service_role;
