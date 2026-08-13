-- Keep the operational invoice and Arc Books tax register on the same fact.
-- Invoice writes deliberately carry the jurisdiction in metadata as well as the
-- typed column so older clients remain readable; this trigger makes the typed
-- foreign key authoritative and validates tenant ownership at the database edge.
set lock_timeout = '5s';
set statement_timeout = '120s';

begin;

create or replace function public.sync_invoice_tax_jurisdiction()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_requested_id uuid;
begin
  if new.metadata ? 'tax_jurisdiction_id' then
    begin
      v_requested_id := nullif(new.metadata ->> 'tax_jurisdiction_id', '')::uuid;
    exception when invalid_text_representation then
      raise exception 'Invoice tax jurisdiction is not a valid identifier';
    end;
    new.tax_jurisdiction_id := v_requested_id;
  end if;

  if new.tax_jurisdiction_id is not null and not exists (
    select 1
    from public.books_tax_jurisdictions jurisdiction
    where jurisdiction.id = new.tax_jurisdiction_id
      and jurisdiction.org_id = new.org_id
  ) then
    raise exception 'Invoice tax jurisdiction does not belong to this organization';
  end if;

  if coalesce(new.tax_cents, 0) > 0
    and (new.client_visible or new.status in ('sent', 'viewed', 'partial', 'paid', 'overdue'))
    and new.tax_jurisdiction_id is null then
    raise exception 'Issued taxable invoices require a tax jurisdiction';
  end if;

  return new;
end;
$$;

drop trigger if exists invoices_sync_tax_jurisdiction on public.invoices;
create trigger invoices_sync_tax_jurisdiction
before insert or update of metadata, tax_jurisdiction_id, tax_cents, client_visible, status
on public.invoices
for each row execute function public.sync_invoice_tax_jurisdiction();

revoke all on function public.sync_invoice_tax_jurisdiction() from public, anon, authenticated;
grant execute on function public.sync_invoice_tax_jurisdiction() to service_role;

commit;
