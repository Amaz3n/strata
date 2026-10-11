-- Payables search matches the vendor and project names in the database.
-- PostgREST exposes a function over the row type as a filterable column, so the
-- desk can OR it with the bill number instead of first fetching a bounded list
-- of matching company and project ids.
create or replace function public.bill_search_text(bill public.vendor_bills)
returns text
language sql
stable
security invoker
set search_path = public
as $$
  select concat_ws(
    ' ',
    (select c.name from public.companies c where c.id = bill.company_id and c.org_id = bill.org_id),
    (select p.name from public.projects p where p.id = bill.project_id and p.org_id = bill.org_id)
  )
$$;
