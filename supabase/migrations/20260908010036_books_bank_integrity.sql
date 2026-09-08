-- Bank matching and reconciliation are transactions, not client-side sums.
-- Pending production approval. Existing closed evidence is preserved.
alter table public.bank_reconciliations add column if not exists book_balance_cents bigint;
alter table public.bank_reconciliations add column if not exists outstanding_balance_cents bigint;
alter table public.bank_reconciliations add column if not exists evidence jsonb;

create or replace function public.validate_books_bank_match()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  txn public.bank_transactions%rowtype;
  bank public.bank_accounts%rowtype;
  jl public.journal_lines%rowtype;
  entry_status text;
  used_cents bigint;
begin
  if tg_op = 'UPDATE' and (new.org_id <> old.org_id or new.bank_transaction_id <> old.bank_transaction_id
      or new.journal_line_id is distinct from old.journal_line_id) then
    raise exception 'A bank match cannot be reassigned; reverse it and create a new match';
  end if;
  select * into txn from public.bank_transactions where id = new.bank_transaction_id and org_id = new.org_id;
  if not found then raise exception 'Bank transaction not found in organization'; end if;
  select * into bank from public.bank_accounts where id = txn.bank_account_id and org_id = new.org_id for update;
  if not found then raise exception 'Bank account not found in organization'; end if;
  if exists (select 1 from public.bank_reconciliations r where r.org_id = new.org_id
    and r.bank_account_id = bank.id and r.status = 'closed' and txn.transaction_date <= r.statement_end) then
    raise exception 'Reopen the bank reconciliation before changing its matches';
  end if;
  select * into txn from public.bank_transactions where id = new.bank_transaction_id and org_id = new.org_id for update;
  if new.status <> 'confirmed' then return new; end if;
  if txn.lifecycle_status <> 'posted' or txn.excluded then raise exception 'Only posted, included bank transactions can be matched'; end if;
  if new.journal_line_id is null or new.match_type = 'excluded' then
    raise exception 'A confirmed match requires a journal line; exclusion is a separate reviewed action';
  end if;
  select * into jl from public.journal_lines where id = new.journal_line_id and org_id = new.org_id for update;
  if not found or jl.account_id is distinct from bank.gl_account_id then raise exception 'Journal line must belong to the mapped bank account and organization'; end if;
  select status into entry_status from public.journal_entries where id = jl.entry_id and org_id = new.org_id;
  if entry_status not in('posted','reversed') then raise exception 'Only an economic journal line can receive a new match'; end if;
  if (txn.direction = 'inflow' and jl.debit_cents <= 0) or (txn.direction = 'outflow' and jl.credit_cents <= 0) then
    raise exception 'Bank and journal line directions differ';
  end if;
  select coalesce(sum(matched_amount_cents),0) into used_cents from public.bank_transaction_matches
    where org_id = new.org_id and bank_transaction_id = txn.id and status = 'confirmed' and id <> new.id;
  if used_cents + new.matched_amount_cents > abs(txn.amount_cents) then raise exception 'Matches exceed bank transaction capacity'; end if;
  select coalesce(sum(matched_amount_cents),0) into used_cents from public.bank_transaction_matches
    where journal_line_id = jl.id and status = 'confirmed' and id <> new.id;
  if used_cents + new.matched_amount_cents > jl.debit_cents + jl.credit_cents then raise exception 'Matches exceed journal line capacity'; end if;
  return new;
end;
$$;
revoke all on function public.validate_books_bank_match() from public, anon, authenticated;
create trigger bank_matches_validate before insert or update on public.bank_transaction_matches
for each row execute function public.validate_books_bank_match();

create or replace function public.confirm_books_bank_match_atomic(
  p_org_id uuid, p_transaction_id uuid, p_line_id uuid, p_amount_cents bigint,
  p_match_type text, p_confidence numeric, p_actor_id uuid
) returns uuid language plpgsql security definer set search_path = '' as $$
declare result_id uuid;
begin
  -- All matching and reconciliation use the bank-account lock first.
  perform 1 from public.bank_accounts b join public.bank_transactions t on t.bank_account_id = b.id
    where b.org_id = p_org_id and t.org_id = p_org_id and t.id = p_transaction_id for update of b;
  if not found then raise exception 'Bank transaction not found'; end if;
  select id into result_id from public.bank_transaction_matches
    where org_id = p_org_id and bank_transaction_id = p_transaction_id and journal_line_id = p_line_id
      and matched_amount_cents = p_amount_cents and match_type = p_match_type and status = 'confirmed'
    order by id limit 1;
  if result_id is not null then return result_id; end if;
  insert into public.bank_transaction_matches(org_id,bank_transaction_id,journal_line_id,matched_amount_cents,match_type,confidence,status,confirmed_by,confirmed_at)
    values(p_org_id,p_transaction_id,p_line_id,p_amount_cents,p_match_type,p_confidence,'confirmed',p_actor_id,now()) returning id into result_id;
  return result_id;
end;
$$;
revoke all on function public.confirm_books_bank_match_atomic(uuid,uuid,uuid,bigint,text,numeric,uuid) from public, anon, authenticated;
grant execute on function public.confirm_books_bank_match_atomic(uuid,uuid,uuid,bigint,text,numeric,uuid) to service_role;

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
    'direction_factor',direction_factor,'items',coalesce(jsonb_agg(to_jsonb(i) order by i.id),'[]'::jsonb)) into proof
    from public.bank_reconciliation_items i where i.org_id=p_org_id and i.reconciliation_id=rec.id;
  proof_digest:=encode(extensions.digest(proof::text,'sha256'),'hex');
  update public.bank_reconciliations set status='closed',cleared_balance_cents=books,difference_cents=0,
    book_balance_cents=books,outstanding_balance_cents=outstanding,evidence=proof,digest=proof_digest,closed_by=p_actor_id,closed_at=now()
    where org_id=p_org_id and id=rec.id;
  return jsonb_build_object('id',rec.id,'digest',proof_digest);
end;
$$;
revoke all on function public.close_books_bank_reconciliation_atomic(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.close_books_bank_reconciliation_atomic(uuid,uuid,uuid) to service_role;

create or replace function public.create_books_deposit_batch_atomic(
  p_org_id uuid,p_transaction_id uuid,p_payment_ids uuid[],p_reference text,p_actor_id uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  txn public.bank_transactions%rowtype;
  bank public.bank_accounts%rowtype;
  batch public.books_deposit_batches%rowtype;
  payment record;
  receipt_cents bigint;
  total_cents bigint:=0;
  clearing_id uuid;
  deposit_entry_id uuid;
  bank_line_id uuid;
  policy integer;
  receipt_ids uuid[];
begin
  if cardinality(p_payment_ids)=0 or cardinality(p_payment_ids)<>(select count(distinct id) from unnest(p_payment_ids) id) then
    raise exception 'Select distinct customer receipts';
  end if;
  select * into txn from public.bank_transactions where id=p_transaction_id and org_id=p_org_id;
  if not found then raise exception 'Bank transaction not found'; end if;
  select * into bank from public.bank_accounts where id=txn.bank_account_id and org_id=p_org_id for update;
  select * into txn from public.bank_transactions where id=p_transaction_id and org_id=p_org_id for update;
  if txn.direction<>'inflow' or txn.lifecycle_status<>'posted' or txn.excluded or bank.gl_account_id is null then raise exception 'Choose an included posted deposit into a mapped account'; end if;
  select * into batch from public.books_deposit_batches where org_id=p_org_id and bank_transaction_id=txn.id for update;
  if batch.id is not null then
    select array_agg(payment_id order by payment_id) into receipt_ids from public.books_deposit_batch_items where org_id=p_org_id and batch_id=batch.id;
    if receipt_ids is not null and receipt_ids<>(select array_agg(id order by id) from unnest(p_payment_ids) id) then raise exception 'Retry must use the original receipt membership'; end if;
    if batch.status='posted' then return jsonb_build_object('id',batch.id,'duplicate',true); end if;
    if batch.status='void' then raise exception 'A void batch cannot be posted'; end if;
  end if;
  select id into clearing_id from public.gl_accounts where org_id=p_org_id and code='1010' and active;
  if clearing_id is null then raise exception 'Undeposited funds account is missing'; end if;
  -- Lock receipts in UUID order so two deposits cannot consume the same receipt.
  for payment in select * from public.payments where org_id=p_org_id and id=any(p_payment_ids) order by id for update loop
    if payment.invoice_id is null or payment.status not in ('succeeded','completed','paid') then raise exception 'Only settled customer receipts may be deposited'; end if;
    select coalesce(sum(l.debit_cents-l.credit_cents),0) into receipt_cents
      from public.journal_entries e join public.journal_lines l on l.entry_id=e.id and l.org_id=e.org_id
      where e.org_id=p_org_id and e.source_id=payment.id and e.source_type in ('invoice_payment','customer_deposit_receipt')
        and e.status='posted' and l.account_id=clearing_id;
    if receipt_cents<=0 then raise exception 'Receipt has no active undeposited-funds posting'; end if;
    total_cents:=total_cents+receipt_cents;
    if exists(select 1 from public.books_deposit_batch_items where org_id=p_org_id and payment_id=payment.id and batch_id is distinct from batch.id) then raise exception 'Receipt is already assigned to another deposit'; end if;
  end loop;
  if (select count(*) from public.payments where org_id=p_org_id and id=any(p_payment_ids))<>cardinality(p_payment_ids) then raise exception 'Receipt not found'; end if;
  if total_cents<>txn.amount_cents then raise exception 'Receipt clearing balances must equal the bank deposit'; end if;
  if batch.id is null then
    insert into public.books_deposit_batches(org_id,bank_transaction_id,bank_account_id,deposited_on,total_cents,reference,created_by)
      values(p_org_id,txn.id,bank.id,txn.transaction_date,total_cents,nullif(btrim(p_reference),''),p_actor_id) returning * into batch;
  elsif batch.total_cents<>total_cents then raise exception 'Receipt amounts changed after batch creation'; end if;
  if receipt_ids is null then
    insert into public.books_deposit_batch_items(org_id,batch_id,payment_id,amount_cents)
      select p_org_id,batch.id,p.id,sum(l.debit_cents-l.credit_cents) from public.payments p
      join public.journal_entries e on e.org_id=p.org_id and e.source_id=p.id and e.source_type in ('invoice_payment','customer_deposit_receipt') and e.status='posted'
      join public.journal_lines l on l.entry_id=e.id and l.org_id=e.org_id and l.account_id=clearing_id
      where p.org_id=p_org_id and p.id=any(p_payment_ids) group by p.id;
  end if;
  select active_policy_version into policy from public.books_settings where org_id=p_org_id;
  deposit_entry_id:=public.post_books_journal_entry(p_org_id,jsonb_build_object(
    'entry_date',batch.deposited_on,'entry_kind','operational','memo','Bank deposit'||coalesce(' · '||batch.reference,''),
    'posting_key','deposit_batch:'||batch.id,'projection_version',1,'policy_version',policy,
    'source_type','deposit_batch','source_id',batch.id,'created_by',p_actor_id),jsonb_build_array(
      jsonb_build_object('line_no',1,'account_id',bank.gl_account_id,'debit_cents',total_cents,'credit_cents',0,'description','Bank deposit','dimensions','{}'::jsonb),
      jsonb_build_object('line_no',2,'account_id',clearing_id,'debit_cents',0,'credit_cents',total_cents,'description',cardinality(p_payment_ids)||' customer receipts','dimensions','{}'::jsonb)));
  select id into bank_line_id from public.journal_lines where org_id=p_org_id and journal_lines.entry_id=deposit_entry_id and account_id=bank.gl_account_id;
  perform public.confirm_books_bank_match_atomic(p_org_id,txn.id,bank_line_id,total_cents,'exact',1,p_actor_id);
  update public.books_deposit_batches set status='posted',journal_entry_id=deposit_entry_id where org_id=p_org_id and id=batch.id;
  return jsonb_build_object('id',batch.id,'duplicate',false);
end;
$$;
revoke all on function public.create_books_deposit_batch_atomic(uuid,uuid,uuid[],text,uuid) from public,anon,authenticated;
grant execute on function public.create_books_deposit_batch_atomic(uuid,uuid,uuid[],text,uuid) to service_role;

-- The account lock is also acquired by writers, so close observes a stable set.
-- Once frozen, changing pre-close economics requires an explicit reopen.
create or replace function public.guard_books_reconciled_activity()
returns trigger language plpgsql security definer set search_path='' as $$
declare
  activity_org uuid;
  activity_date date;
  activity_account uuid;
  bank record;
  row_data jsonb;
begin
  -- Moving a row out of a closed date/account must not evade the new-row check.
  if tg_op='UPDATE' then
    if tg_table_name='bank_transactions' then
      if (to_jsonb(new)-array['updated_at','last_seen_at','latest_revision'])=(to_jsonb(old)-array['updated_at','last_seen_at','latest_revision']) then return new; end if;
      for bank in select id from public.bank_accounts where org_id=old.org_id and id=old.bank_account_id for update loop
        if exists(select 1 from public.bank_reconciliations r where r.org_id=old.org_id and r.bank_account_id=bank.id and r.status='closed' and old.transaction_date<=r.statement_end) then
          raise exception 'Reopen the bank reconciliation before changing reconciled history';
        end if;
      end loop;
    elsif tg_table_name='journal_lines' then
      for bank in select id from public.bank_accounts where org_id=old.org_id and gl_account_id=old.account_id order by id for update loop
        if exists(select 1 from public.bank_reconciliations r join public.journal_entries e on e.org_id=r.org_id and e.id=old.entry_id where r.org_id=old.org_id and r.bank_account_id=bank.id and r.status='closed' and e.entry_date<=r.statement_end) then
          raise exception 'Reopen the bank reconciliation before changing reconciled history';
        end if;
      end loop;
    end if;
  end if;
  row_data:=case when tg_op='DELETE' then to_jsonb(old) else to_jsonb(new) end;
  activity_org:=(row_data->>'org_id')::uuid;
  if tg_table_name='journal_lines' then
    activity_account:=(row_data->>'account_id')::uuid;
    select entry_date into activity_date from public.journal_entries
      where org_id=activity_org and id=(row_data->>'entry_id')::uuid;
  elsif tg_table_name='bank_transactions' then
    if tg_op='UPDATE' and (to_jsonb(new)-array['updated_at','last_seen_at','latest_revision'])=(to_jsonb(old)-array['updated_at','last_seen_at','latest_revision']) then return new; end if;
    activity_date:=(row_data->>'transaction_date')::date;
    select gl_account_id into activity_account from public.bank_accounts where org_id=activity_org and id=(row_data->>'bank_account_id')::uuid;
  else
    select t.transaction_date,b.gl_account_id into activity_date,activity_account
      from public.bank_transactions t join public.bank_accounts b on b.id=t.bank_account_id and b.org_id=t.org_id
      where t.org_id=activity_org and t.id=(row_data->>'bank_transaction_id')::uuid;
  end if;
  for bank in select id from public.bank_accounts where org_id=activity_org and gl_account_id=activity_account order by id for update loop
    if exists(select 1 from public.bank_reconciliations r where r.org_id=activity_org and r.bank_account_id=bank.id and r.status='closed' and activity_date<=r.statement_end) then
      raise exception 'Reopen the bank reconciliation before changing reconciled history';
    end if;
  end loop;
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$;
revoke all on function public.guard_books_reconciled_activity() from public,anon,authenticated;
create trigger journal_lines_bank_close_guard before insert or update or delete on public.journal_lines for each row execute function public.guard_books_reconciled_activity();
create trigger bank_transactions_close_guard before insert or update or delete on public.bank_transactions for each row execute function public.guard_books_reconciled_activity();
create trigger bank_matches_delete_guard before delete on public.bank_transaction_matches for each row execute function public.guard_books_reconciled_activity();

create or replace function public.guard_books_bank_mapping()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.gl_account_id is distinct from old.gl_account_id and (
    exists(select 1 from public.bank_reconciliations where org_id=old.org_id and bank_account_id=old.id and status='closed')
    or exists(select 1 from public.bank_transaction_matches m join public.bank_transactions t on t.id=m.bank_transaction_id and t.org_id=m.org_id where t.org_id=old.org_id and t.bank_account_id=old.id and m.status='confirmed')) then
    raise exception 'An account with confirmed matches or closed reconciliations cannot be remapped';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_books_bank_mapping() from public,anon,authenticated;
create trigger bank_accounts_mapping_guard before update on public.bank_accounts for each row execute function public.guard_books_bank_mapping();

-- Read-only preview uses the same economic window and unmatched-line equation as close.
create or replace function public.preview_books_bank_reconciliation(p_org_id uuid,p_reconciliation_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare rec public.bank_reconciliations%rowtype; account_id_value uuid; factor integer; books bigint; outstanding bigint; items jsonb;
begin
 select * into rec from public.bank_reconciliations where org_id=p_org_id and id=p_reconciliation_id;
 if not found then raise exception 'Bank reconciliation not found'; end if;
 if rec.status='closed' and rec.evidence is not null then return rec.evidence||jsonb_build_object('frozen',true); end if;
 select b.gl_account_id,case when a.account_type='liability' then -1 else 1 end into account_id_value,factor from public.bank_accounts b join public.gl_accounts a on a.id=b.gl_account_id and a.org_id=b.org_id where b.org_id=p_org_id and b.id=rec.bank_account_id;
 if account_id_value is null then raise exception 'Map the bank account before reconciliation'; end if;
 select coalesce(sum(l.debit_cents-l.credit_cents),0)*factor into books from public.journal_lines l join public.journal_entries e on e.id=l.entry_id and e.org_id=l.org_id where l.org_id=p_org_id and l.account_id=account_id_value and e.status in('posted','reversed') and e.entry_date<=rec.statement_end;
 select coalesce(sum(q.amount_cents),0),coalesce(jsonb_agg(to_jsonb(q) order by q.entry_date,q.journal_line_id),'[]'::jsonb) into outstanding,items from (
 select l.id journal_line_id,e.entry_date,(case when l.debit_cents>0 then 1 else -1 end)*(l.debit_cents+l.credit_cents-coalesce(m.cleared,0))*factor amount_cents,'outstanding'::text item_status
 from public.journal_lines l join public.journal_entries e on e.id=l.entry_id and e.org_id=l.org_id
 left join lateral(select sum(mt.matched_amount_cents) cleared from public.bank_transaction_matches mt join public.bank_transactions t on t.id=mt.bank_transaction_id and t.org_id=mt.org_id where mt.org_id=p_org_id and mt.journal_line_id=l.id and mt.status='confirmed' and t.lifecycle_status='posted' and not t.excluded and t.transaction_date<=rec.statement_end) m on true
 where l.org_id=p_org_id and l.account_id=account_id_value and e.status in('posted','reversed') and e.entry_date<=rec.statement_end and e.entry_kind<>'opening' and l.debit_cents+l.credit_cents<>coalesce(m.cleared,0)) q;
 return jsonb_build_object('book_balance_cents',books,'outstanding_balance_cents',outstanding,'direction_factor',factor,'items',items,'frozen',false);
end;
$$;
revoke all on function public.preview_books_bank_reconciliation(uuid,uuid) from public,anon,authenticated;
grant execute on function public.preview_books_bank_reconciliation(uuid,uuid) to service_role;

alter table public.bank_reconciliations add column if not exists evidence_history jsonb not null default '[]'::jsonb check(jsonb_typeof(evidence_history)='array');
create or replace function public.reopen_books_bank_reconciliation(p_org_id uuid,p_reconciliation_id uuid,p_reason text,p_actor_id uuid)
returns void language plpgsql security definer set search_path='' as $$
declare rec public.bank_reconciliations%rowtype;
begin
 if length(btrim(p_reason))<10 then raise exception 'Explain why this bank statement needs reopening'; end if;
 select * into rec from public.bank_reconciliations where org_id=p_org_id and id=p_reconciliation_id;
 if not found then raise exception 'Bank reconciliation not found'; end if;
 perform 1 from public.bank_accounts where org_id=p_org_id and id=rec.bank_account_id for update;
 select * into rec from public.bank_reconciliations where org_id=p_org_id and id=p_reconciliation_id for update;
 if rec.status<>'closed' then raise exception 'Only a closed bank statement can be reopened'; end if;
 if exists(select 1 from public.bank_reconciliations where org_id=p_org_id and bank_account_id=rec.bank_account_id and status='closed' and statement_end>rec.statement_end) then raise exception 'Reopen later bank statements first'; end if;
 if exists(select 1 from public.accounting_periods where org_id=p_org_id and status='closed' and period_start<=rec.statement_end and period_end>=rec.statement_start) then raise exception 'Reopen the overlapping accounting period first'; end if;
 update public.bank_reconciliations set status='draft',evidence_history=evidence_history||jsonb_build_array(jsonb_build_object('evidence',rec.evidence,'digest',rec.digest,'closed_at',rec.closed_at,'closed_by',rec.closed_by,'reopened_by',p_actor_id,'reopened_at',now(),'reason',p_reason)),evidence=null,digest=null,closed_at=null,closed_by=null,book_balance_cents=null,outstanding_balance_cents=null where org_id=p_org_id and id=rec.id;
end;
$$;
revoke all on function public.reopen_books_bank_reconciliation(uuid,uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.reopen_books_bank_reconciliation(uuid,uuid,text,uuid) to service_role;

create or replace function public.guard_books_bank_statement_state()
returns trigger language plpgsql set search_path='' as $$
begin
 if current_user not in('postgres','service_role') and (old.status='closed' or new.status='closed' or new.evidence_history is distinct from old.evidence_history) then raise exception 'Closing and reopening bank statements require the authorized Books service'; end if;
 return new;
end;
$$;
create trigger books_bank_statement_state_guard before update on public.bank_reconciliations for each row execute function public.guard_books_bank_statement_state();
