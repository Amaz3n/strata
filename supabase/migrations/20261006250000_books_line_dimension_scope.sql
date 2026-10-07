-- Every record a journal line names belongs to the line's company.
--
-- journal_lines_validate_scope already refuses a foreign project, company,
-- account or entry in the line's columns. The ids carried inside `dimensions`
-- (cost code, contract, lot, community, division, invoice, bill, payment) were
-- never checked: a reporting slice could name another company's job, or a record
-- that does not exist. A posted line must now name only its own company's
-- records. A key present with a null value means "none" and is allowed.
-- Reversal lines copy their original's dimensions exactly (the classification
-- trigger enforces that) and are not re-checked, so a historical entry can
-- always be reversed.

create or replace function public.books_validate_line_dimension_scope()
returns trigger language plpgsql security invoker set search_path = pg_catalog, public as $$
declare
  dimension record;
  target regclass;
  reversal uuid;
  found_row boolean;
begin
  if new.dimensions is null or jsonb_typeof(new.dimensions) <> 'object' then return new; end if;
  select reversal_of_entry_id into reversal from public.journal_entries where id = new.entry_id and org_id = new.org_id;
  if reversal is not null then return new; end if;
  if new.dimensions ? 'organization_id' and jsonb_typeof(new.dimensions -> 'organization_id') <> 'null'
    and new.dimensions ->> 'organization_id' is distinct from new.org_id::text then
    raise exception 'Journal line names another company (organization_id); correct the source document before posting' using errcode = 'P0001';
  end if;
  for dimension in select key, value from jsonb_each(new.dimensions)
    where key in ('cost_code_id', 'contract_id', 'lot_id', 'community_id', 'division_id', 'invoice_id', 'bill_id', 'payment_id')
      and jsonb_typeof(value) <> 'null'
  loop
    target := case dimension.key
      when 'cost_code_id' then 'public.cost_codes'::regclass
      when 'contract_id' then 'public.contracts'::regclass
      when 'lot_id' then 'public.lots'::regclass
      when 'community_id' then 'public.communities'::regclass
      when 'division_id' then 'public.divisions'::regclass
      when 'invoice_id' then 'public.invoices'::regclass
      when 'bill_id' then 'public.vendor_bills'::regclass
      when 'payment_id' then 'public.payments'::regclass
    end;
    if jsonb_typeof(dimension.value) <> 'string' or (dimension.value #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'Journal line % is not a record id; correct the source document before posting', dimension.key using errcode = 'P0001';
    end if;
    execute format('select exists (select 1 from %s where id = $1 and org_id = $2)', target)
      into found_row using (dimension.value #>> '{}')::uuid, new.org_id;
    if not found_row then
      raise exception 'Journal line % names a record that is not in this company; correct the source document before posting', dimension.key using errcode = 'P0001';
    end if;
  end loop;
  return new;
end;
$$;
revoke all on function public.books_validate_line_dimension_scope() from public, anon, authenticated;
create trigger books_validate_line_dimension_scope before insert on public.journal_lines
for each row execute function public.books_validate_line_dimension_scope();
