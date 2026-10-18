-- EP08 review round 1 fixes for deliveries.
--
-- 1. Over-receipt counts quantity an approved variance order added to the line:
--    po_line_ordered_quantity = the line's own quantity plus approved,
--    non-credit variance-order lines on it. record_po_receipt, close_po_line_short,
--    the late sweep and the delivery queue all read it, so a replacement bought
--    through a VPO can be received without an over-receipt reason.
-- 2. resolve_po_shortage links only a live variance order (draft, sent or
--    approved) that belongs to the shortage's purchase order, so a VPO voided
--    between its creation and the link cannot be attached.
-- 3. void_po_receipt takes p_any_receipt: purchasing (po_exception.resolve) may
--    void any ticket; anyone else may void only a ticket they entered, the same
--    (UTC) day. The check is in the transaction, not only the service.

create or replace function public.po_line_ordered_quantity(p_line_id uuid)
returns numeric
language sql
stable
set search_path = ''
as $$
  select l.quantity + coalesce((
    select sum(vl.quantity)
    from public.commitment_change_order_lines vl
    join public.commitment_change_orders v on v.id = vl.commitment_change_order_id and v.org_id = vl.org_id
    where vl.commitment_line_id = l.id and v.status = 'approved' and vl.unit_cost_cents >= 0 and vl.quantity > 0
  ), 0)
  from public.commitment_lines l
  where l.id = p_line_id;
$$;

revoke all on function public.po_line_ordered_quantity(uuid) from public, anon, authenticated;
grant execute on function public.po_line_ordered_quantity(uuid) to service_role;

create or replace function public.record_po_receipt(
  p_org_id uuid,
  p_actor_id uuid,
  p_commitment_id uuid,
  p_idempotency_key text,
  p_received_at timestamptz,
  p_ticket_number text,
  p_note text,
  p_photo_file_ids uuid[],
  p_lines jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_po public.commitments%rowtype;
  v_existing public.po_receipts%rowtype;
  v_receipt_id uuid;
  v_el jsonb;
  v_line public.commitment_lines%rowtype;
  v_qty numeric;
  v_cond text;
  v_reason text;
  v_prior numeric;
  v_outstanding numeric;
  v_seen uuid[] := '{}';
  v_shortages jsonb := '[]'::jsonb;
  v_shortage_id uuid;
  v_photos uuid[] := coalesce(p_photo_file_ids, '{}');
  v_over boolean := false;
  v_summary jsonb := '[]'::jsonb;
begin
  if p_idempotency_key is null or length(btrim(p_idempotency_key)) = 0 then
    raise exception 'A receipt needs an idempotency key' using errcode = '22023';
  end if;
  if jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Receive at least one line' using errcode = '22023';
  end if;

  select * into v_po from public.commitments where id = p_commitment_id and org_id = p_org_id for update;
  if not found or v_po.commitment_type <> 'purchase_order' then
    raise exception 'Purchase order not found' using errcode = '42501';
  end if;

  select * into v_existing from public.po_receipts where org_id = p_org_id and idempotency_key = p_idempotency_key;
  if found then
    if v_existing.commitment_id <> p_commitment_id then
      raise exception 'That receipt key was already used for another purchase order' using errcode = '23505';
    end if;
    return jsonb_build_object('id', v_existing.id, 'project_id', v_po.project_id, 'commitment_id', p_commitment_id,
      'replayed', true, 'shortages', '[]'::jsonb);
  end if;

  if v_po.status not in ('approved', 'complete') then
    raise exception 'A purchase order has to be issued before it can be received against' using errcode = '22023';
  end if;
  if exists (
    select 1 from unnest(v_photos) as f(id)
    where not exists (select 1 from public.files x where x.id = f.id and x.org_id = p_org_id and x.project_id = v_po.project_id)
  ) then
    raise exception 'A photo does not belong to this home' using errcode = '22023';
  end if;

  insert into public.po_receipts(org_id, project_id, commitment_id, received_at, received_by, ticket_number, note,
    photo_file_ids, idempotency_key)
  values (p_org_id, v_po.project_id, p_commitment_id, coalesce(p_received_at, now()), p_actor_id,
    nullif(btrim(p_ticket_number), ''), nullif(btrim(p_note), ''), v_photos, btrim(p_idempotency_key))
  returning id into v_receipt_id;

  for v_el in select * from jsonb_array_elements(p_lines) loop
    select * into v_line from public.commitment_lines
    where id = (v_el->>'commitment_line_id')::uuid and org_id = p_org_id and commitment_id = p_commitment_id;
    if not found then
      raise exception 'A line is not on this purchase order' using errcode = '22023';
    end if;
    if v_line.id = any (v_seen) then
      raise exception 'A line can be received once per ticket' using errcode = '22023';
    end if;
    v_seen := v_seen || v_line.id;
    if v_line.needed_by is null then
      raise exception 'Give "%" a need-by date before receiving it', v_line.description using errcode = '22023';
    end if;
    v_qty := (v_el->>'quantity')::numeric;
    if v_qty is null or v_qty <= 0 then
      raise exception 'Received quantity must be more than zero' using errcode = '22023';
    end if;
    v_cond := coalesce(nullif(v_el->>'condition', ''), 'ok');
    if v_cond not in ('ok', 'damaged', 'wrong_item') then
      raise exception 'Unknown condition %', v_cond using errcode = '22023';
    end if;
    v_reason := nullif(btrim(coalesce(v_el->>'over_receipt_reason', '')), '');

    v_prior := public.po_line_received_quantity(v_line.id);
    if v_cond = 'ok' and v_prior + v_qty > public.po_line_ordered_quantity(v_line.id) then
      if v_reason is null or length(v_reason) < 3 then
        raise exception 'Receiving % of "%" puts it over the % ordered; say why', v_qty, v_line.description, public.po_line_ordered_quantity(v_line.id)
          using errcode = '22023';
      end if;
      v_over := true;
    else
      v_reason := null;
    end if;

    insert into public.po_receipt_lines(org_id, project_id, receipt_id, commitment_id, commitment_line_id,
      quantity_received, condition, note, over_receipt_reason)
    values (p_org_id, v_po.project_id, v_receipt_id, p_commitment_id, v_line.id, v_qty, v_cond,
      nullif(btrim(coalesce(v_el->>'note', '')), ''), v_reason);

    v_summary := v_summary || jsonb_build_object('commitment_line_id', v_line.id, 'quantity', v_qty, 'condition', v_cond);
    v_outstanding := public.po_line_ordered_quantity(v_line.id) - v_prior - case when v_cond = 'ok' then v_qty else 0 end;

    if v_cond <> 'ok' then
      v_shortage_id := null;
      insert into public.po_shortages(org_id, project_id, commitment_id, commitment_line_id, short_quantity, reason,
        note, opened_by)
      values (p_org_id, v_po.project_id, p_commitment_id, v_line.id, v_qty, v_cond,
        nullif(btrim(coalesce(v_el->>'note', '')), ''), p_actor_id)
      on conflict (commitment_line_id) where status in ('open', 'backordered') do nothing
      returning id into v_shortage_id;
      if v_shortage_id is not null then
        v_shortages := v_shortages || jsonb_build_object('id', v_shortage_id, 'commitment_line_id', v_line.id, 'reason', v_cond);
        insert into public.audit_log(org_id, actor_user_id, action, entity_type, entity_id, after_data, source)
        values (p_org_id, p_actor_id, 'insert', 'po_shortage', v_shortage_id,
          jsonb_build_object('commitment_id', p_commitment_id, 'commitment_line_id', v_line.id, 'reason', v_cond, 'short_quantity', v_qty),
          'po_receipts.shortage_opened');
        insert into public.events(org_id, event_type, entity_type, entity_id, payload, channel)
        values (p_org_id, 'po_shortage.opened', 'po_shortage', v_shortage_id,
          jsonb_build_object('project_id', v_po.project_id, 'commitment_id', p_commitment_id, 'reason', v_cond, 'actor_id', p_actor_id), 'activity');
      end if;
    elsif v_outstanding <= 0 then
      update public.po_shortages
      set status = 'received', backorder_date = null, resolved_by = p_actor_id, resolved_at = now(),
          resolution_note = 'Received in full'
      where commitment_line_id = v_line.id and status in ('open', 'backordered');
    end if;
  end loop;

  insert into public.audit_log(org_id, actor_user_id, action, entity_type, entity_id, after_data, source)
  values (p_org_id, p_actor_id, 'insert', 'po_receipt', v_receipt_id,
    jsonb_build_object('commitment_id', p_commitment_id, 'ticket_number', nullif(btrim(p_ticket_number), ''),
      'lines', v_summary, 'over_receipt', v_over),
    'po_receipts.recorded');
  insert into public.events(org_id, event_type, entity_type, entity_id, payload, channel)
  values (p_org_id, 'po_receipt.recorded', 'po_receipt', v_receipt_id,
    jsonb_build_object('project_id', v_po.project_id, 'commitment_id', p_commitment_id, 'line_count', jsonb_array_length(v_summary),
      'over_receipt', v_over, 'actor_id', p_actor_id), 'activity');

  return jsonb_build_object('id', v_receipt_id, 'project_id', v_po.project_id, 'commitment_id', p_commitment_id,
    'replayed', false, 'shortages', v_shortages);
end;
$$;

revoke all on function public.record_po_receipt(uuid, uuid, uuid, text, timestamptz, text, text, uuid[], jsonb) from public, anon, authenticated;
grant execute on function public.record_po_receipt(uuid, uuid, uuid, text, timestamptz, text, text, uuid[], jsonb) to service_role;

create or replace function public.close_po_line_short(
  p_org_id uuid,
  p_actor_id uuid,
  p_commitment_line_id uuid,
  p_reason text,
  p_note text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_line public.commitment_lines%rowtype;
  v_po public.commitments%rowtype;
  v_active public.po_shortages%rowtype;
  v_outstanding numeric;
  v_id uuid;
begin
  if p_reason not in ('vendor_short', 'not_delivered') then
    raise exception 'A line closed short is either short from the vendor or not delivered' using errcode = '22023';
  end if;
  select * into v_line from public.commitment_lines where id = p_commitment_line_id and org_id = p_org_id;
  if not found then
    raise exception 'Purchase-order line not found' using errcode = '42501';
  end if;
  select * into v_po from public.commitments where id = v_line.commitment_id and org_id = p_org_id for update;
  if not found or v_po.commitment_type <> 'purchase_order' or v_po.status <> 'approved' then
    raise exception 'Only a line on an issued, open purchase order can be closed short' using errcode = '22023';
  end if;
  if v_line.needed_by is null then
    raise exception 'Give "%" a need-by date first', v_line.description using errcode = '22023';
  end if;
  v_outstanding := public.po_line_ordered_quantity(v_line.id) - public.po_line_received_quantity(v_line.id);
  if v_outstanding <= 0 then
    raise exception 'Nothing is outstanding on this line' using errcode = '22023';
  end if;

  select * into v_active from public.po_shortages
  where commitment_line_id = v_line.id and status in ('open', 'backordered') for update;
  if found then
    if v_active.reason = 'late' then
      update public.po_shortages set reason = p_reason, note = coalesce(nullif(btrim(p_note), ''), note)
      where id = v_active.id;
      insert into public.audit_log(org_id, actor_user_id, action, entity_type, entity_id, before_data, after_data, source)
      values (p_org_id, p_actor_id, 'update', 'po_shortage', v_active.id,
        jsonb_build_object('reason', 'late'), jsonb_build_object('reason', p_reason), 'po_receipts.closed_short');
    end if;
    return jsonb_build_object('id', v_active.id, 'project_id', v_po.project_id, 'commitment_id', v_po.id, 'opened', false);
  end if;

  insert into public.po_shortages(org_id, project_id, commitment_id, commitment_line_id, short_quantity, reason, note, opened_by)
  values (p_org_id, v_po.project_id, v_po.id, v_line.id, v_outstanding, p_reason, nullif(btrim(p_note), ''), p_actor_id)
  returning id into v_id;
  insert into public.audit_log(org_id, actor_user_id, action, entity_type, entity_id, after_data, source)
  values (p_org_id, p_actor_id, 'insert', 'po_shortage', v_id,
    jsonb_build_object('commitment_id', v_po.id, 'commitment_line_id', v_line.id, 'reason', p_reason, 'short_quantity', v_outstanding),
    'po_receipts.closed_short');
  insert into public.events(org_id, event_type, entity_type, entity_id, payload, channel)
  values (p_org_id, 'po_shortage.opened', 'po_shortage', v_id,
    jsonb_build_object('project_id', v_po.project_id, 'commitment_id', v_po.id, 'reason', p_reason, 'actor_id', p_actor_id), 'activity');
  return jsonb_build_object('id', v_id, 'project_id', v_po.project_id, 'commitment_id', v_po.id, 'opened', true);
end;
$$;

revoke all on function public.close_po_line_short(uuid, uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.close_po_line_short(uuid, uuid, uuid, text, text) to service_role;

create or replace function public.resolve_po_shortage(
  p_org_id uuid,
  p_actor_id uuid,
  p_shortage_id uuid,
  p_resolution text,
  p_backorder_date date,
  p_note text,
  p_vpo_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.po_shortages%rowtype;
  v_note text := nullif(btrim(p_note), '');
begin
  if p_resolution not in ('backordered', 'vpo', 'accepted_short', 'cancelled') then
    raise exception 'Unknown resolution %', p_resolution using errcode = '22023';
  end if;
  select * into v_row from public.po_shortages where id = p_shortage_id and org_id = p_org_id for update;
  if not found then
    raise exception 'Shortage not found' using errcode = '42501';
  end if;
  if v_row.status not in ('open', 'backordered') then
    raise exception 'This shortage was already resolved' using errcode = '40001';
  end if;
  if p_resolution = 'backordered' and p_backorder_date is null then
    raise exception 'Give the date the back-order is promised for' using errcode = '22023';
  end if;
  if p_resolution = 'vpo' and p_vpo_id is null then
    raise exception 'Name the variance order' using errcode = '22023';
  end if;
  if p_resolution = 'vpo' and not exists (
    select 1 from public.commitment_change_orders v
    where v.id = p_vpo_id and v.org_id = p_org_id and v.commitment_id = v_row.commitment_id
      and v.status in ('draft', 'sent', 'approved')
  ) then
    raise exception 'The variance order is not live on this purchase order' using errcode = '22023';
  end if;
  if p_resolution in ('accepted_short', 'cancelled') and (v_note is null or length(v_note) < 3) then
    raise exception 'Say why' using errcode = '22023';
  end if;

  if p_resolution = 'backordered' then
    update public.po_shortages
    set status = 'backordered', backorder_date = p_backorder_date, resolution_note = v_note
    where id = p_shortage_id;
  else
    update public.po_shortages
    set status = p_resolution, backorder_date = null, vpo_id = case when p_resolution = 'vpo' then p_vpo_id else null end,
        resolved_by = p_actor_id, resolved_at = now(), resolution_note = v_note
    where id = p_shortage_id;
  end if;

  insert into public.audit_log(org_id, actor_user_id, action, entity_type, entity_id, before_data, after_data, source)
  values (p_org_id, p_actor_id, 'update', 'po_shortage', p_shortage_id,
    jsonb_build_object('status', v_row.status, 'backorder_date', v_row.backorder_date),
    jsonb_build_object('status', p_resolution, 'backorder_date', p_backorder_date, 'vpo_id', p_vpo_id, 'note', v_note),
    'po_receipts.shortage_resolved');
  insert into public.events(org_id, event_type, entity_type, entity_id, payload, channel)
  values (p_org_id, 'po_shortage.resolved', 'po_shortage', p_shortage_id,
    jsonb_build_object('project_id', v_row.project_id, 'commitment_id', v_row.commitment_id, 'resolution', p_resolution, 'actor_id', p_actor_id), 'activity');
  return jsonb_build_object('id', p_shortage_id, 'project_id', v_row.project_id, 'resolution', p_resolution);
end;
$$;

revoke all on function public.resolve_po_shortage(uuid, uuid, uuid, text, date, text, uuid) from public, anon, authenticated;
grant execute on function public.resolve_po_shortage(uuid, uuid, uuid, text, date, text, uuid) to service_role;

drop function if exists public.void_po_receipt(uuid, uuid, uuid, text);

create or replace function public.void_po_receipt(
  p_org_id uuid,
  p_actor_id uuid,
  p_receipt_id uuid,
  p_reason text,
  p_any_receipt boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_receipt public.po_receipts%rowtype;
  v_reason text := nullif(btrim(p_reason), '');
begin
  if v_reason is null or length(v_reason) < 3 then
    raise exception 'Say why this receipt is void' using errcode = '22023';
  end if;
  select * into v_receipt from public.po_receipts where id = p_receipt_id and org_id = p_org_id;
  if not found then
    raise exception 'Receipt not found' using errcode = '42501';
  end if;
  if not p_any_receipt and (v_receipt.received_by is distinct from p_actor_id or v_receipt.received_at::date <> (now() at time zone 'utc')::date) then
    raise exception 'Only the person who received it, the same day, or purchasing can void this receipt' using errcode = '42501';
  end if;
  perform 1 from public.commitments where id = v_receipt.commitment_id and org_id = p_org_id for update;
  select * into v_receipt from public.po_receipts where id = p_receipt_id and org_id = p_org_id for update;
  if v_receipt.status = 'void' then
    raise exception 'This receipt was already voided' using errcode = '40001';
  end if;
  update public.po_receipts
  set status = 'void', voided_by = p_actor_id, voided_at = now(), void_reason = v_reason
  where id = p_receipt_id;
  insert into public.audit_log(org_id, actor_user_id, action, entity_type, entity_id, before_data, after_data, source)
  values (p_org_id, p_actor_id, 'update', 'po_receipt', p_receipt_id,
    jsonb_build_object('status', 'recorded'), jsonb_build_object('status', 'void', 'reason', v_reason), 'po_receipts.voided');
  insert into public.events(org_id, event_type, entity_type, entity_id, payload, channel)
  values (p_org_id, 'po_receipt.voided', 'po_receipt', p_receipt_id,
    jsonb_build_object('project_id', v_receipt.project_id, 'commitment_id', v_receipt.commitment_id, 'actor_id', p_actor_id), 'activity');
  return jsonb_build_object('id', p_receipt_id, 'project_id', v_receipt.project_id);
end;
$$;

revoke all on function public.void_po_receipt(uuid, uuid, uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.void_po_receipt(uuid, uuid, uuid, text, boolean) to service_role;

create or replace function public.sweep_late_po_deliveries(p_today date, p_limit integer)
returns table (id uuid, org_id uuid, project_id uuid, commitment_id uuid)
language sql
security definer
set search_path = ''
as $$
  with due as (
    select l.id as line_id, l.org_id, c.project_id, c.id as commitment_id,
           public.po_line_ordered_quantity(l.id) - public.po_line_received_quantity(l.id) as outstanding
    from public.commitment_lines l
    join public.commitments c on c.id = l.commitment_id and c.org_id = l.org_id
    where c.commitment_type = 'purchase_order' and c.status = 'approved'
      and l.needed_by is not null and l.needed_by < coalesce(p_today, current_date)
      and public.po_line_ordered_quantity(l.id) - public.po_line_received_quantity(l.id) > 0
      and not exists (
        select 1 from public.po_shortages s
        where s.commitment_line_id = l.id
          and s.status in ('open', 'backordered', 'vpo', 'accepted_short', 'cancelled')
      )
    order by l.needed_by, l.id
    limit greatest(least(coalesce(p_limit, 500), 2000), 1)
  ),
  opened as (
    insert into public.po_shortages(org_id, project_id, commitment_id, commitment_line_id, short_quantity, reason)
    select d.org_id, d.project_id, d.commitment_id, d.line_id, d.outstanding, 'late' from due d
    on conflict (commitment_line_id) where status in ('open', 'backordered') do nothing
    returning po_shortages.id, po_shortages.org_id, po_shortages.project_id, po_shortages.commitment_id,
              po_shortages.commitment_line_id, po_shortages.short_quantity
  ),
  audited as (
    insert into public.audit_log(org_id, actor_user_id, action, entity_type, entity_id, after_data, source)
    select o.org_id, null, 'insert', 'po_shortage', o.id,
      jsonb_build_object('commitment_id', o.commitment_id, 'commitment_line_id', o.commitment_line_id,
        'reason', 'late', 'short_quantity', o.short_quantity),
      'po_receipts.late_sweep'
    from opened o
  ),
  announced as (
    insert into public.events(org_id, event_type, entity_type, entity_id, payload, channel)
    select o.org_id, 'po_shortage.opened', 'po_shortage', o.id,
      jsonb_build_object('project_id', o.project_id, 'commitment_id', o.commitment_id, 'reason', 'late', 'source', 'late_sweep'),
      'activity'
    from opened o
  )
  select o.id, o.org_id, o.project_id, o.commitment_id from opened o;
$$;

revoke all on function public.sweep_late_po_deliveries(date, integer) from public, anon, authenticated;
grant execute on function public.sweep_late_po_deliveries(date, integer) to service_role;

create or replace function public.list_po_delivery_queue(
  p_org_id uuid,
  p_division_ids uuid[],
  p_member_user_id uuid,
  p_community_id uuid,
  p_project_id uuid,
  p_commitment_id uuid,
  p_state text,
  p_today date,
  p_limit integer,
  p_offset integer
)
returns table (
  line_id uuid,
  commitment_id uuid,
  project_id uuid,
  project_name text,
  po_title text,
  contract_number text,
  vendor_name text,
  cost_code_id uuid,
  description text,
  unit text,
  ordered numeric,
  received numeric,
  outstanding numeric,
  needed_by date,
  expected_date date,
  days_late integer,
  state text,
  shortage_id uuid,
  shortage_status text,
  shortage_reason text,
  backorder_date date,
  total_count bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  with base as (
    select
      l.id as line_id, c.id as commitment_id, c.project_id, pr.name as project_name, c.title as po_title,
      c.contract_number, co.name as vendor_name, l.cost_code_id, l.description, l.unit,
      public.po_line_ordered_quantity(l.id) as ordered,
      public.po_line_received_quantity(l.id) as received,
      public.po_line_ordered_quantity(l.id) - public.po_line_received_quantity(l.id) as outstanding,
      l.needed_by,
      coalesce(case when act.status = 'backordered' then act.backorder_date end, l.needed_by) as expected_date,
      c.status as po_status,
      act.id as shortage_id, act.status as shortage_status, act.reason as shortage_reason, act.backorder_date,
      exists (
        select 1 from public.po_shortages f
        where f.commitment_line_id = l.id and f.status in ('vpo', 'accepted_short', 'cancelled')
      ) as closed_out
    from public.commitment_lines l
    join public.commitments c on c.id = l.commitment_id and c.org_id = l.org_id
    join public.projects pr on pr.id = c.project_id and pr.org_id = c.org_id
    left join public.companies co on co.id = c.company_id
    left join lateral (
      select s.id, s.status, s.reason, s.backorder_date from public.po_shortages s
      where s.commitment_line_id = l.id and s.status in ('open', 'backordered') limit 1
    ) act on true
    where l.org_id = p_org_id and l.needed_by is not null
      and c.commitment_type = 'purchase_order' and c.status in ('approved', 'complete')
      and (p_project_id is null or c.project_id = p_project_id)
      and (p_commitment_id is null or c.id = p_commitment_id)
      and (p_division_ids is null or pr.division_id = any (p_division_ids))
      and (p_member_user_id is null or exists (
        select 1 from public.project_members pm
        where pm.org_id = p_org_id and pm.project_id = pr.id and pm.user_id = p_member_user_id and pm.status = 'active'
      ))
      and (p_community_id is null or exists (
        select 1 from public.lots lo
        where lo.org_id = p_org_id and lo.project_id = pr.id and lo.community_id = p_community_id
      ))
  ),
  classified as (
    select b.*,
      case
        when b.outstanding <= 0 then 'received'
        when b.closed_out or b.po_status = 'complete' then 'closed'
        when b.shortage_status = 'open' and b.shortage_reason <> 'late' then 'short'
        when b.expected_date < coalesce(p_today, current_date) then 'late'
        when b.received > 0 then 'partial'
        else 'expected'
      end as state
    from base b
  )
  select x.line_id, x.commitment_id, x.project_id, x.project_name, x.po_title, x.contract_number, x.vendor_name,
    x.cost_code_id, x.description, x.unit, x.ordered, x.received, x.outstanding, x.needed_by, x.expected_date,
    case when x.outstanding > 0 then greatest(coalesce(p_today, current_date) - x.expected_date, 0) else 0 end as days_late,
    x.state, x.shortage_id, x.shortage_status, x.shortage_reason, x.backorder_date,
    count(*) over () as total_count
  from classified x
  where case coalesce(p_state, 'open')
    when 'all' then true
    when 'open' then x.state in ('expected', 'late', 'partial', 'short')
    else x.state = p_state
  end
  order by x.expected_date, x.project_name, x.line_id
  limit greatest(least(coalesce(p_limit, 50), 200), 1)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

revoke all on function public.list_po_delivery_queue(uuid, uuid[], uuid, uuid, uuid, uuid, text, date, integer, integer) from public, anon, authenticated;
grant execute on function public.list_po_delivery_queue(uuid, uuid[], uuid, uuid, uuid, uuid, text, date, integer, integer) to service_role;
