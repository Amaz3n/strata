-- Phase B: bounded submissions, durable transfer claims, and the state needed
-- to represent a debit return after vendor funds have already left Arc.
-- Supabase MCP applied this under hosted ledger version 20260902114730.

alter table public.disbursements
  drop constraint if exists disbursements_status_check;

alter table public.disbursements
  add constraint disbursements_status_check check (status in (
    'created','submitted','debit_pending','funds_available','transfer_claimed',
    'transfer_pending','payout_pending','paid','returned_after_transfer',
    'failed','returned','reversed','canceled'
  )),
  add column if not exists submission_attempts integer not null default 0
    check (submission_attempts between 0 and 5),
  add column if not exists last_submission_error text,
  add column if not exists next_submission_at timestamptz,
  add column if not exists transfer_claimed_at timestamptz,
  add column if not exists transfer_claim_token uuid,
  add column if not exists provider_transfer_idempotency_key text;

create index if not exists disbursements_submission_recovery_idx
  on public.disbursements (next_submission_at)
  where status = 'created' and next_submission_at is not null;

alter table public.payment_reconciliation_items
  drop constraint if exists payment_reconciliation_items_status_check;
alter table public.payment_reconciliation_items
  add constraint payment_reconciliation_items_status_check check (status in (
    'matched','missing_internal','missing_provider','missing_provider_reference',
    'amount_mismatch','timing_difference','resolved'
  ));

drop index if exists public.disbursements_transfer_release_idx;
create index disbursements_transfer_release_idx
  on public.disbursements (transfer_release_after)
  where status in ('funds_available','transfer_claimed') and transfer_release_after is not null;

drop function if exists public.claim_matured_vendor_transfers(integer);
create function public.claim_matured_vendor_transfers(p_limit integer default 100)
returns table(
  disbursement_id uuid,
  org_id uuid,
  amount_cents bigint,
  currency text,
  provider_payment_id text,
  provider_charge_id text,
  recipient_account_id uuid,
  run_id uuid,
  transfer_group text,
  provider_transfer_idempotency_key text,
  transfer_claim_token uuid,
  reclaimed boolean
)
language sql
security definer
set search_path = public
as $$
  with candidates as (
    select d.id, d.status = 'transfer_claimed' as reclaimed
    from public.disbursements d
    where (
      d.status = 'funds_available'
      and d.transfer_release_after is not null
      and d.transfer_release_after <= now()
    ) or (
      d.status = 'transfer_claimed'
      and d.transfer_claimed_at <= now() - interval '15 minutes'
    )
    order by coalesce(d.transfer_claimed_at, d.transfer_release_after)
    limit greatest(least(p_limit, 500), 1)
    for update skip locked
  ), claimed as (
    update public.disbursements d set
      status = 'transfer_claimed',
      transfer_claimed_at = now(),
      transfer_claim_token = gen_random_uuid(),
      provider_transfer_idempotency_key = coalesce(
        d.provider_transfer_idempotency_key,
        'disbursement:' || d.id::text || ':transfer'
      )
    from candidates c
    where d.id = c.id
    returning d.*, c.reclaimed
  )
  select id, org_id, amount_cents, currency, provider_payment_id,
    provider_charge_id, recipient_account_id, run_id, transfer_group,
    provider_transfer_idempotency_key, transfer_claim_token, reclaimed
  from claimed;
$$;

revoke all on function public.claim_matured_vendor_transfers(integer) from public, anon, authenticated;
grant execute on function public.claim_matured_vendor_transfers(integer) to service_role;

create or replace function public.list_payment_submission_recovery_candidates(p_limit integer default 100)
returns table(run_id uuid, org_id uuid, requested_by uuid)
language sql
security definer
set search_path = public
as $$
  select distinct on (candidate.org_id, candidate.run_id)
    candidate.run_id, candidate.org_id, candidate.requested_by
  from (
    select d.run_id, d.org_id, r.requested_by, d.next_submission_at as due_at
    from public.disbursements d
    join public.payment_runs r on r.id = d.run_id and r.org_id = d.org_id
    where d.status = 'created'
      and d.submission_attempts < 5
      and d.next_submission_at is not null
      and d.next_submission_at <= now()
    union all
    select i.run_id, i.org_id, r.requested_by, r.processing_started_at as due_at
    from public.payment_run_items i
    join public.payment_runs r on r.id = i.run_id and r.org_id = i.org_id
    where i.status = 'processing'
      and r.status in ('processing','partially_failed')
      and r.processing_started_at <= now() - interval '2 minutes'
      and not exists (
        select 1 from public.disbursements d
        where d.org_id = i.org_id and d.run_item_id = i.id
      )
  ) candidate
  order by candidate.org_id, candidate.run_id, candidate.due_at
  limit greatest(least(p_limit, 500), 1);
$$;

revoke all on function public.list_payment_submission_recovery_candidates(integer) from public, anon, authenticated;
grant execute on function public.list_payment_submission_recovery_candidates(integer) to service_role;

create or replace function public.release_failed_payment_run_item_atomic(
  p_org_id uuid,
  p_disbursement_id uuid,
  p_reason text,
  p_effective_at timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_d public.disbursements%rowtype;
  v_original public.payment_ledger_transactions%rowtype;
  v_run_status text;
  v_all_terminal boolean;
begin
  select * into v_d from public.disbursements
  where id = p_disbursement_id and org_id = p_org_id for update;
  if v_d.id is null then raise exception 'Disbursement not found'; end if;
  if v_d.status = 'failed' then
    return jsonb_build_object('duplicate', true, 'run_id', v_d.run_id);
  end if;
  if v_d.status <> 'created' then raise exception 'Only an unsubmitted disbursement can be released'; end if;

  select * into v_original from public.payment_ledger_transactions
  where org_id = p_org_id and idempotency_key = 'disbursement:' || v_d.id::text || ':submitted';
  if v_original.id is not null then
    perform public.post_payment_ledger_transaction_atomic(
      p_org_id, v_d.id, null, 'disbursement', v_d.id, 'reversal', v_d.currency,
      'disbursement:' || v_d.id::text || ':submission-reversal', v_original.id,
      'Reverse definitively failed builder bank debit', coalesce(p_effective_at, now()),
      jsonb_build_array(
        jsonb_build_object('account_code','org_cash','direction','debit','amount_cents',v_d.amount_cents,'currency',v_d.currency),
        jsonb_build_object('account_code','ach_clearing','direction','credit','amount_cents',v_d.amount_cents,'currency',v_d.currency)
      )
    );
  end if;

  update public.disbursements set status = 'failed', failure_reason = p_reason,
    next_submission_at = null, last_submission_error = p_reason
  where id = v_d.id and org_id = p_org_id;
  update public.payment_run_item_payees set status = 'failed'
  where id = v_d.run_item_payee_id and org_id = p_org_id;
  update public.payment_run_items set status = 'failed', failure_reason = p_reason
  where id = v_d.run_item_id and org_id = p_org_id;

  select bool_and(status in ('paid','failed','returned','canceled')),
    case
      when bool_and(status = 'paid') then 'paid'
      when bool_and(status in ('failed','returned','canceled')) then 'failed'
      else 'partially_failed'
    end
  into v_all_terminal, v_run_status
  from public.payment_run_items where run_id = v_d.run_id and org_id = p_org_id;
  update public.payment_runs set status = v_run_status,
    completed_at = case when v_all_terminal then coalesce(completed_at, now()) else null end
  where id = v_d.run_id and org_id = p_org_id;
  return jsonb_build_object('duplicate', false, 'run_id', v_d.run_id, 'run_status', v_run_status);
end;
$$;

revoke all on function public.release_failed_payment_run_item_atomic(uuid,uuid,text,timestamptz) from public, anon, authenticated;
grant execute on function public.release_failed_payment_run_item_atomic(uuid,uuid,text,timestamptz) to service_role;

create or replace function public.complete_post_transfer_return_recovery_atomic(
  p_org_id uuid,
  p_disbursement_id uuid,
  p_reason text,
  p_returned_at timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_d public.disbursements%rowtype;
  v_run_status text;
  v_all_terminal boolean;
begin
  select * into v_d from public.disbursements
  where id = p_disbursement_id and org_id = p_org_id for update;
  if v_d.id is null then raise exception 'Disbursement not found'; end if;
  if v_d.status = 'returned' then return jsonb_build_object('duplicate', true); end if;
  if v_d.status <> 'returned_after_transfer' then raise exception 'Transfer return is not awaiting recovery'; end if;
  update public.disbursements set status = 'returned', returned_at = coalesce(p_returned_at, now()), failure_reason = p_reason
  where id = v_d.id and org_id = p_org_id;
  update public.payment_run_item_payees set status = 'returned'
  where id = v_d.run_item_payee_id and org_id = p_org_id;
  update public.payment_run_items set status = 'returned', failure_reason = p_reason
  where id = v_d.run_item_id and org_id = p_org_id;
  update public.vendor_bills set status = case when coalesce(paid_cents, 0) > 0 then 'partial' else 'approved' end
  where id = v_d.bill_id and org_id = p_org_id;
  select bool_and(status in ('paid','failed','returned','canceled')),
    case
      when bool_and(status = 'paid') then 'paid'
      when bool_and(status in ('failed','returned','canceled')) then 'failed'
      when bool_or(status in ('failed','returned','canceled')) then 'partially_failed'
      when bool_or(status in ('paid','partially_paid')) then 'partially_paid'
      else 'processing'
    end
  into v_all_terminal, v_run_status
  from public.payment_run_items where run_id = v_d.run_id and org_id = p_org_id;
  update public.payment_runs set status = v_run_status,
    completed_at = case when v_all_terminal then coalesce(completed_at, now()) else null end
  where id = v_d.run_id and org_id = p_org_id;
  return jsonb_build_object('duplicate', false, 'run_id', v_d.run_id, 'bill_id', v_d.bill_id, 'run_status', v_run_status);
end;
$$;

revoke all on function public.complete_post_transfer_return_recovery_atomic(uuid,uuid,text,timestamptz) from public, anon, authenticated;
grant execute on function public.complete_post_transfer_return_recovery_atomic(uuid,uuid,text,timestamptz) to service_role;

-- `returned_after_transfer` still becomes a real AP payment if the connected
-- account payout wins the race. The existing function remains otherwise
-- unchanged; replace its guard without weakening tenant or service-role checks.
do $$
declare
  v_oid oid;
  v_definition text;
  v_replaced text;
begin
  select p.oid into v_oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'record_ap_payment_atomic'
    and pg_get_function_identity_arguments(p.oid) = 'p_org_id uuid, p_disbursement_id uuid, p_provider_payment_id text, p_provider_charge_id text, p_provider_transfer_id text, p_provider_payout_id text, p_provider_balance_transaction_id text, p_paid_at timestamp with time zone';
  if v_oid is null then raise exception 'record_ap_payment_atomic is required before Phase B'; end if;
  v_definition := pg_get_functiondef(v_oid);
  v_replaced := replace(
    v_definition,
    'not in (''payout_pending'',''paid'')',
    'not in (''payout_pending'',''returned_after_transfer'',''paid'')'
  );
  if v_replaced = v_definition then
    v_replaced := replace(
      v_definition,
      'not in (''payout_pending'', ''paid'')',
      'not in (''payout_pending'', ''returned_after_transfer'', ''paid'')'
    );
  end if;
  if v_replaced = v_definition then
    raise exception 'record_ap_payment_atomic payout-state guard did not match its canonical definition';
  end if;
  v_definition := v_replaced;
  v_replaced := replace(
    v_definition,
    'completed_at = case when v_run_status in (''paid'',''partially_failed'',''failed'') then now() else completed_at end',
    'completed_at = case when v_run_status in (''paid'',''failed'') or (v_run_status = ''partially_failed'' and not exists (select 1 from public.payment_run_items pending_item where pending_item.run_id = v_disbursement.run_id and pending_item.org_id = p_org_id and pending_item.status not in (''paid'',''failed'',''returned'',''canceled''))) then now() else null end'
  );
  if v_replaced = v_definition then
    raise exception 'record_ap_payment_atomic completion-state guard did not match its canonical definition';
  end if;
  execute v_replaced;
end;
$$;

revoke all on function public.record_ap_payment_atomic(uuid,uuid,text,text,text,text,text,timestamptz) from public, anon, authenticated;
grant execute on function public.record_ap_payment_atomic(uuid,uuid,text,text,text,text,text,timestamptz) to service_role;

comment on column public.disbursements.status is
  'Phase B state machine; returned_after_transfer may only advance to paid or returned.';
