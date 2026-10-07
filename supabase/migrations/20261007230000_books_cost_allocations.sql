-- B11.4: shared construction cost (equipment, overhead, insurance, supervision)
-- reaches jobs only through a reviewed allocation.
--
-- * The pool is the source expense account's balance that sits on no job. Costs
--   already charged to a job (time entries, bills, payroll) are never in it, and
--   every allocation draws the pool down, so the same depreciation or overhead
--   cannot be allocated twice.
-- * A proposal states the pool, the basis and each destination's weight; one
--   destination may be "retained" (the part that stays company overhead). The
--   database splits the total in exact cents (books_allocation_shares) and a
--   different member approves it before anything posts.
-- * Approval posts one journal (credit the pool, debit each job's cost account —
--   inventory for a home the builder owns, by the same date rule as any other
--   cost) and one job-cost row per destination line, keyed on that journal line,
--   so budget, job cost, WIP and the statements read the same cents.
-- * A reallocation reverses the original (both legs stay on record: the original
--   entry, its exact reversal and the negative job-cost rows) and posts the new
--   split, in one transaction.

alter table public.job_cost_entries drop constraint job_cost_entries_source_type_check;
alter table public.job_cost_entries add constraint job_cost_entries_source_type_check check (source_type = any (array[
  'vendor_bill_line','project_expense','project_expense_line','time_entry','bank_transaction','inventory_event','payroll_import','payroll_correction','cost_allocation']));

create table public.books_cost_allocations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  allocation_date date not null,
  reference text not null check (length(btrim(reference)) between 3 and 120),
  pool text not null check (pool in ('equipment','overhead','insurance','supervision','other')),
  basis text not null check (basis in ('equal','labor_hours','direct_cost','equipment_hours','custom')),
  source_account_id uuid not null references public.gl_accounts(id) on delete restrict,
  cost_code_id uuid references public.cost_codes(id) on delete restrict,
  total_cents bigint not null check (total_cents > 0),
  shares jsonb not null check (jsonb_typeof(shares) = 'array' and jsonb_array_length(shares) between 1 and 250),
  evidence_url text not null check (evidence_url like 'https://%'),
  note text not null check (length(trim(note)) between 10 and 4000),
  corrects_allocation_id uuid references public.books_cost_allocations(id) on delete restrict,
  status text not null default 'proposed' check (status in ('proposed','approved','rejected','reallocated')),
  prepared_by uuid not null references public.app_users(id),
  prepared_at timestamptz not null default clock_timestamp(),
  reviewed_by uuid references public.app_users(id),
  reviewed_at timestamptz,
  review_note text,
  journal_entry_id uuid references public.journal_entries(id) on delete restrict,
  reversal_entry_id uuid references public.journal_entries(id) on delete restrict,
  constraint books_cost_allocations_review_check check ((status = 'proposed') = (reviewed_by is null)),
  constraint books_cost_allocations_independent_check check (reviewed_by is null or reviewed_by <> prepared_by),
  constraint books_cost_allocations_posted_check check ((status in ('approved','reallocated')) = (journal_entry_id is not null)),
  constraint books_cost_allocations_reversal_check check ((status = 'reallocated') = (reversal_entry_id is not null)),
  unique (org_id, reference)
);
create index books_cost_allocations_org_date_idx on public.books_cost_allocations (org_id, allocation_date desc);
create index books_cost_allocations_source_account_idx on public.books_cost_allocations (source_account_id);
create index books_cost_allocations_cost_code_idx on public.books_cost_allocations (cost_code_id) where cost_code_id is not null;
create index books_cost_allocations_corrects_idx on public.books_cost_allocations (corrects_allocation_id) where corrects_allocation_id is not null;
create unique index books_cost_allocations_one_correction_idx on public.books_cost_allocations (corrects_allocation_id) where corrects_allocation_id is not null and status in ('proposed','approved','reallocated');
create index books_cost_allocations_prepared_by_idx on public.books_cost_allocations (prepared_by);
create index books_cost_allocations_reviewed_by_idx on public.books_cost_allocations (reviewed_by) where reviewed_by is not null;
create index books_cost_allocations_entry_idx on public.books_cost_allocations (journal_entry_id) where journal_entry_id is not null;
create index books_cost_allocations_reversal_idx on public.books_cost_allocations (reversal_entry_id) where reversal_entry_id is not null;
alter table public.books_cost_allocations enable row level security;
create policy books_cost_allocations_read on public.books_cost_allocations
  for select to authenticated using (public.has_org_permission(org_id, 'books.read'));
grant select on public.books_cost_allocations to authenticated;

create or replace function public.books_guard_cost_allocation()
returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'DELETE' then raise exception 'Cost allocations are kept; propose a reallocation instead'; end if;
  if (new.org_id, new.allocation_date, new.reference, new.pool, new.basis, new.source_account_id, new.cost_code_id, new.total_cents, new.shares, new.evidence_url, new.note, new.corrects_allocation_id, new.prepared_by, new.prepared_at)
    is distinct from (old.org_id, old.allocation_date, old.reference, old.pool, old.basis, old.source_account_id, old.cost_code_id, old.total_cents, old.shares, old.evidence_url, old.note, old.corrects_allocation_id, old.prepared_by, old.prepared_at) then
    raise exception 'A cost allocation proposal cannot change; propose a new one';
  end if;
  if not (old.status = 'proposed' and new.status in ('approved','rejected')) and not (old.status = 'approved' and new.status = 'reallocated') then
    raise exception 'A reviewed cost allocation cannot change';
  end if;
  return new;
end;
$$;
revoke all on function public.books_guard_cost_allocation() from public, anon, authenticated;
create trigger books_cost_allocations_guard before update or delete on public.books_cost_allocations
  for each row execute function public.books_guard_cost_allocation();

-- The pool: what the source account holds on no job as of a date.
create or replace function public.books_cost_pool_cents(p_org_id uuid, p_account_id uuid, p_as_of date)
returns bigint language sql stable set search_path = public as $$
  select coalesce(sum(l.debit_cents - l.credit_cents), 0)::bigint
  from public.journal_lines l join public.journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
  where l.org_id = p_org_id and l.account_id = p_account_id and l.project_id is null and e.status in ('posted','reversed') and e.entry_date <= p_as_of;
$$;
revoke all on function public.books_cost_pool_cents(uuid,uuid,date) from public, anon, authenticated;
grant execute on function public.books_cost_pool_cents(uuid,uuid,date) to service_role;

create or replace function public.propose_books_cost_allocation(
  p_org_id uuid, p_date date, p_reference text, p_pool text, p_basis text, p_source_account_id uuid, p_cost_code_id uuid,
  p_total_cents bigint, p_weights jsonb, p_evidence_url text, p_note text, p_corrects uuid, p_actor_id uuid
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_row jsonb; v_shares jsonb; v_id uuid; v_original public.books_cost_allocations%rowtype; v_moved bigint;
begin
  if p_actor_id is null or not exists(select 1 from public.app_users where id = p_actor_id) then raise exception 'A preparer is required'; end if;
  if not exists(select 1 from public.gl_accounts where org_id = p_org_id and id = p_source_account_id and active and account_type = 'expense') then
    raise exception 'Allocate from a company expense account (the pool); job costs are already on their jobs';
  end if;
  if p_cost_code_id is not null and not exists(select 1 from public.cost_codes where org_id = p_org_id and id = p_cost_code_id) then raise exception 'The cost code is outside this organization'; end if;
  if jsonb_typeof(p_weights) is distinct from 'array' or jsonb_array_length(p_weights) = 0 then raise exception 'Give each destination its share of the basis'; end if;
  if (select count(*) from jsonb_array_elements(p_weights)) <> (select count(distinct coalesce(value->>'project_id', 'retained')) from jsonb_array_elements(p_weights)) then raise exception 'Name each destination once'; end if;
  if not exists(select 1 from jsonb_array_elements(p_weights) where value->>'project_id' is not null) then raise exception 'Allocate to at least one job'; end if;
  for v_row in select value from jsonb_array_elements(p_weights) loop
    if coalesce((v_row->>'weight')::numeric, 0) <= 0 then raise exception 'Each destination''s basis must be positive'; end if;
    if v_row->>'project_id' is not null and not exists(select 1 from public.projects where org_id = p_org_id and id = (v_row->>'project_id')::uuid) then raise exception 'A destination job is outside this organization'; end if;
  end loop;
  if exists(select 1 from public.accounting_periods where org_id = p_org_id and status = 'closed' and p_date between period_start and period_end) then raise exception 'The allocation date is in a closed month'; end if;
  if p_corrects is not null then
    select * into v_original from public.books_cost_allocations where org_id = p_org_id and id = p_corrects;
    if not found or v_original.status <> 'approved' then raise exception 'Only an approved allocation can be reallocated'; end if;
    if v_original.source_account_id <> p_source_account_id then raise exception 'A reallocation draws on the same pool as the allocation it corrects'; end if;
    if p_date < v_original.allocation_date then raise exception 'A reallocation cannot be dated before the allocation it corrects'; end if;
  end if;
  select jsonb_agg(jsonb_build_object('project_id', nullif(s->>'key', 'retained'), 'weight', s->'weight', 'amount_cents', s->'amount_cents') order by s->>'key') into v_shares
    from jsonb_array_elements(public.books_allocation_shares(p_total_cents,
      (select jsonb_agg(jsonb_build_object('key', coalesce(w->>'project_id', 'retained'), 'weight', w->'weight')) from jsonb_array_elements(p_weights) w))) s;
  if (select sum((value->>'amount_cents')::bigint) from jsonb_array_elements(v_shares)) <> p_total_cents then raise exception 'Allocation shares must add to the total'; end if;
  select coalesce(sum((value->>'amount_cents')::bigint), 0) into v_moved from jsonb_array_elements(v_shares) where value->>'project_id' is not null;
  if v_moved > public.books_cost_pool_cents(p_org_id, p_source_account_id, p_date) + coalesce((select sum(l.debit_cents) from public.journal_lines l
       where l.org_id = p_org_id and l.entry_id = v_original.journal_entry_id and l.project_id is not null), 0) then
    raise exception 'The allocation exceeds the unallocated pool on that account at that date';
  end if;
  insert into public.books_cost_allocations(org_id, allocation_date, reference, pool, basis, source_account_id, cost_code_id, total_cents, shares, evidence_url, note, corrects_allocation_id, prepared_by)
  values (p_org_id, p_date, btrim(p_reference), p_pool, p_basis, p_source_account_id, p_cost_code_id, p_total_cents, v_shares, p_evidence_url, trim(p_note), p_corrects, p_actor_id)
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.propose_books_cost_allocation(uuid,date,text,text,text,uuid,uuid,bigint,jsonb,text,text,uuid,uuid) from public, anon, authenticated;
grant execute on function public.propose_books_cost_allocation(uuid,date,text,text,text,uuid,uuid,bigint,jsonb,text,text,uuid,uuid) to service_role;

-- A job's cost account on a date: inventory while the builder owns the home, cost
-- of sales otherwise (the same rule as inventoryCostAccount in the application).
create or replace function public.books_job_cost_account_code(p_org_id uuid, p_project_id uuid, p_date date)
returns text language sql stable set search_path = public as $$
  select case
    when s.project_id is null or not s.books_inventory_enabled or s.books_inventory_effective_on is null or p_date < s.books_inventory_effective_on then '5000'
    when s.books_inventory_sold_on is not null and p_date >= s.books_inventory_sold_on then '5000'
    when s.books_inventory_completed_on is not null and p_date >= s.books_inventory_completed_on then '1170'
    else '1160' end
  from (select 1) one left join public.project_financial_settings s on s.org_id = p_org_id and s.project_id = p_project_id;
$$;
revoke all on function public.books_job_cost_account_code(uuid,uuid,date) from public, anon, authenticated;
grant execute on function public.books_job_cost_account_code(uuid,uuid,date) to service_role;

create or replace function public.review_books_cost_allocation(p_org_id uuid, p_allocation_id uuid, p_approve boolean, p_note text, p_actor_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v public.books_cost_allocations%rowtype; v_original public.books_cost_allocations%rowtype; v_policy integer; v_entry uuid; v_reversal uuid;
  v_lines jsonb := '[]'::jsonb; v_line integer := 0; v_share jsonb; v_code text; v_sold date; v_moved bigint := 0; v_dims jsonb; v_row record;
begin
  select * into v from public.books_cost_allocations where id = p_allocation_id and org_id = p_org_id for update;
  if not found then raise exception 'Cost allocation not found'; end if;
  if v.status <> 'proposed' then raise exception 'This allocation has already been reviewed'; end if;
  if p_actor_id is null or p_actor_id = v.prepared_by then raise exception 'A cost allocation is approved by someone other than the person who proposed it'; end if;
  if not p_approve then
    if length(trim(coalesce(p_note, ''))) < 10 then raise exception 'Say why the allocation is rejected'; end if;
    update public.books_cost_allocations set status = 'rejected', reviewed_by = p_actor_id, reviewed_at = clock_timestamp(), review_note = trim(p_note) where id = v.id;
    return jsonb_build_object('allocationId', v.id, 'status', 'rejected', 'journalEntryId', null, 'reversalEntryId', null);
  end if;
  -- One pool at a time: concurrent approvals cannot both spend the same balance.
  perform pg_advisory_xact_lock(hashtextextended(p_org_id::text || ':cost-pool:' || v.source_account_id::text, 0));
  select active_policy_version into v_policy from public.books_settings where org_id = p_org_id;
  if v_policy is null then raise exception 'Books posting is not enabled'; end if;
  -- A reallocation first reverses what it corrects: the entry and its job-cost rows.
  if v.corrects_allocation_id is not null then
    select * into v_original from public.books_cost_allocations where id = v.corrects_allocation_id and org_id = p_org_id for update;
    if v_original.status <> 'approved' then raise exception 'The allocation being corrected was already reallocated'; end if;
    v_reversal := (public.reverse_books_journal_entry(p_org_id, v_original.journal_entry_id,
      jsonb_build_object('entry_date', v.allocation_date, 'entry_kind', 'reversal', 'reversal_of_entry_id', v_original.journal_entry_id,
        'memo', 'Reallocated: ' || v_original.reference, 'posting_key', 'cost_allocation_reversal:' || v_original.id, 'projection_version', 1, 'policy_version', v_policy,
        'source_type', 'cost_allocation', 'source_id', v_original.id, 'created_by', p_actor_id),
      (select jsonb_agg(jsonb_build_object('line_no', l.line_no, 'account_id', l.account_id, 'project_id', l.project_id, 'debit_cents', l.credit_cents, 'credit_cents', l.debit_cents,
          'dimensions', l.dimensions) order by l.line_no)
        from public.journal_lines l where l.org_id = p_org_id and l.entry_id = v_original.journal_entry_id))->>'id')::uuid;
    update public.journal_entries set status = 'reversed' where org_id = p_org_id and id = v_original.journal_entry_id and status = 'posted';
    for v_row in select l.id, l.project_id, l.debit_cents - l.credit_cents as cents, l.dimensions from public.journal_lines l
      where l.org_id = p_org_id and l.entry_id = v_reversal and l.project_id is not null loop
      insert into public.job_cost_entries(org_id, project_id, cost_code_id, source_type, source_id, incurred_on, cost_cents, status, is_billable, metadata)
      values (p_org_id, v_row.project_id, v_original.cost_code_id, 'cost_allocation', v_row.id::text, v.allocation_date, v_row.cents, 'posted', false,
        jsonb_build_object('cost_allocation_id', v_original.id, 'reallocated_by', v.id, 'pool', v_original.pool));
    end loop;
    update public.books_cost_allocations set status = 'reallocated', reversal_entry_id = v_reversal where id = v_original.id;
  end if;
  for v_share in select value from jsonb_array_elements(v.shares) where value->>'project_id' is not null order by value->>'project_id' loop
    v_code := public.books_job_cost_account_code(p_org_id, (v_share->>'project_id')::uuid, v.allocation_date);
    select books_inventory_sold_on into v_sold from public.project_financial_settings where org_id = p_org_id and project_id = (v_share->>'project_id')::uuid and books_inventory_enabled;
    v_dims := jsonb_build_object('cost_allocation_id', v.id, 'pool', v.pool, 'cost_type', 'allocated_' || v.pool)
      || case when v.cost_code_id is not null then jsonb_build_object('cost_code_id', v.cost_code_id) else '{}'::jsonb end
      || case when v_sold is not null and v.allocation_date >= v_sold then jsonb_build_object('closed_home_cost', true) else '{}'::jsonb end;
    v_line := v_line + 1;
    v_moved := v_moved + (v_share->>'amount_cents')::bigint;
    v_lines := v_lines || jsonb_build_array(jsonb_build_object('line_no', v_line, 'account_id', (select id from public.gl_accounts where org_id = p_org_id and code = v_code and active),
      'project_id', (v_share->>'project_id')::uuid, 'debit_cents', (v_share->>'amount_cents')::bigint, 'credit_cents', 0, 'dimensions', v_dims));
  end loop;
  if v_moved > public.books_cost_pool_cents(p_org_id, v.source_account_id, v.allocation_date) then
    raise exception 'The allocation exceeds the unallocated pool on that account at that date';
  end if;
  v_lines := v_lines || jsonb_build_array(jsonb_build_object('line_no', v_line + 1, 'account_id', v.source_account_id, 'project_id', null,
    'debit_cents', 0, 'credit_cents', v_moved, 'dimensions', jsonb_build_object('cost_allocation_id', v.id, 'pool', v.pool, 'basis', v.basis, 'evidence_url', v.evidence_url)));
  v_entry := public.post_books_journal_entry(p_org_id, jsonb_build_object('entry_date', v.allocation_date, 'entry_kind', 'adjusting', 'memo', 'Allocate ' || v.pool || ': ' || v.reference,
    'posting_key', 'cost_allocation:' || v.id, 'projection_version', 1, 'policy_version', v_policy, 'source_type', 'cost_allocation', 'source_id', v.id, 'created_by', p_actor_id), v_lines);
  for v_row in select l.id, l.project_id, l.debit_cents as cents from public.journal_lines l where l.org_id = p_org_id and l.entry_id = v_entry and l.project_id is not null loop
    insert into public.job_cost_entries(org_id, project_id, cost_code_id, source_type, source_id, incurred_on, cost_cents, status, is_billable, metadata)
    values (p_org_id, v_row.project_id, v.cost_code_id, 'cost_allocation', v_row.id::text, v.allocation_date, v_row.cents, 'posted', false,
      jsonb_build_object('cost_allocation_id', v.id, 'pool', v.pool, 'basis', v.basis));
  end loop;
  update public.books_cost_allocations set status = 'approved', reviewed_by = p_actor_id, reviewed_at = clock_timestamp(), review_note = nullif(trim(coalesce(p_note, '')), ''), journal_entry_id = v_entry
    where id = v.id;
  return jsonb_build_object('allocationId', v.id, 'status', 'approved', 'journalEntryId', v_entry, 'reversalEntryId', v_reversal);
end;
$$;
revoke all on function public.review_books_cost_allocation(uuid,uuid,boolean,text,uuid) from public, anon, authenticated;
grant execute on function public.review_books_cost_allocation(uuid,uuid,boolean,text,uuid) to service_role;

-- Every pool with something left to allocate, in one read for the register.
create or replace function public.books_cost_pools(p_org_id uuid, p_as_of date)
returns table (account_id uuid, code text, name text, cents bigint) language sql stable set search_path = public as $$
  select a.id, a.code, a.name, sum(l.debit_cents - l.credit_cents)::bigint
  from public.journal_lines l
  join public.journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
  join public.gl_accounts a on a.id = l.account_id and a.org_id = l.org_id
  where l.org_id = p_org_id and l.project_id is null and a.account_type = 'expense' and a.active and e.status in ('posted','reversed') and e.entry_date <= p_as_of
  group by a.id, a.code, a.name having sum(l.debit_cents - l.credit_cents) > 0
  order by a.code;
$$;
revoke all on function public.books_cost_pools(uuid,date) from public, anon, authenticated;
grant execute on function public.books_cost_pools(uuid,date) to service_role;
