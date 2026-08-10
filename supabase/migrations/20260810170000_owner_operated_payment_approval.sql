-- Small owner-operated builders may explicitly allow the same authorized user
-- to prepare and approve a payment. The choice is frozen into each run's
-- control_snapshot; changing policy later never changes an in-flight run.

alter table public.payment_rail_policies
  drop constraint if exists payment_rail_policies_requester_may_approve_check;

alter table public.payment_rail_policies
  add constraint payment_rail_policies_owner_approval_mode_check
  check (requester_may_approve = false or approval_mode = 'sole');

create or replace function public.enforce_payment_run_approval_separation()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  run_requester uuid;
  run_org uuid;
  run_required_approvals integer;
  requester_allowed boolean;
begin
  select requested_by, org_id, required_approvals,
    coalesce((control_snapshot -> 'policy' ->> 'requester_may_approve')::boolean, false)
  into run_requester, run_org, run_required_approvals, requester_allowed
  from public.payment_runs
  where id = new.run_id;

  if run_requester is null then raise exception 'Payment run does not exist'; end if;
  if new.org_id <> run_org then raise exception 'Approval organization must match payment run organization'; end if;
  if new.approver_id = run_requester and (
    requester_allowed = false or run_required_approvals <> 1
  ) then
    raise exception 'Payment run requester cannot approve their own run';
  end if;
  return new;
end;
$$;

create or replace function public.decide_payment_run_atomic(
  p_org_id uuid,
  p_run_id uuid,
  p_approver_id uuid,
  p_decision text,
  p_reason text,
  p_content_hash text,
  p_step_up_verified_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run public.payment_runs%rowtype;
  v_approval public.payment_run_approvals%rowtype;
  v_approval_count integer;
  v_next_status text;
  v_requester_allowed boolean;
begin
  if p_decision not in ('approved','rejected') then raise exception 'Unsupported payment run decision'; end if;
  if p_decision = 'rejected' and length(btrim(coalesce(p_reason, ''))) < 8 then
    raise exception 'A rejection reason of at least 8 characters is required';
  end if;

  select * into v_run from public.payment_runs
  where id = p_run_id and org_id = p_org_id for update;
  if v_run.id is null then raise exception 'Payment run not found'; end if;
  if v_run.status <> 'pending_approval' then raise exception 'Payment run is not awaiting approval'; end if;

  v_requester_allowed := coalesce(
    (v_run.control_snapshot -> 'policy' ->> 'requester_may_approve')::boolean,
    false
  ) and v_run.required_approvals = 1;
  if v_run.requested_by = p_approver_id and v_requester_allowed = false then
    raise exception 'Payment run requester cannot approve their own run';
  end if;
  if v_run.content_hash is null or v_run.content_hash <> p_content_hash then
    raise exception 'Payment run changed after it was submitted for approval';
  end if;

  insert into public.payment_run_approvals (
    org_id, run_id, approver_id, decision, content_hash, reason, step_up_verified_at
  ) values (
    p_org_id, p_run_id, p_approver_id, p_decision, p_content_hash, p_reason, p_step_up_verified_at
  ) returning * into v_approval;

  if p_decision = 'rejected' then
    update public.payment_runs set status = 'canceled', canceled_at = now()
      where id = p_run_id and org_id = p_org_id;
    update public.payment_run_items set status = 'canceled'
      where run_id = p_run_id and org_id = p_org_id;
    v_next_status := 'canceled';
  else
    select count(distinct approver_id)::integer into v_approval_count
    from public.payment_run_approvals
    where run_id = p_run_id and org_id = p_org_id and decision = 'approved';
    if v_approval_count >= v_run.required_approvals then
      update public.payment_runs set status = 'approved', approved_at = now()
        where id = p_run_id and org_id = p_org_id;
      update public.payment_run_items set status = 'approved'
        where run_id = p_run_id and org_id = p_org_id;
      v_next_status := 'approved';
    else
      v_next_status := 'pending_approval';
    end if;
  end if;

  return jsonb_build_object(
    'approval_id', v_approval.id,
    'status', v_next_status,
    'approval_count', coalesce(v_approval_count, 0),
    'required_approvals', v_run.required_approvals
  );
end;
$$;

revoke all on function public.decide_payment_run_atomic(uuid,uuid,uuid,text,text,text,timestamptz) from public, anon, authenticated;
grant execute on function public.decide_payment_run_atomic(uuid,uuid,uuid,text,text,text,timestamptz) to service_role;
