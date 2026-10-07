-- B04.1: WIP is owned by the contract. A project with one primary contract (or
-- none) keeps one project-scoped WIP position, exactly as before. A project with
-- two or more primary contracts in force at a period end has one position per
-- contract, built only from that contract's costs and billings, so one
-- contract's profit never hides another's loss.
--
-- Ownership is explicit. A cost belongs to a contract when its cost code is on
-- that contract's schedule of values (and on no other), or when a reviewed cost
-- allocation says how it is shared. A billing belongs to the contract it bills.
-- Anything else is reported as unowned in the scope it affects, and preparing that
-- scope is refused with the cure; other projects and contracts are untouched.

alter table public.poc_snapshots add column contract_id uuid references public.contracts(id) on delete restrict;
alter table public.poc_snapshots drop constraint poc_snapshots_org_id_project_id_as_of_inputs_hash_key;
alter table public.poc_snapshots add constraint poc_snapshots_scope_inputs_key
  unique nulls not distinct (org_id, project_id, contract_id, as_of, inputs_hash);
create index poc_snapshots_contract_idx on public.poc_snapshots (contract_id) where contract_id is not null;

-- Primary contracts in force on a date: never chosen by row order.
create or replace function public.books_wip_primary_contracts(p_org_id uuid, p_project_id uuid, p_as_of date)
returns setof uuid language sql stable security definer set search_path = public as $$
  select id from public.contracts
  where org_id = p_org_id and project_id = p_project_id and parent_contract_id is null
    and status in ('active','amended','completed','terminated')
    and (effective_date is null or effective_date <= p_as_of)
  order by id;
$$;
revoke all on function public.books_wip_primary_contracts(uuid,uuid,date) from public, anon, authenticated;
grant execute on function public.books_wip_primary_contracts(uuid,uuid,date) to service_role;

-- A project needs contract-scoped WIP when two or more primary contracts are in force.
create or replace function public.books_wip_contract_scoped(p_org_id uuid, p_project_id uuid, p_as_of date)
returns boolean language sql stable security definer set search_path = public as $$
  select count(*) > 1 from public.books_wip_primary_contracts(p_org_id, p_project_id, p_as_of);
$$;
revoke all on function public.books_wip_contract_scoped(uuid,uuid,date) from public, anon, authenticated;
grant execute on function public.books_wip_contract_scoped(uuid,uuid,date) to service_role;

-- Reviewed shares of one cost code's costs across a project's contracts.
-- Append-only: the latest row for a project and cost code is in force, and the
-- WIP evidence names the row it used, so a later allocation invalidates the review.
create table public.books_wip_cost_allocations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  cost_code_id uuid references public.cost_codes(id) on delete restrict,
  shares jsonb not null check (jsonb_typeof(shares) = 'array' and jsonb_array_length(shares) between 1 and 50),
  note text not null check (length(trim(note)) between 10 and 4000),
  created_by uuid not null references public.app_users(id),
  created_at timestamptz not null default clock_timestamp()
);
create index books_wip_cost_allocations_scope_idx on public.books_wip_cost_allocations (org_id, project_id, cost_code_id, created_at desc);
create index books_wip_cost_allocations_cost_code_idx on public.books_wip_cost_allocations (cost_code_id);
create index books_wip_cost_allocations_created_by_idx on public.books_wip_cost_allocations (created_by);
alter table public.books_wip_cost_allocations enable row level security;
create policy books_wip_cost_allocations_read on public.books_wip_cost_allocations
  for select to authenticated using (public.has_org_permission(org_id, 'books.read'));
grant select on public.books_wip_cost_allocations to authenticated;
create trigger books_wip_cost_allocations_immutable before update or delete on public.books_wip_cost_allocations
  for each row execute function public.books_reject_mutation();

create or replace function public.record_books_wip_cost_allocation(
  p_org_id uuid, p_project_id uuid, p_cost_code_id uuid, p_shares jsonb, p_note text, p_actor_id uuid
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_share jsonb; v_total integer := 0; v_id uuid;
begin
  perform 1 from public.projects where id = p_project_id and org_id = p_org_id for update;
  if not found then raise exception 'Project is outside this organization'; end if;
  if p_actor_id is null or not exists(select 1 from public.app_users where id = p_actor_id) then raise exception 'Cost allocation preparer is required'; end if;
  if length(trim(coalesce(p_note, ''))) < 10 then raise exception 'Explain how these costs are shared between the contracts'; end if;
  if p_cost_code_id is not null and not exists(select 1 from public.cost_codes where id = p_cost_code_id and org_id = p_org_id) then raise exception 'Cost code is outside this organization'; end if;
  if jsonb_typeof(p_shares) is distinct from 'array' or jsonb_array_length(p_shares) = 0 then raise exception 'Give each contract''s share of these costs'; end if;
  for v_share in select value from jsonb_array_elements(p_shares) loop
    if coalesce(v_share->>'basis_points', '') !~ '^[1-9][0-9]{0,4}$' or (v_share->>'basis_points')::integer > 10000 then raise exception 'Each share must be between 0.01%% and 100%%'; end if;
    if not exists(select 1 from public.contracts where id = (v_share->>'contract_id')::uuid and org_id = p_org_id and project_id = p_project_id
      and parent_contract_id is null and status in ('active','amended','completed','terminated')) then
      raise exception 'Costs can only be shared between this project''s contracts';
    end if;
    v_total := v_total + (v_share->>'basis_points')::integer;
  end loop;
  if v_total <> 10000 then raise exception 'The shares must add up to 100%%'; end if;
  if (select count(distinct value->>'contract_id') from jsonb_array_elements(p_shares)) <> jsonb_array_length(p_shares) then raise exception 'Name each contract once'; end if;
  insert into public.books_wip_cost_allocations(org_id, project_id, cost_code_id, shares, note, created_by)
  values (p_org_id, p_project_id, p_cost_code_id,
    (select jsonb_agg(jsonb_build_object('contract_id', (value->>'contract_id')::uuid, 'basis_points', (value->>'basis_points')::integer) order by value->>'contract_id') from jsonb_array_elements(p_shares)),
    trim(p_note), p_actor_id)
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.record_books_wip_cost_allocation(uuid,uuid,uuid,jsonb,text,uuid) from public, anon, authenticated;
grant execute on function public.record_books_wip_cost_allocation(uuid,uuid,uuid,jsonb,text,uuid) to service_role;

-- Which contract owns each cost code's costs on a date: the latest reviewed
-- allocation, or else the one contract whose schedule of values carries the code.
-- A code with no single owner and no allocation has no rows here.
create or replace function public.books_wip_cost_shares(p_org_id uuid, p_project_id uuid, p_as_of date)
returns table(cost_code_id uuid, contract_id uuid, basis_points integer, allocation_id uuid)
language sql stable security definer set search_path = public as $$
  with primary_contracts as (
    select id from public.books_wip_primary_contracts(p_org_id, p_project_id, p_as_of) as c(id)
  ), codes as (
    select distinct c.cost_code_id from public.job_cost_entries c
    where c.org_id = p_org_id and c.project_id = p_project_id and c.status = 'posted' and c.incurred_on <= p_as_of
  ), allocations as (
    select distinct on (a.cost_code_id) a.id, a.cost_code_id, a.shares from public.books_wip_cost_allocations a
    where a.org_id = p_org_id and a.project_id = p_project_id
    order by a.cost_code_id, a.created_at desc, a.id desc
  ), linked as (
    select l.cost_code_id, l.contract_id from public.prime_sov_lines l
      where l.org_id = p_org_id and l.cost_code_id is not null and l.contract_id in (select id from primary_contracts)
    union
    select b.cost_code_id, k.contract_id from public.prime_sov_budget_links k
      join public.budget_lines b on b.id = k.budget_line_id and b.org_id = k.org_id
      where k.org_id = p_org_id and k.project_id = p_project_id and b.cost_code_id is not null and k.contract_id in (select id from primary_contracts)
  ), single_owner as (
    select linked.cost_code_id, min(linked.contract_id::text)::uuid as contract_id from linked
    group by linked.cost_code_id having count(*) = 1
  )
  select codes.cost_code_id, (share->>'contract_id')::uuid, (share->>'basis_points')::integer, a.id
    from codes join allocations a on a.cost_code_id is not distinct from codes.cost_code_id
    cross join lateral jsonb_array_elements(a.shares) share
  union all
  select codes.cost_code_id, s.contract_id, 10000, null::uuid
    from codes join single_owner s on s.cost_code_id = codes.cost_code_id
    where not exists(select 1 from allocations a where a.cost_code_id is not distinct from codes.cost_code_id);
$$;
revoke all on function public.books_wip_cost_shares(uuid,uuid,date) from public, anon, authenticated;
grant execute on function public.books_wip_cost_shares(uuid,uuid,date) to service_role;

-- The contract an invoice bills: its own record, else its pay application or draw.
create or replace function public.books_invoice_contract(p_org_id uuid, p_invoice_id uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select coalesce(
    (select nullif(i.metadata->>'source_contract_id', '')::uuid from public.invoices i where i.org_id = p_org_id and i.id = p_invoice_id),
    (select p.contract_id from public.pay_applications p where p.org_id = p_org_id and p.invoice_id = p_invoice_id order by p.id limit 1),
    (select d.contract_id from public.draw_schedules d where d.org_id = p_org_id and d.invoice_id = p_invoice_id and d.contract_id is not null order by d.id limit 1)
  );
$$;
revoke all on function public.books_invoice_contract(uuid,uuid) from public, anon, authenticated;
grant execute on function public.books_invoice_contract(uuid,uuid) to service_role;

-- Dated evidence for one WIP scope. With no contract it is the project's, byte
-- for byte as before. With a contract: that contract's share of each cost (exact
-- cents, the remainder kept by cumulative rounding), the billings and credits on
-- its invoices, and whatever in the project it cannot tell is its own.
drop function public.books_wip_source_evidence(uuid,uuid,date);
create or replace function public.books_wip_source_evidence(p_org_id uuid, p_project_id uuid, p_as_of date, p_contract_id uuid default null)
returns jsonb language sql stable security definer set search_path = public as $$
  with billings as (
    select i.id, i.issue_date, i.total_cents-coalesce(i.tax_cents,0)+coalesce((select sum(r.amount_cents) from public.retainage r where r.org_id=p_org_id and r.invoice_id=i.id),0) as cents,
      public.books_invoice_contract(p_org_id, i.id) as contract_id
    from public.invoices i where i.org_id=p_org_id and i.project_id=p_project_id and i.issue_date<=p_as_of
      and (i.status in ('sent','partial','paid','overdue') or (i.status='void' and i.metadata->>'voided_at'>=((p_as_of+1)::text||'T00:00:00')))
      and coalesce(i.metadata->>'invoice_kind','') <> 'earnest_deposit'
      and not exists(select 1 from public.retainage r where r.org_id=p_org_id and r.release_invoice_id=i.id)
  ), credits as (
    select a.id, a.effective_date, a.amount_cents-coalesce(a.tax_cents,0) as cents, public.books_invoice_contract(p_org_id, a.invoice_id) as contract_id
    from public.receivable_adjustments a where a.org_id=p_org_id and a.project_id=p_project_id and a.adjustment_type='credit_memo' and a.effective_date<=p_as_of
      and (a.status='posted' or a.voided_at>=((p_as_of+1)::timestamp at time zone 'UTC'))
  ), costs as (
    select c.id, c.incurred_on, c.cost_cents, c.cost_code_id from public.job_cost_entries c
    where c.org_id=p_org_id and c.project_id=p_project_id and c.status='posted' and c.incurred_on<=p_as_of
  ), shares as (
    select s.*, sum(s.basis_points) over (partition by s.cost_code_id order by s.contract_id) as cumulative
    from public.books_wip_cost_shares(p_org_id, p_project_id, p_as_of) s
  ), contract_costs as (
    select costs.id, costs.incurred_on, shares.basis_points, shares.allocation_id,
      (round(costs.cost_cents::numeric*shares.cumulative/10000) - round(costs.cost_cents::numeric*(shares.cumulative-shares.basis_points)/10000))::bigint as cents
    from costs join shares on shares.cost_code_id is not distinct from costs.cost_code_id and shares.contract_id = p_contract_id
  ), linked as (
    select l.cost_code_id, l.contract_id from public.prime_sov_lines l where l.org_id=p_org_id and l.cost_code_id is not null
      and l.contract_id in (select id from public.books_wip_primary_contracts(p_org_id, p_project_id, p_as_of) as c(id))
    union
    select b.cost_code_id, k.contract_id from public.prime_sov_budget_links k join public.budget_lines b on b.id=k.budget_line_id and b.org_id=k.org_id
      where k.org_id=p_org_id and k.project_id=p_project_id and b.cost_code_id is not null
        and k.contract_id in (select id from public.books_wip_primary_contracts(p_org_id, p_project_id, p_as_of) as c(id))
  ), unowned_codes as (
    -- Costs with no owner affect every contract; costs shared without an allocation, the contracts sharing them.
    select costs.cost_code_id, sum(costs.cost_cents)::bigint as cents,
      coalesce((select jsonb_agg(distinct linked.contract_id) from linked where linked.cost_code_id = costs.cost_code_id), '[]'::jsonb) as contracts
    from costs where not exists(select 1 from shares where shares.cost_code_id is not distinct from costs.cost_code_id)
    group by costs.cost_code_id
  )
  select case when p_contract_id is null then jsonb_build_object(
    'costs',coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'incurredOn',c.incurred_on,'cents',c.cost_cents) order by c.id) from costs c),'[]'::jsonb),
    'billings',coalesce((select jsonb_agg(jsonb_build_object('id',b.id,'issueDate',b.issue_date,'cents',b.cents) order by b.id) from billings b),'[]'::jsonb),
    'credits',coalesce((select jsonb_agg(jsonb_build_object('id',a.id,'effectiveDate',a.effective_date,'cents',a.cents) order by a.id) from credits a),'[]'::jsonb)
  ) else jsonb_build_object(
    'contractId',p_contract_id,
    'costs',coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'incurredOn',c.incurred_on,'cents',c.cents)
      || case when c.basis_points < 10000 then jsonb_build_object('basisPoints',c.basis_points) else '{}'::jsonb end
      || case when c.allocation_id is not null then jsonb_build_object('allocationId',c.allocation_id) else '{}'::jsonb end order by c.id) from contract_costs c),'[]'::jsonb),
    'billings',coalesce((select jsonb_agg(jsonb_build_object('id',b.id,'issueDate',b.issue_date,'cents',b.cents) order by b.id) from billings b where b.contract_id = p_contract_id),'[]'::jsonb),
    'credits',coalesce((select jsonb_agg(jsonb_build_object('id',a.id,'effectiveDate',a.effective_date,'cents',a.cents) order by a.id) from credits a where a.contract_id = p_contract_id),'[]'::jsonb),
    'unowned',jsonb_build_object(
      'costCodes',coalesce((select jsonb_agg(jsonb_build_object('costCodeId',u.cost_code_id,'cents',u.cents,'contracts',u.contracts) order by u.cost_code_id nulls first) from unowned_codes u
        where jsonb_array_length(u.contracts) < 2 or u.contracts ? p_contract_id::text),'[]'::jsonb),
      'billings',coalesce((select jsonb_agg(b.id order by b.id) from billings b where b.contract_id is null or b.contract_id not in (select id from public.books_wip_primary_contracts(p_org_id, p_project_id, p_as_of) as c(id))),'[]'::jsonb)
    )
  ) end;
$$;
revoke all on function public.books_wip_source_evidence(uuid,uuid,date,uuid) from public, anon, authenticated;
grant execute on function public.books_wip_source_evidence(uuid,uuid,date,uuid) to service_role;

-- A snapshot's scope must match the project's contracts on its date.
drop function public.books_assert_loss_wip_supported(uuid,uuid);
drop function public.books_assert_single_contract_wip(uuid,uuid);
create or replace function public.books_assert_wip_scope(p_org_id uuid, p_project_id uuid, p_contract_id uuid, p_as_of date)
returns void language plpgsql security definer set search_path = public as $$
begin
  if public.books_wip_contract_scoped(p_org_id, p_project_id, p_as_of) then
    if p_contract_id is null then raise exception 'This project has more than one contract; prepare WIP for each contract'; end if;
    if p_contract_id not in (select id from public.books_wip_primary_contracts(p_org_id, p_project_id, p_as_of) as c(id)) then
      raise exception 'WIP contract is not one of the project''s contracts in force on %', p_as_of;
    end if;
  elsif p_contract_id is not null then
    raise exception 'This project has one contract; its WIP is prepared for the project';
  end if;
end;
$$;
revoke all on function public.books_assert_wip_scope(uuid,uuid,uuid,date) from public, anon, authenticated;
grant execute on function public.books_assert_wip_scope(uuid,uuid,uuid,date) to service_role;

create or replace function public.books_assert_loss_wip_supported(p_org_id uuid, p_snapshot_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_snapshot public.poc_snapshots%rowtype;
begin
  select * into v_snapshot from public.poc_snapshots where org_id=p_org_id and id=p_snapshot_id;
  if not found then raise exception 'WIP snapshot not found'; end if;
  perform public.books_assert_wip_scope(p_org_id, v_snapshot.project_id, v_snapshot.contract_id, v_snapshot.as_of);
  if v_snapshot.eac_cents>v_snapshot.revised_contract_cents and exists(
    select 1 from public.journal_lines l join public.journal_entries e on e.id=l.entry_id and e.org_id=l.org_id
    join public.gl_accounts a on a.id=l.account_id and a.org_id=l.org_id
    where l.org_id=p_org_id and l.project_id=v_snapshot.project_id and a.code in ('1120','1130','1160','1170') and e.status in ('posted','reversed') and e.entry_date<=v_snapshot.as_of
    group by l.account_id having sum(l.debit_cents-l.credit_cents)<>0
  ) then raise exception 'Capitalized construction costs require impairment review before a loss provision'; end if;
  if exists(select 1 from public.gl_accounts where org_id=p_org_id and (
    (code='2360' and (account_type<>'liability' or subtype<>'expected_contract_loss_reserve' or normal_balance<>'credit' or not active)) or
    (code='5060' and (account_type<>'cogs' or subtype<>'expected_contract_loss_expense' or normal_balance<>'debit' or not active))
  )) then raise exception 'Expected-loss account codes conflict with the organization chart'; end if;
end;
$$;
revoke all on function public.books_assert_loss_wip_supported(uuid,uuid) from public, anon, authenticated;
grant execute on function public.books_assert_loss_wip_supported(uuid,uuid) to service_role;

-- The cure for an unowned scope, named by cost code and invoice number.
create or replace function public.books_wip_unowned_message(p_org_id uuid, p_sources jsonb)
returns text language sql stable security definer set search_path = public as $$
  select concat_ws(' ',
    case when jsonb_array_length(coalesce(p_sources->'unowned'->'costCodes','[]'))>0 then
      'Costs under ' || (select string_agg(coalesce(cc.code, 'no cost code'), ', ' order by cc.code nulls first)
        from jsonb_array_elements(p_sources->'unowned'->'costCodes') u left join public.cost_codes cc on cc.org_id=p_org_id and cc.id=(u->>'costCodeId')::uuid)
      || ' do not belong to one contract: put each code on one contract''s schedule of values, or record how its costs are shared.' end,
    case when jsonb_array_length(coalesce(p_sources->'unowned'->'billings','[]'))>0 then
      'Invoices ' || (select string_agg(coalesce(i.invoice_number, i.id::text), ', ' order by i.invoice_number)
        from jsonb_array_elements_text(p_sources->'unowned'->'billings') b(id) join public.invoices i on i.org_id=p_org_id and i.id=b.id::uuid)
      || ' do not say which contract they bill: assign each to its contract.' end);
$$;
revoke all on function public.books_wip_unowned_message(uuid,jsonb) from public, anon, authenticated;
grant execute on function public.books_wip_unowned_message(uuid,jsonb) to service_role;

drop function public.prepare_books_wip_atomic(uuid,uuid,uuid,uuid,bigint,bigint,bigint,text);
create or replace function public.prepare_books_wip_atomic(
  p_org_id uuid,p_period_id uuid,p_project_id uuid,p_actor_id uuid,
  p_original_cents bigint,p_change_orders_cents bigint,p_eac_cents bigint,p_note text,p_contract_id uuid default null
) returns uuid language plpgsql security definer set search_path=public as $$
declare
  v_period public.accounting_periods%rowtype;
  v_sources jsonb;
  v_cost bigint;
  v_billed bigint;
  v_contract bigint;
  v_earned bigint;
  v_ratio numeric;
  v_hash text;
  v_basis jsonb;
  v_id uuid;
  v_preparation jsonb;
  v_prior public.poc_snapshots%rowtype;
  v_unowned text;
begin
  select * into v_period from public.accounting_periods where id=p_period_id and org_id=p_org_id for update;
  if not found then raise exception 'Accounting period not found'; end if;
  if v_period.status not in ('open','reopened') then raise exception 'Reopen the period before preparing WIP'; end if;
  if v_period.period_end > (now() at time zone 'UTC')::date then raise exception 'Cannot prepare future period-end WIP'; end if;
  if not exists(select 1 from public.projects where id=p_project_id and org_id=p_org_id) then raise exception 'Project is outside this organization'; end if;
  perform public.books_assert_wip_scope(p_org_id,p_project_id,p_contract_id,v_period.period_end);
  if p_actor_id is null or not exists(select 1 from public.app_users where id=p_actor_id) then raise exception 'WIP preparer is required'; end if;
  if length(trim(coalesce(p_note,''))) < 10 then raise exception 'Explain the period-end contract and estimate basis'; end if;
  if p_original_cents is null or p_change_orders_cents is null or p_eac_cents is null or p_original_cents < 0 or p_eac_cents <= 0 then raise exception 'Valid period-end contract and EAC are required'; end if;
  v_contract := p_original_cents+p_change_orders_cents;
  if v_contract <= 0 then raise exception 'Revised contract value must be positive'; end if;
  v_sources := public.books_wip_source_evidence(p_org_id,p_project_id,v_period.period_end,p_contract_id);
  v_unowned := public.books_wip_unowned_message(p_org_id,v_sources);
  if v_unowned <> '' then raise exception '%', v_unowned; end if;
  select coalesce(sum((value->>'cents')::bigint),0) into v_cost from jsonb_array_elements(v_sources->'costs');
  select coalesce(sum((value->>'cents')::bigint),0) into v_billed from jsonb_array_elements(v_sources->'billings');
  v_billed := v_billed-(select coalesce(sum((value->>'cents')::bigint),0) from jsonb_array_elements(v_sources->'credits'));
  if v_cost<0 then raise exception 'Negative cumulative cost requires correction before WIP preparation'; end if;
  if p_eac_cents<v_cost then raise exception 'EAC cannot be below incurred cost'; end if;
  if greatest(abs(v_cost),abs(v_billed),abs(v_contract),abs(p_eac_cents),abs(p_original_cents),abs(p_change_orders_cents))>9007199254740991 then raise exception 'WIP amounts exceed safe integer cents'; end if;
  v_ratio := least(1::numeric,v_cost::numeric/p_eac_cents);
  v_earned := div(v_contract::numeric*v_cost*2+p_eac_cents,p_eac_cents::numeric*2);
  if abs(v_billed::numeric-v_earned)>9007199254740991 then raise exception 'WIP over-under exceeds safe integer cents'; end if;
  v_preparation := jsonb_build_object('calculationVersion',2,'kind','period_prepared','periodId',p_period_id,'preparedBy',p_actor_id,'preparedAt',now(),'note',trim(p_note),'sources',v_sources);
  -- The project-scope basis is unchanged so earlier snapshots keep their hashes.
  v_basis := jsonb_build_object('calculationVersion',2,'asOf',v_period.period_end,'original',p_original_cents,'changes',p_change_orders_cents,'eac',p_eac_cents,'sources',v_sources,'note',trim(p_note));
  if p_contract_id is not null then v_basis := v_basis || jsonb_build_object('contractId',p_contract_id); end if;
  v_hash := encode(sha256(convert_to(v_basis::text,'UTF8')),'hex');
  select * into v_prior from public.poc_snapshots where org_id=p_org_id and project_id=p_project_id and contract_id is not distinct from p_contract_id and as_of=v_period.period_end order by created_at desc,id desc limit 1;
  if found and v_prior.preparation->>'basisHash'=v_hash and v_prior.earned_revenue_cents=v_earned and v_prior.billed_cents=v_billed and v_prior.cost_to_date_cents=v_cost then return v_prior.id; end if;
  v_preparation := v_preparation || jsonb_build_object('basisHash',v_hash,'priorSnapshotId',v_prior.id);
  v_hash := encode(sha256(convert_to(v_hash||coalesce(v_prior.id::text,''),'UTF8')),'hex');
  insert into public.poc_snapshots(org_id,project_id,contract_id,as_of,original_contract_cents,approved_change_orders_cents,revised_contract_cents,cost_to_date_cents,eac_cents,percent_complete,earned_revenue_cents,billed_cents,over_under_cents,forecast_gross_profit_cents,inputs_hash,warnings,preparation,created_at)
  values(p_org_id,p_project_id,p_contract_id,v_period.period_end,p_original_cents,p_change_orders_cents,v_contract,v_cost,p_eac_cents,round(v_ratio,5),v_earned,v_billed,v_billed-v_earned,v_contract-p_eac_cents,v_hash,'[]',v_preparation,greatest(clock_timestamp(),v_prior.created_at+interval '1 microsecond'))
  on conflict(org_id,project_id,contract_id,as_of,inputs_hash) do nothing returning id into v_id;
  if v_id is null then select id into v_id from public.poc_snapshots where org_id=p_org_id and project_id=p_project_id and contract_id is not distinct from p_contract_id and as_of=v_period.period_end and inputs_hash=v_hash; end if;
  return v_id;
end;
$$;
revoke all on function public.prepare_books_wip_atomic(uuid,uuid,uuid,uuid,bigint,bigint,bigint,text,uuid) from public,anon,authenticated;
grant execute on function public.prepare_books_wip_atomic(uuid,uuid,uuid,uuid,bigint,bigint,bigint,text,uuid) to service_role;

drop function public.carry_forward_books_wip_atomic(uuid,uuid,uuid,uuid,text);
create or replace function public.carry_forward_books_wip_atomic(p_org_id uuid,p_period_id uuid,p_project_id uuid,p_actor_id uuid,p_note text,p_contract_id uuid default null)
returns uuid language plpgsql security definer set search_path=public as $$
declare
  v_target public.accounting_periods%rowtype;
  v_prior public.poc_snapshots%rowtype;
  v_prior_period uuid;
  v_sources jsonb;
  v_latest public.poc_snapshots%rowtype;
  v_basis text;
  v_hash text;
  v_id uuid;
begin
  select * into v_target from public.accounting_periods where id=p_period_id and org_id=p_org_id for update;
  if not found then raise exception 'Accounting period not found'; end if;
  if v_target.status not in ('open','reopened') then raise exception 'Reopen the period before carrying WIP forward'; end if;
  if v_target.period_end>(now() at time zone 'UTC')::date then raise exception 'Cannot carry WIP into a future period end'; end if;
  if p_actor_id is null or not exists(select 1 from public.app_users where id=p_actor_id) then raise exception 'WIP preparer is required'; end if;
  if not exists(select 1 from public.projects where id=p_project_id and org_id=p_org_id and status='completed') then raise exception 'Only completed projects can carry a final WIP estimate forward'; end if;
  perform public.books_assert_wip_scope(p_org_id,p_project_id,p_contract_id,v_target.period_end);
  if length(trim(coalesce(p_note,'')))<10 then raise exception 'Confirm why the final contract and estimate remain unchanged'; end if;
  select s.* into v_prior from public.poc_snapshots s
    join public.accounting_periods p on p.org_id=s.org_id and p.period_end=s.as_of and p.status='closed'
    join public.books_close_items c on c.period_id=p.id and c.org_id=p.org_id and c.code='poc_snapshots'
    where s.org_id=p_org_id and s.project_id=p_project_id and s.contract_id is not distinct from p_contract_id and s.as_of<v_target.period_end
      and s.preparation->>'kind'='period_prepared'
      and exists(select 1 from jsonb_array_elements(coalesce(c.support_review->'snapshots','[]'::jsonb)) e where e->>'snapshotId'=s.id::text and e->>'inputsHash'=s.inputs_hash)
    order by s.as_of desc,s.created_at desc,s.id desc limit 1;
  if not found then raise exception 'No approved closed-period WIP position is available'; end if;
  select id into v_prior_period from public.accounting_periods where org_id=p_org_id and period_end=v_prior.as_of and status='closed' for share;
  if not found then raise exception 'Prior accounting period was reopened; review its corrected WIP first'; end if;
  if v_prior.eac_cents<=0 or v_prior.revised_contract_cents<=0 or v_prior.cost_to_date_cents<>v_prior.eac_cents or v_prior.earned_revenue_cents<>v_prior.revised_contract_cents then raise exception 'Prior WIP is not a fully earned final estimate'; end if;
  v_sources:=public.books_wip_source_evidence(p_org_id,p_project_id,v_target.period_end,p_contract_id);
  if v_sources is distinct from v_prior.preparation->'sources' then raise exception 'Dated costs or billings changed; prepare a revised period-end estimate'; end if;
  select * into v_latest from public.poc_snapshots where org_id=p_org_id and project_id=p_project_id and contract_id is not distinct from p_contract_id and as_of=v_target.period_end order by created_at desc,id desc limit 1;
  v_basis:=encode(sha256(convert_to(jsonb_build_object('carriedFrom',v_prior.id,'period',p_period_id,'note',trim(p_note))::text,'UTF8')),'hex');
  if found and v_latest.preparation->>'basisHash'=v_basis then return v_latest.id; end if;
  v_hash:=encode(sha256(convert_to(v_basis||coalesce(v_latest.id::text,''),'UTF8')),'hex');
  insert into public.poc_snapshots(org_id,project_id,contract_id,as_of,original_contract_cents,approved_change_orders_cents,revised_contract_cents,cost_to_date_cents,eac_cents,percent_complete,earned_revenue_cents,billed_cents,over_under_cents,forecast_gross_profit_cents,inputs_hash,warnings,preparation,created_at)
  values(p_org_id,p_project_id,p_contract_id,v_target.period_end,v_prior.original_contract_cents,v_prior.approved_change_orders_cents,v_prior.revised_contract_cents,v_prior.cost_to_date_cents,v_prior.eac_cents,1,v_prior.earned_revenue_cents,v_prior.billed_cents,v_prior.over_under_cents,v_prior.forecast_gross_profit_cents,v_hash,v_prior.warnings,
    jsonb_build_object('kind','period_prepared','periodId',p_period_id,'preparedBy',p_actor_id,'preparedAt',now(),'note','Carryforward of approved snapshot '||v_prior.id::text||' from '||v_prior.as_of::text||'. Confirmed unchanged: '||trim(p_note),'sources',v_sources,'basisHash',v_basis,'priorSnapshotId',v_latest.id,'carriedFromSnapshotId',v_prior.id,'carriedFromPeriodId',v_prior_period),
    greatest(clock_timestamp(),v_latest.created_at+interval '1 microsecond')) returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.carry_forward_books_wip_atomic(uuid,uuid,uuid,uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.carry_forward_books_wip_atomic(uuid,uuid,uuid,uuid,text,uuid) to service_role;

create or replace function public.books_wip_financial_sources_current(p_org_id uuid,p_snapshot_ids uuid[])
returns boolean language sql stable security definer set search_path=public as $$
  select not exists(
    select 1 from unnest(p_snapshot_ids) requested(id)
    left join public.poc_snapshots s on s.id=requested.id and s.org_id=p_org_id
    where s.id is null or s.eac_cents<=0 or s.cost_to_date_cents<0 or s.cost_to_date_cents>s.eac_cents or s.revised_contract_cents<=0
      or s.earned_revenue_cents is distinct from case when s.eac_cents>0 then div(s.revised_contract_cents::numeric*s.cost_to_date_cents*2+s.eac_cents,s.eac_cents::numeric*2)::bigint end
      or s.over_under_cents::numeric is distinct from s.billed_cents::numeric-s.earned_revenue_cents
      or s.forecast_gross_profit_cents::numeric is distinct from s.revised_contract_cents::numeric-s.eac_cents
      or s.preparation->>'kind' is distinct from 'period_prepared'
      or s.preparation->'sources' is distinct from public.books_wip_source_evidence(p_org_id,s.project_id,s.as_of,s.contract_id)
      or public.books_wip_contract_scoped(p_org_id,s.project_id,s.as_of) is distinct from (s.contract_id is not null)
  );
$$;

create or replace function public.books_wip_sources_current(p_org_id uuid,p_snapshot_ids uuid[])
returns boolean language sql stable security definer set search_path=public as $$
  select public.books_wip_financial_sources_current(p_org_id,p_snapshot_ids) and not exists(
    select 1 from public.poc_snapshots s where s.org_id=p_org_id and s.id=any(p_snapshot_ids)
      and s.preparation->>'revenueAllocationRequired'='true' and jsonb_array_length(s.revenue_allocations)=0
  ) and not exists(
    select 1 from public.poc_snapshots s cross join lateral jsonb_array_elements(s.revenue_allocations) allocation
    left join public.gl_accounts a on a.id=(allocation->>'account_id')::uuid and a.org_id=s.org_id
    where s.org_id=p_org_id and s.id=any(p_snapshot_ids) and (
      a.id is null or not a.active or a.account_type<>'income' or a.code is distinct from allocation->>'account_code'
      or (allocation->>'cost_code_id' is not null and not exists(select 1 from public.cost_codes c where c.org_id=s.org_id and c.id=(allocation->>'cost_code_id')::uuid))
      or (allocation->>'contract_id' is not null and not exists(select 1 from public.contracts c where c.org_id=s.org_id and c.project_id=s.project_id and c.id=(allocation->>'contract_id')::uuid))
      or (s.contract_id is not null and allocation->>'contract_id' is distinct from s.contract_id::text)
    )
  );
$$;

create or replace function public.review_books_wip_atomic(p_org_id uuid, p_period_id uuid, p_actor_id uuid, p_review jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_period public.accounting_periods%rowtype;
  v_item jsonb;
  v_snapshot public.poc_snapshots%rowtype;
  v_latest uuid;
  v_review jsonb;
begin
  select * into v_period from public.accounting_periods where id=p_period_id and org_id=p_org_id for update;
  if not found then raise exception 'Accounting period not found'; end if;
  if v_period.status not in ('open','reopened') then raise exception 'Reopen the period before reviewing WIP'; end if;
  if p_actor_id is null or not exists(select 1 from public.app_users where id=p_actor_id) then raise exception 'WIP reviewer is required'; end if;
  if jsonb_typeof(p_review->'snapshots') is distinct from 'array' or length(trim(coalesce(p_review->>'note',''))) < 10 then raise exception 'WIP evidence and review explanation are required'; end if;
  if jsonb_array_length(p_review->'snapshots')=0 then raise exception 'WIP review has no projects'; end if;
  if (select count(*) from jsonb_array_elements(p_review->'snapshots')) <> (select count(distinct (value->>'projectId', coalesce(value->>'contractId',''))) from jsonb_array_elements(p_review->'snapshots')) then raise exception 'Duplicate WIP project evidence'; end if;
  for v_item in select value from jsonb_array_elements(p_review->'snapshots') loop
    select * into v_snapshot from public.poc_snapshots
      where id=(v_item->>'snapshotId')::uuid and org_id=p_org_id and project_id=(v_item->>'projectId')::uuid
        and contract_id is not distinct from nullif(v_item->>'contractId','')::uuid;
    if not found then raise exception 'WIP snapshot is outside this organization, project or contract'; end if;
    perform public.books_assert_loss_wip_supported(p_org_id,v_snapshot.id);
    if v_snapshot.as_of <> v_period.period_end or (v_item->>'asOf')::date is distinct from v_snapshot.as_of
      or v_snapshot.inputs_hash is distinct from v_item->>'inputsHash'
      or v_snapshot.earned_revenue_cents is distinct from (v_item->>'earnedRevenueCents')::bigint then
      raise exception 'WIP snapshot evidence changed';
    end if;
    if not public.books_wip_sources_current(p_org_id,array[v_snapshot.id]) then raise exception 'WIP source evidence changed or needs period preparation'; end if;
    if v_snapshot.warnings ?| array['missing_contract_value','missing_eac','negative_actual_cost','missing_budget','eac_below_actual_cost'] then raise exception 'WIP inputs require correction before approval'; end if;
    select id into v_latest from public.poc_snapshots where org_id=p_org_id and project_id=v_snapshot.project_id and contract_id is not distinct from v_snapshot.contract_id and as_of=v_period.period_end order by created_at desc,id desc limit 1;
    if v_latest <> v_snapshot.id then raise exception 'WIP snapshot superseded; reload before reviewing'; end if;
  end loop;
  v_review := p_review || jsonb_build_object('reviewerId',p_actor_id,'reviewedAt',now());
  insert into public.books_close_items(org_id,period_id,code,label,category,blocking,status,support_review,acknowledged_by,acknowledged_at)
    values(p_org_id,p_period_id,'poc_snapshots','WIP reviewed through period end','construction',true,'pending',v_review,p_actor_id,now())
    on conflict(period_id,code) do update set support_review=excluded.support_review,acknowledged_by=excluded.acknowledged_by,acknowledged_at=excluded.acknowledged_at,updated_at=now();
  return v_review;
end;
$$;

-- Revenue allocation inside a contract scope stays inside that contract.
create or replace function public.books_validate_wip_revenue_allocations()
returns trigger language plpgsql security definer set search_path=public as $$
declare v_row jsonb; v_total numeric:=0; v_account public.gl_accounts%rowtype; v_prior public.poc_snapshots%rowtype;
begin
  if new.preparation->>'carriedFromSnapshotId' is not null then
    select * into v_prior from public.poc_snapshots where id=(new.preparation->>'carriedFromSnapshotId')::uuid and org_id=new.org_id and project_id=new.project_id and contract_id is not distinct from new.contract_id;
    if not found then raise exception 'Carried WIP allocation evidence is outside the project or contract'; end if;
    new.revenue_allocations:=v_prior.revenue_allocations;
  end if;
  if jsonb_array_length(new.revenue_allocations)=0 and new.preparation->>'priorSnapshotId' is not null then
    select * into v_prior from public.poc_snapshots where id=(new.preparation->>'priorSnapshotId')::uuid and org_id=new.org_id and project_id=new.project_id and contract_id is not distinct from new.contract_id;
    if found and jsonb_array_length(v_prior.revenue_allocations)>0 then
      if v_prior.revised_contract_cents=new.revised_contract_cents then
        new.revenue_allocations:=v_prior.revenue_allocations;
        new.preparation:=new.preparation || jsonb_build_object('revenueAllocationInheritedFrom',v_prior.id,'revenueAllocationNote',v_prior.preparation->'revenueAllocationNote');
      else
        new.preparation:=new.preparation || jsonb_build_object('revenueAllocationRequired',true);
      end if;
    elsif found and v_prior.preparation->>'revenueAllocationRequired'='true' then
      new.preparation:=new.preparation || jsonb_build_object('revenueAllocationRequired',true);
    end if;
  end if;
  if jsonb_array_length(new.revenue_allocations)=0 then return new; end if;
  if jsonb_array_length(new.revenue_allocations)>100 then raise exception 'At most 100 WIP revenue allocations are supported'; end if;
  for v_row in select value from jsonb_array_elements(new.revenue_allocations) loop
    if jsonb_typeof(v_row) is distinct from 'object' or coalesce(v_row->>'contract_cents','') !~ '^[1-9][0-9]*$'
      or (v_row->>'contract_cents')::numeric>9007199254740991 then raise exception 'WIP allocation contract amounts must be positive safe integer cents'; end if;
    select * into v_account from public.gl_accounts where id=(v_row->>'account_id')::uuid and org_id=new.org_id for share;
    if not found or v_account.account_type<>'income' or not v_account.active or v_account.code is distinct from v_row->>'account_code' then raise exception 'WIP revenue allocation requires the current active income account'; end if;
    if v_row->>'cost_code_id' is not null and not exists(select 1 from public.cost_codes where id=(v_row->>'cost_code_id')::uuid and org_id=new.org_id) then raise exception 'WIP revenue cost code is outside the organization'; end if;
    if v_row->>'contract_id' is not null and not exists(select 1 from public.contracts where id=(v_row->>'contract_id')::uuid and org_id=new.org_id and project_id=new.project_id and parent_contract_id is null and status in ('active','amended','completed','terminated')) then raise exception 'WIP revenue contract is outside the primary project scope'; end if;
    if new.contract_id is not null and v_row->>'contract_id' is distinct from new.contract_id::text then raise exception 'A contract''s WIP revenue is allocated within that contract'; end if;
    v_total:=v_total+(v_row->>'contract_cents')::numeric;
  end loop;
  if v_total<>new.revised_contract_cents then raise exception 'Revenue allocation contract amounts must equal the reviewed revised contract'; end if;
  if (select count(*) from jsonb_array_elements(new.revenue_allocations))<>(select count(distinct jsonb_build_array(value->>'account_id',value->>'contract_id',value->>'cost_code_id')) from jsonb_array_elements(new.revenue_allocations)) then raise exception 'Duplicate WIP revenue allocation bucket'; end if;
  return new;
end;
$$;

create or replace function public.allocate_books_wip_revenue_atomic(p_org_id uuid,p_period_id uuid,p_snapshot_id uuid,p_actor_id uuid,p_allocations jsonb,p_note text)
returns uuid language plpgsql security definer set search_path=public as $$
declare v_period public.accounting_periods%rowtype; v_prior public.poc_snapshots%rowtype; v_latest public.poc_snapshots%rowtype; v_next public.poc_snapshots%rowtype; v_hash text; v_allocations jsonb;
begin
  select * into v_period from public.accounting_periods where id=p_period_id and org_id=p_org_id for update;
  if not found or v_period.status not in ('open','reopened') then raise exception 'Reopen the period before allocating WIP revenue'; end if;
  if p_actor_id is null or not exists(select 1 from public.app_users where id=p_actor_id) then raise exception 'Revenue allocation preparer is required'; end if;
  if length(trim(coalesce(p_note,'')))<10 or length(p_note)>4000 then raise exception 'Explain the revenue allocation basis'; end if;
  if jsonb_typeof(p_allocations) is distinct from 'array' or jsonb_array_length(p_allocations)=0 then raise exception 'Revenue allocation evidence is required'; end if;
  select * into v_prior from public.poc_snapshots where id=p_snapshot_id and org_id=p_org_id and as_of=v_period.period_end;
  if not found or not public.books_wip_financial_sources_current(p_org_id,array[p_snapshot_id]) then raise exception 'Current prepared period-end WIP is required'; end if;
  perform 1 from public.projects where id=v_prior.project_id and org_id=p_org_id for update;
  select jsonb_agg(jsonb_build_object('account_id',a.id,'account_code',a.code,'contract_cents',value->'contract_cents','contract_id',value->'contract_id','cost_code_id',value->'cost_code_id') order by value->>'account_id',coalesce(value->>'contract_id',''),coalesce(value->>'cost_code_id','')) into v_allocations
    from jsonb_array_elements(p_allocations) join public.gl_accounts a on a.id=(value->>'account_id')::uuid and a.org_id=p_org_id;
  if jsonb_array_length(coalesce(v_allocations,'[]'))<>jsonb_array_length(p_allocations) then raise exception 'Income account is outside the organization'; end if;
  v_hash:=encode(sha256(convert_to(v_prior.inputs_hash||v_allocations::text||trim(p_note),'UTF8')),'hex');
  select * into v_latest from public.poc_snapshots where org_id=p_org_id and project_id=v_prior.project_id and contract_id is not distinct from v_prior.contract_id and as_of=v_period.period_end order by created_at desc,id desc limit 1;
  if v_latest.preparation->>'revenueAllocationHash'=v_hash then return v_latest.id; end if;
  if v_latest.id<>v_prior.id then raise exception 'WIP snapshot was superseded; reload revenue allocations'; end if;
  v_next:=v_prior;
  v_next.id:=gen_random_uuid(); v_next.inputs_hash:=v_hash; v_next.revenue_allocations:=v_allocations;
  v_next.created_at:=greatest(clock_timestamp(),v_prior.created_at+interval '1 microsecond');
  v_next.preparation:=v_prior.preparation || jsonb_build_object('revenueAllocationRequired',false,'revenueAllocationHash',v_hash,'revenueAllocationNote',trim(p_note),'revenueAllocationPreparedBy',p_actor_id,'revenueAllocationPreparedAt',now(),'priorSnapshotId',v_prior.id);
  v_next.preparation:=v_next.preparation-'carriedFromSnapshotId';
  insert into public.poc_snapshots select (v_next).*;
  return v_next.id;
end;
$$;

-- The loss provision is a contract's own: its revenue, its reserve, never netted.
create or replace function public.post_books_expected_loss_atomic(p_org_id uuid,p_period_id uuid,p_snapshot_id uuid,p_actor_id uuid,p_policy_version integer,p_projection_version integer)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_period public.accounting_periods%rowtype;
  v_snapshot public.poc_snapshots%rowtype;
  v_latest uuid;
  v_total bigint;
  v_incurred bigint;
  v_target bigint;
  v_balance bigint;
  v_delta bigint;
  v_liability uuid;
  v_expense uuid;
  v_revision integer;
  v_entry uuid;
  v_dimensions jsonb;
  v_recognized bigint;
  v_scope text;
begin
  select * into v_period from public.accounting_periods where org_id=p_org_id and id=p_period_id for update;
  if not found or v_period.status<>'reviewing' then raise exception 'Expected-loss posting requires the period close review'; end if;
  select * into v_snapshot from public.poc_snapshots where org_id=p_org_id and id=p_snapshot_id and as_of=v_period.period_end;
  if not found then raise exception 'Exact period-end WIP snapshot is required'; end if;
  perform 1 from public.projects where org_id=p_org_id and id=v_snapshot.project_id for update;
  perform public.books_assert_loss_wip_supported(p_org_id,v_snapshot.id);
  if not public.books_wip_financial_sources_current(p_org_id,array[p_snapshot_id]) then raise exception 'WIP evidence changed before loss provisioning'; end if;
  select id into v_latest from public.poc_snapshots where org_id=p_org_id and project_id=v_snapshot.project_id and contract_id is not distinct from v_snapshot.contract_id and as_of=v_period.period_end order by created_at desc,id desc limit 1;
  if v_latest<>p_snapshot_id then raise exception 'WIP snapshot was superseded'; end if;
  if not exists(select 1 from public.books_close_items c, lateral jsonb_array_elements(coalesce(c.support_review->'snapshots','[]'::jsonb)) e
    where c.org_id=p_org_id and c.period_id=p_period_id and c.code='poc_snapshots' and c.support_review->>'reviewerId' is not null and e->>'snapshotId'=p_snapshot_id::text and e->>'inputsHash'=v_snapshot.inputs_hash) then
    raise exception 'Expected-loss provision requires approved WIP evidence';
  end if;
  select coalesce(sum(l.credit_cents-l.debit_cents),0) into v_recognized from public.journal_lines l
    join public.journal_entries e on e.id=l.entry_id and e.org_id=l.org_id
    join public.gl_accounts a on a.id=l.account_id and a.org_id=l.org_id
    where l.org_id=p_org_id and l.project_id=v_snapshot.project_id
      and (v_snapshot.contract_id is null or l.dimensions->>'contract_id'=v_snapshot.contract_id::text)
      and (a.code='4000' or e.source_type='revenue_recognition' or exists(select 1 from public.journal_entries original where original.id=e.reversal_of_entry_id and original.org_id=e.org_id and original.source_type='revenue_recognition')) and a.account_type='income' and e.entry_kind<>'closing' and e.status in ('posted','reversed') and e.entry_date<=v_period.period_end;
  if v_recognized<>v_snapshot.earned_revenue_cents then raise exception 'Post reviewed WIP revenue before the expected-loss provision'; end if;
  v_total:=greatest(0,v_snapshot.eac_cents-v_snapshot.revised_contract_cents);
  v_incurred:=greatest(0,v_snapshot.cost_to_date_cents-v_snapshot.earned_revenue_cents);
  v_target:=greatest(0,v_total-v_incurred);
  insert into public.gl_accounts(org_id,code,name,account_type,subtype,normal_balance,cash_flow_category,is_system,active) values
    (p_org_id,'2360','Expected contract loss reserve','liability','expected_contract_loss_reserve','credit','operating',true,true),
    (p_org_id,'5060','Expected contract loss provision','cogs','expected_contract_loss_expense','debit','operating',true,true)
    on conflict(org_id,code) do nothing;
  select id into v_liability from public.gl_accounts where org_id=p_org_id and code='2360' and account_type='liability' and subtype='expected_contract_loss_reserve' and normal_balance='credit' and active;
  select id into v_expense from public.gl_accounts where org_id=p_org_id and code='5060' and account_type='cogs' and subtype='expected_contract_loss_expense' and normal_balance='debit' and active;
  if v_liability is null or v_expense is null then raise exception 'Expected-loss account codes conflict with the organization chart'; end if;
  select coalesce(sum(l.credit_cents-l.debit_cents),0) into v_balance from public.journal_lines l join public.journal_entries e on e.id=l.entry_id and e.org_id=l.org_id
    where l.org_id=p_org_id and l.project_id=v_snapshot.project_id and l.account_id=v_liability and e.status in ('posted','reversed') and e.entry_date<=v_period.period_end
      and (v_snapshot.contract_id is null or l.dimensions->>'contract_id'=v_snapshot.contract_id::text);
  v_delta:=v_target-v_balance;
  if abs(v_delta::numeric)>9007199254740991 then raise exception 'Loss provision adjustment exceeds safe integer cents'; end if;
  if v_delta=0 then return jsonb_build_object('posted',false,'deltaCents',0,'reserveCents',v_target,'totalExpectedLossCents',v_total); end if;
  v_scope := v_snapshot.project_id::text || coalesce(':'||v_snapshot.contract_id::text,'');
  select count(*)+1 into v_revision from public.journal_entries where org_id=p_org_id and source_type='expected_loss_provision' and posting_key like 'expected_loss:'||v_scope||':'||p_period_id||':%';
  v_dimensions:=jsonb_build_object('expected_loss_provision',true,'wip_snapshot_id',p_snapshot_id,'wip_inputs_hash',v_snapshot.inputs_hash,'total_expected_loss_cents',v_total,'incurred_loss_cents',v_incurred,'reserve_target_cents',v_target);
  if v_snapshot.contract_id is not null then v_dimensions:=v_dimensions || jsonb_build_object('contract_id',v_snapshot.contract_id); end if;
  v_entry:=public.post_books_journal_entry(p_org_id,jsonb_build_object('entry_date',v_period.period_end,'entry_kind','poc','memo','Expected construction contract loss provision','posting_key','expected_loss:'||v_scope||':'||p_period_id||':'||v_revision,'projection_version',p_projection_version,'policy_version',p_policy_version,'source_type','expected_loss_provision','source_id',v_snapshot.project_id,'created_by',p_actor_id),jsonb_build_array(
    jsonb_build_object('line_no',1,'account_id',v_expense,'project_id',v_snapshot.project_id,'debit_cents',greatest(0,v_delta),'credit_cents',greatest(0,-v_delta),'dimensions',v_dimensions),
    jsonb_build_object('line_no',2,'account_id',v_liability,'project_id',v_snapshot.project_id,'debit_cents',greatest(0,-v_delta),'credit_cents',greatest(0,v_delta),'dimensions',v_dimensions)));
  return jsonb_build_object('posted',true,'entryId',v_entry,'deltaCents',v_delta,'reserveCents',v_target,'totalExpectedLossCents',v_total);
end;
$$;

-- Assign an invoice that names no contract to the contract it bills. Only once:
-- an invoice that already names its contract keeps it.
create or replace function public.assign_books_invoice_contract(p_org_id uuid, p_invoice_id uuid, p_contract_id uuid, p_actor_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_invoice public.invoices%rowtype;
begin
  select * into v_invoice from public.invoices where org_id=p_org_id and id=p_invoice_id for update;
  if not found then raise exception 'Invoice not found'; end if;
  if p_actor_id is null or not exists(select 1 from public.app_users where id=p_actor_id) then raise exception 'An assigning member is required'; end if;
  if public.books_invoice_contract(p_org_id, p_invoice_id) is not null then raise exception 'This invoice already names the contract it bills'; end if;
  if not exists(select 1 from public.contracts where id=p_contract_id and org_id=p_org_id and project_id=v_invoice.project_id and parent_contract_id is null and status in ('active','amended','completed','terminated')) then
    raise exception 'Choose one of the project''s contracts';
  end if;
  update public.invoices set metadata = coalesce(metadata,'{}'::jsonb) || jsonb_build_object('source_contract_id', p_contract_id, 'contract_assigned_by', p_actor_id, 'contract_assigned_at', now())
    where org_id=p_org_id and id=p_invoice_id;
  return jsonb_build_object('invoiceId', p_invoice_id, 'contractId', p_contract_id);
end;
$$;
revoke all on function public.assign_books_invoice_contract(uuid,uuid,uuid,uuid) from public, anon, authenticated;
grant execute on function public.assign_books_invoice_contract(uuid,uuid,uuid,uuid) to service_role;
