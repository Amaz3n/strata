-- Payment run scheduling.
--
-- A preparer picks the business date they want a run released on when they submit
-- it for approval. Null means "release as soon as it is approved", which is the
-- behaviour every existing run already has, so the column is nullable with no
-- backfill.
--
-- The date is part of what an approver approves: `scheduled_for` is folded into
-- the run content hash in `lib/services/payment-runs.ts`, so moving the date after
-- approval invalidates the approvals exactly like changing an amount or a payee.

alter table public.payment_runs
  add column if not exists scheduled_for date;

comment on column public.payment_runs.scheduled_for is
  'Business date the preparer asked for release on, in the org''s local reckoning. Null releases as soon as the run is approved. Covered by the run content hash, so a change invalidates existing approvals.';

-- The scheduled-release sweep asks one question every run: which approved runs in
-- this org are due today or overdue. Partial so the index stays small — the vast
-- majority of rows are terminal and never scheduled.
create index if not exists payment_runs_scheduled_release_idx
  on public.payment_runs (org_id, scheduled_for)
  where status = 'approved' and scheduled_for is not null;

-- Adding a defaulted parameter would leave the old five-argument function in place
-- and make every existing five-argument call ambiguous, so the old signature is
-- dropped and replaced rather than overloaded.
drop function if exists public.submit_payment_run_atomic(uuid, uuid, uuid, text, timestamptz);

create function public.submit_payment_run_atomic(
  p_org_id uuid,
  p_run_id uuid,
  p_requester_id uuid,
  p_content_hash text,
  p_requested_at timestamptz,
  p_scheduled_for date
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_run public.payment_runs%rowtype;
begin
  select * into v_run from public.payment_runs
  where id = p_run_id and org_id = p_org_id for update;
  if v_run.id is null then raise exception 'Payment run not found'; end if;
  if v_run.requested_by <> p_requester_id then raise exception 'Only the payment-run preparer can submit it'; end if;
  if v_run.status <> 'draft' then raise exception 'Only a draft payment run can be submitted'; end if;
  if p_content_hash !~ '^[a-f0-9]{64}$' then raise exception 'Payment run content hash is invalid'; end if;
  -- A run scheduled into the past would be swept for release on the very next
  -- cron tick, which is not what anyone picking a date means.
  if p_scheduled_for is not null and p_scheduled_for < current_date then
    raise exception 'Payment run cannot be scheduled in the past';
  end if;

  update public.payment_runs set
    status = 'pending_approval', content_hash = p_content_hash,
    requested_at = p_requested_at, scheduled_for = p_scheduled_for
  where id = p_run_id and org_id = p_org_id;
  update public.payment_run_items set status = 'pending_approval'
  where run_id = p_run_id and org_id = p_org_id and status = 'draft';
  return jsonb_build_object(
    'id', p_run_id,
    'status', 'pending_approval',
    'content_hash', p_content_hash,
    'scheduled_for', p_scheduled_for
  );
end;
$function$;

revoke all on function public.submit_payment_run_atomic(uuid, uuid, uuid, text, timestamptz, date) from public;
grant execute on function public.submit_payment_run_atomic(uuid, uuid, uuid, text, timestamptz, date) to service_role;
