-- Bank statement outstanding items have one definition, and offsetting book
-- lines can clear each other.
--
-- APPLY AFTER the October Books train (20261003021045 in particular): this
-- redefines the statement close that train introduces.
--
-- 1. books_bank_outstanding_lines() is the only definition of an outstanding
--    book item. The close and the preview each had their own copy and had
--    drifted (the preview ignored cutover outstanding items).
-- 2. A book offset clears book lines on the bank account that cancel each
--    other (a check and its void; an imported cutover check later voided)
--    without a bank transaction. It is a reviewed, append-only record; its
--    lines can never be matched to the bank, and it cannot reach into a closed
--    statement.
create table public.books_bank_offsets (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  bank_account_id uuid not null references public.bank_accounts(id),
  offset_on date not null,
  reason text not null check (length(btrim(reason)) >= 10),
  created_by uuid not null,
  created_at timestamptz not null default now()
);
create index books_bank_offsets_account_idx on public.books_bank_offsets(org_id, bank_account_id, offset_on);

create table public.books_bank_offset_lines (
  org_id uuid not null,
  offset_id uuid not null references public.books_bank_offsets(id) on delete restrict,
  journal_line_id uuid not null references public.journal_lines(id) on delete restrict,
  signed_cents bigint not null check (signed_cents <> 0),
  primary key (offset_id, journal_line_id)
);
create unique index books_bank_offset_lines_line_idx on public.books_bank_offset_lines(journal_line_id);
create index books_bank_offset_lines_org_idx on public.books_bank_offset_lines(org_id, offset_id);

alter table public.books_bank_offsets enable row level security;
alter table public.books_bank_offset_lines enable row level security;
create policy books_bank_offsets_read on public.books_bank_offsets for select to authenticated
  using (public.has_org_permission(org_id, 'books.reconcile'));
create policy books_bank_offset_lines_read on public.books_bank_offset_lines for select to authenticated
  using (public.has_org_permission(org_id, 'books.reconcile'));
revoke insert, update, delete, truncate on public.books_bank_offsets, public.books_bank_offset_lines from anon, authenticated;
revoke update, delete, truncate on public.books_bank_offsets, public.books_bank_offset_lines from service_role;

create or replace function public.books_bank_outstanding_lines(p_org_id uuid, p_account_id uuid, p_factor integer, p_statement_end date)
returns table(journal_line_id uuid, entry_date date, memo text, description text, amount_cents bigint)
language sql stable security definer set search_path = '' as $$
  select l.id, e.entry_date, e.memo, l.description,
    (case when l.debit_cents>0 then 1 else -1 end)*(l.debit_cents+l.credit_cents-coalesce(m.cleared,0))*p_factor
  from public.journal_lines l join public.journal_entries e on e.id=l.entry_id and e.org_id=l.org_id
  left join lateral (select sum(mt.matched_amount_cents) cleared from public.bank_transaction_matches mt
    join public.bank_transactions t on t.id=mt.bank_transaction_id and t.org_id=mt.org_id
    where mt.org_id=p_org_id and mt.journal_line_id=l.id and mt.status='confirmed' and t.lifecycle_status='posted'
      and not t.excluded and t.transaction_date<=p_statement_end) m on true
  where l.org_id=p_org_id and l.account_id=p_account_id and e.status in ('posted','reversed') and e.entry_date<=p_statement_end
    -- The opening position is not an outstanding item, except the cutover checks
    -- and deposits imported as their own opening lines until the bank clears them.
    and (e.entry_kind<>'opening' or l.dimensions->>'bank_opening_role'='outstanding_item')
    and l.debit_cents+l.credit_cents<>coalesce(m.cleared,0)
    and not exists (select 1 from public.books_bank_offset_lines ol join public.books_bank_offsets o on o.id=ol.offset_id and o.org_id=ol.org_id
      where ol.org_id=p_org_id and ol.journal_line_id=l.id and o.offset_on<=p_statement_end)
$$;
revoke all on function public.books_bank_outstanding_lines(uuid,uuid,integer,date) from public, anon, authenticated;
grant execute on function public.books_bank_outstanding_lines(uuid,uuid,integer,date) to service_role;

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
    select p_org_id,rec.id,o.journal_line_id,o.amount_cents,'outstanding'
    from public.books_bank_outstanding_lines(p_org_id,bank.gl_account_id,direction_factor,rec.statement_end) o;
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
  -- Book lines cleared against each other (a check and its void) are evidence too.
  proof := proof || jsonb_build_object('book_offsets',(
    select coalesce(jsonb_agg(jsonb_build_object('offset_id',o.id,'offset_on',o.offset_on,'reason',o.reason,
      'lines',(select jsonb_agg(jsonb_build_object('journal_line_id',ol.journal_line_id,'signed_cents',ol.signed_cents) order by ol.journal_line_id)
        from public.books_bank_offset_lines ol where ol.org_id=o.org_id and ol.offset_id=o.id)) order by o.offset_on,o.id),'[]'::jsonb)
    from public.books_bank_offsets o where o.org_id=p_org_id and o.bank_account_id=bank.id and o.offset_on between rec.statement_start and rec.statement_end));
  proof_digest:=encode(extensions.digest(proof::text,'sha256'),'hex');
  update public.bank_reconciliations set status='closed',cleared_balance_cents=books,difference_cents=0,
    book_balance_cents=books,outstanding_balance_cents=outstanding,evidence=proof,digest=proof_digest,closed_by=p_actor_id,closed_at=now()
    where org_id=p_org_id and id=rec.id;
  return jsonb_build_object('id',rec.id,'digest',proof_digest);
end;
$$;

revoke all on function public.close_books_bank_reconciliation_atomic(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.close_books_bank_reconciliation_atomic(uuid,uuid,uuid) to service_role;

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
 select coalesce(sum(o.amount_cents),0),coalesce(jsonb_agg(jsonb_build_object('journal_line_id',o.journal_line_id,'entry_date',o.entry_date,'memo',o.memo,'description',o.description,'amount_cents',o.amount_cents,'item_status','outstanding') order by o.entry_date,o.journal_line_id),'[]'::jsonb)
   into outstanding,items from public.books_bank_outstanding_lines(p_org_id,account_id_value,factor,rec.statement_end) o;
 return jsonb_build_object('book_balance_cents',books,'outstanding_balance_cents',outstanding,'direction_factor',factor,'items',items,'frozen',false);
end;
$$;
revoke all on function public.preview_books_bank_reconciliation(uuid,uuid) from public,anon,authenticated;
grant execute on function public.preview_books_bank_reconciliation(uuid,uuid) to service_role;

create or replace function public.create_books_bank_offset_atomic(p_org_id uuid, p_bank_account_id uuid, p_line_ids uuid[], p_reason text, p_actor_id uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare bank public.bank_accounts%rowtype; offset_id uuid; offset_date date; net bigint; usable integer;
begin
  if cardinality(p_line_ids) < 2 or cardinality(p_line_ids) <> (select count(distinct id) from unnest(p_line_ids) id) then
    raise exception 'Choose at least two distinct book entries to offset';
  end if;
  if length(btrim(coalesce(p_reason,''))) < 10 then raise exception 'Explain why these entries cancel each other'; end if;
  -- The bank-account lock orders this with matching and statement close.
  select * into bank from public.bank_accounts where org_id=p_org_id and id=p_bank_account_id for update;
  if bank.id is null or bank.gl_account_id is null then raise exception 'Bank account not found or not mapped'; end if;
  select count(*), coalesce(sum(l.debit_cents-l.credit_cents),0), max(e.entry_date) into usable, net, offset_date
  from public.journal_lines l join public.journal_entries e on e.id=l.entry_id and e.org_id=l.org_id
  where l.org_id=p_org_id and l.id=any(p_line_ids) and l.account_id=bank.gl_account_id and e.status in ('posted','reversed')
    and (e.entry_kind<>'opening' or l.dimensions->>'bank_opening_role'='outstanding_item')
    and not exists (select 1 from public.bank_transaction_matches m where m.journal_line_id=l.id and m.status='confirmed')
    and not exists (select 1 from public.books_bank_offset_lines ol where ol.journal_line_id=l.id);
  if usable <> cardinality(p_line_ids) then
    raise exception 'Only unmatched book entries on this bank account that are not already offset can be offset';
  end if;
  if net <> 0 then raise exception 'Offsetting entries must cancel exactly; these differ by % cents', net; end if;
  if exists (select 1 from public.bank_reconciliations r where r.org_id=p_org_id and r.bank_account_id=bank.id and r.status='closed' and r.statement_end>=offset_date) then
    raise exception 'Reopen the bank statement covering % before offsetting these entries', offset_date;
  end if;
  insert into public.books_bank_offsets(org_id,bank_account_id,offset_on,reason,created_by)
    values(p_org_id,bank.id,offset_date,btrim(p_reason),p_actor_id) returning id into offset_id;
  insert into public.books_bank_offset_lines(org_id,offset_id,journal_line_id,signed_cents)
    select p_org_id,offset_id,l.id,l.debit_cents-l.credit_cents from public.journal_lines l where l.org_id=p_org_id and l.id=any(p_line_ids);
  return offset_id;
end;
$$;
revoke all on function public.create_books_bank_offset_atomic(uuid,uuid,uuid[],text,uuid) from public,anon,authenticated;
grant execute on function public.create_books_bank_offset_atomic(uuid,uuid,uuid[],text,uuid) to service_role;

-- An offset line is cleared; the bank can never also clear it.
create or replace function public.validate_books_bank_match()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  txn public.bank_transactions%rowtype;
  bank public.bank_accounts%rowtype;
  jl public.journal_lines%rowtype;
  entry_status text;
  entry_kind_value text;
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
  if exists (select 1 from public.books_bank_offset_lines where journal_line_id = jl.id) then
    raise exception 'This book entry was offset against another entry and cannot be matched to the bank';
  end if;
  if not found or jl.account_id is distinct from bank.gl_account_id then raise exception 'Journal line must belong to the mapped bank account and organization'; end if;
  select status, entry_kind into entry_status, entry_kind_value from public.journal_entries where id = jl.entry_id and org_id = new.org_id;
  if entry_status not in('posted','reversed') then raise exception 'Only an economic journal line can receive a new match'; end if;
  if entry_kind_value = 'opening' and coalesce(jl.dimensions->>'bank_opening_role','') <> 'outstanding_item' then
    raise exception 'Only an imported outstanding check or deposit can clear against the opening balance';
  end if;
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
