-- Phase G: make accounting enqueue and delivery state durable and truthful.
--
-- A sync request and its outbox job are committed in one transaction. Blocked
-- requests remain visible as needs_review rows, including the no-target case
-- where there is deliberately no connection id yet.
set lock_timeout = '5s';
set statement_timeout = '120s';

begin;

alter table public.accounting_sync_records
  alter column connection_id drop not null,
  alter column provider drop not null,
  alter column last_synced_at drop not null,
  alter column last_synced_at drop default,
  add column if not exists status_reason text,
  add column if not exists last_attempt_id uuid references public.accounting_sync_attempts(id) on delete set null,
  add column if not exists updated_at timestamptz not null default now();

update public.accounting_sync_records
set updated_at = coalesce(last_synced_at, created_at),
    last_synced_at = case when status = 'synced' then last_synced_at else null end;

drop trigger if exists accounting_sync_records_set_updated_at on public.accounting_sync_records;
create trigger accounting_sync_records_set_updated_at
  before update on public.accounting_sync_records
  for each row execute function public.tg_set_updated_at();

-- NULL connection ids are the durable "no target" bucket. PostgreSQL unique
-- indexes treat NULLs as distinct, so this partial index supplies the missing
-- one-row-per-entity invariant for that bucket.
create unique index if not exists accounting_sync_records_unmapped_entity_idx
  on public.accounting_sync_records (org_id, entity_type, entity_id)
  where connection_id is null;

create index if not exists accounting_sync_records_pending_age_idx
  on public.accounting_sync_records (status, updated_at, org_id)
  where status = 'pending';

create index if not exists accounting_sync_records_reconnect_idx
  on public.accounting_sync_records (connection_id, status_reason, status)
  where status = 'needs_review' and status_reason = 'connection_unhealthy';

create or replace function public.enqueue_accounting_sync_atomic(
  p_org_id uuid,
  p_connection_id uuid,
  p_provider text,
  p_entity_type text,
  p_entity_id uuid,
  p_status text,
  p_status_reason text,
  p_error_message text,
  p_job_type text,
  p_payload jsonb,
  p_dedupe_key text
)
returns table (
  record_id uuid,
  outbox_id bigint,
  enqueued boolean,
  duplicate boolean
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_record_id uuid;
  v_outbox_id bigint;
begin
  if p_org_id is null or p_entity_id is null or nullif(btrim(p_entity_type), '') is null then
    raise exception 'Organization, entity type, and entity id are required';
  end if;
  if p_status not in ('pending', 'needs_review') then
    raise exception 'Accounting enqueue status must be pending or needs_review';
  end if;
  if p_status = 'pending' and (
    p_connection_id is null
    or nullif(btrim(p_provider), '') is null
    or p_job_type not in (
      'accounting_push_invoice',
      'accounting_push_payment',
      'accounting_push_project_expense',
      'accounting_push_vendor_bill',
      'accounting_push_bill_payment'
    )
    or p_payload is null
    or nullif(btrim(p_dedupe_key), '') is null
  ) then
    raise exception 'Queued accounting sync requires a connection, provider, job type, payload, and dedupe key';
  end if;
  if p_connection_id is not null and not exists (
    select 1
    from public.accounting_connections connection
    where connection.id = p_connection_id
      and connection.org_id = p_org_id
      and connection.provider = p_provider
  ) then
    raise exception 'Accounting connection does not belong to this organization/provider';
  end if;

  if p_connection_id is null then
    insert into public.accounting_sync_records (
      org_id, connection_id, provider, entity_type, entity_id, external_id,
      status, status_reason, error_message, updated_at
    ) values (
      p_org_id, null, null, p_entity_type, p_entity_id, '',
      p_status, p_status_reason, left(p_error_message, 4000), now()
    )
    on conflict (org_id, entity_type, entity_id) where connection_id is null
    do update set
      status = excluded.status,
      status_reason = excluded.status_reason,
      error_message = excluded.error_message,
      updated_at = now()
    returning id into v_record_id;
  else
    -- A previously unmapped intent is current state, not historical delivery
    -- evidence. Once a real target exists, retire that null-target placeholder
    -- inside the same transaction that creates the connected state/job.
    delete from public.accounting_sync_records
    where org_id = p_org_id
      and entity_type = p_entity_type
      and entity_id = p_entity_id
      and connection_id is null;

    insert into public.accounting_sync_records (
      org_id, connection_id, provider, entity_type, entity_id, external_id,
      status, status_reason, error_message, updated_at
    ) values (
      p_org_id, p_connection_id, p_provider, p_entity_type, p_entity_id, '',
      p_status, p_status_reason, left(p_error_message, 4000), now()
    )
    on conflict (org_id, connection_id, entity_type, entity_id)
    do update set
      provider = excluded.provider,
      status = excluded.status,
      status_reason = excluded.status_reason,
      error_message = excluded.error_message,
      updated_at = now()
    returning id into v_record_id;
  end if;

  if p_status = 'pending' then
    insert into public.outbox (
      org_id, job_type, payload, dedupe_key, run_at
    ) values (
      p_org_id, p_job_type, p_payload, p_dedupe_key, now()
    )
    on conflict (org_id, dedupe_key)
      where status = 'pending' and dedupe_key is not null
    do nothing
    returning id into v_outbox_id;
  end if;

  record_id := v_record_id;
  outbox_id := v_outbox_id;
  enqueued := v_outbox_id is not null;
  duplicate := p_status = 'pending' and v_outbox_id is null;
  return next;
end;
$$;

revoke all on function public.enqueue_accounting_sync_atomic(
  uuid, uuid, text, text, uuid, text, text, text, text, jsonb, text
) from public, anon, authenticated;
grant execute on function public.enqueue_accounting_sync_atomic(
  uuid, uuid, text, text, uuid, text, text, text, text, jsonb, text
) to service_role;

comment on function public.enqueue_accounting_sync_atomic(
  uuid, uuid, text, text, uuid, text, text, text, text, jsonb, text
) is 'Atomically records accounting sync intent and enqueues its deduplicated outbox job.';

commit;
