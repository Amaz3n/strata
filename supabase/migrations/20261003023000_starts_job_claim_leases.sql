-- STAGED: do not activate starts lease consumers until this migration is approved,
-- deployed and verified, and legacy starts workers have been drained. This adds
-- claim ownership only; domain write fencing and atomic release commit follow.
alter table public.outbox add column start_claim_token uuid;
alter table public.outbox add column start_job_lease_expires_at timestamptz;
create index outbox_start_lease_expiry_idx on public.outbox(start_job_lease_expires_at,id)
  where status='processing' and start_claim_token is not null;

create function public.claim_starts_jobs(p_limit integer default 2)
returns table(job_id bigint,org_id uuid,job_type text,payload jsonb,retry_count integer,claim_token uuid)
language plpgsql set search_path=public,pg_catalog as $$
begin
  if p_limit is null or p_limit<1 or p_limit>6 then raise exception 'Invalid starts claim limit'; end if;
  return query with picked as (
    select o.id from public.outbox o
    where o.status='pending' and o.run_at<=clock_timestamp()
      and o.job_type in ('start_release','trade_schedule_change_notice','start_release_trade_notice')
    order by o.priority desc,o.created_at,o.id limit p_limit for update skip locked
  ), changed as (update public.outbox o set status='processing',updated_at=clock_timestamp(),
      start_claim_token=gen_random_uuid(),start_job_lease_expires_at=clock_timestamp()+interval '3 minutes'
    from picked where o.id=picked.id
    returning o.id,o.org_id,o.job_type,o.payload,o.retry_count,o.start_claim_token,o.priority,o.created_at)
  select c.id,c.org_id,c.job_type,c.payload,c.retry_count,c.start_claim_token from changed c
    order by c.priority desc,c.created_at,c.id;
end $$;

create function public.transition_starts_job_lease(p_org_id uuid,p_id bigint,p_token uuid,p_action text,p_error text default null)
returns boolean language plpgsql set search_path=public,pg_catalog as $$
declare v_job public.outbox%rowtype;
begin
  if p_action is null or p_action not in ('heartbeat','defer','complete','retry') then raise exception 'Invalid starts lease transition'; end if;
  select * into v_job from public.outbox where id=p_id and org_id=p_org_id
    and job_type in ('start_release','trade_schedule_change_notice','start_release_trade_notice')
    and status='processing' and start_claim_token=p_token
    and start_job_lease_expires_at>clock_timestamp() for update;
  if not found then return false; end if;
  if p_action='heartbeat' then
    update public.outbox set updated_at=clock_timestamp(),start_job_lease_expires_at=clock_timestamp()+interval '3 minutes' where id=p_id;
  elsif p_action='defer' then
    update public.outbox set status='pending',run_at=clock_timestamp()+interval '1 minute',updated_at=clock_timestamp(),
      start_claim_token=null,start_job_lease_expires_at=null where id=p_id;
  elsif p_action='complete' then
    update public.outbox set status='completed',last_error=null,updated_at=clock_timestamp(),
      start_claim_token=null,start_job_lease_expires_at=null where id=p_id;
  else
    update public.outbox set status=case when retry_count+1>=3 then 'failed' else 'pending' end,
      retry_count=retry_count+1,last_error=left(p_error,2000),updated_at=clock_timestamp(),
      run_at=case when retry_count+1>=3 then run_at else clock_timestamp()+make_interval(secs => (power(2,retry_count+1)*60)::integer) end,
      start_claim_token=null,start_job_lease_expires_at=null where id=p_id;
  end if;
  return true;
end $$;

create function public.recover_starts_job_leases(p_limit integer default 500)
returns integer language plpgsql set search_path=public,pg_catalog as $$
declare v_count integer:=0; v_job public.outbox%rowtype;
begin
  if p_limit is null or p_limit<1 or p_limit>500 then raise exception 'Invalid starts recovery limit'; end if;
  for v_job in select * from public.outbox where status='processing' and start_claim_token is not null
    and job_type in ('start_release','trade_schedule_change_notice','start_release_trade_notice')
    and coalesce(start_job_lease_expires_at,updated_at+interval '3 minutes')<=clock_timestamp()
    order by start_job_lease_expires_at nulls first,id limit p_limit for update skip locked
  loop
    update public.outbox set status=case when retry_count+1>=3 then 'failed' else 'pending' end,
      retry_count=retry_count+1,last_error='Starts worker lease expired',run_at=clock_timestamp(),updated_at=clock_timestamp(),
      start_claim_token=null,start_job_lease_expires_at=null where id=v_job.id;
    v_count:=v_count+1;
  end loop;
  return v_count;
end $$;

-- The existing outbox table grants browser roles broad org-member writes.
-- Starts jobs must be server-authored so a browser cannot spoof an actor,
-- reset a processing job or replace ownership through direct table writes.
create function public.guard_starts_job_browser_writes() returns trigger
language plpgsql set search_path=public,pg_catalog as $$
begin
  if current_user in ('anon','authenticated') and (
    (tg_op<>'DELETE' and (new.job_type in ('start_release','trade_schedule_change_notice','start_release_trade_notice') or new.start_claim_token is not null))
    or (tg_op<>'INSERT' and (old.job_type in ('start_release','trade_schedule_change_notice','start_release_trade_notice') or old.start_claim_token is not null))
  ) then raise exception 'Starts jobs must be changed through authorized server actions' using errcode='42501'; end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;
create trigger starts_job_browser_write_guard before insert or update or delete on public.outbox
  for each row execute function public.guard_starts_job_browser_writes();

revoke all on function public.guard_starts_job_browser_writes() from public,anon,authenticated;
revoke all on function public.claim_starts_jobs(integer) from public,anon,authenticated;
revoke all on function public.transition_starts_job_lease(uuid,bigint,uuid,text,text) from public,anon,authenticated;
revoke all on function public.recover_starts_job_leases(integer) from public,anon,authenticated;
grant execute on function public.claim_starts_jobs(integer) to service_role;
grant execute on function public.transition_starts_job_lease(uuid,bigint,uuid,text,text) to service_role;
grant execute on function public.recover_starts_job_leases(integer) to service_role;
