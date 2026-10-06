-- A close that stops between its freeze and its lock (a deploy, a timeout, a
-- crash) used to leave the period in 'reviewing' forever: operational postings
-- refused, a new close refused as "already running", no cure. The freeze now
-- records when and from which status it started; a freeze older than 30
-- minutes is abandoned and the next close resumes it. The actor argument
-- defaults so callers that predate it keep working.
alter table public.accounting_periods
  add column close_started_at timestamptz,
  add column close_started_by uuid,
  add column close_prior_status text
    constraint accounting_periods_close_prior_status_check check (close_prior_status in ('open', 'reopened'));

comment on column public.accounting_periods.close_started_at is
  'When the current close froze the period; a reviewing period older than 30 minutes is an abandoned close that the next close resumes.';

drop function public.begin_books_period_close(uuid, uuid);

create function public.begin_books_period_close(
  p_org_id uuid,
  p_period_id uuid,
  p_actor_id uuid default null
) returns text
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  period public.accounting_periods%rowtype;
begin
  select * into period
  from public.accounting_periods
  where id = p_period_id and org_id = p_org_id
  for update;

  if period.id is null then
    raise exception 'Accounting period not found';
  end if;
  if period.status = 'closed' then
    raise exception 'Accounting period is already closed';
  end if;
  if period.status = 'reviewing' then
    if period.close_started_at is not null and period.close_started_at > now() - interval '30 minutes' then
      raise exception 'Accounting period close is already running';
    end if;
    -- An abandoned close: resume it from the status it froze.
    update public.accounting_periods
    set close_started_at = now(), close_started_by = p_actor_id, updated_at = now()
    where id = p_period_id and org_id = p_org_id;
    return coalesce(period.close_prior_status, 'open');
  end if;

  update public.accounting_periods
  set status = 'reviewing', close_started_at = now(), close_started_by = p_actor_id,
      close_prior_status = period.status, updated_at = now()
  where id = p_period_id and org_id = p_org_id;

  return period.status;
end;
$$;

create or replace function public.cancel_books_period_close(
  p_org_id uuid,
  p_period_id uuid,
  p_prior_status text
) returns void
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  if p_prior_status not in ('open', 'reopened') then
    raise exception 'Invalid prior accounting-period status';
  end if;

  update public.accounting_periods
  set status = p_prior_status, close_started_at = null, close_started_by = null,
      close_prior_status = null, updated_at = now()
  where id = p_period_id
    and org_id = p_org_id
    and status = 'reviewing';
end;
$$;

revoke all on function public.begin_books_period_close(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.cancel_books_period_close(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.begin_books_period_close(uuid, uuid, uuid) to service_role;
grant execute on function public.cancel_books_period_close(uuid, uuid, text) to service_role;
