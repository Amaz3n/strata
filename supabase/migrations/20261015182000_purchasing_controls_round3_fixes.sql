-- EP08 review round 3 fixes for variance orders, completions and payment.
--
-- 1. A change order line's cost code, budget line and commitment line belong to the order's organization,
--    home and commitment, for every writer.
-- 2. A variance order is created with its lines in one transaction (create_commitment_change_order), so a
--    failed line never leaves a lineless order with a total.
-- 3. Deleting a pending variance order reopens a shortage it resolved, like voiding or rejecting it does.
-- 4. A bill rejected after its completion was approved returns the completion to reported/verified, so its
--    scope can be re-reported and re-billed, with an event and an audit row.
-- 5. approve_po_completion: only credit variance orders alone close as a vendor credit; lines netting below
--    zero are refused with a message that says what to do; the over-total message names an unclaimed credit.
-- 6. A change order is approved only on an issued (approved) purchase order, by a named approver; a rejected or
--    voided one never moves again, whoever writes it.
-- 7. list_variance_order_page: the division lens resolves in SQL, so a division with many homes pages.
--
-- Carries forward the 172000 definitions of approve_po_completion and the shortage reopening it replaces.

-- 1. Line references.

create function public.tg_commitment_change_order_line_refs()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.commitment_change_orders%rowtype;
begin
  select * into v_order from public.commitment_change_orders where id = new.commitment_change_order_id;
  if not found or v_order.org_id is distinct from new.org_id then
    raise exception 'A change order line belongs to the organization of its change order' using errcode = '23514';
  end if;
  if new.cost_code_id is not null and not exists (
    select 1 from public.cost_codes cc where cc.id = new.cost_code_id and cc.org_id = new.org_id
  ) then
    raise exception 'A change order line''s cost code must belong to this organization' using errcode = '23514';
  end if;
  if new.budget_line_id is not null and not exists (
    select 1 from public.budget_lines bl
    join public.budgets b on b.id = bl.budget_id and b.org_id = bl.org_id
    where bl.id = new.budget_line_id and bl.org_id = new.org_id and b.project_id = v_order.project_id
  ) then
    raise exception 'A change order line''s budget line must belong to the order''s home' using errcode = '23514';
  end if;
  if new.commitment_line_id is not null and not exists (
    select 1 from public.commitment_lines cl
    where cl.id = new.commitment_line_id and cl.org_id = new.org_id and cl.commitment_id = v_order.commitment_id
  ) then
    raise exception 'A change order line''s commitment line must belong to the order''s commitment' using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function public.tg_commitment_change_order_line_refs() from public, anon, authenticated;

create trigger commitment_change_order_lines_refs
before insert or update of org_id, commitment_change_order_id, commitment_line_id, cost_code_id, budget_line_id
on public.commitment_change_order_lines
for each row execute function public.tg_commitment_change_order_line_refs();

-- 6. Approval only on an issued purchase order, by a named approver, and never out of a closed status
-- (adds three clauses to the 172000 rules).

create or replace function public.tg_commitment_change_order_commitment_rules()
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
  -- A rejected or voided order is closed for every writer: a signature, a sync or a stale write never reopens it.
  if tg_op = 'UPDATE' and old.status in ('rejected', 'voided') and new.status is distinct from old.status then
    raise exception 'A % change order is closed and cannot move to %', old.status, new.status using errcode = '23514';
  end if;
  -- A purchase order's change is approved by a named approver, through the variance controls.
  if tg_op = 'UPDATE' and v_commitment.commitment_type = 'purchase_order'
     and new.status = 'approved' and old.status is distinct from 'approved' and new.approved_by is null then
    raise exception 'A purchase-order change is approved by a named approver, not by a signature or a sync' using errcode = '23514';
  end if;
  if tg_op = 'UPDATE' and v_commitment.commitment_type = 'purchase_order'
     and new.status = 'approved' and old.status is distinct from 'approved'
     and v_commitment.status is distinct from 'approved' then
    raise exception 'A variance order is approved on an issued purchase order; this one is %', v_commitment.status
      using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function public.tg_commitment_change_order_commitment_rules() from public, anon, authenticated;

-- 2. Header and lines in one transaction.

create function public.create_commitment_change_order(
  p_org_id uuid,
  p_header jsonb,
  p_lines jsonb
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_commitment public.commitments%rowtype;
  v_id uuid;
  v_total bigint;
begin
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Add at least one line';
  end if;
  select * into v_commitment from public.commitments
    where org_id = p_org_id and id = (p_header ->> 'commitment_id')::uuid for share;
  if not found then raise exception 'Commitment not found'; end if;
  if v_commitment.commitment_type = 'purchase_order' and v_commitment.status is distinct from 'approved' then
    raise exception 'A variance order is raised on an issued purchase order; this one is %', v_commitment.status;
  end if;
  select coalesce(sum((l ->> 'amount_cents')::bigint), 0) into v_total from jsonb_array_elements(p_lines) l;
  insert into public.commitment_change_orders (
    org_id, project_id, commitment_id, company_id, title, description, total_cents, currency,
    reason_code_id, origin, requested_by, photo_file_ids, evidence_file_ids, metadata)
  values (
    p_org_id, v_commitment.project_id, v_commitment.id, v_commitment.company_id,
    p_header ->> 'title', p_header ->> 'description', v_total, 'usd',
    (p_header ->> 'reason_code_id')::uuid, p_header ->> 'origin', (p_header ->> 'requested_by')::uuid,
    array(select jsonb_array_elements_text(coalesce(p_header -> 'photo_file_ids', '[]'::jsonb))::uuid),
    array(select jsonb_array_elements_text(coalesce(p_header -> 'evidence_file_ids', '[]'::jsonb))::uuid),
    coalesce(p_header -> 'metadata', '{}'::jsonb))
  returning id into v_id;
  insert into public.commitment_change_order_lines (
    org_id, commitment_change_order_id, commitment_line_id, cost_code_id, budget_line_id, description,
    quantity, unit, unit_cost_cents, amount_cents, sort_order, metadata)
  select p_org_id, v_id, (l ->> 'commitment_line_id')::uuid, (l ->> 'cost_code_id')::uuid, (l ->> 'budget_line_id')::uuid,
    l ->> 'description', (l ->> 'quantity')::numeric, l ->> 'unit', (l ->> 'unit_cost_cents')::integer,
    (l ->> 'amount_cents')::integer, (l ->> 'sort_order')::integer, coalesce(l -> 'metadata', '{}'::jsonb)
  from jsonb_array_elements(p_lines) l;
  return v_id;
end;
$$;

revoke all on function public.create_commitment_change_order(uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.create_commitment_change_order(uuid, jsonb, jsonb) to service_role;

-- 3. A shortage a deleted variance order resolved is open again.

create function public.reopen_vpo_shortages(p_org_id uuid, p_vpo_id uuid, p_cause text)
returns void
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
    where s.org_id = p_org_id and s.vpo_id = p_vpo_id and s.status = 'vpo'
    for update
  loop
    if exists (
      select 1 from public.po_shortages other
      where other.commitment_line_id = v_shortage.commitment_line_id and other.id <> v_shortage.id
        and other.status in ('open', 'backordered')
    ) then
      -- A newer shortage already covers the line; this one closes without a replacement.
      update public.po_shortages set status = 'cancelled', vpo_id = null,
        resolution_note = 'The replacement variance order was ' || p_cause || '; a newer shortage covers this line.'
      where id = v_shortage.id;
    else
      update public.po_shortages set status = 'open', vpo_id = null, resolved_by = null, resolved_at = null,
        resolution_note = null
      where id = v_shortage.id;
    end if;
  end loop;
  perform set_config('arc.vpo_shortage_reopen', 'off', true);
end;
$$;

revoke all on function public.reopen_vpo_shortages(uuid, uuid, text) from public, anon, authenticated;

create or replace function public.tg_commitment_change_order_reopen_shortage()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.reopen_vpo_shortages(new.org_id, new.id, new.status);
  return new;
end;
$$;

revoke all on function public.tg_commitment_change_order_reopen_shortage() from public, anon, authenticated;

create function public.tg_commitment_change_order_delete_reopen_shortage()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.reopen_vpo_shortages(old.org_id, old.id, 'deleted');
  return old;
end;
$$;

revoke all on function public.tg_commitment_change_order_delete_reopen_shortage() from public, anon, authenticated;

-- Before the delete, while the shortage still names the order (the foreign key clears it afterwards).
create trigger commitment_change_orders_delete_reopen_shortage
before delete on public.commitment_change_orders
for each row execute function public.tg_commitment_change_order_delete_reopen_shortage();

-- 4. A rejected bill gives its completion's scope back.

create function public.tg_vendor_bill_rejected_reopens_completion()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_completion public.po_completions%rowtype;
  v_status text;
begin
  select * into v_completion from public.po_completions pc
    where pc.org_id = new.org_id and pc.vendor_bill_id = new.id and pc.status = 'billed'
    for update;
  if not found then return new; end if;
  v_status := case when v_completion.verified_by is not null then 'verified' else 'reported' end;
  update public.po_completions set
    status = v_status, vendor_bill_id = null, amount_cents = null, approved_by = null, approved_at = null,
    metadata = metadata || jsonb_build_object('reopened_after_bill_rejected', jsonb_build_object(
      'bill_id', new.id, 'at', now(), 'reason', new.rejection_reason, 'amount_cents', v_completion.amount_cents))
  where id = v_completion.id;
  insert into public.events (org_id, event_type, entity_type, entity_id, payload)
  values (new.org_id, 'po_completion.reopened', 'po_completion', v_completion.id,
    jsonb_build_object('project_id', v_completion.project_id, 'vendor_bill_id', new.id, 'status', v_status));
  insert into public.audit_log (org_id, actor_user_id, action, entity_type, entity_id, before_data, after_data, source)
  values (new.org_id, new.rejected_by, 'update', 'po_completion', v_completion.id,
    jsonb_build_object('status', v_completion.status, 'vendor_bill_id', new.id, 'amount_cents', v_completion.amount_cents),
    jsonb_build_object('status', v_status, 'vendor_bill_id', null, 'amount_cents', null, 'reason', 'bill rejected'),
    'bill_rejected');
  return new;
end;
$$;

revoke all on function public.tg_vendor_bill_rejected_reopens_completion() from public, anon, authenticated;

create trigger vendor_bills_rejected_reopens_completion
after update of status on public.vendor_bills
for each row
when (new.status = 'rejected' and old.status is distinct from 'rejected')
execute function public.tg_vendor_bill_rejected_reopens_completion();

-- 5. Completion approval.

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
  v_unclaimed_credit bigint := 0;
  v_attempt bigint := 0;
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
    -- Only a claim of credit variance orders alone closes as a credit. Lines that net below zero against
    -- credits would be closed unbilled and could never be billed again, and the credit applied later would
    -- not equal the lines it nets.
    if v_lines_amount <> 0 then
      raise exception 'These lines and variance orders net to a credit of %; report the credit variance order as its own completion and approve it, then bill the lines', -v_amount;
    end if;
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
    select coalesce(sum(cco.total_cents), 0)::bigint into v_unclaimed_credit
    from public.commitment_change_orders cco
    where cco.org_id = p_org_id and cco.commitment_id = v_commitment.id and cco.status = 'approved' and cco.total_cents < 0
      and not (cco.id = any (coalesce(v_vpo_ids, '{}')))
      and not exists (
        select 1 from public.po_completions other
        where other.org_id = p_org_id and other.commitment_id = v_commitment.id
          and other.id <> v_completion.id and other.status in ('approved', 'billed')
          and cco.id = any (coalesce(other.change_order_ids, '{}'))
      );
    if v_unclaimed_credit < 0 then
      raise exception 'Completion exceeds the revised PO total because an approved credit variance order of % is not claimed yet; report it as its own completion and approve it, then bill this scope', -v_unclaimed_credit;
    end if;
    raise exception 'Completion exceeds the revised PO total; create a VPO first';
  end if;

  -- A bill rejected earlier keeps its number (the duplicate check counts it), so the bill that replaces it is numbered anew.
  select count(*) into v_attempt from public.vendor_bills vb
    where vb.org_id = p_org_id and vb.metadata ->> 'po_completion_id' = v_completion.id::text;

  insert into public.vendor_bills (
    org_id, project_id, commitment_id, company_id, bill_number, status,
    bill_date, due_date, total_cents, currency, metadata, approved_at, approved_by
  ) values (
    p_org_id, v_completion.project_id, v_commitment.id, v_commitment.company_id,
    concat('PO-', coalesce(v_commitment.contract_number, left(v_commitment.id::text, 8)), '-', left(v_completion.id::text, 8),
      case when v_attempt > 0 then concat('-R', v_attempt) else '' end),
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

-- 7. The variance queue's division lens, in SQL: a home's division is its lot's, falling back to the project's,
-- the rule get_variance_analysis applies. Service role only; the service authorizes and scopes before calling.

create function public.list_variance_order_page(
  p_org_id uuid,
  p_division_ids uuid[],
  p_statuses text[],
  p_reason_code_id uuid,
  p_origin text,
  p_project_id uuid,
  p_community_id uuid,
  p_member_user_id uuid,
  p_limit integer,
  p_offset integer
) returns table (id uuid, total_count bigint)
language sql
stable
security definer
set search_path = ''
as $$
  with scoped as (
    select cco.id, cco.created_at
    from public.commitment_change_orders cco
    join public.commitments c on c.id = cco.commitment_id and c.org_id = cco.org_id and c.commitment_type = 'purchase_order'
    join public.projects p on p.id = cco.project_id and p.org_id = cco.org_id
    left join public.lots l on l.project_id = p.id and l.org_id = p.org_id
    where cco.org_id = p_org_id
      and coalesce(l.division_id, p.division_id) = any (p_division_ids)
      and (p_statuses is null or cco.status = any (p_statuses))
      and (p_reason_code_id is null or cco.reason_code_id = p_reason_code_id)
      and (p_origin is null or cco.origin = p_origin)
      and (p_project_id is null or cco.project_id = p_project_id)
      and (p_community_id is null or l.community_id = p_community_id)
      and (p_member_user_id is null or exists (
        select 1 from public.project_members pm
        where pm.org_id = p_org_id and pm.project_id = cco.project_id and pm.user_id = p_member_user_id and pm.status = 'active'))
  )
  select s.id, count(*) over ()
  from scoped s
  order by s.created_at desc, s.id desc
  limit p_limit offset p_offset;
$$;

revoke all on function public.list_variance_order_page(uuid, uuid[], text[], uuid, text, uuid, uuid, uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.list_variance_order_page(uuid, uuid[], text[], uuid, text, uuid, uuid, uuid, integer, integer) to service_role;
