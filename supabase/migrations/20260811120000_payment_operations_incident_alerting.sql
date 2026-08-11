-- Payment-operations alerts are incidents, not hourly observations.
-- Keep one durable row per organization/finding so repeated watchdog ticks do
-- not create a fresh email until the condition has recovered and reopened.

begin;

alter table public.payment_rail_policies
  add column if not exists reconciliation_monitoring_started_at timestamptz;

-- Existing enabled rails retain their real age where possible. New enablement
-- writes this timestamp explicitly in the application.
update public.payment_rail_policies
set reconciliation_monitoring_started_at = coalesce(last_reconciled_at, updated_at, created_at)
where enabled = true
  and reconciliation_monitoring_started_at is null;

create table if not exists public.payment_operations_incidents (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  finding_code text not null,
  detail text not null,
  status text not null default 'open' check (status in ('open', 'resolved')),
  opened_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  last_notified_at timestamptz not null default now(),
  resolved_at timestamptz,
  unique (org_id, finding_code)
);

create index if not exists payment_operations_incidents_open_idx
  on public.payment_operations_incidents (finding_code, org_id)
  where status = 'open';

alter table public.payment_operations_incidents enable row level security;
revoke all on table public.payment_operations_incidents from anon, authenticated;
revoke all on table public.payment_operations_incidents from service_role;
grant select, insert, update on table public.payment_operations_incidents to service_role;

create or replace function public.sync_payment_operations_incidents(
  p_finding_code text,
  p_active_org_ids uuid[],
  p_detail text
)
returns table (org_id uuid, should_notify boolean)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_org_id uuid;
  v_status text;
begin
  if nullif(btrim(p_finding_code), '') is null then
    raise exception 'finding code is required';
  end if;

  -- Stable lock ordering prevents overlapping batches from deadlocking even if
  -- a future caller supplies the organization IDs in a different order.
  for v_org_id in
    select distinct active.org_id
    from unnest(coalesce(p_active_org_ids, array[]::uuid[])) as active(org_id)
    order by active.org_id
  loop
    -- Makes both the first insert and a resolved -> open transition safe when
    -- two cron invocations overlap.
    perform pg_advisory_xact_lock(
      hashtextextended(v_org_id::text || ':' || p_finding_code, 0)
    );

    select incident.status
    into v_status
    from public.payment_operations_incidents incident
    where incident.org_id = v_org_id
      and incident.finding_code = p_finding_code
    for update;

    if not found then
      insert into public.payment_operations_incidents (
        org_id, finding_code, detail
      ) values (
        v_org_id, p_finding_code, p_detail
      );
      org_id := v_org_id;
      should_notify := true;
      return next;
    elsif v_status = 'resolved' then
      update public.payment_operations_incidents incident
      set detail = p_detail,
          status = 'open',
          opened_at = now(),
          last_seen_at = now(),
          last_notified_at = now(),
          resolved_at = null
      where incident.org_id = v_org_id
        and incident.finding_code = p_finding_code;
      org_id := v_org_id;
      should_notify := true;
      return next;
    else
      update public.payment_operations_incidents incident
      set detail = p_detail,
          last_seen_at = now()
      where incident.org_id = v_org_id
        and incident.finding_code = p_finding_code;
      org_id := v_org_id;
      should_notify := false;
      return next;
    end if;
  end loop;

  update public.payment_operations_incidents incident
  set status = 'resolved',
      resolved_at = now()
  where incident.finding_code = p_finding_code
    and incident.status = 'open'
    and not (incident.org_id = any(coalesce(p_active_org_ids, array[]::uuid[])));
end;
$$;

revoke all on function public.sync_payment_operations_incidents(text, uuid[], text) from public, anon, authenticated;
grant execute on function public.sync_payment_operations_incidents(text, uuid[], text) to service_role;

comment on table public.payment_operations_incidents is
  'Open/resolved watchdog incidents used to notify on state transitions instead of every cron observation.';

commit;
