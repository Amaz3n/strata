-- Honor the configured fiscal year, including months in the following calendar year.
create or replace function public.replace_books_overhead_budget_atomic(
  p_org_id uuid,
  p_budget_id uuid,
  p_name text,
  p_fiscal_year integer,
  p_status text,
  p_notes text,
  p_lines jsonb,
  p_actor_id uuid
) returns uuid
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_budget_id uuid;
  v_line jsonb;
  v_account public.gl_accounts%rowtype;
  v_month date;
  v_fiscal_start date;
begin
  select make_date(p_fiscal_year,fiscal_year_start_month,1) into v_fiscal_start from public.books_settings where org_id=p_org_id;
  if v_fiscal_start is null then raise exception 'Books fiscal calendar is missing'; end if;
  if length(trim(coalesce(p_name, ''))) < 2 then
    raise exception 'Budget name must contain at least two characters';
  end if;
  if p_fiscal_year < 2000 or p_fiscal_year > 2200 then
    raise exception 'Fiscal year is outside the supported range';
  end if;
  if p_status not in ('draft', 'active', 'archived') then
    raise exception 'Unsupported overhead budget status';
  end if;
  if jsonb_typeof(p_lines) <> 'array' then
    raise exception 'Budget lines must be an array';
  end if;

  if p_budget_id is null then
    insert into public.books_overhead_budgets (
      org_id, name, fiscal_year, status, notes, created_by, updated_by
    ) values (
      p_org_id, trim(p_name), p_fiscal_year, p_status, nullif(trim(p_notes), ''),
      p_actor_id, p_actor_id
    ) returning id into v_budget_id;
  else
    update public.books_overhead_budgets
    set name = trim(p_name),
        fiscal_year = p_fiscal_year,
        status = p_status,
        notes = nullif(trim(p_notes), ''),
        updated_by = p_actor_id,
        updated_at = now()
    where org_id = p_org_id and id = p_budget_id
    returning id into v_budget_id;
    if v_budget_id is null then
      raise exception 'Overhead budget not found';
    end if;
    delete from public.books_overhead_budget_lines
    where org_id = p_org_id and budget_id = v_budget_id;
  end if;

  for v_line in select value from jsonb_array_elements(p_lines)
  loop
    if coalesce((v_line ->> 'budget_cents')::integer, 0) < 0 then
      raise exception 'Budget amounts cannot be negative';
    end if;
    v_month := (v_line ->> 'month_start')::date;
    if extract(day from v_month) <> 1 or v_month < v_fiscal_start or v_month >= (v_fiscal_start + interval '1 year')::date then
      raise exception 'Every budget month must be the first day of the fiscal year month';
    end if;
    select * into v_account
    from public.gl_accounts
    where org_id = p_org_id
      and id = (v_line ->> 'account_id')::uuid
      and account_type = 'expense'
      and active = true;
    if v_account.id is null then
      raise exception 'Overhead budgets may use active expense accounts only';
    end if;
    if (v_line ->> 'budget_cents')::integer > 0 then
      insert into public.books_overhead_budget_lines (
        org_id, budget_id, account_id, month_start, budget_cents, notes
      ) values (
        p_org_id, v_budget_id, v_account.id, v_month,
        (v_line ->> 'budget_cents')::integer,
        nullif(trim(v_line ->> 'notes'), '')
      );
    end if;
  end loop;

  return v_budget_id;
end;
$$;
