-- EP08 review round 2 (R2-D): the lock now covers execution evidence and the imported marker, the
-- history probe no longer leaks across orgs, receipts void inside a window keyed on the server's
-- creation time, and a line is written under the order's row lock so an approval cannot race it.
--
-- 1. tg_po_issued_lock: executed_at / executed_file_id / signature_envelope_id / source_document_id are part
--    of the locked row on an approved order; imported_open_wip is server-written only (insert or change by a
--    member is refused on orders and lines, drafts included).
-- 2. po_has_history answers only for an order in the caller's org (or the service).
-- 3. void_po_receipt: a person voids their own receipt within 24 hours of it being entered (created_at), not
--    by the user-editable received_at.
-- 4. write_commitment_line: the only service writer of a line. It locks the order's row, refuses an issued
--    purchase order, writes the line and re-totals the order in one transaction.


create or replace function public.po_has_history(p_commitment_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
begin
  select c.org_id into v_org_id from public.commitments c where c.id = p_commitment_id;
  if v_org_id is null then
    return false;
  end if;
  if (select auth.role()) is distinct from 'service_role' and not public.is_org_member(v_org_id) then
    return false;
  end if;
  return exists (select 1 from public.po_issue_versions v where v.commitment_id = p_commitment_id)
    or exists (select 1 from public.po_acknowledgments a where a.commitment_id = p_commitment_id)
    or exists (select 1 from public.po_receipts r where r.commitment_id = p_commitment_id);
end;
$$;

revoke all on function public.po_has_history(uuid) from public, anon;
grant execute on function public.po_has_history(uuid) to authenticated, service_role;


create or replace function public.tg_po_issued_lock()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_parent_id uuid;
  v_type text;
  v_status text;
begin
  if current_user <> 'authenticated' then
    return coalesce(new, old);
  end if;

  if tg_table_name = 'commitments' then
    -- Provenance keys are written by the server: a member never marks an order imported, on a draft or otherwise.
    if (tg_op = 'INSERT' and new.metadata ? 'imported_open_wip')
       or (tg_op = 'UPDATE' and (new.metadata -> 'imported_open_wip') is distinct from (old.metadata -> 'imported_open_wip')) then
      raise exception 'The imported marker is written by the import, not by a member' using errcode = '42501';
    end if;

    if tg_op = 'INSERT' then
      if new.commitment_type = 'purchase_order' and public.po_status_is_issued(new.status) then
        raise exception 'A purchase order is issued by approving it, not by inserting it as approved' using errcode = '42501';
      end if;
      return new;
    end if;

    if tg_op = 'DELETE' then
      if old.commitment_type = 'purchase_order' and public.po_has_history(old.id) then
        raise exception 'A purchase order that was issued keeps its history and cannot be deleted' using errcode = '42501';
      end if;
      if old.commitment_type = 'purchase_order' and public.po_status_is_issued(old.status) then
        raise exception 'An approved purchase order cannot be deleted; return it to draft first' using errcode = '42501';
      end if;
      return old;
    end if;

    if new.commitment_type = 'purchase_order' and public.po_status_is_issued(new.status)
       and not (old.commitment_type = 'purchase_order' and old.status is not distinct from new.status) then
      raise exception 'A purchase order is issued by approving it, which a member does through the approval service' using errcode = '42501';
    end if;

    if old.commitment_type <> 'purchase_order' or not public.po_status_is_issued(old.status) then
      return new;
    end if;
    if row(new.org_id, new.project_id, new.company_id, new.contact_id, new.commitment_type, new.title, new.scope, new.terms,
           new.total_cents, new.currency, new.contract_number, new.retainage_percent, new.start_date, new.end_date, new.issued_at,
           new.executed_at, new.executed_file_id, new.signature_envelope_id, new.source_document_id,
           public.po_locked_metadata(new.metadata))
       is distinct from
       row(old.org_id, old.project_id, old.company_id, old.contact_id, old.commitment_type, old.title, old.scope, old.terms,
           old.total_cents, old.currency, old.contract_number, old.retainage_percent, old.start_date, old.end_date, old.issued_at,
           old.executed_at, old.executed_file_id, old.signature_envelope_id, old.source_document_id,
           public.po_locked_metadata(old.metadata)) then
      raise exception 'An approved purchase order is locked: raise a variance order to change it, or return it to draft' using errcode = '42501';
    end if;
    if not public.po_status_is_issued(new.status) then
      raise exception 'An approved purchase order is returned to draft or cancelled from the purchase order, not by editing its row' using errcode = '42501';
    end if;
    return new;
  end if;

  -- commitment_lines: the same provenance rule, then the order the line is on, before and after the change.
  if (tg_op = 'INSERT' and new.metadata ? 'imported_open_wip')
     or (tg_op = 'UPDATE' and (new.metadata -> 'imported_open_wip') is distinct from (old.metadata -> 'imported_open_wip')) then
    raise exception 'The imported marker is written by the import, not by a member' using errcode = '42501';
  end if;

  -- the order the line is on, before and after the change.
  for v_parent_id in
    select distinct x from unnest(array[
      case when tg_op <> 'INSERT' then old.commitment_id end,
      case when tg_op <> 'DELETE' then new.commitment_id end
    ]) x where x is not null
  loop
    select c.commitment_type, c.status into v_type, v_status from public.commitments c where c.id = v_parent_id;
    if v_type = 'purchase_order' and public.po_status_is_issued(v_status) then
      if tg_op = 'UPDATE'
         and row(new.org_id, new.commitment_id, new.cost_code_id, new.budget_line_id, new.description, new.quantity, new.unit,
                 new.unit_cost_cents, new.scheduled_value_cents, new.retainage_percent, new.needed_by, new.sort_order,
                 public.po_locked_metadata(new.metadata))
             is not distinct from
             row(old.org_id, old.commitment_id, old.cost_code_id, old.budget_line_id, old.description, old.quantity, old.unit,
                 old.unit_cost_cents, old.scheduled_value_cents, old.retainage_percent, old.needed_by, old.sort_order,
                 public.po_locked_metadata(old.metadata)) then
        continue;
      end if;
      raise exception 'The lines of an approved purchase order are locked: raise a variance order to change them, or return it to draft' using errcode = '42501';
    end if;
  end loop;
  return coalesce(new, old);
end;
$$;

revoke all on function public.tg_po_issued_lock() from public, anon, authenticated;

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

  if p_op = 'insert' then
    insert into public.commitment_lines(org_id, commitment_id, cost_code_id, budget_line_id, description, quantity, unit,
      unit_cost_cents, scheduled_value_cents, retainage_percent)
    values (p_org_id, p_commitment_id, (p_values ->> 'cost_code_id')::uuid, (p_values ->> 'budget_line_id')::uuid,
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
        cost_code_id = case when p_values ? 'cost_code_id' then (p_values ->> 'cost_code_id')::uuid else l.cost_code_id end,
        budget_line_id = case when p_values ? 'budget_line_id' then (p_values ->> 'budget_line_id')::uuid else l.budget_line_id end,
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

  select coalesce(round(sum(l.quantity * coalesce(l.unit_cost_cents, 0))), 0)::bigint into v_total
  from public.commitment_lines l where l.org_id = p_org_id and l.commitment_id = p_commitment_id;
  update public.commitments set total_cents = v_total where id = p_commitment_id and org_id = p_org_id;
  return jsonb_build_object('line_id', v_line_id, 'commitment_id', p_commitment_id, 'total_cents', v_total);
end;
$$;

revoke all on function public.write_commitment_line(uuid, text, uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.write_commitment_line(uuid, text, uuid, uuid, jsonb) to service_role;
