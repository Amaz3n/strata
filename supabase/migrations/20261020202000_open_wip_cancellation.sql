-- Cancelling a running Open-WIP cutover (EP13-03).
--
-- A cutover commit builds one home per house row, each with its receipt, and can
-- run for many minutes. An operator can now stop it. The stop happens between
-- homes, never inside one: a home is built whole with its receipt or not at all,
-- exactly as for a crash, so a cancelled batch holds a prefix of complete homes
-- and the receipts that say which. It ends `failed` with `report.cancelled`
-- (when, by whom, how many homes were built of how many), keeps every home it
-- built, and "Commit again" resumes from the receipts as after any interruption.
--
-- A request against a live claim is recorded and honoured by the worker at its
-- next home (`cancel_open_wip_commit_if_requested`); a request against a claim
-- whose process already died is applied at once, since no worker will see it.
-- A request made before the operator's latest commit belongs to an earlier
-- attempt and is dropped rather than stopping the new one; a resume the outbox
-- started for that same commit still honours it.

alter table public.import_batches
  add column if not exists cancel_requested_at timestamptz,
  add column if not exists cancel_requested_by uuid references public.app_users(id) on delete set null;

comment on column public.import_batches.cancel_requested_at is
  'An operator asked a running Open-WIP commit to stop; the worker stops at its next home and records report.cancelled.';

create or replace function public.open_wip_cancel_now(p_batch public.import_batches, p_actor_id uuid, p_requested_at timestamptz)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_built integer;
  v_rows integer;
  v_cancelled jsonb;
begin
  select count(*) filter (where status = 'committed'), count(*) filter (where status <> 'skipped')
  into v_built, v_rows
  from public.import_rows where org_id = p_batch.org_id and batch_id = p_batch.id;
  v_cancelled := jsonb_build_object('at', clock_timestamp(), 'requested_at', p_requested_at, 'by', p_actor_id,
    'homes_built', v_built, 'rows', v_rows, 'attempt', p_batch.commit_attempts);
  update public.import_batches set
    status = 'failed', commit_claim_token = null, commit_lease_expires_at = null,
    cancel_requested_at = null, cancel_requested_by = null,
    report = (report - 'commit_error') || jsonb_build_object('cancelled', v_cancelled)
  where id = p_batch.id;
  return v_cancelled;
end $$;

revoke all on function public.open_wip_cancel_now(public.import_batches, uuid, timestamptz) from public, anon, authenticated;

create or replace function public.request_open_wip_cancel(p_org_id uuid, p_batch_id uuid, p_actor_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_batch public.import_batches%rowtype;
begin
  if p_actor_id is null then raise exception 'A cancellation names the operator who asked for it'; end if;
  select * into v_batch from public.import_batches
  where org_id = p_org_id and id = p_batch_id and importer = 'open_wip' for update;
  if not found then raise exception 'Import batch not found'; end if;
  if v_batch.status <> 'committing' then
    raise exception 'Only a running cutover can be cancelled' using errcode = '55000';
  end if;
  if v_batch.commit_claim_token is not null and v_batch.commit_lease_expires_at > clock_timestamp() then
    update public.import_batches set cancel_requested_at = clock_timestamp(), cancel_requested_by = p_actor_id
    where id = p_batch_id;
    return jsonb_build_object('state', 'requested');
  end if;
  return jsonb_build_object('state', 'cancelled', 'cancelled', public.open_wip_cancel_now(v_batch, p_actor_id, clock_timestamp()));
end $$;

revoke all on function public.request_open_wip_cancel(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.request_open_wip_cancel(uuid, uuid, uuid) to service_role;

create or replace function public.cancel_open_wip_commit_if_requested(p_org_id uuid, p_batch_id uuid, p_claim_token uuid)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_batch public.import_batches%rowtype;
  v_operator_claim timestamptz;
begin
  v_batch := public.open_wip_commit_fence(p_org_id, p_batch_id, p_claim_token, false);
  if v_batch.cancel_requested_at is null then return null; end if;
  -- The operator's latest commit: a resume the outbox started carries on that commit, a fresh commit starts a new one.
  select max((attempt->>'claimed_at')::timestamptz) into v_operator_claim
  from jsonb_array_elements(coalesce(v_batch.report->'commit_attempts', '[]'::jsonb)) attempt
  where attempt->>'from_status' <> 'committing';
  if v_operator_claim is not null and v_batch.cancel_requested_at < v_operator_claim then
    update public.import_batches set cancel_requested_at = null, cancel_requested_by = null where id = p_batch_id;
    return null;
  end if;
  return public.open_wip_cancel_now(v_batch, v_batch.cancel_requested_by, v_batch.cancel_requested_at);
end $$;

revoke all on function public.cancel_open_wip_commit_if_requested(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.cancel_open_wip_commit_if_requested(uuid, uuid, uuid) to service_role;
