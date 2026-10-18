-- EP08 review round 3 (R3-D): issued purchase orders, acknowledgments and receipts.
--
-- 1. write_commitment_line totals an order as the sum of each line's amount rounded half up to a cent
--    (the rule lib/purchasing/po-line-amount.ts and PO generation use), checks the line's cost code and
--    budget line belong to the order's org (and the budget line to its project), and the line it deletes
--    may not carry history.
-- 2. tg_commitment_line_history_guard: a line with a vendor answer line, a receipt line or a shortage on
--    record cannot be deleted (it would cascade the vendor's dispute and the shortage away). Chosen over
--    changing the foreign keys to NO ACTION so the refusal reads as a sentence, from the data API and the
--    service alike; deleting the order itself is already refused once it has history.
-- 3. tg_commitment_creator_provenance: created_by_user_id is the data API caller on insert and cannot be
--    rewritten or removed by a member on update, drafts included, because separation of duties reads it.
-- 4. po_shortages remembers the receipt that opened it and the receipt that closed it, and void_po_receipt
--    cancels the open shortages the receipt opened and reopens the ones it closed, in the same
--    transaction. record_po_receipt stamps those links and refuses a receipt dated in the future.
--
-- guard_po_receipt_record is redefined here only to allow the reopening above (round 2's clause is carried).
-- No other EP08 round-3 migration redefines these functions (checked with grep over 2026101518*).

alter table public.po_shortages
  add column if not exists opened_by_receipt_id uuid references public.po_receipts(id) on delete set null,
  add column if not exists closed_by_receipt_id uuid references public.po_receipts(id) on delete set null;

create index if not exists po_shortages_opened_by_receipt_idx on public.po_shortages (opened_by_receipt_id) where opened_by_receipt_id is not null;
create index if not exists po_shortages_closed_by_receipt_idx on public.po_shortages (closed_by_receipt_id) where closed_by_receipt_id is not null;

-- ---------------------------------------------------------------------------
-- 2. Line history guard.
-- ---------------------------------------------------------------------------

create or replace function public.tg_commitment_line_history_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- The order itself is being deleted (a cascade): its own guards decide whether that was allowed.
  if not exists (select 1 from public.commitments c where c.id = old.commitment_id) then
    return old;
  end if;
  if exists (select 1 from public.po_acknowledgment_lines al where al.commitment_line_id = old.id)
     or exists (select 1 from public.po_receipt_lines rl where rl.commitment_line_id = old.id)
     or exists (select 1 from public.po_shortages s where s.commitment_line_id = old.id) then
    raise exception 'This line has a vendor answer, a receipt or a shortage on record and cannot be deleted. Cancel the order or raise a variance order instead.' using errcode = '23503';
  end if;
  return old;
end;
$$;

revoke all on function public.tg_commitment_line_history_guard() from public, anon, authenticated;

drop trigger if exists commitment_lines_history_guard on public.commitment_lines;
create trigger commitment_lines_history_guard
  before delete on public.commitment_lines
  for each row execute function public.tg_commitment_line_history_guard();

-- ---------------------------------------------------------------------------
-- 3. Creator provenance.
-- ---------------------------------------------------------------------------

create or replace function public.tg_commitment_creator_provenance()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if current_user <> 'authenticated' then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if v_uid is not null then
      new.metadata := coalesce(new.metadata, '{}'::jsonb) || jsonb_build_object('created_by_user_id', v_uid::text);
    else
      new.metadata := coalesce(new.metadata, '{}'::jsonb) - 'created_by_user_id';
    end if;
    return new;
  end if;
  if (new.metadata -> 'created_by_user_id') is distinct from (old.metadata -> 'created_by_user_id') then
    raise exception 'Who created an order is recorded by the system and is locked' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.tg_commitment_creator_provenance() from public, anon, authenticated;

drop trigger if exists commitments_creator_provenance on public.commitments;
create trigger commitments_creator_provenance
  before insert or update of metadata on public.commitments
  for each row execute function public.tg_commitment_creator_provenance();

-- ---------------------------------------------------------------------------
-- 4. Receipts: link shortages to the receipts that opened and closed them.
-- ---------------------------------------------------------------------------

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

  if p_received_at is not null and p_received_at > now() + interval '10 minutes' then
    raise exception 'A delivery cannot be received in the future' using errcode = '22023';
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
        note, opened_by, opened_by_receipt_id)
      values (p_org_id, v_po.project_id, p_commitment_id, v_line.id, v_qty, v_cond,
        nullif(btrim(coalesce(v_el->>'note', '')), ''), p_actor_id, v_receipt_id)
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
          resolution_note = 'Received in full', closed_by_receipt_id = v_receipt_id
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

-- The receipt guard keeps a closed shortage closed; voiding the receipt that closed it is the one way back
-- from 'received' (the round-2 clause for a voided variance order is carried unchanged).
create or replace function public.guard_po_receipt_record()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_table_name = 'po_receipt_lines' then
    raise exception 'A received quantity cannot be changed; void the receipt and record it again' using errcode = '42501';
  end if;
  if tg_table_name = 'po_receipts' then
    if row(new.org_id, new.project_id, new.commitment_id, new.received_at, new.received_by, new.ticket_number,
           new.note, new.photo_file_ids, new.idempotency_key)
       is distinct from
       row(old.org_id, old.project_id, old.commitment_id, old.received_at, old.received_by, old.ticket_number,
           old.note, old.photo_file_ids, old.idempotency_key) then
      raise exception 'A receipt cannot be changed; void it and record it again' using errcode = '42501';
    end if;
    if old.status = 'void' and new.status is distinct from old.status then
      raise exception 'This receipt is already void' using errcode = '42501';
    end if;
    return new;
  end if;
  -- po_shortages
  if row(new.org_id, new.project_id, new.commitment_id, new.commitment_line_id, new.short_quantity, new.opened_by, new.opened_at)
     is distinct from
     row(old.org_id, old.project_id, old.commitment_id, old.commitment_line_id, old.short_quantity, old.opened_by, old.opened_at) then
    raise exception 'A shortage''s line and quantity cannot be changed' using errcode = '42501';
  end if;
  -- A late shortage is re-labelled when the receiver closes the line short.
  if new.reason is distinct from old.reason and old.reason <> 'late' then
    raise exception 'A shortage''s reason cannot be changed' using errcode = '42501';
  end if;
  if old.status not in ('open', 'backordered') and new.status is distinct from old.status
     and not (old.status = 'vpo' and new.status in ('open', 'cancelled')
              and coalesce(current_setting('arc.vpo_shortage_reopen', true), '') = 'on')
     and not (old.status = 'received' and new.status = 'open'
              and coalesce(current_setting('arc.receipt_void_reopen', true), '') = 'on') then
    raise exception 'This shortage is already closed' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_po_receipt_record() from public, anon, authenticated;

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
  v_cancelled integer;
  v_reopened integer;
begin
  if v_reason is null or length(v_reason) < 3 then
    raise exception 'Say why this receipt is void' using errcode = '22023';
  end if;
  select * into v_receipt from public.po_receipts where id = p_receipt_id and org_id = p_org_id;
  if not found then
    raise exception 'Receipt not found' using errcode = '42501';
  end if;
  if not p_any_receipt and (v_receipt.received_by is distinct from p_actor_id or v_receipt.created_at < now() - interval '24 hours') then
    raise exception 'Only the person who received it, within 24 hours of entering it, or purchasing can void this receipt' using errcode = '42501';
  end if;
  perform 1 from public.commitments where id = v_receipt.commitment_id and org_id = p_org_id for update;
  select * into v_receipt from public.po_receipts where id = p_receipt_id and org_id = p_org_id for update;
  if v_receipt.status = 'void' then
    raise exception 'This receipt was already voided' using errcode = '40001';
  end if;
  update public.po_receipts
  set status = 'void', voided_by = p_actor_id, voided_at = now(), void_reason = v_reason
  where id = p_receipt_id;

  -- A shortage this ticket opened and nobody has acted on is cancelled with the ticket; one purchasing
  -- already back-ordered or resolved stays as they left it.
  update public.po_shortages
  set status = 'cancelled', backorder_date = null, resolved_by = p_actor_id, resolved_at = now(),
      resolution_note = 'The receipt that reported it was voided'
  where org_id = p_org_id and opened_by_receipt_id = p_receipt_id and status = 'open';
  get diagnostics v_cancelled = row_count;

  -- A shortage this ticket closed as received in full is outstanding again, unless the line has a live one.
  perform set_config('arc.receipt_void_reopen', 'on', true);
  update public.po_shortages s
  set status = 'open', backorder_date = null, resolved_by = null, resolved_at = null, resolution_note = null,
      closed_by_receipt_id = null
  where s.org_id = p_org_id and s.closed_by_receipt_id = p_receipt_id and s.status = 'received'
    and not exists (
      select 1 from public.po_shortages other
      where other.commitment_line_id = s.commitment_line_id and other.status in ('open', 'backordered')
    );
  get diagnostics v_reopened = row_count;
  perform set_config('arc.receipt_void_reopen', 'off', true);

  insert into public.audit_log(org_id, actor_user_id, action, entity_type, entity_id, before_data, after_data, source)
  values (p_org_id, p_actor_id, 'update', 'po_receipt', p_receipt_id,
    jsonb_build_object('status', 'recorded'),
    jsonb_build_object('status', 'void', 'reason', v_reason, 'shortages_cancelled', v_cancelled, 'shortages_reopened', v_reopened),
    'po_receipts.voided');
  insert into public.events(org_id, event_type, entity_type, entity_id, payload, channel)
  values (p_org_id, 'po_receipt.voided', 'po_receipt', p_receipt_id,
    jsonb_build_object('project_id', v_receipt.project_id, 'commitment_id', v_receipt.commitment_id, 'actor_id', p_actor_id,
      'shortages_cancelled', v_cancelled, 'shortages_reopened', v_reopened), 'activity');
  return jsonb_build_object('id', p_receipt_id, 'project_id', v_receipt.project_id,
    'shortages_cancelled', v_cancelled, 'shortages_reopened', v_reopened);
end;
$$;

revoke all on function public.void_po_receipt(uuid, uuid, uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.void_po_receipt(uuid, uuid, uuid, text, boolean) to service_role;

-- ---------------------------------------------------------------------------
-- 1. write_commitment_line.
-- ---------------------------------------------------------------------------

create or replace function public.write_commitment_line(
  p_org_id uuid,
  p_op text,
  p_commitment_id uuid,
  p_line_id uuid,
  p_values jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_commitment public.commitments%rowtype;
  v_line_id uuid := p_line_id;
  v_total bigint;
  v_cost_code_id uuid;
  v_budget_line_id uuid;
begin
  if p_op not in ('insert', 'update', 'delete') then
    raise exception 'Unknown line operation' using errcode = '22023';
  end if;
  select * into v_commitment from public.commitments
  where id = p_commitment_id and org_id = p_org_id
  for update;
  if not found then
    raise exception 'Commitment not found or access denied' using errcode = '42501';
  end if;
  if v_commitment.commitment_type = 'purchase_order' and public.po_status_is_issued(v_commitment.status) then
    raise exception 'This purchase order is approved and locked. Raise a variance order to change it, or return it to draft first.' using errcode = '42501';
  end if;

  if p_op in ('insert', 'update') then
    v_cost_code_id := nullif(p_values ->> 'cost_code_id', '')::uuid;
    v_budget_line_id := nullif(p_values ->> 'budget_line_id', '')::uuid;
    if v_cost_code_id is not null and (p_op = 'insert' or p_values ? 'cost_code_id')
       and not exists (select 1 from public.cost_codes cc where cc.id = v_cost_code_id and cc.org_id = p_org_id) then
      raise exception 'That cost code does not belong to this organization' using errcode = '22023';
    end if;
    if v_budget_line_id is not null and (p_op = 'insert' or p_values ? 'budget_line_id')
       and not exists (
         select 1 from public.budget_lines bl join public.budgets b on b.id = bl.budget_id and b.org_id = bl.org_id
         where bl.id = v_budget_line_id and bl.org_id = p_org_id and b.project_id = v_commitment.project_id
       ) then
      raise exception 'That budget line is not on this home' using errcode = '22023';
    end if;
  end if;

  if p_op = 'insert' then
    insert into public.commitment_lines(org_id, commitment_id, cost_code_id, budget_line_id, description, quantity, unit,
      unit_cost_cents, scheduled_value_cents, retainage_percent)
    values (p_org_id, p_commitment_id, v_cost_code_id, v_budget_line_id,
      p_values ->> 'description', (p_values ->> 'quantity')::numeric, p_values ->> 'unit',
      (p_values ->> 'unit_cost_cents')::integer, (p_values ->> 'scheduled_value_cents')::integer,
      (p_values ->> 'retainage_percent')::numeric)
    returning id into v_line_id;
  else
    perform 1 from public.commitment_lines where id = v_line_id and org_id = p_org_id and commitment_id = p_commitment_id;
    if not found then
      raise exception 'Commitment line not found or access denied' using errcode = '42501';
    end if;
    if p_op = 'update' then
      update public.commitment_lines l set
        cost_code_id = case when p_values ? 'cost_code_id' then v_cost_code_id else l.cost_code_id end,
        budget_line_id = case when p_values ? 'budget_line_id' then v_budget_line_id else l.budget_line_id end,
        description = case when p_values ? 'description' then p_values ->> 'description' else l.description end,
        quantity = case when p_values ? 'quantity' then (p_values ->> 'quantity')::numeric else l.quantity end,
        unit = case when p_values ? 'unit' then p_values ->> 'unit' else l.unit end,
        unit_cost_cents = case when p_values ? 'unit_cost_cents' then (p_values ->> 'unit_cost_cents')::integer else l.unit_cost_cents end,
        scheduled_value_cents = case when p_values ? 'scheduled_value_cents' then (p_values ->> 'scheduled_value_cents')::integer else l.scheduled_value_cents end,
        retainage_percent = case when p_values ? 'retainage_percent' then (p_values ->> 'retainage_percent')::numeric else l.retainage_percent end
      where l.id = v_line_id and l.org_id = p_org_id;
    else
      delete from public.commitment_lines where id = v_line_id and org_id = p_org_id;
    end if;
  end if;

  -- The order's total is the sum of each line's amount rounded half up to a cent.
  select coalesce(sum(round(l.quantity * coalesce(l.unit_cost_cents, 0))), 0)::bigint into v_total
  from public.commitment_lines l where l.org_id = p_org_id and l.commitment_id = p_commitment_id;
  update public.commitments set total_cents = v_total where id = p_commitment_id and org_id = p_org_id;
  return jsonb_build_object('line_id', v_line_id, 'commitment_id', p_commitment_id, 'total_cents', v_total);
end;
$$;

revoke all on function public.write_commitment_line(uuid, text, uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.write_commitment_line(uuid, text, uuid, uuid, jsonb) to service_role;
