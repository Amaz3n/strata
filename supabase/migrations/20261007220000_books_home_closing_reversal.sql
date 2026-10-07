-- B11.3: a recorded home closing can be reversed, and the reversal puts the
-- books back exactly. The money side runs first in the service (the balance
-- payment refunded, the deposit applications reversed so the deposit liability
-- returns, and a full credit memo taking the sale out of revenue). This function
-- then, atomically: returns the home's relieved cost to inventory component by
-- component (the exact negative of the relief), clears the sale date, withdraws
-- the remaining warranty provision, returns the lot to started and records the
-- closing as cancelled with who reversed it and why. Nothing is deleted.

create or replace function public.guard_closing_settlement_evidence() returns trigger
language plpgsql security definer set search_path=public,pg_catalog as $$
declare gates integer;
begin
 if tg_op='DELETE' then
  if old.status in ('closed','cancelled') then raise exception 'Recorded closing history cannot be deleted'; end if;
  return old;
 end if;
 if tg_op='UPDATE' then
  if (new.id,new.org_id,new.project_id,new.lot_id,new.community_id) is distinct from (old.id,old.org_id,old.project_id,old.lot_id,old.community_id) then raise exception 'Closing home identity cannot change'; end if;
  -- The one change a recorded closing allows: its reversal, made only by
  -- reverse_books_home_closing (which sets arc.closing_reversal for this row).
  if old.status='closed' and new.status='cancelled' and current_setting('arc.closing_reversal', true)=old.id::text
   and (new.scheduled_date,new.actual_date,new.settlement,new.closing_invoice_id) is not distinct from (old.scheduled_date,old.actual_date,old.settlement,old.closing_invoice_id) then
   return new;
  end if;
  if old.status in ('closed','cancelled') and
   (new.status,new.scheduled_date,new.actual_date,new.settlement,new.closing_invoice_id,new.cancel_reason,new.metadata->'adjustments') is distinct from
   (old.status,old.scheduled_date,old.actual_date,old.settlement,old.closing_invoice_id,old.cancel_reason,old.metadata->'adjustments') then
   raise exception 'Recorded closing settlement evidence is immutable';
  end if;
 end if;
 if new.status='closed' and (tg_op='INSERT' or old.status<>'closed') then
  if new.closing_invoice_id is null then raise exception 'Closing invoice evidence is required'; end if;
  if jsonb_typeof(new.settlement->'finalPriceCents') is distinct from 'number' or coalesce(new.settlement->>'finalPriceCents','')!~'^[0-9]+$' then raise exception 'Recorded final price cents are invalid'; end if;
  if (new.settlement->>'finalPriceCents')::numeric>9007199254740991 then raise exception 'Recorded final price exceeds safe integer cents'; end if;
  perform 1 from public.invoices where id=new.closing_invoice_id and org_id=new.org_id and project_id=new.project_id and total_cents=(new.settlement->>'finalPriceCents')::numeric for share;
  if not found then raise exception 'Closing invoice belongs to another home, is unavailable or differs from the settlement'; end if;
  perform 1 from public.files f where exists(select 1 from public.closing_checklist_items i
    where i.closing_id=new.id and i.org_id=new.org_id and i.is_gate and i.file_id=f.id) order by f.id for share;
  select count(*) into gates from public.closing_checklist_items where closing_id=new.id and org_id=new.org_id and is_gate;
  if gates=0 then raise exception 'Closing readiness gates are missing'; end if;
  -- No child row locks: checklist writers take the parent lock and either
  -- commit before this read or fail after the parent becomes closed.
  if exists(select 1 from public.closing_checklist_items i where i.closing_id=new.id and i.org_id=new.org_id and i.is_gate and
   (i.status='open' or i.completed_by is null or i.completed_at is null or (i.status='waived' and length(btrim(coalesce(i.notes,'')))<10) or
    (i.file_id is not null and not exists(select 1 from public.files f where f.id=i.file_id and f.org_id=new.org_id and f.project_id=new.project_id and f.archived_at is null)))) then
   raise exception 'Closing readiness gate evidence is incomplete';
  end if;
 end if;
 return new;
end $$;

create or replace function public.reverse_books_home_closing(p_org_id uuid, p_closing_id uuid, p_date date, p_reason text, p_actor_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_closing public.closings%rowtype; v_invoice public.invoices%rowtype; v_settings public.project_financial_settings%rowtype;
  v_cogs uuid; v_reserve uuid; v_expense uuid; v_policy integer; v_lines jsonb := '[]'::jsonb; v_line integer := 0; v_row record; v_inventory uuid; v_warranty uuid; v_reserve_cents bigint; v_revision integer;
begin
  select * into v_closing from public.closings where id = p_closing_id and org_id = p_org_id for update;
  if not found then raise exception 'Closing not found'; end if;
  if v_closing.status <> 'closed' then raise exception 'Only a recorded closing can be reversed'; end if;
  if p_actor_id is null or length(trim(coalesce(p_reason, ''))) < 10 then raise exception 'Say why the closing is reversed'; end if;
  if exists(select 1 from public.accounting_periods where org_id = p_org_id and status = 'closed' and p_date between period_start and period_end) then
    raise exception 'The reversal date is in a closed month; date it in an open month';
  end if;
  select * into v_invoice from public.invoices where id = v_closing.closing_invoice_id and org_id = p_org_id for update;
  if not found then raise exception 'Closing invoice not found'; end if;
  -- The money comes off first: nothing still owed, nothing still collected, and the sale credited in full.
  if coalesce(v_invoice.balance_due_cents, 0) <> 0
    or coalesce((select sum(a.amount_cents) from public.receivable_adjustments a where a.org_id = p_org_id and a.invoice_id = v_invoice.id and a.adjustment_type = 'credit_memo' and a.status = 'posted'), 0) <> v_invoice.total_cents then
    raise exception 'Refund the closing payment, reverse the deposit applications and credit the sale in full before reversing the closing';
  end if;
  select * into v_settings from public.project_financial_settings where org_id = p_org_id and project_id = v_closing.project_id for update;
  select active_policy_version into v_policy from public.books_settings where org_id = p_org_id;
  select id into v_cogs from public.gl_accounts where org_id = p_org_id and code = '5000' and active;
  -- Inventory back, component by component: the exact negative of every relief.
  if v_settings.books_inventory_sold_on is not null then
    for v_row in
      select l.account_id, coalesce(l.dimensions->>'cost_component', 'construction') as component, sum(l.debit_cents - l.credit_cents)::bigint as cents
      from public.journal_lines l join public.journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
      where l.org_id = p_org_id and l.project_id = v_closing.project_id and e.status in ('posted','reversed')
        and (e.source_type = 'inventory_sale_relief' or exists(select 1 from public.journal_entries o where o.id = e.reversal_of_entry_id and o.source_type = 'inventory_sale_relief'))
      group by 1, 2 having sum(l.debit_cents - l.credit_cents) <> 0 order by 2, 1
    loop
      v_line := v_line + 1;
      v_lines := v_lines || jsonb_build_array(jsonb_build_object('line_no', v_line, 'account_id', v_row.account_id, 'project_id', v_closing.project_id,
        'debit_cents', greatest(-v_row.cents, 0), 'credit_cents', greatest(v_row.cents, 0),
        'dimensions', jsonb_build_object('inventory_transition', 'sale_reversal', 'closing_id', v_closing.id) || case when v_row.account_id = v_cogs then jsonb_build_object('cost_component', v_row.component) else '{}'::jsonb end));
    end loop;
    if jsonb_array_length(v_lines) > 0 then
      select count(*) + 1 into v_revision from public.journal_entries where org_id = p_org_id and source_type = 'inventory_sale_relief' and source_id = v_closing.project_id;
      v_inventory := public.post_books_journal_entry(p_org_id, jsonb_build_object('entry_date', p_date, 'entry_kind', 'adjusting', 'memo', 'Closing reversed: home returned to inventory',
        'posting_key', 'inventory:' || v_closing.project_id || ':sale_reversal:' || v_revision, 'projection_version', 1, 'policy_version', v_policy,
        'source_type', 'inventory_sale_relief', 'source_id', v_closing.project_id, 'created_by', p_actor_id), v_lines);
    end if;
    update public.project_financial_settings set books_inventory_sold_on = null, updated_at = now() where org_id = p_org_id and project_id = v_closing.project_id;
  end if;
  -- The warranty provision made at closing is withdrawn (what remains of it).
  select id into v_reserve from public.gl_accounts where org_id = p_org_id and code = '2260' and active;
  select id into v_expense from public.gl_accounts where org_id = p_org_id and code = '5050' and active;
  select coalesce(sum(l.credit_cents - l.debit_cents), 0) into v_reserve_cents from public.journal_lines l join public.journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
    where l.org_id = p_org_id and l.project_id = v_closing.project_id and l.account_id = v_reserve and e.status in ('posted','reversed');
  if v_reserve_cents <> 0 then
    select count(*) + 1 into v_revision from public.journal_entries where org_id = p_org_id and source_type = 'warranty_reserve' and source_id = v_closing.project_id;
    v_warranty := public.post_books_journal_entry(p_org_id, jsonb_build_object('entry_date', p_date, 'entry_kind', 'adjusting', 'memo', 'Closing reversed: warranty provision withdrawn',
      'posting_key', 'warranty_reserve:' || v_closing.project_id || ':' || v_revision, 'projection_version', 1, 'policy_version', v_policy,
      'source_type', 'warranty_reserve', 'source_id', v_closing.project_id, 'created_by', p_actor_id),
      jsonb_build_array(
        jsonb_build_object('line_no', 1, 'account_id', v_reserve, 'project_id', v_closing.project_id, 'debit_cents', greatest(v_reserve_cents, 0), 'credit_cents', greatest(-v_reserve_cents, 0), 'dimensions', jsonb_build_object('warranty_reserve_adjustment', true, 'closing_id', v_closing.id)),
        jsonb_build_object('line_no', 2, 'account_id', v_expense, 'project_id', v_closing.project_id, 'debit_cents', greatest(-v_reserve_cents, 0), 'credit_cents', greatest(v_reserve_cents, 0), 'dimensions', jsonb_build_object('warranty_reserve_adjustment', true, 'closing_id', v_closing.id))));
  end if;
  update public.project_financial_settings set books_warranty_provisioned_on = null, updated_at = now() where org_id = p_org_id and project_id = v_closing.project_id;
  update public.lots set status = 'started', updated_at = now() where org_id = p_org_id and id = v_closing.lot_id and status = 'closed';
  perform set_config('arc.closing_reversal', v_closing.id::text, true);
  update public.closings set status = 'cancelled', cancel_reason = trim(p_reason),
    metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('reversed_at', now(), 'reversed_by', p_actor_id, 'reversed_on', p_date, 'reversal_inventory_entry_id', v_inventory, 'reversal_warranty_entry_id', v_warranty)
    where id = v_closing.id;
  perform set_config('arc.closing_reversal', '', true);
  return jsonb_build_object('closingId', v_closing.id, 'projectId', v_closing.project_id, 'inventoryEntryId', v_inventory, 'warrantyEntryId', v_warranty);
end;
$$;
revoke all on function public.reverse_books_home_closing(uuid,uuid,date,text,uuid) from public, anon, authenticated;
grant execute on function public.reverse_books_home_closing(uuid,uuid,date,text,uuid) to service_role;
