-- Extend the closed subtype vocabulary for the liability and its expense.
alter table public.gl_accounts
  drop constraint if exists gl_accounts_subtype_check;
alter table public.gl_accounts
  add constraint gl_accounts_subtype_check check (subtype in (
    'cash', 'undeposited_funds', 'accounts_receivable', 'retainage_receivable',
    'costs_in_excess', 'work_in_progress', 'prepaid_expenses', 'fixed_assets',
    'accumulated_depreciation', 'other_asset', 'accounts_payable',
    'retainage_payable', 'credit_card', 'payroll_clearing', 'sales_use_tax',
    'customer_deposits', 'billings_in_excess', 'current_debt', 'long_term_debt',
    'other_liability', 'owner_equity', 'owner_contributions',
    'owner_distributions', 'retained_earnings', 'construction_revenue',
    'other_revenue', 'early_pay_discount', 'payment_fee_recovery', 'job_costs',
    'subcontractor_costs', 'material_costs', 'direct_labor', 'equipment_costs',
    'warranty_costs', 'rent', 'insurance', 'software', 'professional_fees',
    'utilities', 'bank_fees', 'interest', 'payroll', 'depreciation', 'other_expense', 'expected_contract_loss_reserve', 'expected_contract_loss_expense'
  ));

-- A project WIP schedule currently represents one primary construction contract.
-- Multiple primary contracts must not hide one contract's loss by netting profits.
create or replace function public.books_assert_single_contract_wip(p_org_id uuid,p_project_id uuid)
returns void language plpgsql security definer set search_path=public as $$
begin
  if (select count(*) from public.contracts where org_id=p_org_id and project_id=p_project_id and parent_contract_id is null and status in ('active','amended','completed','terminated'))>1 then
    raise exception 'Separate contract WIP reviews are required for projects with multiple primary contracts';
  end if;
end;
$$;
revoke all on function public.books_assert_single_contract_wip(uuid,uuid) from public,anon,authenticated;
grant execute on function public.books_assert_single_contract_wip(uuid,uuid) to service_role;

create or replace function public.books_assert_loss_wip_supported(p_org_id uuid,p_snapshot_id uuid)
returns void language plpgsql security definer set search_path=public as $$
declare v_snapshot public.poc_snapshots%rowtype;
begin
  select * into v_snapshot from public.poc_snapshots where org_id=p_org_id and id=p_snapshot_id;
  if not found then raise exception 'WIP snapshot not found'; end if;
  perform public.books_assert_single_contract_wip(p_org_id,v_snapshot.project_id);
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
revoke all on function public.books_assert_loss_wip_supported(uuid,uuid) from public,anon,authenticated;
grant execute on function public.books_assert_loss_wip_supported(uuid,uuid) to service_role;

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
begin
  select * into v_period from public.accounting_periods where org_id=p_org_id and id=p_period_id for update;
  if not found or v_period.status<>'reviewing' then raise exception 'Expected-loss posting requires the period close review'; end if;
  select * into v_snapshot from public.poc_snapshots where org_id=p_org_id and id=p_snapshot_id and as_of=v_period.period_end;
  if not found then raise exception 'Exact period-end WIP snapshot is required'; end if;
  perform 1 from public.projects where org_id=p_org_id and id=v_snapshot.project_id for update;
  perform public.books_assert_loss_wip_supported(p_org_id,v_snapshot.id);
  if not public.books_wip_sources_current(p_org_id,array[p_snapshot_id]) then raise exception 'WIP evidence changed before loss provisioning'; end if;
  select id into v_latest from public.poc_snapshots where org_id=p_org_id and project_id=v_snapshot.project_id and as_of=v_period.period_end order by created_at desc,id desc limit 1;
  if v_latest<>p_snapshot_id then raise exception 'WIP snapshot was superseded'; end if;
  if not exists(select 1 from public.books_close_items c, lateral jsonb_array_elements(coalesce(c.support_review->'snapshots','[]'::jsonb)) e
    where c.org_id=p_org_id and c.period_id=p_period_id and c.code='poc_snapshots' and c.support_review->>'reviewerId' is not null and e->>'snapshotId'=p_snapshot_id::text and e->>'inputsHash'=v_snapshot.inputs_hash) then
    raise exception 'Expected-loss provision requires approved WIP evidence';
  end if;
  select coalesce(sum(l.credit_cents-l.debit_cents),0) into v_recognized from public.journal_lines l
    join public.journal_entries e on e.id=l.entry_id and e.org_id=l.org_id
    join public.gl_accounts a on a.id=l.account_id and a.org_id=l.org_id
    where l.org_id=p_org_id and l.project_id=v_snapshot.project_id and a.code='4000' and e.status in ('posted','reversed') and e.entry_date<=v_period.period_end;
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
    where l.org_id=p_org_id and l.project_id=v_snapshot.project_id and l.account_id=v_liability and e.status in ('posted','reversed') and e.entry_date<=v_period.period_end;
  v_delta:=v_target-v_balance;
  if abs(v_delta::numeric)>9007199254740991 then raise exception 'Loss provision adjustment exceeds safe integer cents'; end if;
  if v_delta=0 then return jsonb_build_object('posted',false,'deltaCents',0,'reserveCents',v_target,'totalExpectedLossCents',v_total); end if;
  select count(*)+1 into v_revision from public.journal_entries where org_id=p_org_id and source_type='expected_loss_provision' and source_id=v_snapshot.project_id and period_id=p_period_id;
  v_dimensions:=jsonb_build_object('expected_loss_provision',true,'wip_snapshot_id',p_snapshot_id,'wip_inputs_hash',v_snapshot.inputs_hash,'total_expected_loss_cents',v_total,'incurred_loss_cents',v_incurred,'reserve_target_cents',v_target);
  v_entry:=public.post_books_journal_entry(p_org_id,jsonb_build_object('entry_date',v_period.period_end,'entry_kind','poc','memo','Expected construction contract loss provision','posting_key','expected_loss:'||v_snapshot.project_id||':'||p_period_id||':'||v_revision,'projection_version',p_projection_version,'policy_version',p_policy_version,'source_type','expected_loss_provision','source_id',v_snapshot.project_id,'created_by',p_actor_id),jsonb_build_array(
    jsonb_build_object('line_no',1,'account_id',v_expense,'project_id',v_snapshot.project_id,'debit_cents',greatest(0,v_delta),'credit_cents',greatest(0,-v_delta),'dimensions',v_dimensions),
    jsonb_build_object('line_no',2,'account_id',v_liability,'project_id',v_snapshot.project_id,'debit_cents',greatest(0,-v_delta),'credit_cents',greatest(0,v_delta),'dimensions',v_dimensions)));
  return jsonb_build_object('posted',true,'entryId',v_entry,'deltaCents',v_delta,'reserveCents',v_target,'totalExpectedLossCents',v_total);
end;
$$;
revoke all on function public.post_books_expected_loss_atomic(uuid,uuid,uuid,uuid,integer,integer) from public,anon,authenticated;
grant execute on function public.post_books_expected_loss_atomic(uuid,uuid,uuid,uuid,integer,integer) to service_role;

create or replace function public.books_guard_period_posting()
returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
declare
  period_row public.accounting_periods%rowtype;
  close_owned boolean;
begin
  if new.period_id is null then
    return new;
  end if;

  select * into period_row
  from public.accounting_periods
  where id = new.period_id and org_id = new.org_id
  for share;

  if not found or new.entry_date not between period_row.period_start and period_row.period_end then
    raise exception 'Journal entry must belong to its organization and accounting period';
  end if;
  if period_row.status = 'closed' then
    raise exception 'Accounting period is closed and cannot accept postings';
  end if;

  close_owned := (
    new.source_type in ('revenue_recognition','expected_loss_provision') and new.entry_kind = 'poc'
    and new.entry_date = period_row.period_end
  ) or (
    new.source_type = 'year_end_close' and new.entry_kind = 'closing'
    and new.source_id = period_row.id and new.entry_date = period_row.period_end
    and period_row.fiscal_period in (12, 13)
  );
  if period_row.status = 'reviewing' and close_owned is not true then
    raise exception 'Accounting period is reviewing and cannot accept operational postings';
  end if;
  return new;
end;
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
  if (select count(*) from jsonb_array_elements(p_review->'snapshots')) <> (select count(distinct value->>'projectId') from jsonb_array_elements(p_review->'snapshots')) then raise exception 'Duplicate WIP project evidence'; end if;
  for v_item in select value from jsonb_array_elements(p_review->'snapshots') loop
    select * into v_snapshot from public.poc_snapshots
      where id=(v_item->>'snapshotId')::uuid and org_id=p_org_id and project_id=(v_item->>'projectId')::uuid;
    if not found then raise exception 'WIP snapshot is outside this organization or project'; end if;
    perform public.books_assert_loss_wip_supported(p_org_id,v_snapshot.id);
    if v_snapshot.as_of <> v_period.period_end or (v_item->>'asOf')::date is distinct from v_snapshot.as_of
      or v_snapshot.inputs_hash is distinct from v_item->>'inputsHash'
      or v_snapshot.earned_revenue_cents is distinct from (v_item->>'earnedRevenueCents')::bigint then
      raise exception 'WIP snapshot evidence changed';
    end if;
    if not public.books_wip_sources_current(p_org_id,array[v_snapshot.id]) then raise exception 'WIP source evidence changed or needs period preparation'; end if;
    if v_snapshot.warnings ?| array['missing_contract_value','missing_eac','negative_actual_cost','missing_budget','eac_below_actual_cost'] then raise exception 'WIP inputs require correction before approval'; end if;
    select id into v_latest from public.poc_snapshots where org_id=p_org_id and project_id=v_snapshot.project_id and as_of=v_period.period_end order by created_at desc,id desc limit 1;
    if v_latest <> v_snapshot.id then raise exception 'WIP snapshot superseded; reload before reviewing'; end if;
  end loop;
  v_review := p_review || jsonb_build_object('reviewerId',p_actor_id,'reviewedAt',now());
  insert into public.books_close_items(org_id,period_id,code,label,category,blocking,status,support_review,acknowledged_by,acknowledged_at)
    values(p_org_id,p_period_id,'poc_snapshots','WIP reviewed through period end','construction',true,'pending',v_review,p_actor_id,now())
    on conflict(period_id,code) do update set support_review=excluded.support_review,acknowledged_by=excluded.acknowledged_by,acknowledged_at=excluded.acknowledged_at,updated_at=now();
  return v_review;
end;
$$;

