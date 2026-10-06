-- Child allocation edits must enter incremental projection and invalidate prior receipts.
create trigger zz_books_payment_source_revision before update on public.payments
for each row execute function public.books_advance_source_revision();

create or replace function public.books_touch_payment_allocation_source()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if tg_op in ('UPDATE','DELETE') then
    update public.payments set updated_at=clock_timestamp() where id=old.payment_id and org_id=old.org_id;
  end if;
  if tg_op='INSERT' or (tg_op='UPDATE' and (new.payment_id is distinct from old.payment_id or new.org_id is distinct from old.org_id)) then
    update public.payments set updated_at=clock_timestamp() where id=new.payment_id and org_id=new.org_id;
  end if;
  return null;
end;
$$;
revoke all on function public.books_touch_payment_allocation_source() from public,anon,authenticated;
create trigger books_payment_allocation_source_touch after insert or update or delete on public.payment_allocations
for each row execute function public.books_touch_payment_allocation_source();
