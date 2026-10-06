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
