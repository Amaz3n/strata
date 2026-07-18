-- Atomic bid submission versioning. Demote-current + insert + item rows +
-- invite status previously ran as separate statements with manual rollback;
-- concurrent submits could race into two current rows. The invite row lock
-- serializes revisions per invite. Also stores the benchmark signal snapshot
-- on the submission so list reads stop returning an always-null field.

alter table public.bid_submissions
  add column if not exists benchmark jsonb;

create or replace function public.create_bid_submission_version(
  p_org_id uuid,
  p_bid_invite_id uuid,
  p_payload jsonb,
  p_items jsonb default '[]'::jsonb,
  p_source text default 'portal',
  p_entered_by uuid default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_invite public.bid_invites%rowtype;
  v_current public.bid_submissions%rowtype;
  v_next_version integer;
  v_status text;
  v_now timestamp with time zone := now();
  v_created public.bid_submissions%rowtype;
  v_item jsonb;
begin
  select * into v_invite
  from public.bid_invites
  where org_id = p_org_id and id = p_bid_invite_id
  for update;

  if not found then
    raise exception 'Bid invite not found';
  end if;

  select * into v_current
  from public.bid_submissions
  where org_id = p_org_id
    and bid_invite_id = p_bid_invite_id
    and is_current = true
  limit 1
  for update;

  v_next_version := coalesce(v_current.version, 0) + 1;
  if v_next_version > 100 then
    raise exception 'Revision limit reached for this bid';
  end if;
  v_status := case when v_next_version > 1 then 'revised' else 'submitted' end;

  if v_current.id is not null then
    update public.bid_submissions
    set is_current = false, updated_at = v_now
    where id = v_current.id;
  end if;

  insert into public.bid_submissions (
    org_id, bid_invite_id, status, version, is_current,
    total_cents, currency, valid_until, lead_time_days, duration_days,
    start_available_on, exclusions, clarifications, notes,
    submitted_by_name, submitted_by_email, submitted_at,
    source, entered_by, entered_at, line_items
  )
  values (
    p_org_id,
    p_bid_invite_id,
    v_status,
    v_next_version,
    true,
    nullif(p_payload->>'total_cents', '')::bigint,
    coalesce(nullif(p_payload->>'currency', ''), 'usd'),
    nullif(p_payload->>'valid_until', '')::date,
    nullif(p_payload->>'lead_time_days', '')::integer,
    nullif(p_payload->>'duration_days', '')::integer,
    nullif(p_payload->>'start_available_on', '')::date,
    nullif(p_payload->>'exclusions', ''),
    nullif(p_payload->>'clarifications', ''),
    nullif(p_payload->>'notes', ''),
    nullif(p_payload->>'submitted_by_name', ''),
    nullif(p_payload->>'submitted_by_email', ''),
    v_now,
    coalesce(nullif(p_source, ''), 'portal'),
    p_entered_by,
    case when p_entered_by is not null then v_now else null end,
    coalesce(p_payload->'line_items', '[]'::jsonb)
  )
  returning * into v_created;

  if jsonb_typeof(p_items) = 'array' then
    for v_item in select * from jsonb_array_elements(p_items)
    loop
      insert into public.bid_submission_items (
        org_id, bid_submission_id, bid_scope_item_id,
        description, response, amount_cents, unit_rate_cents, quantity, notes
      )
      values (
        p_org_id,
        v_created.id,
        nullif(v_item->>'bid_scope_item_id', '')::uuid,
        coalesce(nullif(v_item->>'description', ''), 'Scope item'),
        coalesce(nullif(v_item->>'response', ''), 'priced'),
        nullif(v_item->>'amount_cents', '')::bigint,
        nullif(v_item->>'unit_rate_cents', '')::bigint,
        nullif(v_item->>'quantity', '')::numeric,
        nullif(v_item->>'notes', '')
      );
    end loop;
  end if;

  update public.bid_invites
  set status = 'submitted', submitted_at = v_now, updated_at = v_now
  where org_id = p_org_id and id = p_bid_invite_id;

  delete from public.bid_portal_drafts
  where org_id = p_org_id and bid_invite_id = p_bid_invite_id;

  return jsonb_build_object(
    'submission_id', v_created.id,
    'version', v_created.version,
    'status', v_created.status
  );
end;
$$;

revoke all on function public.create_bid_submission_version(uuid, uuid, jsonb, jsonb, text, uuid) from public;
grant execute on function public.create_bid_submission_version(uuid, uuid, jsonb, jsonb, text, uuid) to service_role;
