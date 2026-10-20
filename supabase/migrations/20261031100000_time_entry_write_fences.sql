-- Write fences on time_entries (Arc Trade readiness TR03 fix round).
--
-- The original policy lets any org member write any time_entries row, so a crew
-- member could mark their own row approved, change its rate or overtime flags, or
-- write a coworker's time. Approval and pricing are decisions for someone who
-- holds time.approve, bill.approve, time.manage or time.close (on the org or on the job);
-- everyone else may only write their OWN draft or submitted time, with no
-- approval, pricing or overtime fields. The services run as the caller, so this
-- is enforced where the rows live. service_role is never fenced.

begin;

create or replace function public.can_decide_time_entries(p_org_id uuid, p_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'pg_catalog', 'public'
as $$
  select
    public.has_org_permission(p_org_id, 'time.approve')
    or public.has_org_permission(p_org_id, 'bill.approve')
    or public.has_org_permission(p_org_id, 'time.manage')
    or public.has_org_permission(p_org_id, 'time.close')
    or exists (
      select 1
      from public.project_members pm
      join public.role_permissions rp on rp.role_id = pm.role_id
        and rp.permission_key in ('time.approve', 'bill.approve', 'time.manage', 'time.close')
      where pm.org_id = p_org_id
        and pm.project_id = p_project_id
        and pm.user_id = (select auth.uid())
        and pm.status = 'active'
    );
$$;

revoke all on function public.can_decide_time_entries(uuid, uuid) from public, anon;
grant execute on function public.can_decide_time_entries(uuid, uuid) to authenticated, service_role;

create or replace function public.guard_time_entry_writes()
returns trigger
language plpgsql
set search_path to 'pg_catalog', 'public'
as $$
begin
  if (select auth.role()) is distinct from 'authenticated' then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    if old.worker_user_id is distinct from (select auth.uid()) and not public.can_decide_time_entries(old.org_id, old.project_id) then
      raise exception 'You can only change your own time' using errcode = '42501';
    end if;
    return old;
  end if;

  if public.can_decide_time_entries(new.org_id, new.project_id) then
    return new;
  end if;

  if new.worker_user_id is distinct from (select auth.uid())
     or (tg_op = 'UPDATE' and old.worker_user_id is distinct from (select auth.uid())) then
    raise exception 'You can only change your own time' using errcode = '42501';
  end if;
  if new.status not in ('draft', 'submitted')
     or new.approved_by_pm_at is not null or new.approved_by_pm_user_id is not null
     or new.approved_by_client_at is not null or new.approval_token_hash is not null
     or new.locked_at is not null or new.locked_by is not null or new.pay_period_id is not null
     or new.reverses_time_entry_id is not null or new.billable_cost_id is not null
     or new.is_overtime or new.is_double_time then
    raise exception 'Approval, overtime and payroll fields are set by whoever approves time' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' then
    if old.status not in ('draft', 'submitted', 'rejected')
       or new.base_rate_cents is distinct from old.base_rate_cents
       or new.burden_multiplier is distinct from old.burden_multiplier
       or new.ot_multiplier is distinct from old.ot_multiplier
       or new.dt_multiplier is distinct from old.dt_multiplier
       or new.is_billable is distinct from old.is_billable
       or new.labor_cost_policy_version is distinct from old.labor_cost_policy_version
       or new.org_id is distinct from old.org_id then
      raise exception 'Approval, overtime and payroll fields are set by whoever approves time' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;

create trigger time_entries_write_fence before insert or update or delete on public.time_entries
  for each row execute function public.guard_time_entry_writes();

commit;
