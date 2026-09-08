-- Phase C: payment-run lifecycle, recoverability and payable correctness.
-- All state-changing functions remain service-role only; browser callers go
-- through permission-checked server services.

create or replace function public.normalize_vendor_invoice_number(p_value text)
returns text
language sql
immutable
parallel safe
set search_path = pg_catalog
as $$
  select nullif(regexp_replace(lower(btrim(coalesce(p_value, ''))), '[^a-z0-9]+', '', 'g'), '')
$$;

create or replace function public.normalize_vendor_name(p_value text)
returns text
language sql
immutable
parallel safe
set search_path = pg_catalog
as $$
  select nullif(regexp_replace(lower(btrim(coalesce(p_value, ''))), '[^a-z0-9]+', '', 'g'), '')
$$;

alter table public.payment_rail_policies
  add column if not exists enabled_jurisdictions text[] not null default array['FL']::text[];

update public.payment_rail_policies
set enabled_jurisdictions = array[upper(waiver_jurisdiction)]::text[]
where cardinality(enabled_jurisdictions) = 0
  and nullif(btrim(waiver_jurisdiction), '') is not null;

alter table public.payment_rail_policies
  add constraint payment_rail_policies_enabled_jurisdictions_nonempty
  check (cardinality(enabled_jurisdictions) > 0) not valid;
alter table public.payment_rail_policies validate constraint payment_rail_policies_enabled_jurisdictions_nonempty;

alter table public.payment_runs
  add column if not exists canceled_by uuid references public.app_users(id) on delete restrict,
  add column if not exists cancel_reason text;

alter table public.payment_runs
  add constraint payment_runs_cancel_evidence_check
  check (
    (status <> 'canceled')
    or (canceled_at is not null and canceled_by is not null and length(btrim(cancel_reason)) >= 8)
  ) not valid;

alter table public.payment_execution_reservations
  add column if not exists status text not null default 'pending',
  add column if not exists executed_at timestamptz,
  add column if not exists released_at timestamptz,
  add column if not exists release_reason text;

alter table public.payment_execution_reservations
  add constraint payment_execution_reservations_status_check
  check (status in ('pending','executed','released')) not valid;
alter table public.payment_execution_reservations validate constraint payment_execution_reservations_status_check;

create index if not exists payment_execution_reservations_live_daily_idx
  on public.payment_execution_reservations (org_id, business_date)
  where status in ('pending','executed');

alter table public.payment_risk_reviews
  add column if not exists content_hash text,
  add column if not exists signal_set_hash text,
  add column if not exists last_evaluated_at timestamptz not null default now(),
  add column if not exists identity_enforced boolean not null default false;

update public.payment_risk_reviews
set content_hash = coalesce(content_hash, encode(digest(coalesce(run_id::text, id::text), 'sha256'), 'hex')),
    signal_set_hash = coalesce(signal_set_hash, encode(digest(signals::text, 'sha256'), 'hex'));

-- Preserve the append-only historical audit trail. New automated evaluations
-- opt into the durable identity; old duplicate rows remain queryable forever.
alter table public.payment_risk_reviews
  alter column identity_enforced set default true;

create unique index if not exists payment_risk_reviews_evaluation_uidx
  on public.payment_risk_reviews (org_id, run_id, content_hash, signal_set_hash)
  where run_id is not null and review_type = 'automated' and identity_enforced;

alter table public.vendor_bills
  add column if not exists retainage_release_requested_at timestamptz,
  add column if not exists invoice_number_normalized text
    generated always as (public.normalize_vendor_invoice_number(bill_number)) stored,
  add column if not exists vendor_name_normalized text
    generated always as (
      public.normalize_vendor_name(coalesce(metadata ->> 'vendor_name', qbo_vendor_name))
    ) stored;

create index if not exists vendor_bills_company_invoice_normalized_idx
  on public.vendor_bills (org_id, company_id, invoice_number_normalized)
  where invoice_number_normalized is not null;
create index if not exists vendor_bills_name_invoice_normalized_idx
  on public.vendor_bills (org_id, vendor_name_normalized, invoice_number_normalized)
  where company_id is null and vendor_name_normalized is not null and invoice_number_normalized is not null;

create or replace function public.prevent_concurrent_vendor_bill_duplicate()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_invoice text := public.normalize_vendor_invoice_number(new.bill_number);
  v_vendor_name text := public.normalize_vendor_name(coalesce(new.metadata ->> 'vendor_name', new.qbo_vendor_name));
begin
  if v_invoice is null or (new.company_id is null and v_vendor_name is null) then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended(
    new.org_id::text || ':' || coalesce(new.company_id::text, v_vendor_name) || ':' || v_invoice, 0
  ));
  if exists (
    select 1
    from public.vendor_bills bill
    where bill.org_id = new.org_id
      and bill.id is distinct from new.id
      and bill.invoice_number_normalized = v_invoice
      and (
        (new.company_id is not null and bill.company_id = new.company_id)
        or (new.company_id is null and bill.company_id is null and bill.vendor_name_normalized = v_vendor_name)
      )
      -- Historic paid duplicates may move through unrelated status maintenance;
      -- a still-unpaid twin remains a hard stop.
      and bill.status <> 'paid'
  ) then
    raise exception 'Duplicate vendor invoice number for this vendor';
  end if;
  return new;
end;
$$;

create or replace function public.payment_run_eligible_approver_count(p_run_id uuid)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  with run_data as (
    select r.*,
      coalesce(array(
        select distinct p.division_id
        from public.payment_run_items i
        join public.projects p on p.id = i.project_id and p.org_id = i.org_id
        where i.run_id = r.id and p.division_id is not null
      ), array[]::uuid[]) as division_ids,
      coalesce(array(
        select jsonb_array_elements_text(r.control_snapshot -> 'preferred_approver_ids')::uuid
      ), array[]::uuid[]) as preferred_ids
    from public.payment_runs r where r.id = p_run_id
  )
  select count(distinct a.user_id)::integer
  from run_data r
  join public.payment_run_approvers a on a.org_id = r.org_id
  join public.memberships m on m.org_id = r.org_id and m.user_id = a.user_id and m.status = 'active'
  where (a.approval_limit_cents is null or a.approval_limit_cents >= r.total_debit_cents)
    and (a.division_id is null or (cardinality(r.division_ids) > 0 and r.division_ids <@ array[a.division_id]))
    and (cardinality(r.preferred_ids) = 0 or a.user_id = any(r.preferred_ids))
    and (
      a.user_id <> r.requested_by
      or (
        coalesce((r.control_snapshot -> 'policy' ->> 'requester_may_approve')::boolean, false)
        and r.required_approvals = 1
      )
    )
    and coalesce(
      (select o.effect = 'allow' from public.membership_permission_overrides o
       where o.membership_id = m.id and o.permission_key = 'payment.approve_run'),
      exists (select 1 from public.role_permissions rp where rp.role_id = m.role_id and rp.permission_key = 'payment.approve_run'),
      false
    )
$$;

create or replace function public.guard_payment_run_approvable()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.status = 'pending_approval' and old.status is distinct from 'pending_approval'
     and public.payment_run_eligible_approver_count(new.id) < new.required_approvals then
    raise exception 'Payment run has fewer eligible approvers than its required approvals';
  end if;
  return new;
end;
$$;

drop trigger if exists payment_runs_require_eligible_approvers on public.payment_runs;
create constraint trigger payment_runs_require_eligible_approvers
  after update of status on public.payment_runs
  deferrable initially immediate
  for each row execute function public.guard_payment_run_approvable();

create or replace function public.submit_payment_run_atomic(
  p_org_id uuid,
  p_run_id uuid,
  p_requester_id uuid,
  p_content_hash text,
  p_requested_at timestamptz,
  p_scheduled_for date
)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_run public.payment_runs%rowtype;
  v_business_date date := coalesce(p_scheduled_for, (coalesce(p_requested_at, now()) at time zone 'UTC')::date);
  v_daily_limit bigint;
  v_reserved bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_org_id::text || ':' || v_business_date::text, 0));
  select * into v_run from public.payment_runs where id = p_run_id and org_id = p_org_id for update;
  if v_run.id is null then raise exception 'Payment run not found'; end if;
  if v_run.requested_by <> p_requester_id then raise exception 'Only the payment-run preparer can submit it'; end if;
  if v_run.status <> 'draft' then raise exception 'Only a draft payment run can be submitted'; end if;
  if p_content_hash !~ '^[a-f0-9]{64}$' then raise exception 'Payment run content hash is invalid'; end if;
  if p_scheduled_for is not null and p_scheduled_for < current_date then raise exception 'Payment run cannot be scheduled in the past'; end if;
  if public.payment_run_eligible_approver_count(p_run_id) < v_run.required_approvals then
    raise exception 'Payment run has fewer eligible approvers than its required approvals';
  end if;

  select daily_limit_cents into v_daily_limit from public.payment_rail_policies where org_id = p_org_id;
  select coalesce(sum(reserved_cents), 0) into v_reserved
  from public.payment_execution_reservations
  where org_id = p_org_id and business_date = v_business_date and status in ('pending','executed');
  if v_daily_limit is not null and v_reserved + v_run.total_debit_cents > v_daily_limit then
    raise exception 'Organization daily payment limit would be exceeded';
  end if;

  insert into public.payment_execution_reservations (org_id, run_id, business_date, reserved_cents, status)
  values (p_org_id, p_run_id, v_business_date, v_run.total_debit_cents, 'pending');

  update public.payment_runs set status = 'pending_approval', content_hash = p_content_hash,
    requested_at = p_requested_at, scheduled_for = p_scheduled_for
  where id = p_run_id and org_id = p_org_id;
  update public.payment_run_items set status = 'pending_approval'
  where run_id = p_run_id and org_id = p_org_id and status = 'draft';
  return jsonb_build_object('id', p_run_id, 'status', 'pending_approval', 'content_hash', p_content_hash,
    'scheduled_for', p_scheduled_for, 'reserved_cents', v_run.total_debit_cents);
end;
$$;

drop function if exists public.cancel_payment_run_atomic(uuid,uuid,uuid);
create function public.cancel_payment_run_atomic(
  p_org_id uuid,
  p_run_id uuid,
  p_actor_id uuid,
  p_reason text,
  p_step_up_verified_at timestamptz,
  p_step_up_max_age interval default interval '10 minutes'
)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_run public.payment_runs%rowtype;
  v_may_manage boolean := false;
begin
  if length(btrim(coalesce(p_reason, ''))) < 8 then raise exception 'A cancellation reason of at least 8 characters is required'; end if;
  if p_step_up_verified_at is null or p_step_up_verified_at > now() or now() - p_step_up_verified_at > p_step_up_max_age then
    raise exception 'Recent payment step-up verification is required';
  end if;
  select * into v_run from public.payment_runs where id = p_run_id and org_id = p_org_id for update;
  if v_run.id is null then raise exception 'Payment run not found'; end if;
  select coalesce(
    (select o.effect = 'allow' from public.membership_permission_overrides o where o.membership_id = m.id and o.permission_key = 'payment.manage_rail'),
    exists (select 1 from public.role_permissions rp where rp.role_id = m.role_id and rp.permission_key = 'payment.manage_rail'), false
  ) into v_may_manage
  from public.memberships m where m.org_id = p_org_id and m.user_id = p_actor_id and m.status = 'active';
  if v_run.requested_by <> p_actor_id and not coalesce(v_may_manage, false) then
    raise exception 'Only the preparer or a payment rail manager can cancel this run';
  end if;
  if v_run.status not in ('draft','pending_approval','approved') then raise exception 'Payment run can no longer be canceled'; end if;
  if exists (select 1 from public.disbursements where org_id = p_org_id and run_id = p_run_id) then
    raise exception 'Payment run already has movement attempts';
  end if;
  update public.payment_runs set status='canceled', canceled_at=now(), canceled_by=p_actor_id, cancel_reason=btrim(p_reason)
  where id=p_run_id and org_id=p_org_id;
  update public.payment_run_items set status='canceled' where run_id=p_run_id and org_id=p_org_id
    and status in ('draft','pending_approval','approved');
  update public.payment_execution_reservations
    set status='released', released_at=now(), release_reason='run_canceled'
    where run_id=p_run_id and org_id=p_org_id and status='pending';
  return jsonb_build_object('id',p_run_id,'status','canceled','canceled_by',p_actor_id,'cancel_reason',btrim(p_reason));
end;
$$;

-- Abandoning an unsubmitted draft is cleanup, not a money-movement decision.
-- Keeping this separate from cancellation prevents a failed submit from
-- stranding its bills while preserving step-up for every submitted run.
create or replace function public.discard_payment_run_draft_atomic(
  p_org_id uuid,
  p_run_id uuid,
  p_preparer_id uuid
)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_run public.payment_runs%rowtype;
begin
  select * into v_run
  from public.payment_runs
  where id = p_run_id and org_id = p_org_id
  for update;
  if v_run.id is null then raise exception 'Payment run not found'; end if;
  if v_run.status <> 'draft' then raise exception 'Only an unsubmitted draft can be discarded without step-up'; end if;
  if v_run.requested_by <> p_preparer_id then raise exception 'Only the preparer can discard this draft'; end if;

  update public.payment_runs
  set status = 'canceled', canceled_at = now(), canceled_by = p_preparer_id,
      cancel_reason = 'Draft discarded before submission'
  where id = p_run_id and org_id = p_org_id;
  update public.payment_run_items
  set status = 'canceled'
  where run_id = p_run_id and org_id = p_org_id and status = 'draft';

  return jsonb_build_object('id', p_run_id, 'status', 'canceled');
end;
$$;

drop function if exists public.decide_payment_run_atomic(uuid,uuid,uuid,text,text,text,timestamptz);
create function public.decide_payment_run_atomic(
  p_org_id uuid,
  p_run_id uuid,
  p_approver_id uuid,
  p_decision text,
  p_reason text,
  p_content_hash text,
  p_step_up_verified_at timestamptz,
  p_step_up_max_age interval default interval '10 minutes'
)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_run public.payment_runs%rowtype;
  v_approval public.payment_run_approvals%rowtype;
  v_approval_count integer := 0;
  v_next_status text;
  v_requester_allowed boolean;
begin
  if p_decision not in ('approved','rejected') then raise exception 'Unsupported payment run decision'; end if;
  if p_decision='rejected' and length(btrim(coalesce(p_reason,''))) < 8 then raise exception 'A rejection reason of at least 8 characters is required'; end if;
  if p_step_up_verified_at is null or p_step_up_verified_at > now() or now() - p_step_up_verified_at > p_step_up_max_age then
    raise exception 'Recent payment step-up verification is required';
  end if;
  select * into v_run from public.payment_runs where id=p_run_id and org_id=p_org_id for update;
  if v_run.id is null then raise exception 'Payment run not found'; end if;
  if v_run.status <> 'pending_approval' then raise exception 'Payment run is not awaiting approval'; end if;
  v_requester_allowed := coalesce((v_run.control_snapshot->'policy'->>'requester_may_approve')::boolean,false) and v_run.required_approvals=1;
  if v_run.requested_by=p_approver_id and not v_requester_allowed then raise exception 'Payment run requester cannot approve their own run'; end if;
  if v_run.content_hash is null or v_run.content_hash<>p_content_hash then raise exception 'Payment run changed after it was submitted for approval'; end if;
  insert into public.payment_run_approvals(org_id,run_id,approver_id,decision,content_hash,reason,step_up_verified_at)
  values(p_org_id,p_run_id,p_approver_id,p_decision,p_content_hash,p_reason,p_step_up_verified_at) returning * into v_approval;
  if p_decision='rejected' then
    update public.payment_runs set status='canceled',canceled_at=now(),canceled_by=p_approver_id,
      cancel_reason=coalesce(nullif(btrim(p_reason),''),'Payment run rejected') where id=p_run_id and org_id=p_org_id;
    update public.payment_run_items set status='canceled' where run_id=p_run_id and org_id=p_org_id;
    update public.payment_execution_reservations set status='released',released_at=now(),release_reason='run_rejected'
      where run_id=p_run_id and org_id=p_org_id and status='pending';
    v_next_status := 'canceled';
  else
    select count(distinct approver_id)::integer into v_approval_count from public.payment_run_approvals
      where run_id=p_run_id and org_id=p_org_id and decision='approved';
    if v_approval_count >= v_run.required_approvals then
      update public.payment_runs set status='approved',approved_at=now() where id=p_run_id and org_id=p_org_id;
      update public.payment_run_items set status='approved' where run_id=p_run_id and org_id=p_org_id;
      v_next_status := 'approved';
    else v_next_status := 'pending_approval'; end if;
  end if;
  return jsonb_build_object('approval_id',v_approval.id,'status',v_next_status,'approval_count',v_approval_count,'required_approvals',v_run.required_approvals);
end;
$$;

create or replace function public.claim_payment_run_execution_atomic(p_org_id uuid,p_run_id uuid,p_claimed_at timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run public.payment_runs%rowtype;
  v_res public.payment_execution_reservations%rowtype;
  v_daily_limit bigint;
  v_reserved bigint;
begin
  select * into v_res from public.payment_execution_reservations where org_id=p_org_id and run_id=p_run_id for update;
  if v_res.id is null or v_res.status <> 'pending' then raise exception 'Payment run has no live submitted reservation'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_org_id::text || ':' || v_res.business_date::text,0));
  select * into v_run from public.payment_runs where id=p_run_id and org_id=p_org_id for update;
  if v_run.id is null then raise exception 'Payment run not found'; end if;
  if v_run.status='processing' then return jsonb_build_object('claimed',false,'duplicate',true,'status',v_run.status); end if;
  if v_run.status<>'approved' then raise exception 'Payment run is not approved'; end if;
  select daily_limit_cents into v_daily_limit from public.payment_rail_policies where org_id=p_org_id;
  select coalesce(sum(reserved_cents),0) into v_reserved from public.payment_execution_reservations
    where org_id=p_org_id and business_date=v_res.business_date and status in ('pending','executed');
  if v_daily_limit is not null and v_reserved > v_daily_limit then raise exception 'Live organization daily payment limit would be exceeded'; end if;
  update public.payment_execution_reservations set status='executed',executed_at=coalesce(p_claimed_at,now()) where id=v_res.id;
  update public.payment_runs set status='processing',processing_started_at=coalesce(processing_started_at,p_claimed_at,now())
    where id=p_run_id and org_id=p_org_id and status='approved';
  if not found then raise exception 'Payment run execution was claimed concurrently'; end if;
  return jsonb_build_object('claimed',true,'duplicate',false,'status','processing');
end;
$$;

create or replace function public.latest_payment_risk_reviews(p_org_id uuid, p_run_ids uuid[] default null)
returns setof public.payment_risk_reviews
language sql
stable
security definer
set search_path = public
as $$
  select distinct on (r.run_id) r.* from public.payment_risk_reviews r
  where r.org_id=p_org_id and r.run_id is not null and (p_run_ids is null or r.run_id=any(p_run_ids))
  order by r.run_id,r.last_evaluated_at desc,r.created_at desc
$$;

create or replace function public.record_automated_payment_risk_review(
  p_org_id uuid,
  p_run_id uuid,
  p_content_hash text,
  p_signal_set_hash text,
  p_decision text,
  p_signals jsonb,
  p_risk_score numeric,
  p_evaluated_at timestamptz default now()
)
returns uuid
language plpgsql
set search_path = public
as $$
declare v_id uuid;
begin
  insert into public.payment_risk_reviews(
    org_id,run_id,review_type,decision,signals,risk_score,content_hash,signal_set_hash,last_evaluated_at,identity_enforced
  ) values(
    p_org_id,p_run_id,'automated',p_decision,coalesce(p_signals,'[]'::jsonb),p_risk_score,p_content_hash,p_signal_set_hash,coalesce(p_evaluated_at,now()),true
  )
  on conflict (org_id,run_id,content_hash,signal_set_hash)
    where run_id is not null and review_type='automated' and identity_enforced
  do update set decision=excluded.decision,signals=excluded.signals,risk_score=excluded.risk_score,last_evaluated_at=excluded.last_evaluated_at
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.release_retainage_atomic(
  p_org_id uuid,
  p_bill_id uuid,
  p_actor_id uuid,
  p_amount_cents bigint,
  p_require_final_waiver boolean default true,
  p_requested_at timestamptz default now()
)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_bill public.vendor_bills%rowtype;
  v_release public.vendor_bills%rowtype;
  v_held bigint;
begin
  if p_amount_cents <= 0 then raise exception 'Retainage release amount must be positive'; end if;
  select * into v_bill from public.vendor_bills where id=p_bill_id and org_id=p_org_id for update;
  if v_bill.id is null then raise exception 'Vendor bill not found'; end if;
  if v_bill.status not in ('approved','partial','paid') then raise exception 'Only approved retainage can be released'; end if;
  v_held := greatest(coalesce(v_bill.retainage_cents,0)-coalesce(v_bill.retainage_released_cents,0),0);
  if p_amount_cents > v_held then raise exception 'Retainage release exceeds the held amount'; end if;
  if p_require_final_waiver and v_bill.lien_waiver_status <> 'received' then raise exception 'An unconditional final waiver is required before releasing retainage'; end if;
  insert into public.vendor_bills(org_id,project_id,commitment_id,company_id,bill_number,status,bill_date,due_date,total_cents,currency,
    metadata,approved_at,approved_by,retainage_percent,retainage_cents,retainage_released_cents)
  values(p_org_id,v_bill.project_id,v_bill.commitment_id,v_bill.company_id,coalesce(v_bill.bill_number,'Bill')||'-RET-'||to_char(coalesce(p_requested_at,now()),'YYYYMMDDHH24MISS'),
    'pending',(coalesce(p_requested_at,now()) at time zone 'UTC')::date,(coalesce(p_requested_at,now()) at time zone 'UTC')::date,
    p_amount_cents,v_bill.currency,jsonb_build_object('source','retainage_release','source_bill_id',v_bill.id),null,null,0,0,0)
  returning * into v_release;
  insert into public.bill_lines(org_id,bill_id,project_id,description,quantity,unit,unit_cost_cents,metadata,sort_order)
  values(p_org_id,v_release.id,v_bill.project_id,'Retainage release for '||coalesce(v_bill.bill_number,v_bill.id::text),1,'ls',p_amount_cents,
    jsonb_build_object('source_bill_id',v_bill.id,'kind','retainage_release'),0);
  update public.vendor_bills set retainage_released_cents=coalesce(retainage_released_cents,0)+p_amount_cents,
    retainage_release_requested_at=coalesce(p_requested_at,now()) where id=v_bill.id;
  insert into public.events(org_id,event_type,entity_type,entity_id,payload)
  values(p_org_id,'vendor_bill_retainage_released','vendor_bill',v_bill.id,
    jsonb_build_object('release_bill_id',v_release.id,'amount_cents',p_amount_cents,'actor_id',p_actor_id));
  return jsonb_build_object('source_bill_id',v_bill.id,'release_bill_id',v_release.id,'amount_cents',p_amount_cents,'held_after_cents',v_held-p_amount_cents);
end;
$$;

revoke all on function public.normalize_vendor_invoice_number(text) from public,anon,authenticated;
revoke all on function public.normalize_vendor_name(text) from public,anon,authenticated;
revoke all on function public.payment_run_eligible_approver_count(uuid) from public,anon,authenticated;
revoke all on function public.latest_payment_risk_reviews(uuid,uuid[]) from public,anon,authenticated;
revoke all on function public.record_automated_payment_risk_review(uuid,uuid,text,text,text,jsonb,numeric,timestamptz) from public,anon,authenticated;
revoke all on function public.cancel_payment_run_atomic(uuid,uuid,uuid,text,timestamptz,interval) from public,anon,authenticated;
revoke all on function public.discard_payment_run_draft_atomic(uuid,uuid,uuid) from public,anon,authenticated;
revoke all on function public.decide_payment_run_atomic(uuid,uuid,uuid,text,text,text,timestamptz,interval) from public,anon,authenticated;
revoke all on function public.release_retainage_atomic(uuid,uuid,uuid,bigint,boolean,timestamptz) from public,anon,authenticated;
revoke all on function public.submit_payment_run_atomic(uuid,uuid,uuid,text,timestamptz,date) from public,anon,authenticated;
revoke all on function public.claim_payment_run_execution_atomic(uuid,uuid,timestamptz) from public,anon,authenticated;

grant execute on function public.normalize_vendor_invoice_number(text) to service_role;
grant execute on function public.normalize_vendor_name(text) to service_role;
grant execute on function public.payment_run_eligible_approver_count(uuid) to service_role;
grant execute on function public.latest_payment_risk_reviews(uuid,uuid[]) to service_role;
grant execute on function public.record_automated_payment_risk_review(uuid,uuid,text,text,text,jsonb,numeric,timestamptz) to service_role;
grant execute on function public.cancel_payment_run_atomic(uuid,uuid,uuid,text,timestamptz,interval) to service_role;
grant execute on function public.discard_payment_run_draft_atomic(uuid,uuid,uuid) to service_role;
grant execute on function public.decide_payment_run_atomic(uuid,uuid,uuid,text,text,text,timestamptz,interval) to service_role;
grant execute on function public.release_retainage_atomic(uuid,uuid,uuid,bigint,boolean,timestamptz) to service_role;
grant execute on function public.submit_payment_run_atomic(uuid,uuid,uuid,text,timestamptz,date) to service_role;
grant execute on function public.claim_payment_run_execution_atomic(uuid,uuid,timestamptz) to service_role;
