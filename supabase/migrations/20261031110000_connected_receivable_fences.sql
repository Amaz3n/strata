-- A member's retainage write must not be refused for what its own trigger does.
-- books_touch_invoice_from_retainage bumps updated_at on the invoices a retainage
-- row points at, and ran as the caller, so a member releasing retainage through a
-- pay application (update retainage ... release_invoice_id) hit the invoices
-- policy (members read invoices, only the service role writes them) and the whole
-- release failed with "permission denied for table invoices". The touch is
-- system bookkeeping with no authority of its own, so it runs as its owner;
-- who may change retainage stays the application's check and retainage's policies.
begin;

create or replace function public.books_touch_invoice_from_retainage()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  if tg_op = 'DELETE' then
    update public.invoices set updated_at = now()
    where id in (old.invoice_id, old.release_invoice_id);
    return old;
  end if;
  update public.invoices set updated_at = now()
  where id in (new.invoice_id, new.release_invoice_id);
  if tg_op = 'UPDATE' then
    update public.invoices set updated_at = now()
    where id in (old.invoice_id, old.release_invoice_id)
      and id is distinct from new.invoice_id
      and id is distinct from new.release_invoice_id;
  end if;
  return new;
end;
$$;

commit;
