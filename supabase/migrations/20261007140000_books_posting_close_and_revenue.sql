-- Bank offsets and cutover outstanding items, posted-source delete guard, projection progress, close review aggregates, contract and dimension invalidation, opening items, contract WIP scope and revenue policies (B01, B04, B08, B09, B11.1).
--
-- Consolidated before deploy (2026-10-09) from 9 unapplied migrations, in their
-- original order; each section is marked with the file it came from.

-- ==== 20261006190000_books_bank_outstanding_and_offsets ====
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

-- ==== 20261006210000_books_posted_source_delete_guard ====
-- A document that carries money in the ledger cannot be deleted.
--
-- The projector retires a voided or un-approved source on its next 10-minute
-- run, because the status change moves the row's updated_at. A deleted row
-- leaves nothing to watermark, so its journal stayed posted until the nightly
-- full pass — overstating payables and cost for up to a day, and for good if
-- the period closed first. An approved, unpaid bill could be deleted this way.
--
-- A source with a posted (unreversed) journal now refuses DELETE. Return it to
-- pending or void it; once the next run has reversed its journal it deletes
-- normally. Reversal entries carry no source, and the original entry moves to
-- 'reversed', so the check is exact. Rollbacks that delete a row in the same
-- request that inserted it are unaffected: no journal exists yet.

create or replace function public.books_guard_posted_source_delete()
returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if exists (
    select 1 from public.journal_entries
    where org_id = old.org_id and source_type = any(tg_argv) and source_id = old.id and status = 'posted'
  ) then
    raise exception 'This record has posted to the ledger. Return it to pending or void it, then delete it once its journal is reversed (within about 10 minutes).'
      using errcode = 'P0001';
  end if;
  return old;
end;
$$;
revoke all on function public.books_guard_posted_source_delete() from public, anon, authenticated;

create trigger books_guard_posted_source_delete before delete on public.vendor_bills
for each row execute function public.books_guard_posted_source_delete('vendor_bill');
create trigger books_guard_posted_source_delete before delete on public.invoices
for each row execute function public.books_guard_posted_source_delete('invoice');
create trigger books_guard_posted_source_delete before delete on public.project_expenses
for each row execute function public.books_guard_posted_source_delete('expense');
create trigger books_guard_posted_source_delete before delete on public.payments
for each row execute function public.books_guard_posted_source_delete('invoice_payment', 'bill_payment', 'customer_deposit_receipt', 'customer_deposit_application');

-- ==== 20261006220000_books_projection_progress ====
-- Where each company's projection run left off, and when it last completed.
--
-- The 10-minute run used the newest accounting fact as its cursor. A fact is
-- written only when money changes, so every document touched without a money
-- change since then was re-read and re-sent to the database on every run; and a
-- write that committed after a newer one had been projected fell behind the
-- cursor until the nightly pass. The run now saves, per source family, the
-- latest updated_at it actually read, plus when its read began. The next run
-- reads strictly after each cursor, reaching back to five minutes before that
-- start only for writes that were still in flight when it read.
--
-- The completion times order the next run: the company least recently completed
-- goes first, so one that the time budget did not reach is first next time.
-- Written only by the service role through complete_books_projection_run.

create table public.books_projection_progress (
  org_id uuid primary key references public.orgs(id) on delete cascade,
  cursors jsonb not null default '{}'::jsonb check (jsonb_typeof(cursors) = 'object'),
  read_started_at timestamptz,
  incremental_completed_at timestamptz,
  full_completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.books_projection_progress enable row level security;
revoke all on table public.books_projection_progress from anon, authenticated;
create trigger books_projection_progress_set_updated_at before update on public.books_projection_progress
for each row execute function public.tg_set_updated_at();

-- Cursors only move forward: a slower concurrent run that read less never pulls
-- one back. A full pass also counts as an ordinary run.
create or replace function public.complete_books_projection_run(p_org_id uuid, p_cursors jsonb, p_full boolean, p_read_started_at timestamptz)
returns void language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  if jsonb_typeof(p_cursors) <> 'object' then raise exception 'Projection cursors must be an object'; end if;
  if p_read_started_at is null then raise exception 'Projection read start is required'; end if;
  insert into public.books_projection_progress as progress (org_id, cursors, read_started_at, incremental_completed_at, full_completed_at)
  values (p_org_id, p_cursors, p_read_started_at, clock_timestamp(), case when p_full then clock_timestamp() end)
  on conflict (org_id) do update set
    cursors = (
      select coalesce(jsonb_object_agg(family, to_jsonb(at)), '{}'::jsonb)
      from (
        select family, max(value::timestamptz) at
        from (
          select key family, value #>> '{}' value from jsonb_each(progress.cursors)
          union all
          select key, value #>> '{}' from jsonb_each(excluded.cursors)
        ) both_cursors
        group by family
      ) merged
    ),
    -- The earlier start of two overlapping runs keeps the wider late-commit window.
    read_started_at = case when progress.incremental_completed_at < p_read_started_at then p_read_started_at else least(progress.read_started_at, p_read_started_at) end,
    incremental_completed_at = clock_timestamp(),
    full_completed_at = case when p_full then clock_timestamp() else progress.full_completed_at end;
end;
$$;
revoke all on function public.complete_books_projection_run(uuid, jsonb, boolean, timestamptz) from public, anon, authenticated;
grant execute on function public.complete_books_projection_run(uuid, jsonb, boolean, timestamptz) to service_role;

-- ==== 20261006230000_books_close_review_aggregates ====
-- Ledger and job-cost totals for the month-end review, summed in the database.
--
-- The close checklist, the close snapshot and the as-of statements loaded every
-- posted journal entry and line since the company began, several times per
-- review, and summed them in the application: the review's cost grew with the
-- whole history (18,160 rows for 1,200 bills in CAP-01). These return one row
-- per account, project and contract, and one job-cost total, so the review reads
-- what the chart and the jobs need.
--
-- A reversed entry and its reversal both count, as in the application loader,
-- and net to zero. Service role only: they take an organization id.

create or replace function public.books_ledger_balances(p_org_id uuid, p_as_of date)
returns table (
  account_id uuid,
  project_id uuid,
  contract_id text,
  warranty_reserve_adjustment boolean,
  debit_cents bigint,
  credit_cents bigint
)
language sql stable security invoker set search_path = pg_catalog, public as $$
  select line.account_id,
    line.project_id,
    line.dimensions ->> 'contract_id',
    coalesce(line.dimensions ->> 'warranty_reserve_adjustment' = 'true', false),
    sum(line.debit_cents)::bigint,
    sum(line.credit_cents)::bigint
  from public.journal_lines line
  join public.journal_entries entry on entry.id = line.entry_id and entry.org_id = line.org_id
  where line.org_id = p_org_id
    and entry.org_id = p_org_id
    and entry.status in ('posted', 'reversed')
    and entry.entry_date <= p_as_of
  group by 1, 2, 3, 4
$$;
revoke all on function public.books_ledger_balances(uuid, date) from public, anon, authenticated;
grant execute on function public.books_ledger_balances(uuid, date) to service_role;

create or replace function public.books_job_cost_subledger_cents(p_org_id uuid, p_as_of date)
returns bigint
language sql stable security invoker set search_path = pg_catalog, public as $$
  select coalesce(sum(cost_cents), 0)::bigint
  from public.job_cost_entries
  where org_id = p_org_id and status = 'posted' and incurred_on <= p_as_of
$$;
revoke all on function public.books_job_cost_subledger_cents(uuid, date) from public, anon, authenticated;
grant execute on function public.books_job_cost_subledger_cents(uuid, date) to service_role;

-- Clearing accounts at period end: each account's net and a fingerprint of the
-- lines behind it, so a saved clearing review is invalidated by any change to
-- those lines without the review reading every clearing line since inception.
create or replace function public.books_account_positions(p_org_id uuid, p_as_of date, p_codes text[])
returns table (code text, debit_cents bigint, credit_cents bigint, line_count bigint, lines_digest text)
language sql stable security invoker set search_path = pg_catalog, public as $$
  select account.code,
    coalesce(sum(line.debit_cents), 0)::bigint,
    coalesce(sum(line.credit_cents), 0)::bigint,
    count(line.id),
    md5(coalesce(string_agg(line.id::text || ':' || line.entry_id::text || ':' || line.debit_cents || ':' || line.credit_cents, ',' order by line.id), ''))
  from public.gl_accounts account
  join public.journal_lines line on line.org_id = account.org_id and line.account_id = account.id
  join public.journal_entries entry on entry.id = line.entry_id and entry.org_id = line.org_id
  where account.org_id = p_org_id
    and account.code = any(p_codes)
    and entry.status in ('posted', 'reversed')
    and entry.entry_date <= p_as_of
  group by account.code
$$;
revoke all on function public.books_account_positions(uuid, date, text[]) from public, anon, authenticated;
grant execute on function public.books_account_positions(uuid, date, text[]) to service_role;

-- Which of these projects carry posted job cost by a date: the WIP review needs
-- only that a job has cost, not every cost line it has ever had.
create or replace function public.books_projects_with_posted_cost(p_org_id uuid, p_as_of date, p_project_ids uuid[])
returns setof uuid
language sql stable security invoker set search_path = pg_catalog, public as $$
  select project.id
  from unnest(p_project_ids) as project(id)
  where exists (
    select 1 from public.job_cost_entries cost
    where cost.org_id = p_org_id and cost.project_id = project.id and cost.status = 'posted' and cost.incurred_on <= p_as_of
  )
$$;
revoke all on function public.books_projects_with_posted_cost(uuid, date, uuid[]) from public, anon, authenticated;
grant execute on function public.books_projects_with_posted_cost(uuid, date, uuid[]) to service_role;

-- A ledger proof is either the full rebuild drill or the narrowed proof of what
-- changed since a time. The nightly job runs the narrowed proof and a full drill
-- weekly, so a run records which it was.
alter table public.ledger_rebuild_runs
  add column scope text not null default 'full' check (scope in ('full', 'changed_since')),
  add column changed_since timestamptz,
  add constraint ledger_rebuild_runs_scope_since check ((scope = 'changed_since') = (changed_since is not null));
create index if not exists ledger_rebuild_runs_org_scope_started_idx on public.ledger_rebuild_runs (org_id, scope, started_at desc);

-- ==== 20261006240000_books_contract_effective_date_invalidation ====
-- A contract taking effect changes how its project's documents post, with no edit.
--
-- A project's revenue basis comes from the primary contracts in effect today
-- (resolveProjectRevenueBasis). Editing a contract touches the project's sources
-- (20261006175218), but a contract dated in the future changes the basis on the
-- morning its effective date arrives, and nothing moved the sources: they kept
-- reading "posted" under the old basis until the nightly pass. Each ordinary run
-- now touches the sources of projects whose primary contract took effect since
-- its previous read, so they re-post on that run.

create or replace function public.books_touch_sources_for_effective_contracts(p_org_id uuid, p_after date, p_through date)
returns integer language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  project uuid;
  touched integer := 0;
begin
  if p_after is null or p_through is null or p_after >= p_through then return 0; end if;
  for project in
    select distinct contract.project_id from public.contracts contract
    where contract.org_id = p_org_id and contract.parent_contract_id is null and contract.project_id is not null
      and contract.effective_date > p_after and contract.effective_date <= p_through
  loop
    perform public.books_touch_project_sources(p_org_id, project);
    touched := touched + 1;
  end loop;
  return touched;
end;
$$;
revoke all on function public.books_touch_sources_for_effective_contracts(uuid, date, date) from public, anon, authenticated;
grant execute on function public.books_touch_sources_for_effective_contracts(uuid, date, date) to service_role;

-- ==== 20261006250000_books_line_dimension_scope ====
-- Every record a journal line names belongs to the line's company.
--
-- journal_lines_validate_scope already refuses a foreign project, company,
-- account or entry in the line's columns. The ids carried inside `dimensions`
-- (cost code, contract, lot, community, division, invoice, bill, payment) were
-- never checked: a reporting slice could name another company's job, or a record
-- that does not exist. A posted line must now name only its own company's
-- records. A key present with a null value means "none" and is allowed.
-- Reversal lines copy their original's dimensions exactly (the classification
-- trigger enforces that) and are not re-checked, so a historical entry can
-- always be reversed.

create or replace function public.books_validate_line_dimension_scope()
returns trigger language plpgsql security invoker set search_path = pg_catalog, public as $$
declare
  dimension record;
  target regclass;
  reversal uuid;
  found_row boolean;
begin
  if new.dimensions is null or jsonb_typeof(new.dimensions) <> 'object' then return new; end if;
  select reversal_of_entry_id into reversal from public.journal_entries where id = new.entry_id and org_id = new.org_id;
  if reversal is not null then return new; end if;
  if new.dimensions ? 'organization_id' and jsonb_typeof(new.dimensions -> 'organization_id') <> 'null'
    and new.dimensions ->> 'organization_id' is distinct from new.org_id::text then
    raise exception 'Journal line names another company (organization_id); correct the source document before posting' using errcode = 'P0001';
  end if;
  for dimension in select key, value from jsonb_each(new.dimensions)
    where key in ('cost_code_id', 'contract_id', 'lot_id', 'community_id', 'division_id', 'invoice_id', 'bill_id', 'payment_id')
      and jsonb_typeof(value) <> 'null'
  loop
    target := case dimension.key
      when 'cost_code_id' then 'public.cost_codes'::regclass
      when 'contract_id' then 'public.contracts'::regclass
      when 'lot_id' then 'public.lots'::regclass
      when 'community_id' then 'public.communities'::regclass
      when 'division_id' then 'public.divisions'::regclass
      when 'invoice_id' then 'public.invoices'::regclass
      when 'bill_id' then 'public.vendor_bills'::regclass
      when 'payment_id' then 'public.payments'::regclass
    end;
    if jsonb_typeof(dimension.value) <> 'string' or (dimension.value #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'Journal line % is not a record id; correct the source document before posting', dimension.key using errcode = 'P0001';
    end if;
    execute format('select exists (select 1 from %s where id = $1 and org_id = $2)', target)
      into found_row using (dimension.value #>> '{}')::uuid, new.org_id;
    if not found_row then
      raise exception 'Journal line % names a record that is not in this company; correct the source document before posting', dimension.key using errcode = 'P0001';
    end if;
  end loop;
  return new;
end;
$$;
revoke all on function public.books_validate_line_dimension_scope() from public, anon, authenticated;
create trigger books_validate_line_dimension_scope before insert on public.journal_lines
for each row execute function public.books_validate_line_dimension_scope();

-- ==== 20261007010000_books_opening_items_as_documented ====
-- Opening invoices and bills carry what the original document says, nothing made up.
--
-- post_books_opening_batch filled gaps: a number of OPEN-<id>, the cutover date as
-- the document and due date, and the project's client as the customer. Each
-- distorted the subledger that cutover is meant to carry over: invented due
-- dates moved items between aging bands, and an inferred customer could
-- collect from the wrong party. A new opening invoice or bill now needs its
-- original number, date and customer or vendor; a missing due date stays
-- missing and ages as "no due date". createOpeningBalanceBatch reports every
-- gap at once; this function is the backstop. Loans and assets are unchanged.

create or replace function public.post_books_opening_batch(p_org_id uuid,p_batch_id uuid,p_actor_id uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare batch public.opening_balance_batches%rowtype; item record; entity_id uuid; payment_id uuid; entity_kind text; customer uuid; amount bigint; document_number text; document_date date; due_date date; journal_id uuid; policy integer; lines jsonb; cash uuid; interest uuid; accumulated uuid; depreciation uuid; funding uuid; opening_asset_number text; existing_amount bigint;
begin
 select * into batch from public.opening_balance_batches where org_id=p_org_id and id=p_batch_id for update;
 if not found then raise exception 'Opening batch not found'; end if;
 if batch.status='posted' and batch.journal_entry_id is not null then return batch.journal_entry_id; end if;
 if batch.status<>'approved' or batch.digest is null or (select count(distinct approved_by) from public.opening_balance_approvals where org_id=p_org_id and batch_id=p_batch_id and approved_digest=batch.digest)<>2 then raise exception 'Opening batch requires owner and accountant approval'; end if;
 if batch.line_manifest_digest is null or batch.line_manifest_digest<>public.books_opening_manifest(p_org_id,p_batch_id) then raise exception 'Revalidate and reapprove this opening batch with the operational import contract'; end if;
 if (select count(*) from public.opening_balance_lines where org_id=p_org_id and batch_id=p_batch_id)<2 or (select sum(debit_cents-credit_cents) from public.opening_balance_lines where org_id=p_org_id and batch_id=p_batch_id)<>0 then raise exception 'Opening journal must balance'; end if;
 select active_policy_version into policy from public.books_settings where org_id=p_org_id and workspace_enabled and arc_ledger_mode<>'disabled';
 if not found then raise exception 'Books posting is not enabled'; end if;
 -- Cost records precede accumulated-depreciation lines regardless of CSV ordering.
 for item in select l.*,a.code,a.subtype from public.opening_balance_lines l join public.gl_accounts a on a.id=l.account_id and a.org_id=l.org_id where l.org_id=p_org_id and l.batch_id=p_batch_id order by case when a.subtype='fixed_assets' then 0 when a.subtype='accumulated_depreciation' then 2 else 1 end,l.line_no loop
   entity_id:=null; payment_id:=null; entity_kind:=null;
   if item.project_id is not null and not exists(select 1 from public.projects where org_id=p_org_id and id=item.project_id) then raise exception 'Opening project is outside the organization'; end if;
   if item.company_id is not null and not exists(select 1 from public.companies where org_id=p_org_id and id=item.company_id) then raise exception 'Opening company is outside the organization'; end if;
   document_number:=coalesce(nullif(item.details->>'document_number',''),nullif(item.source_entity_id,''),'OPEN-'||left(item.id::text,8));
   document_date:=coalesce((item.details->>'document_date')::date,batch.cutover_date);
   -- No due date stays no due date; aging shows it as such rather than as due at cutover.
   due_date:=(item.details->>'due_date')::date;
   if document_date>batch.cutover_date then raise exception 'Imported documents cannot originate after cutover'; end if;
   if item.details->>'existing_entity_id' is not null then entity_id:=(item.details->>'existing_entity_id')::uuid; end if;
   if item.subledger_type in('ar','deposit') then
     if (item.subledger_type='ar' and item.subtype not in('accounts_receivable','retainage_receivable')) or (item.subledger_type='deposit' and item.subtype<>'customer_deposits') then raise exception 'Receivable and deposit openings require their control accounts'; end if;
     amount:=case when item.subledger_type='ar' then item.debit_cents-item.credit_cents else item.credit_cents-item.debit_cents end;
     if amount<=0 then raise exception 'Import positive outstanding invoices or unapplied deposits; customer credits need a separate supported credit document'; end if;
     customer:=nullif(item.details->>'customer_id','')::uuid;
     if customer is null or not exists(select 1 from public.contacts where org_id=p_org_id and id=customer) then raise exception 'Opening line %: name the customer who owes this item', item.line_no; end if;
     if entity_id is null then
       if nullif(item.details->>'document_number','') is null and nullif(item.source_entity_id,'') is null then raise exception 'Opening line %: give the original invoice number', item.line_no; end if;
       if item.details->>'document_date' is null then raise exception 'Opening line %: give the original invoice date', item.line_no; end if;
       insert into public.invoices(org_id,project_id,invoice_number,title,status,issue_date,due_date,recipient_contact_id,subtotal_cents,total_cents,balance_due_cents,tax_cents,metadata)
       values(p_org_id,item.project_id,document_number,coalesce(item.description,'Imported outstanding balance'),'draft',document_date,due_date,customer,amount,amount,amount,0,jsonb_build_object('invoice_kind',case when item.subledger_type='deposit' then 'earnest_deposit' else 'standard' end,'opening_batch_id',batch.id,'customer_id',customer,'original_document',item.details)) returning id into entity_id;
       insert into public.invoice_lines(org_id,invoice_id,description,quantity,unit,unit_price_cents,metadata) values(p_org_id,entity_id,coalesce(item.description,'Imported outstanding balance'),1,'ea',amount,jsonb_build_object('opening_balance',true));
       update public.invoices set status='sent',subtotal_cents=amount,total_cents=amount,balance_due_cents=amount where org_id=p_org_id and id=entity_id;
     else
       select balance_due_cents into existing_amount from public.invoices where org_id=p_org_id and id=entity_id and recipient_contact_id=customer and project_id is not distinct from item.project_id and balance_due_cents=total_cents and status in('sent','overdue','partial');
       if not found or existing_amount<>amount then raise exception 'Existing invoice must match the exact imported outstanding balance and customer'; end if;
       if exists(select 1 from public.payments where org_id=p_org_id and invoice_id=entity_id and status in('succeeded','completed','paid')) then raise exception 'Previously paid invoice history must be imported as a residual open item'; end if;
     end if;
     entity_kind:=case when item.subledger_type='deposit' then 'deposit_invoice' else 'invoice' end;
     if exists(select 1 from public.accounting_facts where org_id=p_org_id and source_type='invoice' and source_id=entity_id) then raise exception 'An already projected invoice cannot also belong to an opening batch'; end if;
     if item.subtype='retainage_receivable' then
       if not exists(select 1 from public.contracts where org_id=p_org_id and id=nullif(item.details->>'contract_id','')::uuid and project_id=item.project_id) then raise exception 'Retained receivables require their project contract'; end if;
       if item.details->>'existing_entity_id' is not null then raise exception 'Import held retainage as a separate residual document'; end if;
       update public.invoice_lines set unit_price_cents=0 where org_id=p_org_id and invoice_id=entity_id;
       update public.invoices set subtotal_cents=0,total_cents=0,balance_due_cents=0 where org_id=p_org_id and id=entity_id;
       insert into public.retainage(org_id,project_id,contract_id,invoice_id,amount_cents,status,held_at,metadata) values(p_org_id,item.project_id,(item.details->>'contract_id')::uuid,entity_id,amount,'held',document_date::timestamptz,jsonb_build_object('opening_batch_id',batch.id));
     end if;
     if item.subledger_type='deposit' then
       insert into public.payments(org_id,invoice_id,amount_cents,status,method,received_at,metadata) values(p_org_id,entity_id,amount,'succeeded','imported',document_date::timestamptz,jsonb_build_object('opening_batch_id',batch.id)) returning id into payment_id;
       update public.invoices set balance_due_cents=0,status='paid' where org_id=p_org_id and id=entity_id;
     end if;
   elsif item.subledger_type='ap' then
     if item.subtype not in('accounts_payable','retainage_payable') then raise exception 'AP open items require the accounts-payable control account'; end if;
     amount:=item.credit_cents-item.debit_cents;
     if amount<=0 or item.company_id is null or item.project_id is null then raise exception 'AP openings require a positive unpaid balance, vendor and project'; end if;
     if entity_id is null then
       if nullif(item.details->>'document_number','') is null and nullif(item.source_entity_id,'') is null then raise exception 'Opening line %: give the vendor''s bill number', item.line_no; end if;
       if item.details->>'document_date' is null then raise exception 'Opening line %: give the original bill date', item.line_no; end if;
       insert into public.vendor_bills(org_id,project_id,company_id,bill_number,bill_date,due_date,total_cents,paid_cents,retainage_cents,status,metadata)
       values(p_org_id,item.project_id,item.company_id,document_number,document_date,due_date,amount,0,0,'approved',jsonb_build_object('opening_batch_id',batch.id,'original_document',item.details)) returning id into entity_id;
       insert into public.bill_lines(org_id,bill_id,description,quantity,unit_cost_cents) values(p_org_id,entity_id,coalesce(item.description,'Imported unpaid balance'),1,amount);
     else
       select total_cents into existing_amount from public.vendor_bills where org_id=p_org_id and id=entity_id and company_id=item.company_id and project_id=item.project_id and paid_cents=0 and coalesce(retainage_cents,0)=0 and status in('approved','payable');
       if not found or existing_amount<>amount then raise exception 'Existing payable must match the imported unpaid amount, vendor and project'; end if;
     end if;
     if item.subtype='retainage_payable' then
       if item.details->>'existing_entity_id' is not null then raise exception 'Import held payable retainage as a separate residual document'; end if;
       update public.vendor_bills set retainage_cents=amount where org_id=p_org_id and id=entity_id;
     end if;
     entity_kind:='vendor_bill';
     if exists(select 1 from public.accounting_facts where org_id=p_org_id and source_type='vendor_bill' and source_id=entity_id) then raise exception 'An already projected payable cannot also belong to an opening batch'; end if;
   elsif item.subledger_type in('bank','credit_card') then
     if entity_id is null then raise exception 'Create or select the native bank/card account before importing its opening balance'; end if;
     if not exists(select 1 from public.bank_accounts where org_id=p_org_id and id=entity_id and gl_account_id=item.account_id) then raise exception 'Opening bank/card account must map to this control account'; end if;
     entity_kind:='bank_account';
     -- A check or deposit uncleared at cutover rides on the account's opening as
     -- its own line; the statement-balance line remains the account's one owner.
     if item.details->>'bank_opening_role'='outstanding_item' then
       if nullif(btrim(item.details->>'reference'),'') is null then raise exception 'An outstanding bank item needs its check or deposit reference'; end if;
       entity_id:=null; entity_kind:=null;
     elsif item.details ? 'bank_opening_role' then raise exception 'Unknown bank opening role';
     end if;
   elsif item.subledger_type='loan' then
     amount:=item.credit_cents-item.debit_cents;
     if amount<=0 or item.subtype not in('current_debt','long_term_debt') then raise exception 'Loan opening must credit a debt account'; end if;
     if entity_id is null then
       cash:=nullif(item.details->>'cash_account_id','')::uuid; interest:=nullif(item.details->>'interest_account_id','')::uuid;
       if not exists(select 1 from public.gl_accounts where org_id=p_org_id and id=cash and subtype='cash' and active) or not exists(select 1 from public.gl_accounts where org_id=p_org_id and id=interest and subtype='interest' and active) then raise exception 'Select the native repayment bank and interest accounts for the loan'; end if;
       insert into public.books_debt_instruments(org_id,name,liability_account_id,cash_account_id,interest_expense_account_id,opened_on,maturity_on,original_principal_cents,annual_interest_bps,payment_frequency,created_by)
       values(p_org_id,coalesce(item.description,document_number),item.account_id,cash,interest,document_date,(item.details->>'maturity_on')::date,amount,coalesce((item.details->>'annual_interest_bps')::integer,0),coalesce(item.details->>'payment_frequency','monthly'),p_actor_id) returning id into entity_id;
     else
       if not exists(select 1 from public.books_debt_instruments where org_id=p_org_id and id=entity_id and liability_account_id=item.account_id and original_principal_cents=amount) or exists(select 1 from public.books_debt_events where org_id=p_org_id and instrument_id=entity_id) then raise exception 'Opening loan must match a register with no posted history'; end if;
     end if;
     entity_kind:='debt_instrument';
   elsif item.subledger_type='fixed_asset' then
     opening_asset_number:=coalesce(nullif(item.details->>'asset_number',''),document_number);
     if item.subtype='fixed_assets' then
       amount:=item.debit_cents-item.credit_cents;
       if amount<=0 then raise exception 'Asset cost opening must be a debit'; end if;
       if entity_id is null then
         accumulated:=nullif(item.details->>'accumulated_depreciation_account_id','')::uuid; depreciation:=nullif(item.details->>'depreciation_expense_account_id','')::uuid; funding:=nullif(item.details->>'funding_account_id','')::uuid;
         if not exists(select 1 from public.gl_accounts where org_id=p_org_id and id=accumulated and subtype='accumulated_depreciation') or not exists(select 1 from public.gl_accounts where org_id=p_org_id and id=depreciation and subtype='depreciation') or not exists(select 1 from public.gl_accounts where org_id=p_org_id and id=funding and subtype in('cash','accounts_payable','current_debt','long_term_debt','owner_contributions','owner_equity')) then raise exception 'Asset register accounts must belong to this organization and match their roles'; end if;
         insert into public.books_fixed_assets(org_id,asset_number,name,project_id,placed_in_service_on,acquisition_cost_cents,salvage_value_cents,useful_life_months,asset_account_id,accumulated_depreciation_account_id,depreciation_expense_account_id,funding_account_id,opening_as_of,created_by)
         values(p_org_id,opening_asset_number,coalesce(item.description,opening_asset_number),item.project_id,coalesce((item.details->>'placed_in_service_on')::date,document_date),amount,coalesce((item.details->>'salvage_value_cents')::bigint,0),(item.details->>'useful_life_months')::integer,item.account_id,accumulated,depreciation,funding,batch.cutover_date,p_actor_id) returning id into entity_id;
       else
         if not exists(select 1 from public.books_fixed_assets where org_id=p_org_id and id=entity_id and acquisition_cost_cents=amount and asset_account_id=item.account_id) or exists(select 1 from public.books_fixed_asset_events where org_id=p_org_id and asset_id=entity_id) then raise exception 'Opening asset must match a register with no posted history'; end if;
         update public.books_fixed_assets set opening_as_of=batch.cutover_date where org_id=p_org_id and id=entity_id;
       end if;
       entity_kind:='fixed_asset';
     elsif item.subtype='accumulated_depreciation' then
       amount:=item.credit_cents-item.debit_cents;
       if amount<=0 then raise exception 'Accumulated depreciation opening must be a credit'; end if;
       if entity_id is null then select id into entity_id from public.books_fixed_assets a where a.org_id=p_org_id and a.asset_number=opening_asset_number; end if;
       if entity_id is null or not exists(select 1 from public.opening_balance_lines where org_id=p_org_id and batch_id=p_batch_id and operational_entity_type='fixed_asset' and operational_entity_id=entity_id) then raise exception 'Import this asset cost in the same batch before its accumulated depreciation'; end if;
       if not exists(select 1 from public.books_fixed_assets where org_id=p_org_id and id=entity_id and accumulated_depreciation_account_id=item.account_id and acquisition_cost_cents-salvage_value_cents>=amount) then raise exception 'Accumulated depreciation exceeds depreciable cost or uses the wrong account'; end if;
       update public.books_fixed_assets set opening_accumulated_depreciation_cents=amount where org_id=p_org_id and id=entity_id;
       entity_kind:='fixed_asset_depreciation';
     else raise exception 'Fixed-asset opening requires cost or accumulated-depreciation accounts'; end if;
   elsif item.subtype in('cash','credit_card','accounts_receivable','accounts_payable','customer_deposits','current_debt','long_term_debt','fixed_assets','accumulated_depreciation','retainage_receivable','retainage_payable') then
     raise exception 'Control accounts require an operational opening subledger type';
   end if;
   if entity_id is not null then
     update public.opening_balance_lines set operational_entity_type=entity_kind,operational_entity_id=entity_id,operational_payment_id=payment_id where org_id=p_org_id and id=item.id;
   end if;
 end loop;
 select jsonb_agg(jsonb_build_object('line_no',line_no,'account_id',account_id,'project_id',project_id,'company_id',company_id,'description',description,'debit_cents',debit_cents,'credit_cents',credit_cents,'dimensions',details||jsonb_build_object('opening_line_id',id)) order by line_no) into lines from public.opening_balance_lines where org_id=p_org_id and batch_id=p_batch_id;
 journal_id:=public.post_books_journal_entry(p_org_id,jsonb_build_object('entry_date',batch.cutover_date,'entry_kind','opening','memo','Opening balances at '||batch.cutover_date,'posting_key','opening:'||batch.id||':'||batch.digest,'projection_version',1,'policy_version',policy,'source_type','opening_balance_batch','source_id',batch.id,'created_by',p_actor_id),lines);
 update public.opening_balance_batches set status='posted',journal_entry_id=journal_id,posted_at=now(),updated_at=now() where org_id=p_org_id and id=p_batch_id;
 return journal_id;
end;
$$;
revoke all on function public.post_books_opening_batch(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.post_books_opening_batch(uuid,uuid,uuid) to service_role;

-- ==== 20261007120000_books_contract_wip_scope ====
-- B04.1: WIP is owned by the contract. A project with one primary contract (or
-- none) keeps one project-scoped WIP position, exactly as before. A project with
-- two or more primary contracts in force at a period end has one position per
-- contract, built only from that contract's costs and billings, so one
-- contract's profit never hides another's loss.
--
-- Ownership is explicit. A cost belongs to a contract when its cost code is on
-- that contract's schedule of values (and on no other), or when a reviewed cost
-- allocation says how it is shared. A billing belongs to the contract it bills.
-- Anything else is reported as unowned in the scope it affects, and preparing that
-- scope is refused with the cure; other projects and contracts are untouched.

alter table public.poc_snapshots add column contract_id uuid references public.contracts(id) on delete restrict;
alter table public.poc_snapshots drop constraint poc_snapshots_org_id_project_id_as_of_inputs_hash_key;
alter table public.poc_snapshots add constraint poc_snapshots_scope_inputs_key
  unique nulls not distinct (org_id, project_id, contract_id, as_of, inputs_hash);
create index poc_snapshots_contract_idx on public.poc_snapshots (contract_id) where contract_id is not null;

-- Primary contracts in force on a date: never chosen by row order.
create or replace function public.books_wip_primary_contracts(p_org_id uuid, p_project_id uuid, p_as_of date)
returns setof uuid language sql stable security definer set search_path = public as $$
  select id from public.contracts
  where org_id = p_org_id and project_id = p_project_id and parent_contract_id is null
    and status in ('active','amended','completed','terminated')
    and (effective_date is null or effective_date <= p_as_of)
  order by id;
$$;
revoke all on function public.books_wip_primary_contracts(uuid,uuid,date) from public, anon, authenticated;
grant execute on function public.books_wip_primary_contracts(uuid,uuid,date) to service_role;

-- A project needs contract-scoped WIP when two or more primary contracts are in force.
create or replace function public.books_wip_contract_scoped(p_org_id uuid, p_project_id uuid, p_as_of date)
returns boolean language sql stable security definer set search_path = public as $$
  select count(*) > 1 from public.books_wip_primary_contracts(p_org_id, p_project_id, p_as_of);
$$;
revoke all on function public.books_wip_contract_scoped(uuid,uuid,date) from public, anon, authenticated;
grant execute on function public.books_wip_contract_scoped(uuid,uuid,date) to service_role;

-- Reviewed shares of one cost code's costs across a project's contracts.
-- Append-only: the latest row for a project and cost code is in force, and the
-- WIP evidence names the row it used, so a later allocation invalidates the review.
create table public.books_wip_cost_allocations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  cost_code_id uuid references public.cost_codes(id) on delete restrict,
  shares jsonb not null check (jsonb_typeof(shares) = 'array' and jsonb_array_length(shares) between 1 and 50),
  note text not null check (length(trim(note)) between 10 and 4000),
  created_by uuid not null references public.app_users(id),
  created_at timestamptz not null default clock_timestamp()
);
create index books_wip_cost_allocations_scope_idx on public.books_wip_cost_allocations (org_id, project_id, cost_code_id, created_at desc);
create index books_wip_cost_allocations_cost_code_idx on public.books_wip_cost_allocations (cost_code_id);
create index books_wip_cost_allocations_created_by_idx on public.books_wip_cost_allocations (created_by);
alter table public.books_wip_cost_allocations enable row level security;
create policy books_wip_cost_allocations_read on public.books_wip_cost_allocations
  for select to authenticated using (public.has_org_permission(org_id, 'books.read'));
grant select on public.books_wip_cost_allocations to authenticated;
create trigger books_wip_cost_allocations_immutable before update or delete on public.books_wip_cost_allocations
  for each row execute function public.books_reject_mutation();

create or replace function public.record_books_wip_cost_allocation(
  p_org_id uuid, p_project_id uuid, p_cost_code_id uuid, p_shares jsonb, p_note text, p_actor_id uuid
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_share jsonb; v_total integer := 0; v_id uuid;
begin
  perform 1 from public.projects where id = p_project_id and org_id = p_org_id for update;
  if not found then raise exception 'Project is outside this organization'; end if;
  if p_actor_id is null or not exists(select 1 from public.app_users where id = p_actor_id) then raise exception 'Cost allocation preparer is required'; end if;
  if length(trim(coalesce(p_note, ''))) < 10 then raise exception 'Explain how these costs are shared between the contracts'; end if;
  if p_cost_code_id is not null and not exists(select 1 from public.cost_codes where id = p_cost_code_id and org_id = p_org_id) then raise exception 'Cost code is outside this organization'; end if;
  if jsonb_typeof(p_shares) is distinct from 'array' or jsonb_array_length(p_shares) = 0 then raise exception 'Give each contract''s share of these costs'; end if;
  for v_share in select value from jsonb_array_elements(p_shares) loop
    if coalesce(v_share->>'basis_points', '') !~ '^[1-9][0-9]{0,4}$' or (v_share->>'basis_points')::integer > 10000 then raise exception 'Each share must be between 0.01%% and 100%%'; end if;
    if not exists(select 1 from public.contracts where id = (v_share->>'contract_id')::uuid and org_id = p_org_id and project_id = p_project_id
      and parent_contract_id is null and status in ('active','amended','completed','terminated')) then
      raise exception 'Costs can only be shared between this project''s contracts';
    end if;
    v_total := v_total + (v_share->>'basis_points')::integer;
  end loop;
  if v_total <> 10000 then raise exception 'The shares must add up to 100%%'; end if;
  if (select count(distinct value->>'contract_id') from jsonb_array_elements(p_shares)) <> jsonb_array_length(p_shares) then raise exception 'Name each contract once'; end if;
  insert into public.books_wip_cost_allocations(org_id, project_id, cost_code_id, shares, note, created_by)
  values (p_org_id, p_project_id, p_cost_code_id,
    (select jsonb_agg(jsonb_build_object('contract_id', (value->>'contract_id')::uuid, 'basis_points', (value->>'basis_points')::integer) order by value->>'contract_id') from jsonb_array_elements(p_shares)),
    trim(p_note), p_actor_id)
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.record_books_wip_cost_allocation(uuid,uuid,uuid,jsonb,text,uuid) from public, anon, authenticated;
grant execute on function public.record_books_wip_cost_allocation(uuid,uuid,uuid,jsonb,text,uuid) to service_role;

-- Which contract owns each cost code's costs on a date: the latest reviewed
-- allocation, or else the one contract whose schedule of values carries the code.
-- A code with no single owner and no allocation has no rows here.
create or replace function public.books_wip_cost_shares(p_org_id uuid, p_project_id uuid, p_as_of date)
returns table(cost_code_id uuid, contract_id uuid, basis_points integer, allocation_id uuid)
language sql stable security definer set search_path = public as $$
  with primary_contracts as (
    select id from public.books_wip_primary_contracts(p_org_id, p_project_id, p_as_of) as c(id)
  ), codes as (
    select distinct c.cost_code_id from public.job_cost_entries c
    where c.org_id = p_org_id and c.project_id = p_project_id and c.status = 'posted' and c.incurred_on <= p_as_of
  ), allocations as (
    select distinct on (a.cost_code_id) a.id, a.cost_code_id, a.shares from public.books_wip_cost_allocations a
    where a.org_id = p_org_id and a.project_id = p_project_id
    order by a.cost_code_id, a.created_at desc, a.id desc
  ), linked as (
    select l.cost_code_id, l.contract_id from public.prime_sov_lines l
      where l.org_id = p_org_id and l.cost_code_id is not null and l.contract_id in (select id from primary_contracts)
    union
    select b.cost_code_id, k.contract_id from public.prime_sov_budget_links k
      join public.budget_lines b on b.id = k.budget_line_id and b.org_id = k.org_id
      where k.org_id = p_org_id and k.project_id = p_project_id and b.cost_code_id is not null and k.contract_id in (select id from primary_contracts)
  ), single_owner as (
    select linked.cost_code_id, min(linked.contract_id::text)::uuid as contract_id from linked
    group by linked.cost_code_id having count(*) = 1
  )
  select codes.cost_code_id, (share->>'contract_id')::uuid, (share->>'basis_points')::integer, a.id
    from codes join allocations a on a.cost_code_id is not distinct from codes.cost_code_id
    cross join lateral jsonb_array_elements(a.shares) share
  union all
  select codes.cost_code_id, s.contract_id, 10000, null::uuid
    from codes join single_owner s on s.cost_code_id = codes.cost_code_id
    where not exists(select 1 from allocations a where a.cost_code_id is not distinct from codes.cost_code_id);
$$;
revoke all on function public.books_wip_cost_shares(uuid,uuid,date) from public, anon, authenticated;
grant execute on function public.books_wip_cost_shares(uuid,uuid,date) to service_role;

-- The contract an invoice bills: its own record, else its pay application or draw.
create or replace function public.books_invoice_contract(p_org_id uuid, p_invoice_id uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select coalesce(
    (select nullif(i.metadata->>'source_contract_id', '')::uuid from public.invoices i where i.org_id = p_org_id and i.id = p_invoice_id),
    (select p.contract_id from public.pay_applications p where p.org_id = p_org_id and p.invoice_id = p_invoice_id order by p.id limit 1),
    (select d.contract_id from public.draw_schedules d where d.org_id = p_org_id and d.invoice_id = p_invoice_id and d.contract_id is not null order by d.id limit 1)
  );
$$;
revoke all on function public.books_invoice_contract(uuid,uuid) from public, anon, authenticated;
grant execute on function public.books_invoice_contract(uuid,uuid) to service_role;

-- Dated evidence for one WIP scope. With no contract it is the project's, byte
-- for byte as before. With a contract: that contract's share of each cost (exact
-- cents, the remainder kept by cumulative rounding), the billings and credits on
-- its invoices, and whatever in the project it cannot tell is its own.
drop function public.books_wip_source_evidence(uuid,uuid,date);
create or replace function public.books_wip_source_evidence(p_org_id uuid, p_project_id uuid, p_as_of date, p_contract_id uuid default null)
returns jsonb language sql stable security definer set search_path = public as $$
  with billings as (
    select i.id, i.issue_date, i.total_cents-coalesce(i.tax_cents,0)+coalesce((select sum(r.amount_cents) from public.retainage r where r.org_id=p_org_id and r.invoice_id=i.id),0) as cents,
      public.books_invoice_contract(p_org_id, i.id) as contract_id
    from public.invoices i where i.org_id=p_org_id and i.project_id=p_project_id and i.issue_date<=p_as_of
      and (i.status in ('sent','partial','paid','overdue') or (i.status='void' and i.metadata->>'voided_at'>=((p_as_of+1)::text||'T00:00:00')))
      and coalesce(i.metadata->>'invoice_kind','') <> 'earnest_deposit'
      and not exists(select 1 from public.retainage r where r.org_id=p_org_id and r.release_invoice_id=i.id)
  ), credits as (
    select a.id, a.effective_date, a.amount_cents-coalesce(a.tax_cents,0) as cents, public.books_invoice_contract(p_org_id, a.invoice_id) as contract_id
    from public.receivable_adjustments a where a.org_id=p_org_id and a.project_id=p_project_id and a.adjustment_type='credit_memo' and a.effective_date<=p_as_of
      and (a.status='posted' or a.voided_at>=((p_as_of+1)::timestamp at time zone 'UTC'))
  ), costs as (
    select c.id, c.incurred_on, c.cost_cents, c.cost_code_id from public.job_cost_entries c
    where c.org_id=p_org_id and c.project_id=p_project_id and c.status='posted' and c.incurred_on<=p_as_of
  ), shares as (
    select s.*, sum(s.basis_points) over (partition by s.cost_code_id order by s.contract_id) as cumulative
    from public.books_wip_cost_shares(p_org_id, p_project_id, p_as_of) s
  ), contract_costs as (
    select costs.id, costs.incurred_on, shares.basis_points, shares.allocation_id,
      (round(costs.cost_cents::numeric*shares.cumulative/10000) - round(costs.cost_cents::numeric*(shares.cumulative-shares.basis_points)/10000))::bigint as cents
    from costs join shares on shares.cost_code_id is not distinct from costs.cost_code_id and shares.contract_id = p_contract_id
  ), linked as (
    select l.cost_code_id, l.contract_id from public.prime_sov_lines l where l.org_id=p_org_id and l.cost_code_id is not null
      and l.contract_id in (select id from public.books_wip_primary_contracts(p_org_id, p_project_id, p_as_of) as c(id))
    union
    select b.cost_code_id, k.contract_id from public.prime_sov_budget_links k join public.budget_lines b on b.id=k.budget_line_id and b.org_id=k.org_id
      where k.org_id=p_org_id and k.project_id=p_project_id and b.cost_code_id is not null
        and k.contract_id in (select id from public.books_wip_primary_contracts(p_org_id, p_project_id, p_as_of) as c(id))
  ), unowned_codes as (
    -- Costs with no owner affect every contract; costs shared without an allocation, the contracts sharing them.
    select costs.cost_code_id, sum(costs.cost_cents)::bigint as cents,
      coalesce((select jsonb_agg(distinct linked.contract_id) from linked where linked.cost_code_id = costs.cost_code_id), '[]'::jsonb) as contracts
    from costs where not exists(select 1 from shares where shares.cost_code_id is not distinct from costs.cost_code_id)
    group by costs.cost_code_id
  )
  select case when p_contract_id is null then jsonb_build_object(
    'costs',coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'incurredOn',c.incurred_on,'cents',c.cost_cents) order by c.id) from costs c),'[]'::jsonb),
    'billings',coalesce((select jsonb_agg(jsonb_build_object('id',b.id,'issueDate',b.issue_date,'cents',b.cents) order by b.id) from billings b),'[]'::jsonb),
    'credits',coalesce((select jsonb_agg(jsonb_build_object('id',a.id,'effectiveDate',a.effective_date,'cents',a.cents) order by a.id) from credits a),'[]'::jsonb)
  ) else jsonb_build_object(
    'contractId',p_contract_id,
    'costs',coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'incurredOn',c.incurred_on,'cents',c.cents)
      || case when c.basis_points < 10000 then jsonb_build_object('basisPoints',c.basis_points) else '{}'::jsonb end
      || case when c.allocation_id is not null then jsonb_build_object('allocationId',c.allocation_id) else '{}'::jsonb end order by c.id) from contract_costs c),'[]'::jsonb),
    'billings',coalesce((select jsonb_agg(jsonb_build_object('id',b.id,'issueDate',b.issue_date,'cents',b.cents) order by b.id) from billings b where b.contract_id = p_contract_id),'[]'::jsonb),
    'credits',coalesce((select jsonb_agg(jsonb_build_object('id',a.id,'effectiveDate',a.effective_date,'cents',a.cents) order by a.id) from credits a where a.contract_id = p_contract_id),'[]'::jsonb),
    'unowned',jsonb_build_object(
      'costCodes',coalesce((select jsonb_agg(jsonb_build_object('costCodeId',u.cost_code_id,'cents',u.cents,'contracts',u.contracts) order by u.cost_code_id nulls first) from unowned_codes u
        where jsonb_array_length(u.contracts) < 2 or u.contracts ? p_contract_id::text),'[]'::jsonb),
      'billings',coalesce((select jsonb_agg(b.id order by b.id) from billings b where b.contract_id is null or b.contract_id not in (select id from public.books_wip_primary_contracts(p_org_id, p_project_id, p_as_of) as c(id))),'[]'::jsonb)
    )
  ) end;
$$;
revoke all on function public.books_wip_source_evidence(uuid,uuid,date,uuid) from public, anon, authenticated;
grant execute on function public.books_wip_source_evidence(uuid,uuid,date,uuid) to service_role;

-- A snapshot's scope must match the project's contracts on its date.
drop function public.books_assert_loss_wip_supported(uuid,uuid);
drop function public.books_assert_single_contract_wip(uuid,uuid);
create or replace function public.books_assert_wip_scope(p_org_id uuid, p_project_id uuid, p_contract_id uuid, p_as_of date)
returns void language plpgsql security definer set search_path = public as $$
begin
  if public.books_wip_contract_scoped(p_org_id, p_project_id, p_as_of) then
    if p_contract_id is null then raise exception 'This project has more than one contract; prepare WIP for each contract'; end if;
    if p_contract_id not in (select id from public.books_wip_primary_contracts(p_org_id, p_project_id, p_as_of) as c(id)) then
      raise exception 'WIP contract is not one of the project''s contracts in force on %', p_as_of;
    end if;
  elsif p_contract_id is not null then
    raise exception 'This project has one contract; its WIP is prepared for the project';
  end if;
end;
$$;
revoke all on function public.books_assert_wip_scope(uuid,uuid,uuid,date) from public, anon, authenticated;
grant execute on function public.books_assert_wip_scope(uuid,uuid,uuid,date) to service_role;

create or replace function public.books_assert_loss_wip_supported(p_org_id uuid, p_snapshot_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_snapshot public.poc_snapshots%rowtype;
begin
  select * into v_snapshot from public.poc_snapshots where org_id=p_org_id and id=p_snapshot_id;
  if not found then raise exception 'WIP snapshot not found'; end if;
  perform public.books_assert_wip_scope(p_org_id, v_snapshot.project_id, v_snapshot.contract_id, v_snapshot.as_of);
  if v_snapshot.eac_cents>v_snapshot.revised_contract_cents and exists(
    select 1 from public.journal_lines l join public.journal_entries e on e.id=l.entry_id and e.org_id=l.org_id
    join public.gl_accounts a on a.id=l.account_id and a.org_id=l.org_id
    where l.org_id=p_org_id and l.project_id=v_snapshot.project_id and a.code in ('1120','1130','1160','1170') and e.status in ('posted','reversed') and e.entry_date<=v_snapshot.as_of
    group by l.account_id having sum(l.debit_cents-l.credit_cents)<>0
  ) then raise exception 'Capitalized construction costs require impairment review before a loss provision'; end if;
  if exists(select 1 from public.gl_accounts where org_id=p_org_id and (
    (code='2360' and (account_type<>'liability' or subtype<>'expected_contract_loss_reserve' or normal_balance<>'credit' or not active)) or
    (code='5060' and (account_type<>'cogs' or subtype<>'expected_contract_loss_expense' or normal_balance<>'debit' or not active))
  )) then raise exception 'Expected-loss account codes conflict with the organization chart'; end if;
end;
$$;
revoke all on function public.books_assert_loss_wip_supported(uuid,uuid) from public, anon, authenticated;
grant execute on function public.books_assert_loss_wip_supported(uuid,uuid) to service_role;

-- The cure for an unowned scope, named by cost code and invoice number.
create or replace function public.books_wip_unowned_message(p_org_id uuid, p_sources jsonb)
returns text language sql stable security definer set search_path = public as $$
  select concat_ws(' ',
    case when jsonb_array_length(coalesce(p_sources->'unowned'->'costCodes','[]'))>0 then
      'Costs under ' || (select string_agg(coalesce(cc.code, 'no cost code'), ', ' order by cc.code nulls first)
        from jsonb_array_elements(p_sources->'unowned'->'costCodes') u left join public.cost_codes cc on cc.org_id=p_org_id and cc.id=(u->>'costCodeId')::uuid)
      || ' do not belong to one contract: put each code on one contract''s schedule of values, or record how its costs are shared.' end,
    case when jsonb_array_length(coalesce(p_sources->'unowned'->'billings','[]'))>0 then
      'Invoices ' || (select string_agg(coalesce(i.invoice_number, i.id::text), ', ' order by i.invoice_number)
        from jsonb_array_elements_text(p_sources->'unowned'->'billings') b(id) join public.invoices i on i.org_id=p_org_id and i.id=b.id::uuid)
      || ' do not say which contract they bill: assign each to its contract.' end);
$$;
revoke all on function public.books_wip_unowned_message(uuid,jsonb) from public, anon, authenticated;
grant execute on function public.books_wip_unowned_message(uuid,jsonb) to service_role;

drop function public.prepare_books_wip_atomic(uuid,uuid,uuid,uuid,bigint,bigint,bigint,text);
create or replace function public.prepare_books_wip_atomic(
  p_org_id uuid,p_period_id uuid,p_project_id uuid,p_actor_id uuid,
  p_original_cents bigint,p_change_orders_cents bigint,p_eac_cents bigint,p_note text,p_contract_id uuid default null
) returns uuid language plpgsql security definer set search_path=public as $$
declare
  v_period public.accounting_periods%rowtype;
  v_sources jsonb;
  v_cost bigint;
  v_billed bigint;
  v_contract bigint;
  v_earned bigint;
  v_ratio numeric;
  v_hash text;
  v_basis jsonb;
  v_id uuid;
  v_preparation jsonb;
  v_prior public.poc_snapshots%rowtype;
  v_unowned text;
begin
  select * into v_period from public.accounting_periods where id=p_period_id and org_id=p_org_id for update;
  if not found then raise exception 'Accounting period not found'; end if;
  if v_period.status not in ('open','reopened') then raise exception 'Reopen the period before preparing WIP'; end if;
  if v_period.period_end > (now() at time zone 'UTC')::date then raise exception 'Cannot prepare future period-end WIP'; end if;
  if not exists(select 1 from public.projects where id=p_project_id and org_id=p_org_id) then raise exception 'Project is outside this organization'; end if;
  perform public.books_assert_wip_scope(p_org_id,p_project_id,p_contract_id,v_period.period_end);
  if p_actor_id is null or not exists(select 1 from public.app_users where id=p_actor_id) then raise exception 'WIP preparer is required'; end if;
  if length(trim(coalesce(p_note,''))) < 10 then raise exception 'Explain the period-end contract and estimate basis'; end if;
  if p_original_cents is null or p_change_orders_cents is null or p_eac_cents is null or p_original_cents < 0 or p_eac_cents <= 0 then raise exception 'Valid period-end contract and EAC are required'; end if;
  v_contract := p_original_cents+p_change_orders_cents;
  if v_contract <= 0 then raise exception 'Revised contract value must be positive'; end if;
  v_sources := public.books_wip_source_evidence(p_org_id,p_project_id,v_period.period_end,p_contract_id);
  v_unowned := public.books_wip_unowned_message(p_org_id,v_sources);
  if v_unowned <> '' then raise exception '%', v_unowned; end if;
  select coalesce(sum((value->>'cents')::bigint),0) into v_cost from jsonb_array_elements(v_sources->'costs');
  select coalesce(sum((value->>'cents')::bigint),0) into v_billed from jsonb_array_elements(v_sources->'billings');
  v_billed := v_billed-(select coalesce(sum((value->>'cents')::bigint),0) from jsonb_array_elements(v_sources->'credits'));
  if v_cost<0 then raise exception 'Negative cumulative cost requires correction before WIP preparation'; end if;
  if p_eac_cents<v_cost then raise exception 'EAC cannot be below incurred cost'; end if;
  if greatest(abs(v_cost),abs(v_billed),abs(v_contract),abs(p_eac_cents),abs(p_original_cents),abs(p_change_orders_cents))>9007199254740991 then raise exception 'WIP amounts exceed safe integer cents'; end if;
  v_ratio := least(1::numeric,v_cost::numeric/p_eac_cents);
  v_earned := div(v_contract::numeric*v_cost*2+p_eac_cents,p_eac_cents::numeric*2);
  if abs(v_billed::numeric-v_earned)>9007199254740991 then raise exception 'WIP over-under exceeds safe integer cents'; end if;
  v_preparation := jsonb_build_object('calculationVersion',2,'kind','period_prepared','periodId',p_period_id,'preparedBy',p_actor_id,'preparedAt',now(),'note',trim(p_note),'sources',v_sources);
  -- The project-scope basis is unchanged so earlier snapshots keep their hashes.
  v_basis := jsonb_build_object('calculationVersion',2,'asOf',v_period.period_end,'original',p_original_cents,'changes',p_change_orders_cents,'eac',p_eac_cents,'sources',v_sources,'note',trim(p_note));
  if p_contract_id is not null then v_basis := v_basis || jsonb_build_object('contractId',p_contract_id); end if;
  v_hash := encode(sha256(convert_to(v_basis::text,'UTF8')),'hex');
  select * into v_prior from public.poc_snapshots where org_id=p_org_id and project_id=p_project_id and contract_id is not distinct from p_contract_id and as_of=v_period.period_end order by created_at desc,id desc limit 1;
  if found and v_prior.preparation->>'basisHash'=v_hash and v_prior.earned_revenue_cents=v_earned and v_prior.billed_cents=v_billed and v_prior.cost_to_date_cents=v_cost then return v_prior.id; end if;
  v_preparation := v_preparation || jsonb_build_object('basisHash',v_hash,'priorSnapshotId',v_prior.id);
  v_hash := encode(sha256(convert_to(v_hash||coalesce(v_prior.id::text,''),'UTF8')),'hex');
  insert into public.poc_snapshots(org_id,project_id,contract_id,as_of,original_contract_cents,approved_change_orders_cents,revised_contract_cents,cost_to_date_cents,eac_cents,percent_complete,earned_revenue_cents,billed_cents,over_under_cents,forecast_gross_profit_cents,inputs_hash,warnings,preparation,created_at)
  values(p_org_id,p_project_id,p_contract_id,v_period.period_end,p_original_cents,p_change_orders_cents,v_contract,v_cost,p_eac_cents,round(v_ratio,5),v_earned,v_billed,v_billed-v_earned,v_contract-p_eac_cents,v_hash,'[]',v_preparation,greatest(clock_timestamp(),v_prior.created_at+interval '1 microsecond'))
  on conflict(org_id,project_id,contract_id,as_of,inputs_hash) do nothing returning id into v_id;
  if v_id is null then select id into v_id from public.poc_snapshots where org_id=p_org_id and project_id=p_project_id and contract_id is not distinct from p_contract_id and as_of=v_period.period_end and inputs_hash=v_hash; end if;
  return v_id;
end;
$$;
revoke all on function public.prepare_books_wip_atomic(uuid,uuid,uuid,uuid,bigint,bigint,bigint,text,uuid) from public,anon,authenticated;
grant execute on function public.prepare_books_wip_atomic(uuid,uuid,uuid,uuid,bigint,bigint,bigint,text,uuid) to service_role;

drop function public.carry_forward_books_wip_atomic(uuid,uuid,uuid,uuid,text);
create or replace function public.carry_forward_books_wip_atomic(p_org_id uuid,p_period_id uuid,p_project_id uuid,p_actor_id uuid,p_note text,p_contract_id uuid default null)
returns uuid language plpgsql security definer set search_path=public as $$
declare
  v_target public.accounting_periods%rowtype;
  v_prior public.poc_snapshots%rowtype;
  v_prior_period uuid;
  v_sources jsonb;
  v_latest public.poc_snapshots%rowtype;
  v_basis text;
  v_hash text;
  v_id uuid;
begin
  select * into v_target from public.accounting_periods where id=p_period_id and org_id=p_org_id for update;
  if not found then raise exception 'Accounting period not found'; end if;
  if v_target.status not in ('open','reopened') then raise exception 'Reopen the period before carrying WIP forward'; end if;
  if v_target.period_end>(now() at time zone 'UTC')::date then raise exception 'Cannot carry WIP into a future period end'; end if;
  if p_actor_id is null or not exists(select 1 from public.app_users where id=p_actor_id) then raise exception 'WIP preparer is required'; end if;
  if not exists(select 1 from public.projects where id=p_project_id and org_id=p_org_id and status='completed') then raise exception 'Only completed projects can carry a final WIP estimate forward'; end if;
  perform public.books_assert_wip_scope(p_org_id,p_project_id,p_contract_id,v_target.period_end);
  if length(trim(coalesce(p_note,'')))<10 then raise exception 'Confirm why the final contract and estimate remain unchanged'; end if;
  select s.* into v_prior from public.poc_snapshots s
    join public.accounting_periods p on p.org_id=s.org_id and p.period_end=s.as_of and p.status='closed'
    join public.books_close_items c on c.period_id=p.id and c.org_id=p.org_id and c.code='poc_snapshots'
    where s.org_id=p_org_id and s.project_id=p_project_id and s.contract_id is not distinct from p_contract_id and s.as_of<v_target.period_end
      and s.preparation->>'kind'='period_prepared'
      and exists(select 1 from jsonb_array_elements(coalesce(c.support_review->'snapshots','[]'::jsonb)) e where e->>'snapshotId'=s.id::text and e->>'inputsHash'=s.inputs_hash)
    order by s.as_of desc,s.created_at desc,s.id desc limit 1;
  if not found then raise exception 'No approved closed-period WIP position is available'; end if;
  select id into v_prior_period from public.accounting_periods where org_id=p_org_id and period_end=v_prior.as_of and status='closed' for share;
  if not found then raise exception 'Prior accounting period was reopened; review its corrected WIP first'; end if;
  if v_prior.eac_cents<=0 or v_prior.revised_contract_cents<=0 or v_prior.cost_to_date_cents<>v_prior.eac_cents or v_prior.earned_revenue_cents<>v_prior.revised_contract_cents then raise exception 'Prior WIP is not a fully earned final estimate'; end if;
  v_sources:=public.books_wip_source_evidence(p_org_id,p_project_id,v_target.period_end,p_contract_id);
  if v_sources is distinct from v_prior.preparation->'sources' then raise exception 'Dated costs or billings changed; prepare a revised period-end estimate'; end if;
  select * into v_latest from public.poc_snapshots where org_id=p_org_id and project_id=p_project_id and contract_id is not distinct from p_contract_id and as_of=v_target.period_end order by created_at desc,id desc limit 1;
  v_basis:=encode(sha256(convert_to(jsonb_build_object('carriedFrom',v_prior.id,'period',p_period_id,'note',trim(p_note))::text,'UTF8')),'hex');
  if found and v_latest.preparation->>'basisHash'=v_basis then return v_latest.id; end if;
  v_hash:=encode(sha256(convert_to(v_basis||coalesce(v_latest.id::text,''),'UTF8')),'hex');
  insert into public.poc_snapshots(org_id,project_id,contract_id,as_of,original_contract_cents,approved_change_orders_cents,revised_contract_cents,cost_to_date_cents,eac_cents,percent_complete,earned_revenue_cents,billed_cents,over_under_cents,forecast_gross_profit_cents,inputs_hash,warnings,preparation,created_at)
  values(p_org_id,p_project_id,p_contract_id,v_target.period_end,v_prior.original_contract_cents,v_prior.approved_change_orders_cents,v_prior.revised_contract_cents,v_prior.cost_to_date_cents,v_prior.eac_cents,1,v_prior.earned_revenue_cents,v_prior.billed_cents,v_prior.over_under_cents,v_prior.forecast_gross_profit_cents,v_hash,v_prior.warnings,
    jsonb_build_object('kind','period_prepared','periodId',p_period_id,'preparedBy',p_actor_id,'preparedAt',now(),'note','Carryforward of approved snapshot '||v_prior.id::text||' from '||v_prior.as_of::text||'. Confirmed unchanged: '||trim(p_note),'sources',v_sources,'basisHash',v_basis,'priorSnapshotId',v_latest.id,'carriedFromSnapshotId',v_prior.id,'carriedFromPeriodId',v_prior_period),
    greatest(clock_timestamp(),v_latest.created_at+interval '1 microsecond')) returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.carry_forward_books_wip_atomic(uuid,uuid,uuid,uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.carry_forward_books_wip_atomic(uuid,uuid,uuid,uuid,text,uuid) to service_role;

create or replace function public.books_wip_financial_sources_current(p_org_id uuid,p_snapshot_ids uuid[])
returns boolean language sql stable security definer set search_path=public as $$
  select not exists(
    select 1 from unnest(p_snapshot_ids) requested(id)
    left join public.poc_snapshots s on s.id=requested.id and s.org_id=p_org_id
    where s.id is null or s.eac_cents<=0 or s.cost_to_date_cents<0 or s.cost_to_date_cents>s.eac_cents or s.revised_contract_cents<=0
      or s.earned_revenue_cents is distinct from case when s.eac_cents>0 then div(s.revised_contract_cents::numeric*s.cost_to_date_cents*2+s.eac_cents,s.eac_cents::numeric*2)::bigint end
      or s.over_under_cents::numeric is distinct from s.billed_cents::numeric-s.earned_revenue_cents
      or s.forecast_gross_profit_cents::numeric is distinct from s.revised_contract_cents::numeric-s.eac_cents
      or s.preparation->>'kind' is distinct from 'period_prepared'
      or s.preparation->'sources' is distinct from public.books_wip_source_evidence(p_org_id,s.project_id,s.as_of,s.contract_id)
      or public.books_wip_contract_scoped(p_org_id,s.project_id,s.as_of) is distinct from (s.contract_id is not null)
  );
$$;

create or replace function public.books_wip_sources_current(p_org_id uuid,p_snapshot_ids uuid[])
returns boolean language sql stable security definer set search_path=public as $$
  select public.books_wip_financial_sources_current(p_org_id,p_snapshot_ids) and not exists(
    select 1 from public.poc_snapshots s where s.org_id=p_org_id and s.id=any(p_snapshot_ids)
      and s.preparation->>'revenueAllocationRequired'='true' and jsonb_array_length(s.revenue_allocations)=0
  ) and not exists(
    select 1 from public.poc_snapshots s cross join lateral jsonb_array_elements(s.revenue_allocations) allocation
    left join public.gl_accounts a on a.id=(allocation->>'account_id')::uuid and a.org_id=s.org_id
    where s.org_id=p_org_id and s.id=any(p_snapshot_ids) and (
      a.id is null or not a.active or a.account_type<>'income' or a.code is distinct from allocation->>'account_code'
      or (allocation->>'cost_code_id' is not null and not exists(select 1 from public.cost_codes c where c.org_id=s.org_id and c.id=(allocation->>'cost_code_id')::uuid))
      or (allocation->>'contract_id' is not null and not exists(select 1 from public.contracts c where c.org_id=s.org_id and c.project_id=s.project_id and c.id=(allocation->>'contract_id')::uuid))
      or (s.contract_id is not null and allocation->>'contract_id' is distinct from s.contract_id::text)
    )
  );
$$;

create or replace function public.review_books_wip_atomic(p_org_id uuid, p_period_id uuid, p_actor_id uuid, p_review jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_period public.accounting_periods%rowtype;
  v_item jsonb;
  v_snapshot public.poc_snapshots%rowtype;
  v_latest uuid;
  v_review jsonb;
begin
  select * into v_period from public.accounting_periods where id=p_period_id and org_id=p_org_id for update;
  if not found then raise exception 'Accounting period not found'; end if;
  if v_period.status not in ('open','reopened') then raise exception 'Reopen the period before reviewing WIP'; end if;
  if p_actor_id is null or not exists(select 1 from public.app_users where id=p_actor_id) then raise exception 'WIP reviewer is required'; end if;
  if jsonb_typeof(p_review->'snapshots') is distinct from 'array' or length(trim(coalesce(p_review->>'note',''))) < 10 then raise exception 'WIP evidence and review explanation are required'; end if;
  if jsonb_array_length(p_review->'snapshots')=0 then raise exception 'WIP review has no projects'; end if;
  if (select count(*) from jsonb_array_elements(p_review->'snapshots')) <> (select count(distinct (value->>'projectId', coalesce(value->>'contractId',''))) from jsonb_array_elements(p_review->'snapshots')) then raise exception 'Duplicate WIP project evidence'; end if;
  for v_item in select value from jsonb_array_elements(p_review->'snapshots') loop
    select * into v_snapshot from public.poc_snapshots
      where id=(v_item->>'snapshotId')::uuid and org_id=p_org_id and project_id=(v_item->>'projectId')::uuid
        and contract_id is not distinct from nullif(v_item->>'contractId','')::uuid;
    if not found then raise exception 'WIP snapshot is outside this organization, project or contract'; end if;
    perform public.books_assert_loss_wip_supported(p_org_id,v_snapshot.id);
    if v_snapshot.as_of <> v_period.period_end or (v_item->>'asOf')::date is distinct from v_snapshot.as_of
      or v_snapshot.inputs_hash is distinct from v_item->>'inputsHash'
      or v_snapshot.earned_revenue_cents is distinct from (v_item->>'earnedRevenueCents')::bigint then
      raise exception 'WIP snapshot evidence changed';
    end if;
    if not public.books_wip_sources_current(p_org_id,array[v_snapshot.id]) then raise exception 'WIP source evidence changed or needs period preparation'; end if;
    if v_snapshot.warnings ?| array['missing_contract_value','missing_eac','negative_actual_cost','missing_budget','eac_below_actual_cost'] then raise exception 'WIP inputs require correction before approval'; end if;
    select id into v_latest from public.poc_snapshots where org_id=p_org_id and project_id=v_snapshot.project_id and contract_id is not distinct from v_snapshot.contract_id and as_of=v_period.period_end order by created_at desc,id desc limit 1;
    if v_latest <> v_snapshot.id then raise exception 'WIP snapshot superseded; reload before reviewing'; end if;
  end loop;
  v_review := p_review || jsonb_build_object('reviewerId',p_actor_id,'reviewedAt',now());
  insert into public.books_close_items(org_id,period_id,code,label,category,blocking,status,support_review,acknowledged_by,acknowledged_at)
    values(p_org_id,p_period_id,'poc_snapshots','WIP reviewed through period end','construction',true,'pending',v_review,p_actor_id,now())
    on conflict(period_id,code) do update set support_review=excluded.support_review,acknowledged_by=excluded.acknowledged_by,acknowledged_at=excluded.acknowledged_at,updated_at=now();
  return v_review;
end;
$$;

-- Revenue allocation inside a contract scope stays inside that contract.
create or replace function public.books_validate_wip_revenue_allocations()
returns trigger language plpgsql security definer set search_path=public as $$
declare v_row jsonb; v_total numeric:=0; v_account public.gl_accounts%rowtype; v_prior public.poc_snapshots%rowtype;
begin
  if new.preparation->>'carriedFromSnapshotId' is not null then
    select * into v_prior from public.poc_snapshots where id=(new.preparation->>'carriedFromSnapshotId')::uuid and org_id=new.org_id and project_id=new.project_id and contract_id is not distinct from new.contract_id;
    if not found then raise exception 'Carried WIP allocation evidence is outside the project or contract'; end if;
    new.revenue_allocations:=v_prior.revenue_allocations;
  end if;
  if jsonb_array_length(new.revenue_allocations)=0 and new.preparation->>'priorSnapshotId' is not null then
    select * into v_prior from public.poc_snapshots where id=(new.preparation->>'priorSnapshotId')::uuid and org_id=new.org_id and project_id=new.project_id and contract_id is not distinct from new.contract_id;
    if found and jsonb_array_length(v_prior.revenue_allocations)>0 then
      if v_prior.revised_contract_cents=new.revised_contract_cents then
        new.revenue_allocations:=v_prior.revenue_allocations;
        new.preparation:=new.preparation || jsonb_build_object('revenueAllocationInheritedFrom',v_prior.id,'revenueAllocationNote',v_prior.preparation->'revenueAllocationNote');
      else
        new.preparation:=new.preparation || jsonb_build_object('revenueAllocationRequired',true);
      end if;
    elsif found and v_prior.preparation->>'revenueAllocationRequired'='true' then
      new.preparation:=new.preparation || jsonb_build_object('revenueAllocationRequired',true);
    end if;
  end if;
  if jsonb_array_length(new.revenue_allocations)=0 then return new; end if;
  if jsonb_array_length(new.revenue_allocations)>100 then raise exception 'At most 100 WIP revenue allocations are supported'; end if;
  for v_row in select value from jsonb_array_elements(new.revenue_allocations) loop
    if jsonb_typeof(v_row) is distinct from 'object' or coalesce(v_row->>'contract_cents','') !~ '^[1-9][0-9]*$'
      or (v_row->>'contract_cents')::numeric>9007199254740991 then raise exception 'WIP allocation contract amounts must be positive safe integer cents'; end if;
    select * into v_account from public.gl_accounts where id=(v_row->>'account_id')::uuid and org_id=new.org_id for share;
    if not found or v_account.account_type<>'income' or not v_account.active or v_account.code is distinct from v_row->>'account_code' then raise exception 'WIP revenue allocation requires the current active income account'; end if;
    if v_row->>'cost_code_id' is not null and not exists(select 1 from public.cost_codes where id=(v_row->>'cost_code_id')::uuid and org_id=new.org_id) then raise exception 'WIP revenue cost code is outside the organization'; end if;
    if v_row->>'contract_id' is not null and not exists(select 1 from public.contracts where id=(v_row->>'contract_id')::uuid and org_id=new.org_id and project_id=new.project_id and parent_contract_id is null and status in ('active','amended','completed','terminated')) then raise exception 'WIP revenue contract is outside the primary project scope'; end if;
    if new.contract_id is not null and v_row->>'contract_id' is distinct from new.contract_id::text then raise exception 'A contract''s WIP revenue is allocated within that contract'; end if;
    v_total:=v_total+(v_row->>'contract_cents')::numeric;
  end loop;
  if v_total<>new.revised_contract_cents then raise exception 'Revenue allocation contract amounts must equal the reviewed revised contract'; end if;
  if (select count(*) from jsonb_array_elements(new.revenue_allocations))<>(select count(distinct jsonb_build_array(value->>'account_id',value->>'contract_id',value->>'cost_code_id')) from jsonb_array_elements(new.revenue_allocations)) then raise exception 'Duplicate WIP revenue allocation bucket'; end if;
  return new;
end;
$$;

create or replace function public.allocate_books_wip_revenue_atomic(p_org_id uuid,p_period_id uuid,p_snapshot_id uuid,p_actor_id uuid,p_allocations jsonb,p_note text)
returns uuid language plpgsql security definer set search_path=public as $$
declare v_period public.accounting_periods%rowtype; v_prior public.poc_snapshots%rowtype; v_latest public.poc_snapshots%rowtype; v_next public.poc_snapshots%rowtype; v_hash text; v_allocations jsonb;
begin
  select * into v_period from public.accounting_periods where id=p_period_id and org_id=p_org_id for update;
  if not found or v_period.status not in ('open','reopened') then raise exception 'Reopen the period before allocating WIP revenue'; end if;
  if p_actor_id is null or not exists(select 1 from public.app_users where id=p_actor_id) then raise exception 'Revenue allocation preparer is required'; end if;
  if length(trim(coalesce(p_note,'')))<10 or length(p_note)>4000 then raise exception 'Explain the revenue allocation basis'; end if;
  if jsonb_typeof(p_allocations) is distinct from 'array' or jsonb_array_length(p_allocations)=0 then raise exception 'Revenue allocation evidence is required'; end if;
  select * into v_prior from public.poc_snapshots where id=p_snapshot_id and org_id=p_org_id and as_of=v_period.period_end;
  if not found or not public.books_wip_financial_sources_current(p_org_id,array[p_snapshot_id]) then raise exception 'Current prepared period-end WIP is required'; end if;
  perform 1 from public.projects where id=v_prior.project_id and org_id=p_org_id for update;
  select jsonb_agg(jsonb_build_object('account_id',a.id,'account_code',a.code,'contract_cents',value->'contract_cents','contract_id',value->'contract_id','cost_code_id',value->'cost_code_id') order by value->>'account_id',coalesce(value->>'contract_id',''),coalesce(value->>'cost_code_id','')) into v_allocations
    from jsonb_array_elements(p_allocations) join public.gl_accounts a on a.id=(value->>'account_id')::uuid and a.org_id=p_org_id;
  if jsonb_array_length(coalesce(v_allocations,'[]'))<>jsonb_array_length(p_allocations) then raise exception 'Income account is outside the organization'; end if;
  v_hash:=encode(sha256(convert_to(v_prior.inputs_hash||v_allocations::text||trim(p_note),'UTF8')),'hex');
  select * into v_latest from public.poc_snapshots where org_id=p_org_id and project_id=v_prior.project_id and contract_id is not distinct from v_prior.contract_id and as_of=v_period.period_end order by created_at desc,id desc limit 1;
  if v_latest.preparation->>'revenueAllocationHash'=v_hash then return v_latest.id; end if;
  if v_latest.id<>v_prior.id then raise exception 'WIP snapshot was superseded; reload revenue allocations'; end if;
  v_next:=v_prior;
  v_next.id:=gen_random_uuid(); v_next.inputs_hash:=v_hash; v_next.revenue_allocations:=v_allocations;
  v_next.created_at:=greatest(clock_timestamp(),v_prior.created_at+interval '1 microsecond');
  v_next.preparation:=v_prior.preparation || jsonb_build_object('revenueAllocationRequired',false,'revenueAllocationHash',v_hash,'revenueAllocationNote',trim(p_note),'revenueAllocationPreparedBy',p_actor_id,'revenueAllocationPreparedAt',now(),'priorSnapshotId',v_prior.id);
  v_next.preparation:=v_next.preparation-'carriedFromSnapshotId';
  insert into public.poc_snapshots select (v_next).*;
  return v_next.id;
end;
$$;

-- The loss provision is a contract's own: its revenue, its reserve, never netted.
create or replace function public.post_books_expected_loss_atomic(p_org_id uuid,p_period_id uuid,p_snapshot_id uuid,p_actor_id uuid,p_policy_version integer,p_projection_version integer)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_period public.accounting_periods%rowtype;
  v_snapshot public.poc_snapshots%rowtype;
  v_latest uuid;
  v_total bigint;
  v_incurred bigint;
  v_target bigint;
  v_balance bigint;
  v_delta bigint;
  v_liability uuid;
  v_expense uuid;
  v_revision integer;
  v_entry uuid;
  v_dimensions jsonb;
  v_recognized bigint;
  v_scope text;
begin
  select * into v_period from public.accounting_periods where org_id=p_org_id and id=p_period_id for update;
  if not found or v_period.status<>'reviewing' then raise exception 'Expected-loss posting requires the period close review'; end if;
  select * into v_snapshot from public.poc_snapshots where org_id=p_org_id and id=p_snapshot_id and as_of=v_period.period_end;
  if not found then raise exception 'Exact period-end WIP snapshot is required'; end if;
  perform 1 from public.projects where org_id=p_org_id and id=v_snapshot.project_id for update;
  perform public.books_assert_loss_wip_supported(p_org_id,v_snapshot.id);
  if not public.books_wip_financial_sources_current(p_org_id,array[p_snapshot_id]) then raise exception 'WIP evidence changed before loss provisioning'; end if;
  select id into v_latest from public.poc_snapshots where org_id=p_org_id and project_id=v_snapshot.project_id and contract_id is not distinct from v_snapshot.contract_id and as_of=v_period.period_end order by created_at desc,id desc limit 1;
  if v_latest<>p_snapshot_id then raise exception 'WIP snapshot was superseded'; end if;
  if not exists(select 1 from public.books_close_items c, lateral jsonb_array_elements(coalesce(c.support_review->'snapshots','[]'::jsonb)) e
    where c.org_id=p_org_id and c.period_id=p_period_id and c.code='poc_snapshots' and c.support_review->>'reviewerId' is not null and e->>'snapshotId'=p_snapshot_id::text and e->>'inputsHash'=v_snapshot.inputs_hash) then
    raise exception 'Expected-loss provision requires approved WIP evidence';
  end if;
  select coalesce(sum(l.credit_cents-l.debit_cents),0) into v_recognized from public.journal_lines l
    join public.journal_entries e on e.id=l.entry_id and e.org_id=l.org_id
    join public.gl_accounts a on a.id=l.account_id and a.org_id=l.org_id
    where l.org_id=p_org_id and l.project_id=v_snapshot.project_id
      and (v_snapshot.contract_id is null or l.dimensions->>'contract_id'=v_snapshot.contract_id::text)
      and (a.code='4000' or e.source_type='revenue_recognition' or exists(select 1 from public.journal_entries original where original.id=e.reversal_of_entry_id and original.org_id=e.org_id and original.source_type='revenue_recognition')) and a.account_type='income' and e.entry_kind<>'closing' and e.status in ('posted','reversed') and e.entry_date<=v_period.period_end;
  if v_recognized<>v_snapshot.earned_revenue_cents then raise exception 'Post reviewed WIP revenue before the expected-loss provision'; end if;
  v_total:=greatest(0,v_snapshot.eac_cents-v_snapshot.revised_contract_cents);
  v_incurred:=greatest(0,v_snapshot.cost_to_date_cents-v_snapshot.earned_revenue_cents);
  v_target:=greatest(0,v_total-v_incurred);
  insert into public.gl_accounts(org_id,code,name,account_type,subtype,normal_balance,cash_flow_category,is_system,active) values
    (p_org_id,'2360','Expected contract loss reserve','liability','expected_contract_loss_reserve','credit','operating',true,true),
    (p_org_id,'5060','Expected contract loss provision','cogs','expected_contract_loss_expense','debit','operating',true,true)
    on conflict(org_id,code) do nothing;
  select id into v_liability from public.gl_accounts where org_id=p_org_id and code='2360' and account_type='liability' and subtype='expected_contract_loss_reserve' and normal_balance='credit' and active;
  select id into v_expense from public.gl_accounts where org_id=p_org_id and code='5060' and account_type='cogs' and subtype='expected_contract_loss_expense' and normal_balance='debit' and active;
  if v_liability is null or v_expense is null then raise exception 'Expected-loss account codes conflict with the organization chart'; end if;
  select coalesce(sum(l.credit_cents-l.debit_cents),0) into v_balance from public.journal_lines l join public.journal_entries e on e.id=l.entry_id and e.org_id=l.org_id
    where l.org_id=p_org_id and l.project_id=v_snapshot.project_id and l.account_id=v_liability and e.status in ('posted','reversed') and e.entry_date<=v_period.period_end
      and (v_snapshot.contract_id is null or l.dimensions->>'contract_id'=v_snapshot.contract_id::text);
  v_delta:=v_target-v_balance;
  if abs(v_delta::numeric)>9007199254740991 then raise exception 'Loss provision adjustment exceeds safe integer cents'; end if;
  if v_delta=0 then return jsonb_build_object('posted',false,'deltaCents',0,'reserveCents',v_target,'totalExpectedLossCents',v_total); end if;
  v_scope := v_snapshot.project_id::text || coalesce(':'||v_snapshot.contract_id::text,'');
  select count(*)+1 into v_revision from public.journal_entries where org_id=p_org_id and source_type='expected_loss_provision' and posting_key like 'expected_loss:'||v_scope||':'||p_period_id||':%';
  v_dimensions:=jsonb_build_object('expected_loss_provision',true,'wip_snapshot_id',p_snapshot_id,'wip_inputs_hash',v_snapshot.inputs_hash,'total_expected_loss_cents',v_total,'incurred_loss_cents',v_incurred,'reserve_target_cents',v_target);
  if v_snapshot.contract_id is not null then v_dimensions:=v_dimensions || jsonb_build_object('contract_id',v_snapshot.contract_id); end if;
  v_entry:=public.post_books_journal_entry(p_org_id,jsonb_build_object('entry_date',v_period.period_end,'entry_kind','poc','memo','Expected construction contract loss provision','posting_key','expected_loss:'||v_scope||':'||p_period_id||':'||v_revision,'projection_version',p_projection_version,'policy_version',p_policy_version,'source_type','expected_loss_provision','source_id',v_snapshot.project_id,'created_by',p_actor_id),jsonb_build_array(
    jsonb_build_object('line_no',1,'account_id',v_expense,'project_id',v_snapshot.project_id,'debit_cents',greatest(0,v_delta),'credit_cents',greatest(0,-v_delta),'dimensions',v_dimensions),
    jsonb_build_object('line_no',2,'account_id',v_liability,'project_id',v_snapshot.project_id,'debit_cents',greatest(0,-v_delta),'credit_cents',greatest(0,v_delta),'dimensions',v_dimensions)));
  return jsonb_build_object('posted',true,'entryId',v_entry,'deltaCents',v_delta,'reserveCents',v_target,'totalExpectedLossCents',v_total);
end;
$$;

-- Assign an invoice that names no contract to the contract it bills. Only once:
-- an invoice that already names its contract keeps it.
create or replace function public.assign_books_invoice_contract(p_org_id uuid, p_invoice_id uuid, p_contract_id uuid, p_actor_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_invoice public.invoices%rowtype;
begin
  select * into v_invoice from public.invoices where org_id=p_org_id and id=p_invoice_id for update;
  if not found then raise exception 'Invoice not found'; end if;
  if p_actor_id is null or not exists(select 1 from public.app_users where id=p_actor_id) then raise exception 'An assigning member is required'; end if;
  if public.books_invoice_contract(p_org_id, p_invoice_id) is not null then raise exception 'This invoice already names the contract it bills'; end if;
  if not exists(select 1 from public.contracts where id=p_contract_id and org_id=p_org_id and project_id=v_invoice.project_id and parent_contract_id is null and status in ('active','amended','completed','terminated')) then
    raise exception 'Choose one of the project''s contracts';
  end if;
  update public.invoices set metadata = coalesce(metadata,'{}'::jsonb) || jsonb_build_object('source_contract_id', p_contract_id, 'contract_assigned_by', p_actor_id, 'contract_assigned_at', now())
    where org_id=p_org_id and id=p_invoice_id;
  return jsonb_build_object('invoiceId', p_invoice_id, 'contractId', p_contract_id);
end;
$$;
revoke all on function public.assign_books_invoice_contract(uuid,uuid,uuid,uuid) from public, anon, authenticated;
grant execute on function public.assign_books_invoice_contract(uuid,uuid,uuid,uuid) to service_role;

-- ==== 20261007140000_books_revenue_policies ====
-- B11.1: how a job earns revenue is a dated record, not whatever the project's
-- billing settings say today. A policy names the project (or one of its
-- contracts), the revenue recognition method, the billing method it was chosen
-- for, the date it takes effect and why. One person proposes it and a different
-- person approves it; rows are never edited or deleted, so earlier periods keep
-- the policy that was in force for them.
--
-- A job nobody has reviewed gets one `inferred` row, recorded by Arc from its
-- billing settings the first time it is projected. From then on the record, not
-- the settings, decides: changing a job's billing model later cannot quietly
-- change how its earlier documents earned revenue. Confirming or changing an
-- inferred policy goes through the same proposal and approval.

create table public.books_revenue_policies (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  contract_id uuid references public.contracts(id) on delete restrict,
  method text not null check (method in ('percentage_of_completion','closing')),
  billing_method text not null check (billing_method in ('fixed_price','cost_plus_percent','cost_plus_fixed_fee','cost_plus_gmp','time_and_materials','purchase_agreement')),
  effective_from date not null,
  rationale text not null check (length(trim(rationale)) between 10 and 4000),
  supersedes_id uuid references public.books_revenue_policies(id) on delete restrict,
  status text not null default 'proposed' check (status in ('inferred','proposed','approved','rejected')),
  prepared_by uuid references public.app_users(id),
  prepared_at timestamptz not null default clock_timestamp(),
  reviewed_by uuid references public.app_users(id),
  reviewed_at timestamptz,
  review_note text,
  constraint books_revenue_policies_review_check check ((status in ('inferred','proposed')) = (reviewed_by is null and reviewed_at is null)),
  constraint books_revenue_policies_preparer_check check ((status = 'inferred') = (prepared_by is null)),
  constraint books_revenue_policies_independent_check check (reviewed_by is null or reviewed_by <> prepared_by)
);
create index books_revenue_policies_scope_idx on public.books_revenue_policies (org_id, project_id, contract_id, effective_from desc);
create unique index books_revenue_policies_one_inferred_idx on public.books_revenue_policies (org_id, project_id, coalesce(contract_id, '00000000-0000-0000-0000-000000000000'::uuid)) where status = 'inferred';
create index books_revenue_policies_contract_idx on public.books_revenue_policies (contract_id) where contract_id is not null;
create index books_revenue_policies_prepared_by_idx on public.books_revenue_policies (prepared_by);
create index books_revenue_policies_reviewed_by_idx on public.books_revenue_policies (reviewed_by) where reviewed_by is not null;
create index books_revenue_policies_supersedes_idx on public.books_revenue_policies (supersedes_id) where supersedes_id is not null;
alter table public.books_revenue_policies enable row level security;
create policy books_revenue_policies_read on public.books_revenue_policies
  for select to authenticated using (public.has_org_permission(org_id, 'books.read'));
grant select on public.books_revenue_policies to authenticated;

-- Only the review decision is ever written after a policy is proposed, once.
create or replace function public.books_guard_revenue_policy()
returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'DELETE' then raise exception 'Revenue policies are kept; propose a new one to change a policy'; end if;
  if old.status <> 'proposed' then raise exception 'A recorded revenue policy cannot change; propose a new one'; end if;
  if (new.org_id, new.project_id, new.contract_id, new.method, new.billing_method, new.effective_from, new.rationale, new.supersedes_id, new.prepared_by, new.prepared_at)
    is distinct from (old.org_id, old.project_id, old.contract_id, old.method, old.billing_method, old.effective_from, old.rationale, old.supersedes_id, old.prepared_by, old.prepared_at) then
    raise exception 'Only the review decision of a revenue policy can be recorded';
  end if;
  return new;
end;
$$;
revoke all on function public.books_guard_revenue_policy() from public, anon, authenticated;
create trigger books_revenue_policies_guard before update or delete on public.books_revenue_policies
  for each row execute function public.books_guard_revenue_policy();

create or replace function public.propose_books_revenue_policy(
  p_org_id uuid, p_project_id uuid, p_contract_id uuid, p_method text, p_billing_method text,
  p_effective_from date, p_rationale text, p_actor_id uuid
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_prior uuid; v_id uuid;
begin
  perform 1 from public.projects where id = p_project_id and org_id = p_org_id for update;
  if not found then raise exception 'Project is outside this organization'; end if;
  if p_actor_id is null or not exists(select 1 from public.app_users where id = p_actor_id) then raise exception 'A preparer is required'; end if;
  if p_contract_id is not null and not exists(select 1 from public.contracts where id = p_contract_id and org_id = p_org_id and project_id = p_project_id and parent_contract_id is null) then
    raise exception 'The contract is not one of this project''s contracts';
  end if;
  if exists(select 1 from public.books_revenue_policies where org_id = p_org_id and project_id = p_project_id and contract_id is not distinct from p_contract_id and status = 'proposed') then
    raise exception 'A proposed policy for this job is already waiting for review';
  end if;
  select id into v_prior from public.books_revenue_policies
    where org_id = p_org_id and project_id = p_project_id and contract_id is not distinct from p_contract_id and status = 'approved' and effective_from <= p_effective_from
    order by effective_from desc, reviewed_at desc, id desc limit 1;
  insert into public.books_revenue_policies(org_id, project_id, contract_id, method, billing_method, effective_from, rationale, supersedes_id, prepared_by)
  values (p_org_id, p_project_id, p_contract_id, p_method, p_billing_method, p_effective_from, trim(p_rationale), v_prior, p_actor_id)
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.propose_books_revenue_policy(uuid,uuid,uuid,text,text,date,text,uuid) from public, anon, authenticated;
grant execute on function public.propose_books_revenue_policy(uuid,uuid,uuid,text,text,date,text,uuid) to service_role;

create or replace function public.review_books_revenue_policy(p_org_id uuid, p_policy_id uuid, p_approve boolean, p_note text, p_actor_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_policy public.books_revenue_policies%rowtype;
begin
  select * into v_policy from public.books_revenue_policies where id = p_policy_id and org_id = p_org_id for update;
  if not found then raise exception 'Revenue policy not found'; end if;
  if v_policy.status <> 'proposed' then raise exception 'This revenue policy has already been reviewed'; end if;
  if p_actor_id is null or not exists(select 1 from public.app_users where id = p_actor_id) then raise exception 'A reviewer is required'; end if;
  if p_actor_id = v_policy.prepared_by then raise exception 'A revenue policy is approved by someone other than the person who proposed it'; end if;
  if not p_approve and length(trim(coalesce(p_note, ''))) < 10 then raise exception 'Say why the policy is rejected'; end if;
  update public.books_revenue_policies
    set status = case when p_approve then 'approved' else 'rejected' end, reviewed_by = p_actor_id, reviewed_at = clock_timestamp(), review_note = nullif(trim(coalesce(p_note, '')), '')
    where id = p_policy_id;
  return jsonb_build_object('policyId', p_policy_id, 'status', case when p_approve then 'approved' else 'rejected' end, 'projectId', v_policy.project_id);
end;
$$;
revoke all on function public.review_books_revenue_policy(uuid,uuid,boolean,text,uuid) from public, anon, authenticated;
grant execute on function public.review_books_revenue_policy(uuid,uuid,boolean,text,uuid) to service_role;

-- The inferred baselines for jobs that have none: one per project, or one per
-- contract when the project has several. Never replaces a recorded policy.
create or replace function public.record_books_inferred_revenue_policies(p_org_id uuid, p_policies jsonb)
returns integer language plpgsql security definer set search_path = public as $$
declare v_row jsonb; v_count integer := 0;
begin
  if jsonb_typeof(p_policies) is distinct from 'array' then raise exception 'Inferred policies must be an array'; end if;
  for v_row in select value from jsonb_array_elements(p_policies) loop
    if not exists(select 1 from public.projects where id = (v_row->>'project_id')::uuid and org_id = p_org_id) then raise exception 'Project is outside this organization'; end if;
    if v_row->>'contract_id' is not null and not exists(select 1 from public.contracts where id = (v_row->>'contract_id')::uuid and org_id = p_org_id and project_id = (v_row->>'project_id')::uuid) then
      raise exception 'Contract is outside this project';
    end if;
    if exists(select 1 from public.books_revenue_policies where org_id = p_org_id and project_id = (v_row->>'project_id')::uuid
      and contract_id is not distinct from nullif(v_row->>'contract_id','')::uuid and status in ('inferred','approved')) then continue; end if;
    insert into public.books_revenue_policies(org_id, project_id, contract_id, method, billing_method, effective_from, rationale, status)
    values (p_org_id, (v_row->>'project_id')::uuid, nullif(v_row->>'contract_id','')::uuid, v_row->>'method', v_row->>'billing_method', '1900-01-01',
      'Inferred by Arc from the billing settings when the job was first posted. Not yet reviewed.', 'inferred')
    on conflict do nothing;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;
revoke all on function public.record_books_inferred_revenue_policies(uuid,jsonb) from public, anon, authenticated;
grant execute on function public.record_books_inferred_revenue_policies(uuid,jsonb) to service_role;
