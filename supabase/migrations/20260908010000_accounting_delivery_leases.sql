-- The lease is independent of business sync status; a deferred contender cannot
-- reset another delivery's status or erase its remote identity.
create table public.accounting_delivery_leases (
  org_id uuid not null references public.orgs(id),
  connection_id uuid not null references public.accounting_connections(id),
  entity_type text not null,
  entity_id uuid not null,
  token uuid not null unique default gen_random_uuid(),
  expires_at timestamptz not null,
  primary key (org_id, connection_id, entity_type, entity_id)
);
alter table public.accounting_delivery_leases enable row level security;
revoke all on public.accounting_delivery_leases from public, anon, authenticated;
grant all on public.accounting_delivery_leases to service_role;

create function public.claim_accounting_delivery(p_org_id uuid, p_connection_id uuid, p_entity_type text, p_entity_id uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_token uuid;
begin
  if not exists(select 1 from accounting_connections where id=p_connection_id and org_id=p_org_id) then
    raise exception 'Accounting connection does not belong to organization';
  end if;
  insert into accounting_delivery_leases(org_id,connection_id,entity_type,entity_id,expires_at)
  values(p_org_id,p_connection_id,p_entity_type,p_entity_id,clock_timestamp()+interval '5 minutes')
  on conflict(org_id,connection_id,entity_type,entity_id) do update
    set token=gen_random_uuid(), expires_at=excluded.expires_at
    where accounting_delivery_leases.expires_at < clock_timestamp()
  returning token into v_token;
  return v_token;
end $$;
create function public.release_accounting_delivery(p_token uuid)
returns void language sql security definer set search_path = public as $$
  delete from accounting_delivery_leases where token=p_token;
$$;
create function public.persist_accounting_delivery(p_token uuid, p_provider text, p_external_id text default null, p_external_version text default null, p_status text default null, p_reason text default null, p_message text default null, p_attempt_id uuid default null, p_fingerprint text default null)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_lease accounting_delivery_leases%rowtype;
begin
  select * into v_lease from accounting_delivery_leases where token=p_token and expires_at>clock_timestamp() for update;
  if not found then return false; end if;
  if not exists(select 1 from accounting_connections where id=v_lease.connection_id and org_id=v_lease.org_id and provider=p_provider) then raise exception 'Accounting provider does not match leased connection'; end if;
  insert into accounting_sync_records(org_id,connection_id,provider,entity_type,entity_id,external_id,external_version,status,status_reason,error_message,last_attempt_id,last_synced_at,metadata)
  values(v_lease.org_id,v_lease.connection_id,p_provider,v_lease.entity_type,v_lease.entity_id,coalesce(nullif(p_external_id,''),''),p_external_version,coalesce(p_status,'processing'),p_reason,left(p_message,4000),p_attempt_id,case when p_status='synced' then now() end,case when p_fingerprint is null then '{}'::jsonb else jsonb_build_object('local_fingerprint',p_fingerprint) end)
  on conflict(org_id,connection_id,entity_type,entity_id) do update set
    external_id=coalesce(nullif(p_external_id,''),accounting_sync_records.external_id),
    external_version=coalesce(p_external_version,accounting_sync_records.external_version),
    status=coalesce(p_status,accounting_sync_records.status),
    status_reason=case when p_status is null then accounting_sync_records.status_reason else p_reason end,
    error_message=case when p_status is null then accounting_sync_records.error_message else left(p_message,4000) end,
    last_attempt_id=coalesce(p_attempt_id,accounting_sync_records.last_attempt_id),
    metadata=case when p_fingerprint is null then accounting_sync_records.metadata else coalesce(accounting_sync_records.metadata,'{}'::jsonb)||jsonb_build_object('local_fingerprint',p_fingerprint) end,
    last_synced_at=case when p_status='synced' then now() else accounting_sync_records.last_synced_at end;
  return true;
end $$;
revoke all on function public.claim_accounting_delivery(uuid,uuid,text,uuid), public.release_accounting_delivery(uuid), public.persist_accounting_delivery(uuid,text,text,text,text,text,text,uuid,text) from public,anon,authenticated;
grant execute on function public.claim_accounting_delivery(uuid,uuid,text,uuid), public.release_accounting_delivery(uuid), public.persist_accounting_delivery(uuid,text,text,text,text,text,text,uuid,text) to service_role;

alter table public.accounting_sync_records drop constraint if exists qbo_sync_records_status_check;
alter table public.accounting_sync_records add constraint accounting_sync_delivery_status_check
  check(status in ('synced','pending','processing','error','conflict','needs_review','skipped','accrued','exported'));

-- Retry one historical failed delivery per dedupe identity; a concurrent new
-- request remains the owner of pending work. Historical failed rows are retained.
create function public.retry_failed_accounting_jobs(p_org_id uuid,p_job_types text[])
returns integer language plpgsql security definer set search_path=public as $$
declare v_job outbox%rowtype; v_count integer:=0;
begin
  for v_job in select * from outbox where org_id=p_org_id and status='failed' and job_type=any(p_job_types) order by id desc for update skip locked loop
    if exists(select 1 from outbox where org_id=p_org_id and status in ('pending','processing') and job_type=v_job.job_type and payload=v_job.payload) then continue; end if;
    begin
      update outbox set status='pending',retry_count=0,last_error=null,run_at=now() where id=v_job.id;
      v_count:=v_count+1;
    exception when unique_violation then null; -- a concurrent enqueue won
    end;
  end loop;
  return v_count;
end $$;
revoke all on function public.retry_failed_accounting_jobs(uuid,text[]) from public,anon,authenticated;
grant execute on function public.retry_failed_accounting_jobs(uuid,text[]) to service_role;

create function public.reconcile_accounting_exhausted_jobs()
returns integer language plpgsql security definer set search_path=public as $$
declare v_count integer;
begin
  with stranded as (
    select s.id,j.last_error from accounting_sync_records s join lateral (
      select o.* from outbox o where o.org_id=s.org_id and o.job_type in ('accounting_push_invoice','accounting_push_project_expense','accounting_push_vendor_bill','accounting_push_payment','accounting_push_bill_payment','accounting_void_bill_payment','qbo_sync_invoice','qbo_sync_project_expense','qbo_sync_vendor_bill','qbo_sync_payment','qbo_sync_bill_payment')
        and coalesce(o.payload->>'invoice_id',o.payload->>'expense_id',o.payload->>'bill_id',o.payload->>'payment_id')=s.entity_id::text
        and (o.payload->>'connection_id' is null or o.payload->>'connection_id'=s.connection_id::text)
      order by o.id desc limit 1
    ) j on j.status='failed'
    where s.status in ('pending','processing')
      and not exists(select 1 from accounting_delivery_leases l where l.org_id=s.org_id and l.connection_id=s.connection_id and l.entity_type=s.entity_type and l.entity_id=s.entity_id and l.expires_at>now())
    limit 200
  ) update accounting_sync_records s set status='error',status_reason='retry_exhausted',error_message=left(coalesce(stranded.last_error,'Accounting job exhausted after an abandoned delivery'),4000)
    from stranded where s.id=stranded.id;
  get diagnostics v_count=row_count;
  return v_count;
end $$;
revoke all on function public.reconcile_accounting_exhausted_jobs() from public,anon,authenticated;
grant execute on function public.reconcile_accounting_exhausted_jobs() to service_role;
