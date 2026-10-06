-- Run after existing *_set_updated_at triggers (trigger ordering is alphabetical).
-- A transaction's now() can predate a revision it waited behind. Source revisions
-- must advance even in that case and when several edits share one transaction.
create or replace function public.books_advance_source_revision()
returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
 new.updated_at := greatest(clock_timestamp(),old.updated_at + interval '1 microsecond');
 return new;
end;
$$;
revoke all on function public.books_advance_source_revision() from public,anon,authenticated;
create trigger zz_books_source_revision before update on public.invoices for each row execute function public.books_advance_source_revision();
create trigger zz_books_source_revision before update on public.vendor_bills for each row execute function public.books_advance_source_revision();
create trigger zz_books_source_revision before update on public.project_expenses for each row execute function public.books_advance_source_revision();

create or replace function public.books_touch_invoice_from_line()
returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
 if tg_op='DELETE' then
   update public.invoices set updated_at=clock_timestamp() where id=old.invoice_id and org_id=old.org_id;
   return old;
 end if;
 update public.invoices set updated_at=clock_timestamp() where id=new.invoice_id and org_id=new.org_id;
 if tg_op='UPDATE' and (old.invoice_id is distinct from new.invoice_id or old.org_id is distinct from new.org_id) then
   update public.invoices set updated_at=clock_timestamp() where id=old.invoice_id and org_id=old.org_id;
 end if;
 return new;
end;
$$;
revoke all on function public.books_touch_invoice_from_line() from public,anon,authenticated;
create trigger invoice_lines_touch_books_parent after insert or update or delete on public.invoice_lines
for each row execute function public.books_touch_invoice_from_line();
