-- A statement reclosed with nothing changed must produce the same proof digest,
-- or the digest cannot say whether a reopened statement changed. The proof now
-- carries each item's economic fields only (not its regenerated row id or
-- timestamps) in a stable economic order. Otherwise identical to
-- 20261003021045_books_bank_statement_evidence.sql.
create or replace function public.close_books_bank_reconciliation_atomic(p_org_id uuid, p_reconciliation_id uuid, p_actor_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  rec public.bank_reconciliations%rowtype;
  bank public.bank_accounts%rowtype;
  previous public.bank_reconciliations%rowtype;
  direction_factor integer;
  movement bigint;
  books bigint;
  outstanding bigint;
  proof jsonb;
  proof_digest text;
begin
  select * into rec from public.bank_reconciliations where org_id=p_org_id and id=p_reconciliation_id;
  if not found then raise exception 'Bank reconciliation not found'; end if;
  select * into bank from public.bank_accounts where org_id=p_org_id and id=rec.bank_account_id for update;
  if bank.gl_account_id is null then raise exception 'Map the bank account before reconciliation'; end if;
  select * into rec from public.bank_reconciliations where org_id=p_org_id and id=p_reconciliation_id for update;
  if rec.status='closed' then return jsonb_build_object('id',rec.id,'digest',rec.digest); end if;
  select case when account_type='liability' then -1 else 1 end into direction_factor
    from public.gl_accounts where org_id=p_org_id and id=bank.gl_account_id;
  select * into previous from public.bank_reconciliations where org_id=p_org_id and bank_account_id=bank.id
    and status='closed' and id<>rec.id order by statement_end desc limit 1;
  if previous.id is not null and (previous.statement_end + 1 <> rec.statement_start or previous.ending_balance_cents <> rec.beginning_balance_cents) then
    raise exception 'Statement dates and opening balance must continue the previous closed reconciliation';
  end if;
  if exists(select 1 from public.bank_transactions t where t.org_id=p_org_id and t.bank_account_id=bank.id
    and t.lifecycle_status='posted' and not t.excluded and t.transaction_date between rec.statement_start and rec.statement_end
    and abs(t.amount_cents) <> (select coalesce(sum(m.matched_amount_cents),0) from public.bank_transaction_matches m
      where m.org_id=p_org_id and m.bank_transaction_id=t.id and m.status='confirmed' and m.journal_line_id is not null)) then
    raise exception 'Every included statement transaction must be fully matched';
  end if;
  select coalesce(sum(case when direction='inflow' then amount_cents else -amount_cents end),0)*direction_factor into movement
    from public.bank_transactions where org_id=p_org_id and bank_account_id=bank.id and lifecycle_status='posted'
      and not excluded and transaction_date between rec.statement_start and rec.statement_end;
  if rec.beginning_balance_cents + movement <> rec.ending_balance_cents then raise exception 'Statement opening plus activity does not equal statement ending balance'; end if;
  select coalesce(sum(l.debit_cents-l.credit_cents),0)*direction_factor into books
    from public.journal_lines l join public.journal_entries e on e.id=l.entry_id and e.org_id=l.org_id
    where l.org_id=p_org_id and l.account_id=bank.gl_account_id and e.status in ('posted','reversed') and e.entry_date<=rec.statement_end;
  delete from public.bank_reconciliation_items where org_id=p_org_id and reconciliation_id=rec.id;
  insert into public.bank_reconciliation_items(org_id,reconciliation_id,bank_transaction_id,journal_line_id,amount_cents,item_status)
    select p_org_id,rec.id,t.id,m.journal_line_id,m.matched_amount_cents,'cleared'
    from public.bank_transactions t join public.bank_transaction_matches m on m.bank_transaction_id=t.id and m.org_id=t.org_id
    where t.org_id=p_org_id and t.bank_account_id=bank.id and t.lifecycle_status='posted' and not t.excluded
      and t.transaction_date between rec.statement_start and rec.statement_end and m.status='confirmed';
  -- Unmatched book lines, including book-only checks and deposits, bridge bank to GL.
  insert into public.bank_reconciliation_items(org_id,reconciliation_id,journal_line_id,amount_cents,item_status)
    select p_org_id,rec.id,l.id,
      (case when l.debit_cents>0 then 1 else -1 end)*(l.debit_cents+l.credit_cents-coalesce(m.cleared,0))*direction_factor,'outstanding'
    from public.journal_lines l join public.journal_entries e on e.id=l.entry_id and e.org_id=l.org_id
    left join lateral (select sum(mt.matched_amount_cents) cleared from public.bank_transaction_matches mt
      join public.bank_transactions t on t.id=mt.bank_transaction_id and t.org_id=mt.org_id
      where mt.org_id=p_org_id and mt.journal_line_id=l.id and mt.status='confirmed' and t.lifecycle_status='posted'
        and not t.excluded and t.transaction_date<=rec.statement_end) m on true
    where l.org_id=p_org_id and l.account_id=bank.gl_account_id and e.status in ('posted','reversed') and e.entry_date<=rec.statement_end
      and e.entry_kind<>'opening' and l.debit_cents+l.credit_cents<>coalesce(m.cleared,0);
  select coalesce(sum(amount_cents),0) into outstanding from public.bank_reconciliation_items
    where org_id=p_org_id and reconciliation_id=rec.id and item_status='outstanding';
  if rec.ending_balance_cents+outstanding<>books then raise exception 'Adjusted statement balance does not equal GL: statement %, outstanding %, GL %',rec.ending_balance_cents,outstanding,books; end if;
  select jsonb_build_object('version',1,'statement_start',rec.statement_start,'statement_end',rec.statement_end,
    'beginning_balance_cents',rec.beginning_balance_cents,'ending_balance_cents',rec.ending_balance_cents,
    'book_balance_cents',books,'outstanding_balance_cents',outstanding,'account_id',bank.gl_account_id,
    'direction_factor',direction_factor,'items',coalesce(jsonb_agg(jsonb_build_object('bank_transaction_id',i.bank_transaction_id,'journal_line_id',i.journal_line_id,'amount_cents',i.amount_cents,'item_status',i.item_status)
      order by i.item_status,i.bank_transaction_id nulls last,i.journal_line_id nulls last,i.amount_cents),'[]'::jsonb)) into proof
    from public.bank_reconciliation_items i where i.org_id=p_org_id and i.reconciliation_id=rec.id;
  proof := proof || jsonb_build_object('version',2,'statement_transactions',(
    select coalesce(jsonb_agg(jsonb_build_object(
      'id',t.id,'transaction_date',t.transaction_date,'description',t.description,'merchant_name',t.merchant_name,
      'direction',t.direction,'amount_cents',t.amount_cents,'excluded',t.excluded,
      'matches',coalesce((select jsonb_agg(jsonb_build_object('matched_amount_cents',m.matched_amount_cents,'status',m.status) order by m.id)
        from public.bank_transaction_matches m where m.org_id=t.org_id and m.bank_transaction_id=t.id and m.status='confirmed'),'[]'::jsonb)
    ) order by t.transaction_date,t.id),'[]'::jsonb)
    from public.bank_transactions t where t.org_id=p_org_id and t.bank_account_id=bank.id
      and t.lifecycle_status='posted' and t.transaction_date between rec.statement_start and rec.statement_end
  ));
  proof_digest:=encode(extensions.digest(proof::text,'sha256'),'hex');
  update public.bank_reconciliations set status='closed',cleared_balance_cents=books,difference_cents=0,
    book_balance_cents=books,outstanding_balance_cents=outstanding,evidence=proof,digest=proof_digest,closed_by=p_actor_id,closed_at=now()
    where org_id=p_org_id and id=rec.id;
  return jsonb_build_object('id',rec.id,'digest',proof_digest);
end;
$$;

revoke all on function public.close_books_bank_reconciliation_atomic(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.close_books_bank_reconciliation_atomic(uuid,uuid,uuid) to service_role;
