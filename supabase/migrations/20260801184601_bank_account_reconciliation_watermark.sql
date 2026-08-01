-- Workspace/read-model watermark for the latest statement reconciliation.
-- Keep the value derived from closed reconciliation records so it cannot drift
-- when a reconciliation is reopened, removed, or moved between accounts.

alter table public.bank_accounts
  add column if not exists last_reconciled_on date;

update public.bank_accounts as account
set last_reconciled_on = source.last_reconciled_on
from (
  select bank_account_id, max(statement_end) as last_reconciled_on
  from public.bank_reconciliations
  where status = 'closed'
  group by bank_account_id
) as source
where account.id = source.bank_account_id;

create or replace function public.books_refresh_bank_account_reconciliation_watermark()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  target_account_id uuid;
begin
  target_account_id := case when tg_op = 'DELETE' then old.bank_account_id else new.bank_account_id end;

  update public.bank_accounts
  set
    last_reconciled_on = (
      select max(reconciliation.statement_end)
      from public.bank_reconciliations as reconciliation
      where reconciliation.bank_account_id = target_account_id
        and reconciliation.status = 'closed'
    ),
    updated_at = now()
  where id = target_account_id;

  if tg_op = 'UPDATE' and old.bank_account_id is distinct from new.bank_account_id then
    update public.bank_accounts
    set
      last_reconciled_on = (
        select max(reconciliation.statement_end)
        from public.bank_reconciliations as reconciliation
        where reconciliation.bank_account_id = old.bank_account_id
          and reconciliation.status = 'closed'
      ),
      updated_at = now()
    where id = old.bank_account_id;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger bank_reconciliations_refresh_account_watermark
  after insert or update or delete on public.bank_reconciliations
  for each row execute function public.books_refresh_bank_account_reconciliation_watermark();

revoke all on function public.books_refresh_bank_account_reconciliation_watermark()
  from public, anon, authenticated;
