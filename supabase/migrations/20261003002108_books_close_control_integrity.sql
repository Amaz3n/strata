-- Close owns POC and retained earnings while ordinary posting remains frozen.
-- Check both insertion and posting of an existing draft. SHARE conflicts with
-- status updates; KEY SHARE does not protect against a non-key status update.
create or replace function public.books_guard_period_posting()
returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
declare
  period_row public.accounting_periods%rowtype;
  close_owned boolean;
begin
  if new.period_id is null then
    return new;
  end if;

  select * into period_row
  from public.accounting_periods
  where id = new.period_id and org_id = new.org_id
  for share;

  if not found or new.entry_date not between period_row.period_start and period_row.period_end then
    raise exception 'Journal entry must belong to its organization and accounting period';
  end if;
  if period_row.status = 'closed' then
    raise exception 'Accounting period is closed and cannot accept postings';
  end if;

  close_owned := (
    new.source_type = 'revenue_recognition' and new.entry_kind = 'poc'
    and new.entry_date = period_row.period_end
  ) or (
    new.source_type = 'year_end_close' and new.entry_kind = 'closing'
    and new.source_id = period_row.id and new.entry_date = period_row.period_end
    and period_row.fiscal_period in (12, 13)
  );
  if period_row.status = 'reviewing' and close_owned is not true then
    raise exception 'Accounting period is reviewing and cannot accept operational postings';
  end if;
  return new;
end;
$$;

drop trigger if exists journal_entries_guard_period_posting on public.journal_entries;
create trigger journal_entries_guard_period_posting
  before insert or update of status, period_id, entry_date, source_type, source_id, entry_kind
  on public.journal_entries
  for each row execute function public.books_guard_period_posting();

revoke all on function public.books_guard_period_posting() from public, anon, authenticated;
