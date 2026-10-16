-- EP08 review round 2 fixes for purchasing controls.
--
-- Model: every change order on a purchase order IS a variance order. The service raises it as a draft with
-- a reason code, and it is approved only with a reason code, through the variance controls (band, evidence,
-- separation of duties). The database enforces the two halves a member could otherwise reach through the
-- data API: no member inserts a change order (or its lines) on a purchase order at all, and no change order
-- on a purchase order moves to approved without a reason code, whoever writes it.
--
-- 1. A change order always sits on its commitment's own project and organization (insert and update).
-- 2. void_commitment_change_order: locked, serialized with completion approval, refuses a variance order
--    that any live bill or completion relies on.
-- 3. approve_po_completion closes a net-credit completion as a vendor credit instead of raising, and applies
--    open vendor credits to the next payable; purchase_order_positions reports the open credit.
-- 4. A shortage resolved by a variance order is reopened when that order is voided or rejected.
-- 5. The variance report reads every approved purchase-order change order, with or without a reason.
--
-- purchasing_settings.vpo_reason_code_required is no longer read by anything. Dropping it is a destructive
-- change and is left to a gated migration.

-- 1. Commitment rules, for every writer.

create function public.tg_commitment_change_order_commitment_rules()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_commitment public.commitments%rowtype;
begin
  select * into v_commitment from public.commitments where id = new.commitment_id;
  if not found or v_commitment.org_id is distinct from new.org_id or v_commitment.project_id is distinct from new.project_id then
    raise exception 'A change order belongs to the project and organization of its commitment' using errcode = '23514';
  end if;
  if v_commitment.commitment_type = 'purchase_order'
     and new.status = 'approved' and new.reason_code_id is null
     and (tg_op = 'INSERT' or old.status is distinct from 'approved') then
    raise exception 'A purchase-order change is approved as a variance order, with a reason' using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function public.tg_commitment_change_order_commitment_rules() from public, anon, authenticated;

create trigger commitment_change_orders_commitment_rules
before insert or update of org_id, project_id, commitment_id, status, reason_code_id
on public.commitment_change_orders
for each row execute function public.tg_commitment_change_order_commitment_rules();

-- A member never inserts a change order, or a line of one, on a purchase order: the service raises them.

create or replace function public.tg_commitment_change_order_system_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_final constant text[] := array['approved', 'rejected', 'voided'];
begin
  if current_user <> 'authenticated' then
    return coalesce(new, old);
  end if;
  if tg_op = 'INSERT' then
    if new.origin = 'design_studio_co' then
      raise exception 'A variance order for an executed change order is raised by the change order' using errcode = '42501';
    end if;
    if new.reason_code_id is not null
       or exists (select 1 from public.commitments c where c.id = new.commitment_id and c.commitment_type = 'purchase_order') then
      raise exception 'A variance order is raised through purchasing' using errcode = '42501';
    end if;
    if new.status not in ('draft', 'sent') or new.approved_by is not null or new.approved_at is not null then
      raise exception 'A change order is approved through its approval, not inserted as approved' using errcode = '42501';
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    if old.origin = 'design_studio_co' then
      raise exception 'A variance order raised by a change order is kept; void it instead' using errcode = '42501';
    end if;
    if old.reason_code_id is not null or old.status <> all (array['draft', 'sent']) then
      raise exception 'A decided or variance order is kept; void it instead' using errcode = '42501';
    end if;
    return old;
  end if;
  if old.origin is distinct from 'design_studio_co' then
    if new.origin = 'design_studio_co' then
      raise exception 'A variance order for an executed change order is raised by the change order' using errcode = '42501';
    end if;
  elsif (new.org_id, new.project_id, new.commitment_id, new.total_cents, new.origin, new.prime_change_order_id, new.reason_code_id)
        is distinct from (old.org_id, old.project_id, old.commitment_id, old.total_cents, old.origin, old.prime_change_order_id, old.reason_code_id) then
    raise exception 'A variance order raised by a change order is re-priced through purchasing with a reason' using errcode = '42501';
  end if;
  if (new.status is distinct from old.status and (new.status = any (v_final) or old.status = any (v_final)))
     or (new.approved_by, new.approved_at) is distinct from (old.approved_by, old.approved_at)
     or (new.org_id, new.project_id, new.commitment_id, new.company_id, new.total_cents, new.reason_code_id,
         new.requested_by, new.evidence_file_ids, new.photo_file_ids, new.currency)
        is distinct from (old.org_id, old.project_id, old.commitment_id, old.company_id, old.total_cents, old.reason_code_id,
         old.requested_by, old.evidence_file_ids, old.photo_file_ids, old.currency) then
    raise exception 'A change order is approved, rejected, voided and repriced through purchasing' using errcode = '42501';
  end if;
  if old.status = any (v_final)
     and (new.title, new.description, new.origin, new.metadata, new.source_document_id, new.executed_file_id, new.signature_envelope_id)
         is distinct from (old.title, old.description, old.origin, old.metadata, old.source_document_id, old.executed_file_id, old.signature_envelope_id) then
    raise exception 'A decided change order is a record and is not edited' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.tg_commitment_change_order_system_guard() from public, anon, authenticated;

create or replace function public.tg_commitment_change_order_line_system_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_order uuid := coalesce(new.commitment_change_order_id, old.commitment_change_order_id);
begin
  if current_user <> 'authenticated' then
    return coalesce(new, old);
  end if;
  if tg_op = 'UPDATE' and new.commitment_change_order_id is distinct from old.commitment_change_order_id
     and exists (select 1 from public.commitment_change_orders v
                 join public.commitments c on c.id = v.commitment_id
                 where v.id = new.commitment_change_order_id
                 and (v.origin = 'design_studio_co' or v.reason_code_id is not null or v.status not in ('draft', 'sent')
                      or c.commitment_type = 'purchase_order')) then
    raise exception 'A change order''s lines are re-priced through purchasing' using errcode = '42501';
  end if;
  if exists (select 1 from public.commitment_change_orders v
             join public.commitments c on c.id = v.commitment_id
             where v.id = v_order
             and (v.origin = 'design_studio_co' or v.reason_code_id is not null or v.status not in ('draft', 'sent')
                  or c.commitment_type = 'purchase_order')) then
    raise exception 'A change order''s lines are re-priced through purchasing' using errcode = '42501';
  end if;
  return coalesce(new, old);
end;
$$;

revoke all on function public.tg_commitment_change_order_line_system_guard() from public, anon, authenticated;

-- 2. Void: serialized with completion approval, refused while a bill or completion relies on the order.

create function public.void_commitment_change_order(
  p_org_id uuid,
  p_id uuid,
  p_actor_id uuid,
  p_reason text,
  p_expected_status text
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_commitment_id uuid;
  v_commitment public.commitments%rowtype;
  v_order public.commitment_change_orders%rowtype;
  v_billed bigint;
  v_revised_without bigint;
begin
  select cco.commitment_id into v_commitment_id from public.commitment_change_orders cco
    where cco.org_id = p_org_id and cco.id = p_id;
  if not found then raise exception 'Commitment change order not found'; end if;
  -- The same lock approve_po_completion takes, so a completion approving and this void cannot interleave.
  select * into v_commitment from public.commitments where org_id = p_org_id and id = v_commitment_id for update;
  select * into v_order from public.commitment_change_orders where org_id = p_org_id and id = p_id for update;
  if v_order.status = 'voided' then return v_order.id; end if;
  if v_order.status = 'rejected' then raise exception 'A rejected change order is already closed.'; end if;
  if v_order.status is distinct from p_expected_status then
    raise exception 'This change order changed while you were reviewing it. Reload and try again.';
  end if;
  if v_order.status = 'approved' then
    if exists (
      select 1 from public.po_completions pc
      where pc.org_id = p_org_id and pc.commitment_id = v_order.commitment_id
        and pc.status in ('reported', 'verified', 'approved', 'billed')
        and p_id = any (coalesce(pc.change_order_ids, '{}'))
    ) then
      raise exception 'A completion already claims this variance order. Reject it, or raise an offsetting back-charge.';
    end if;
    if exists (
      select 1 from public.bill_lines bl
      join public.vendor_bills vb on vb.id = bl.bill_id and vb.org_id = bl.org_id
      join public.commitment_change_order_lines ccol on ccol.id::text = bl.metadata ->> 'commitment_change_order_line_id'
      where bl.org_id = p_org_id and vb.status <> 'rejected' and ccol.commitment_change_order_id = p_id
    ) then
      raise exception 'A bill already bills this variance order. Raise an offsetting back-charge instead.';
    end if;
    select coalesce(sum(vb.total_cents), 0)::bigint into v_billed from public.vendor_bills vb
      where vb.org_id = p_org_id and vb.commitment_id = v_order.commitment_id and vb.status <> 'rejected';
    select coalesce(v_commitment.total_cents, 0)::bigint + coalesce(sum(cco.total_cents), 0)::bigint - v_order.total_cents
      into v_revised_without
      from public.commitment_change_orders cco
      where cco.org_id = p_org_id and cco.commitment_id = v_order.commitment_id and cco.status = 'approved';
    if v_billed > v_revised_without then
      raise exception 'Bills already drawn on this purchase order exceed what it authorizes without this variance order. Raise an offsetting back-charge instead.';
    end if;
  end if;
  update public.commitment_change_orders set
    status = 'voided',
    metadata = metadata || jsonb_build_object('voided_at', now(), 'voided_by', p_actor_id, 'void_reason', btrim(p_reason)),
    updated_at = now()
  where org_id = p_org_id and id = p_id;
  return p_id;
end;
$$;

revoke all on function public.void_commitment_change_order(uuid, uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.void_commitment_change_order(uuid, uuid, uuid, text, text) to service_role;

-- 4. A shortage a variance order resolved is open again when that order is voided or rejected.

-- The receipt guard keeps a closed shortage closed; the one way back is the reopening below, which says so
-- for its own transaction only.
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
              and coalesce(current_setting('arc.vpo_shortage_reopen', true), '') = 'on') then
    raise exception 'This shortage is already closed' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_po_receipt_record() from public, anon, authenticated;

create function public.tg_commitment_change_order_reopen_shortage()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_shortage public.po_shortages%rowtype;
begin
  perform set_config('arc.vpo_shortage_reopen', 'on', true);
  for v_shortage in
    select * from public.po_shortages s
    where s.org_id = new.org_id and s.vpo_id = new.id and s.status = 'vpo'
    for update
  loop
    if exists (
      select 1 from public.po_shortages other
      where other.commitment_line_id = v_shortage.commitment_line_id and other.id <> v_shortage.id
        and other.status in ('open', 'backordered')
    ) then
      -- A newer shortage already covers the line; this one closes without a replacement.
      update public.po_shortages set status = 'cancelled', vpo_id = null,
        resolution_note = 'The replacement variance order was ' || new.status || '; a newer shortage covers this line.'
      where id = v_shortage.id;
    else
      update public.po_shortages set status = 'open', vpo_id = null, resolved_by = null, resolved_at = null,
        resolution_note = null
      where id = v_shortage.id;
    end if;
  end loop;
  perform set_config('arc.vpo_shortage_reopen', 'off', true);
  return new;
end;
$$;

revoke all on function public.tg_commitment_change_order_reopen_shortage() from public, anon, authenticated;

create trigger commitment_change_orders_reopen_shortage
after update of status on public.commitment_change_orders
for each row
when (new.status in ('voided', 'rejected') and old.status is distinct from new.status)
execute function public.tg_commitment_change_order_reopen_shortage();

-- 3. Completion approval: a net credit closes as a vendor credit; open credits net the next payable.

create or replace function public.approve_po_completion(
  p_org_id uuid,
  p_completion_id uuid,
  p_actor_id uuid,
  p_inspection_id uuid default null,
  p_waiver_reason text default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_completion public.po_completions%rowtype;
  v_commitment public.commitments%rowtype;
  v_settings public.purchasing_settings%rowtype;
  v_bill_id uuid;
  v_amount bigint := 0;
  v_net bigint := 0;
  v_lines_amount bigint := 0;
  v_vpo_amount bigint := 0;
  v_vpo_ids uuid[];
  v_revised_total bigint := 0;
  v_already_billed bigint := 0;
  v_overlap uuid;
  v_line record;
  v_credit record;
  v_credit_applied bigint := 0;
  v_credit_ids uuid[] := '{}';
  v_waived boolean := false;
begin
  select * into v_completion from public.po_completions
    where org_id = p_org_id and id = p_completion_id for update;
  if not found then raise exception 'PO completion not found'; end if;
  -- The money step needs a second person: whoever reported or verified the
  -- work does not also release the payment for it.
  if p_actor_id is not distinct from v_completion.reported_by_user_id
     or p_actor_id is not distinct from v_completion.verified_by then
    raise exception 'The person who reported or verified a completion cannot approve it'
      using errcode = '42501';
  end if;

  if v_completion.status = 'billed' then
    return jsonb_build_object('completion_id', v_completion.id, 'vendor_bill_id', v_completion.vendor_bill_id,
      'amount_cents', v_completion.amount_cents, 'credit_cents', (v_completion.metadata ->> 'vendor_credit_cents')::bigint);
  end if;

  select * into v_commitment from public.commitments
    where org_id = p_org_id and id = v_completion.commitment_id for update;
  if not found or v_commitment.commitment_type <> 'purchase_order' or v_commitment.status <> 'approved' then
    raise exception 'Only approved purchase orders can be completed';
  end if;

  select other.id into v_overlap
  from public.po_completions other
  where other.org_id = p_org_id
    and other.commitment_id = v_commitment.id
    and other.id <> v_completion.id
    and other.status in ('approved', 'billed')
    and (
      public.po_completion_lines_overlap(other.commitment_line_ids, v_completion.commitment_line_ids)
      or other.change_order_ids && v_completion.change_order_ids
    )
  limit 1;
  if v_overlap is not null then
    raise exception 'This purchase-order scope was already billed by completion %', v_overlap;
  end if;

  select * into v_settings from public.purchasing_settings where org_id = p_org_id;
  if coalesce(v_settings.po_completion_requires_verification, true) and v_completion.status <> 'verified' then
    raise exception 'PO completion must be verified before approval';
  end if;
  if not coalesce(v_settings.po_completion_requires_verification, true)
      and v_completion.status not in ('reported','verified') then
    raise exception 'PO completion is not approval-ready';
  end if;

  -- The inspection or waiver this approval relies on is written with the approval, only while the
  -- completion is still open: a billed completion's evidence is history.
  if p_inspection_id is not null then
    if not exists (
      select 1 from public.inspections i
      where i.org_id = p_org_id and i.id = p_inspection_id and i.project_id = v_completion.project_id
        and i.status = 'completed' and i.result = 'pass'
    ) then
      raise exception 'Only a completed, passed inspection on this home can back a completion';
    end if;
    v_completion.inspection_id := p_inspection_id;
  elsif nullif(btrim(coalesce(p_waiver_reason, '')), '') is not null and v_completion.inspection_id is null then
    if length(btrim(p_waiver_reason)) < 5 then raise exception 'Say why no passed inspection is needed'; end if;
    v_completion.inspection_waived_reason := btrim(p_waiver_reason);
    v_completion.inspection_waived_by := p_actor_id;
    v_completion.inspection_waived_at := now();
    v_waived := true;
  end if;

  if coalesce(v_settings.po_completion_requires_inspection, false)
     and not exists (
       select 1 from public.inspections i
       where i.org_id = p_org_id and i.id = v_completion.inspection_id
         and i.project_id = v_completion.project_id
         and i.status = 'completed' and i.result = 'pass'
     )
     and nullif(btrim(coalesce(v_completion.inspection_waived_reason, '')), '') is null then
    raise exception 'This organization requires a passed inspection or a recorded waiver before a completion is approved';
  end if;

  select coalesce(sum(round(cl.quantity * cl.unit_cost_cents)), 0)::bigint into v_lines_amount
  from public.commitment_lines cl
  where cl.org_id = p_org_id and cl.commitment_id = v_commitment.id
    and (v_completion.commitment_line_ids is null or cl.id = any(v_completion.commitment_line_ids));

  -- A whole-order completion bills the VPOs nobody has billed yet; an explicit
  -- list bills exactly those; a line completion bills no VPO.
  if v_completion.change_order_ids is not null then
    v_vpo_ids := v_completion.change_order_ids;
    if (select count(*) from public.commitment_change_orders cco
        where cco.org_id = p_org_id and cco.commitment_id = v_commitment.id
          and cco.status = 'approved' and cco.id = any(v_vpo_ids)) <> cardinality(v_vpo_ids) then
      raise exception 'A claimed variance order is not approved on this purchase order';
    end if;
  elsif v_completion.commitment_line_ids is null then
    select coalesce(array_agg(cco.id order by cco.created_at, cco.id), '{}') into v_vpo_ids
    from public.commitment_change_orders cco
    where cco.org_id = p_org_id and cco.commitment_id = v_commitment.id and cco.status = 'approved'
      and not exists (
        select 1 from public.po_completions other
        where other.org_id = p_org_id and other.commitment_id = v_commitment.id
          and other.id <> v_completion.id and other.status in ('approved', 'billed')
          and cco.id = any(coalesce(other.change_order_ids, '{}'))
      );
  else
    v_vpo_ids := '{}';
  end if;

  select coalesce(sum(cco.total_cents), 0)::bigint into v_vpo_amount
  from public.commitment_change_orders cco
  where cco.org_id = p_org_id and cco.commitment_id = v_commitment.id and cco.id = any(v_vpo_ids);
  v_amount := v_lines_amount + v_vpo_amount;
  if v_amount = 0 then raise exception 'PO completion has nothing to pay or credit'; end if;

  -- A net credit bills nothing: it is recorded as an open vendor credit that the next payable on this
  -- purchase order is netted against. It never blocks a bill that was already approved.
  if v_amount < 0 then
    update public.po_completions set
      status = 'billed', approved_by = p_actor_id, approved_at = now(),
      vendor_bill_id = null, amount_cents = null,
      inspection_id = v_completion.inspection_id,
      inspection_waived_reason = v_completion.inspection_waived_reason,
      inspection_waived_by = v_completion.inspection_waived_by,
      inspection_waived_at = v_completion.inspection_waived_at,
      change_order_ids = v_vpo_ids,
      metadata = metadata || jsonb_build_object('vendor_credit_cents', -v_amount)
    where org_id = p_org_id and id = v_completion.id;
    return jsonb_build_object('completion_id', v_completion.id, 'vendor_bill_id', null, 'amount_cents', null,
      'credit_cents', -v_amount, 'waived', v_waived);
  end if;

  -- Open vendor credits on this purchase order net this payable, oldest first, whole credits only and
  -- never to zero.
  for v_credit in
    select pc.id, (pc.metadata ->> 'vendor_credit_cents')::bigint as credit_cents, pc.change_order_ids
    from public.po_completions pc
    where pc.org_id = p_org_id and pc.commitment_id = v_commitment.id and pc.id <> v_completion.id
      and pc.status = 'billed' and pc.vendor_bill_id is null and pc.metadata ? 'vendor_credit_cents'
      and not exists (
        select 1 from public.bill_lines bl
        join public.vendor_bills vb on vb.id = bl.bill_id and vb.org_id = bl.org_id
        where bl.org_id = p_org_id and vb.commitment_id = v_commitment.id and vb.status <> 'rejected'
          and bl.metadata ->> 'credit_completion_id' = pc.id::text
      )
    order by pc.approved_at, pc.id
  loop
    if v_credit_applied + v_credit.credit_cents < v_amount then
      v_credit_applied := v_credit_applied + v_credit.credit_cents;
      v_credit_ids := v_credit_ids || v_credit.id;
    end if;
  end loop;
  v_net := v_amount - v_credit_applied;

  select coalesce(sum(cco.total_cents), 0)::bigint into v_revised_total
  from public.commitment_change_orders cco
  where cco.org_id = p_org_id and cco.commitment_id = v_commitment.id and cco.status = 'approved';
  v_revised_total := coalesce(v_commitment.total_cents, 0)::bigint + v_revised_total;
  select coalesce(sum(vb.total_cents), 0)::bigint into v_already_billed
  from public.vendor_bills vb
  where vb.org_id = p_org_id and vb.commitment_id = v_commitment.id and vb.status <> 'rejected';
  if v_already_billed + v_net > v_revised_total then
    raise exception 'Completion exceeds the revised PO total; create a VPO first';
  end if;

  insert into public.vendor_bills (
    org_id, project_id, commitment_id, company_id, bill_number, status,
    bill_date, due_date, total_cents, currency, metadata, approved_at, approved_by
  ) values (
    p_org_id, v_completion.project_id, v_commitment.id, v_commitment.company_id,
    concat('PO-', coalesce(v_commitment.contract_number, left(v_commitment.id::text, 8)), '-', left(v_completion.id::text, 8)),
    'approved', current_date, current_date, v_net, 'usd',
    jsonb_build_object('source', 'pay_on_po', 'po_completion_id', v_completion.id),
    now(), p_actor_id
  ) returning id into v_bill_id;

  for v_line in
    select cl.* from public.commitment_lines cl
    where cl.org_id = p_org_id and cl.commitment_id = v_commitment.id
      and (v_completion.commitment_line_ids is null or cl.id = any(v_completion.commitment_line_ids))
    order by cl.sort_order
  loop
    insert into public.bill_lines (
      org_id, bill_id, project_id, cost_code_id, budget_line_id, description,
      quantity, unit, unit_cost_cents, sort_order, metadata
    ) values (
      p_org_id, v_bill_id, v_completion.project_id, v_line.cost_code_id,
      v_line.budget_line_id, v_line.description, v_line.quantity, v_line.unit,
      v_line.unit_cost_cents, v_line.sort_order,
      jsonb_build_object('source', 'pay_on_po', 'commitment_line_id', v_line.id)
    );
  end loop;

  for v_line in
    select ccol.* from public.commitment_change_order_lines ccol
    join public.commitment_change_orders cco on cco.id = ccol.commitment_change_order_id and cco.org_id = ccol.org_id
    where ccol.org_id = p_org_id and cco.commitment_id = v_commitment.id and cco.id = any(v_vpo_ids)
    order by cco.created_at, ccol.sort_order
  loop
    insert into public.bill_lines (
      org_id, bill_id, project_id, cost_code_id, budget_line_id, description,
      quantity, unit, unit_cost_cents, sort_order, metadata
    ) values (
      p_org_id, v_bill_id, v_completion.project_id, v_line.cost_code_id,
      v_line.budget_line_id, v_line.description, v_line.quantity, v_line.unit,
      v_line.unit_cost_cents, 10000 + v_line.sort_order,
      jsonb_build_object('source', 'pay_on_po_vpo', 'commitment_change_order_line_id', v_line.id)
    );
  end loop;

  -- The credits applied here come off the bill as the lines of the variance orders that created them.
  for v_line in
    select ccol.*, pc.id as credit_completion_id
    from public.po_completions pc
    join public.commitment_change_order_lines ccol on ccol.org_id = pc.org_id and ccol.commitment_change_order_id = any (pc.change_order_ids)
    where pc.org_id = p_org_id and pc.id = any (v_credit_ids)
    order by pc.approved_at, pc.id, ccol.sort_order
  loop
    insert into public.bill_lines (
      org_id, bill_id, project_id, cost_code_id, budget_line_id, description,
      quantity, unit, unit_cost_cents, sort_order, metadata
    ) values (
      p_org_id, v_bill_id, v_completion.project_id, v_line.cost_code_id,
      v_line.budget_line_id, v_line.description, v_line.quantity, v_line.unit,
      v_line.unit_cost_cents, 20000 + v_line.sort_order,
      jsonb_build_object('source', 'pay_on_po_credit', 'commitment_change_order_line_id', v_line.id,
        'credit_completion_id', v_line.credit_completion_id)
    );
  end loop;

  update public.po_completions set
    status = 'billed', approved_by = p_actor_id, approved_at = now(),
    vendor_bill_id = v_bill_id, amount_cents = v_net,
    inspection_id = v_completion.inspection_id,
    inspection_waived_reason = v_completion.inspection_waived_reason,
    inspection_waived_by = v_completion.inspection_waived_by,
    inspection_waived_at = v_completion.inspection_waived_at,
    change_order_ids = case when v_completion.change_order_ids is null and cardinality(v_vpo_ids) = 0
      then null else v_vpo_ids end
  where org_id = p_org_id and id = v_completion.id;

  return jsonb_build_object('completion_id', v_completion.id, 'vendor_bill_id', v_bill_id, 'amount_cents', v_net,
    'credit_applied_cents', v_credit_applied, 'waived', v_waived);
end;
$$;

revoke all on function public.approve_po_completion(uuid, uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.approve_po_completion(uuid, uuid, uuid, uuid, text) to service_role;

-- 5. The variance report reads every approved purchase-order change order, reasoned or not.

create or replace function public.get_variance_analysis(
  p_org_id uuid,
  p_start timestamptz,
  p_end_exclusive timestamptz
) returns table (
  dimension text,
  dimension_id text,
  dimension_label text,
  net_variance_cents bigint,
  absolute_variance_cents bigint,
  incidence bigint,
  direct_cost_budget_cents bigint,
  variance_rate numeric
)
language sql
stable
security invoker
set search_path = public, pg_catalog
as $$
  with approved_vpos as (
    select
      cco.id,
      cco.project_id,
      cco.reason_code_id,
      cco.total_cents::bigint,
      cco.approved_at,
      c.company_id,
      l.community_id,
      l.house_plan_id,
      coalesce(l.division_id, p.division_id) as division_id
    from public.commitment_change_orders cco
    join public.commitments c on c.id = cco.commitment_id and c.org_id = cco.org_id
    join public.projects p on p.id = cco.project_id and p.org_id = cco.org_id
    left join public.lots l on l.project_id = p.id and l.org_id = p.org_id
    where cco.org_id = p_org_id
      and cco.status = 'approved'
      and c.commitment_type = 'purchase_order'
      and cco.approved_at >= p_start
      and cco.approved_at < p_end_exclusive
  ),
  project_budgets as (
    select distinct on (b.project_id)
      b.project_id, coalesce(b.total_cents, 0)::bigint as budget_cents
    from public.budgets b
    where b.org_id = p_org_id
    order by b.project_id, b.version desc
  ),
  superintendent as (
    select distinct on (pm.project_id)
      pm.project_id, pm.user_id, coalesce(u.full_name, u.email::text, 'Unassigned') as label
    from public.project_members pm
    join public.roles r on r.id = pm.role_id and r.key in ('field', 'org_superintendent')
    join public.app_users u on u.id = pm.user_id
    where pm.org_id = p_org_id and pm.status = 'active'
    order by pm.project_id, pm.created_at
  ),
  expanded as (
    select 'reason'::text dimension, v.reason_code_id::text dimension_id,
      coalesce(rc.label, 'Unclassified')::text dimension_label, v.*
    from approved_vpos v left join public.variance_reason_codes rc on rc.id = v.reason_code_id
    union all
    select 'community', v.community_id::text, coalesce(cm.name, 'No community'), v.*
    from approved_vpos v left join public.communities cm on cm.id = v.community_id
    union all
    select 'plan', v.house_plan_id::text, coalesce(hp.name, 'No plan'), v.*
    from approved_vpos v left join public.house_plans hp on hp.id = v.house_plan_id
    union all
    select 'division', v.division_id::text, coalesce(d.name, 'Main'), v.*
    from approved_vpos v left join public.divisions d on d.id = v.division_id
    union all
    select 'vendor', v.company_id::text, coalesce(co.name, 'No vendor'), v.*
    from approved_vpos v left join public.companies co on co.id = v.company_id
    union all
    select 'superintendent', s.user_id::text, coalesce(s.label, 'Unassigned'), v.*
    from approved_vpos v left join superintendent s on s.project_id = v.project_id
    union all
    select 'month', to_char(v.approved_at at time zone 'UTC', 'YYYY-MM'), to_char(v.approved_at at time zone 'UTC', 'Mon YYYY'), v.*
    from approved_vpos v
  ),
  grouped_vpo as (
    select
      e.dimension,
      coalesce(e.dimension_id, '') as dimension_id,
      e.dimension_label,
      sum(e.total_cents)::bigint as net_variance_cents,
      sum(abs(e.total_cents))::bigint as absolute_variance_cents,
      count(*)::bigint as incidence
    from expanded e
    group by e.dimension, coalesce(e.dimension_id, ''), e.dimension_label
  ),
  covered_projects as (
    select distinct e.dimension, coalesce(e.dimension_id, '') as dimension_id,
      e.dimension_label, e.project_id
    from expanded e
  ),
  grouped_budget as (
    select cp.dimension, cp.dimension_id, cp.dimension_label,
      coalesce(sum(pb.budget_cents), 0)::bigint as direct_cost_budget_cents
    from covered_projects cp
    left join project_budgets pb on pb.project_id = cp.project_id
    group by cp.dimension, cp.dimension_id, cp.dimension_label
  )
  select g.dimension, g.dimension_id, g.dimension_label, g.net_variance_cents,
    g.absolute_variance_cents, g.incidence, b.direct_cost_budget_cents,
    case when b.direct_cost_budget_cents = 0 then 0::numeric
      else g.absolute_variance_cents::numeric / b.direct_cost_budget_cents end
  from grouped_vpo g
  join grouped_budget b using (dimension, dimension_id, dimension_label)
  order by g.dimension, g.absolute_variance_cents desc, g.dimension_label;
$$;

grant execute on function public.get_variance_analysis(uuid, timestamptz, timestamptz) to authenticated, service_role;

-- The reconciliation reports the open vendor credit and no longer reads a status that cannot exist.

create or replace view public.purchase_order_positions
with (security_invoker = true) as
select
  c.org_id,
  c.project_id,
  c.id as commitment_id,
  c.title,
  c.contract_number,
  c.company_id,
  c.status,
  coalesce(l.division_id, p.division_id) as division_id,
  l.community_id,
  coalesce(ps.pay_on_po_enabled, false) as pay_on_po,
  coalesce(c.total_cents, 0)::bigint as original_cents,
  coalesce(vpo.approved_cents, 0)::bigint as approved_vpo_cents,
  coalesce(vpo.pending_count, 0)::bigint as pending_vpo_count,
  coalesce(bills.billed_cents, 0)::bigint as billed_cents,
  coalesce(bills.paid_cents, 0)::bigint as paid_cents,
  coalesce(bills.retainage_held_cents, 0)::bigint as retainage_held_cents,
  coalesce(comp.billed_cents, 0)::bigint as completion_billed_cents,
  coalesce(comp.open_count, 0)::bigint as open_completion_count,
  coalesce(vpo.approved_cents, 0)::bigint - coalesce(claimed.claimed_vpo_cents, 0)::bigint as unclaimed_vpo_cents,
  coalesce(credit.open_credit_cents, 0)::bigint as open_vendor_credit_cents
from public.commitments c
join public.projects p on p.id = c.project_id and p.org_id = c.org_id
left join public.lots l on l.project_id = p.id and l.org_id = p.org_id
left join public.purchasing_settings ps on ps.org_id = c.org_id
left join lateral (
  select
    sum(cco.total_cents) filter (where cco.status = 'approved') as approved_cents,
    count(*) filter (where cco.status in ('draft', 'sent')) as pending_count
  from public.commitment_change_orders cco
  where cco.org_id = c.org_id and cco.commitment_id = c.id
) vpo on true
left join lateral (
  select
    sum(vb.total_cents) as billed_cents,
    sum(vb.paid_cents) as paid_cents,
    sum(greatest(coalesce(vb.retainage_cents, 0) - coalesce(vb.retainage_released_cents, 0), 0)) as retainage_held_cents
  from public.vendor_bills vb
  where vb.org_id = c.org_id and vb.commitment_id = c.id and vb.status <> 'rejected'
) bills on true
left join lateral (
  select
    sum(pc.amount_cents) filter (where pc.status in ('approved', 'billed')) as billed_cents,
    count(*) filter (where pc.status in ('reported', 'verified')) as open_count
  from public.po_completions pc
  where pc.org_id = c.org_id and pc.commitment_id = c.id
) comp on true
left join lateral (
  select sum(cco.total_cents) as claimed_vpo_cents
  from public.commitment_change_orders cco
  where cco.org_id = c.org_id and cco.commitment_id = c.id and cco.status = 'approved'
    and exists (
      select 1 from public.po_completions pc
      where pc.org_id = c.org_id and pc.commitment_id = c.id
        and pc.status in ('approved', 'billed') and cco.id = any(coalesce(pc.change_order_ids, '{}'))
    )
) claimed on true
left join lateral (
  select sum((pc.metadata ->> 'vendor_credit_cents')::bigint) as open_credit_cents
  from public.po_completions pc
  where pc.org_id = c.org_id and pc.commitment_id = c.id
    and pc.status = 'billed' and pc.vendor_bill_id is null and pc.metadata ? 'vendor_credit_cents'
    and not exists (
      select 1 from public.bill_lines bl
      join public.vendor_bills vb on vb.id = bl.bill_id and vb.org_id = bl.org_id
      where bl.org_id = c.org_id and vb.commitment_id = c.id and vb.status <> 'rejected'
        and bl.metadata ->> 'credit_completion_id' = pc.id::text
    )
) credit on true
where c.commitment_type = 'purchase_order'
  and c.status in ('approved', 'active', 'complete', 'completed');

revoke all on public.purchase_order_positions from public, anon, authenticated;
grant select on public.purchase_order_positions to service_role;
