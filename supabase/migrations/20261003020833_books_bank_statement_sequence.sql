-- Validate statement sequencing before an accountant spends time reconciling it.
create or replace function public.books_validate_statement_sequence()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare previous public.bank_reconciliations%rowtype;
begin
  if tg_op='UPDATE' then
    if new.org_id is distinct from old.org_id or new.bank_account_id is distinct from old.bank_account_id then
      raise exception 'Bank statements cannot be reassigned to another account or organization';
    end if;
    if old.status='closed' then raise exception 'Reopen the bank statement before changing its balances or dates'; end if;
  end if;
  perform 1 from public.bank_accounts where id=new.bank_account_id and org_id=new.org_id for update;
  if not found then raise exception 'Bank account not found in organization'; end if;
  if new.statement_start is null or new.statement_end is null or new.statement_end<new.statement_start then
    raise exception 'Statement end must be on or after statement start';
  end if;
  if abs(new.beginning_balance_cents::numeric)>9007199254740991 or abs(new.ending_balance_cents::numeric)>9007199254740991
    or abs(new.ending_balance_cents::numeric-new.beginning_balance_cents::numeric)>9007199254740991 then
    raise exception 'Statement balances exceed safe integer cents';
  end if;
  if exists(select 1 from public.bank_reconciliations where org_id=new.org_id and bank_account_id=new.bank_account_id and id<>new.id
    and statement_start<=new.statement_end and statement_end>=new.statement_start) then
    raise exception 'Bank statement dates overlap an existing reconciliation';
  end if;
  select * into previous from public.bank_reconciliations where org_id=new.org_id and bank_account_id=new.bank_account_id
    and status='closed' and id<>new.id order by statement_end desc limit 1;
  if previous.id is not null and (previous.statement_end+1<>new.statement_start or previous.ending_balance_cents<>new.beginning_balance_cents) then
    raise exception 'Statement dates and opening balance must continue the previous closed reconciliation';
  end if;
  if tg_op='INSERT' and exists(select 1 from public.bank_reconciliations where org_id=new.org_id and bank_account_id=new.bank_account_id and status<>'closed') then
    raise exception 'Finish or remove the existing open bank statement before starting another';
  end if;
  return new;
end;
$$;
revoke all on function public.books_validate_statement_sequence() from public,anon,authenticated;
create trigger books_statement_sequence_guard before insert or update of org_id,bank_account_id,statement_start,statement_end,beginning_balance_cents,ending_balance_cents
on public.bank_reconciliations for each row execute function public.books_validate_statement_sequence();
