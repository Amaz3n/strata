-- Classification belongs to the posting, not to today's mutable chart.
create or replace function public.books_capture_account_classification()
returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
declare
  account public.gl_accounts%rowtype;
  reversal uuid;
  original public.journal_lines%rowtype;
  classification jsonb;
begin
  select * into account from public.gl_accounts where id=new.account_id and org_id=new.org_id;
  if not found then raise exception 'GL account must belong to the line organization'; end if;
  select reversal_of_entry_id into reversal from public.journal_entries where id=new.entry_id and org_id=new.org_id;
  if not found then raise exception 'Journal entry must belong to the line organization'; end if;
  if reversal is not null then
    select * into original from public.journal_lines
    where entry_id=reversal and org_id=new.org_id and line_no=new.line_no;
    if not found or original.account_id<>new.account_id
      or original.project_id is distinct from new.project_id
      or original.company_id is distinct from new.company_id
      or original.debit_cents<>new.credit_cents or original.credit_cents<>new.debit_cents then
      raise exception 'Reversal line must exactly reverse its original posting';
    end if;
    new.dimensions:=original.dimensions;
    classification:=original.dimensions->'books_account_classification';
    if classification is null then
      classification:=jsonb_build_object('version',1,'account_id',new.account_id,'legacy_unknown',true);
    end if;
  else
    classification:=jsonb_build_object('version',1,'account_id',account.id,'code',account.code,
      'account_type',account.account_type,'subtype',account.subtype,
      'normal_balance',account.normal_balance,'cash_flow_category',account.cash_flow_category);
  end if;
  new.dimensions:=coalesce(new.dimensions,'{}'::jsonb)||jsonb_build_object('books_account_classification',classification);
  return new;
end;
$$;
revoke all on function public.books_capture_account_classification() from public,anon,authenticated;
create trigger zz_books_capture_account_classification before insert on public.journal_lines
for each row execute function public.books_capture_account_classification();

-- Exact individual lines alone would still allow a balanced subset reversal.
create or replace function public.books_validate_complete_reversal()
returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
declare original uuid; entry_identifier uuid; entry_status text;
begin
  if tg_table_name='journal_entries' then entry_identifier:=new.id; else entry_identifier:=new.entry_id; end if;
  select reversal_of_entry_id,status into original,entry_status from public.journal_entries where id=entry_identifier and org_id=new.org_id;
  if original is not null and entry_status in ('posted','reversed') and
    (select count(*) from public.journal_lines where entry_id=entry_identifier and org_id=new.org_id)<>
    (select count(*) from public.journal_lines where entry_id=original and org_id=new.org_id) then
    raise exception 'Reversal must include every original journal line';
  end if;
  return null;
end;
$$;
revoke all on function public.books_validate_complete_reversal() from public,anon,authenticated;
create constraint trigger books_complete_reversal after insert on public.journal_lines
deferrable initially deferred for each row execute function public.books_validate_complete_reversal();
create constraint trigger books_complete_reversal_entry after insert or update on public.journal_entries
deferrable initially deferred for each row execute function public.books_validate_complete_reversal();
