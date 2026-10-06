alter table public.poc_snapshots add column revenue_allocations jsonb not null default '[]'::jsonb check (jsonb_typeof(revenue_allocations)='array');

create or replace function public.books_validate_wip_revenue_allocations()
returns trigger language plpgsql security definer set search_path=public as $$
declare v_row jsonb; v_total numeric:=0; v_account public.gl_accounts%rowtype; v_prior public.poc_snapshots%rowtype;
begin
  if new.preparation->>'carriedFromSnapshotId' is not null then
    select * into v_prior from public.poc_snapshots where id=(new.preparation->>'carriedFromSnapshotId')::uuid and org_id=new.org_id and project_id=new.project_id;
    if not found then raise exception 'Carried WIP allocation evidence is outside the project'; end if;
    new.revenue_allocations:=v_prior.revenue_allocations;
  end if;
  if jsonb_array_length(new.revenue_allocations)=0 and new.preparation->>'priorSnapshotId' is not null then
    select * into v_prior from public.poc_snapshots where id=(new.preparation->>'priorSnapshotId')::uuid and org_id=new.org_id and project_id=new.project_id;
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
    v_total:=v_total+(v_row->>'contract_cents')::numeric;
  end loop;
  if v_total<>new.revised_contract_cents then raise exception 'Revenue allocation contract amounts must equal the reviewed revised contract'; end if;
  if (select count(*) from jsonb_array_elements(new.revenue_allocations))<>(select count(distinct jsonb_build_array(value->>'account_id',value->>'contract_id',value->>'cost_code_id')) from jsonb_array_elements(new.revenue_allocations)) then raise exception 'Duplicate WIP revenue allocation bucket'; end if;
  return new;
end;
$$;
revoke all on function public.books_validate_wip_revenue_allocations() from public,anon,authenticated;
create trigger poc_snapshots_revenue_allocation_guard before insert on public.poc_snapshots for each row execute function public.books_validate_wip_revenue_allocations();

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
  -- Account codes come from the scoped chart, never from user-provided labels.
  select jsonb_agg(jsonb_build_object('account_id',a.id,'account_code',a.code,'contract_cents',value->'contract_cents','contract_id',value->'contract_id','cost_code_id',value->'cost_code_id') order by value->>'account_id',coalesce(value->>'contract_id',''),coalesce(value->>'cost_code_id','')) into v_allocations
    from jsonb_array_elements(p_allocations) join public.gl_accounts a on a.id=(value->>'account_id')::uuid and a.org_id=p_org_id;
  if jsonb_array_length(coalesce(v_allocations,'[]'))<>jsonb_array_length(p_allocations) then raise exception 'Income account is outside the organization'; end if;
  v_hash:=encode(sha256(convert_to(v_prior.inputs_hash||v_allocations::text||trim(p_note),'UTF8')),'hex');
  select * into v_latest from public.poc_snapshots where org_id=p_org_id and project_id=v_prior.project_id and as_of=v_period.period_end order by created_at desc,id desc limit 1;
  if v_latest.preparation->>'revenueAllocationHash'=v_hash then return v_latest.id; end if;
  if v_latest.id<>v_prior.id then raise exception 'WIP snapshot was superseded; reload revenue allocations'; end if;
  v_next:=v_prior;
  v_next.id:=gen_random_uuid(); v_next.inputs_hash:=v_hash; v_next.revenue_allocations:=v_allocations;
  v_next.created_at:=greatest(clock_timestamp(),v_prior.created_at+interval '1 microsecond');
  v_next.preparation:=v_prior.preparation || jsonb_build_object('revenueAllocationRequired',false,'revenueAllocationHash',v_hash,'revenueAllocationNote',trim(p_note),'revenueAllocationPreparedBy',p_actor_id,'revenueAllocationPreparedAt',now(),'priorSnapshotId',v_prior.id);
  -- An allocation revision is explicit; a previously carried estimate must not overwrite it in the insertion trigger.
  v_next.preparation:=v_next.preparation-'carriedFromSnapshotId';
  insert into public.poc_snapshots select (v_next).*;
  return v_next.id;
end;
$$;
revoke all on function public.allocate_books_wip_revenue_atomic(uuid,uuid,uuid,uuid,jsonb,text) from public,anon,authenticated;
grant execute on function public.allocate_books_wip_revenue_atomic(uuid,uuid,uuid,uuid,jsonb,text) to service_role;

-- Loss provisions use exactly the same POC income lineage as revenue recognition.
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
  if not public.books_wip_financial_sources_current(p_org_id,array[p_snapshot_id]) then raise exception 'WIP evidence changed before loss provisioning'; end if;
  select id into v_latest from public.poc_snapshots where org_id=p_org_id and project_id=v_snapshot.project_id and as_of=v_period.period_end order by created_at desc,id desc limit 1;
  if v_latest<>p_snapshot_id then raise exception 'WIP snapshot was superseded'; end if;
  if not exists(select 1 from public.books_close_items c, lateral jsonb_array_elements(coalesce(c.support_review->'snapshots','[]'::jsonb)) e
    where c.org_id=p_org_id and c.period_id=p_period_id and c.code='poc_snapshots' and c.support_review->>'reviewerId' is not null and e->>'snapshotId'=p_snapshot_id::text and e->>'inputsHash'=v_snapshot.inputs_hash) then
    raise exception 'Expected-loss provision requires approved WIP evidence';
  end if;
  select coalesce(sum(l.credit_cents-l.debit_cents),0) into v_recognized from public.journal_lines l
    join public.journal_entries e on e.id=l.entry_id and e.org_id=l.org_id
    join public.gl_accounts a on a.id=l.account_id and a.org_id=l.org_id
    where l.org_id=p_org_id and l.project_id=v_snapshot.project_id and (a.code='4000' or e.source_type='revenue_recognition' or exists(select 1 from public.journal_entries original where original.id=e.reversal_of_entry_id and original.org_id=e.org_id and original.source_type='revenue_recognition')) and a.account_type='income' and e.entry_kind<>'closing' and e.status in ('posted','reversed') and e.entry_date<=v_period.period_end;
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
      or s.preparation->'sources' is distinct from public.books_wip_source_evidence(p_org_id,s.project_id,s.as_of)
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
    )
  );
$$;
revoke all on function public.books_wip_financial_sources_current(uuid,uuid[]) from public,anon,authenticated;
grant execute on function public.books_wip_financial_sources_current(uuid,uuid[]) to service_role;
revoke all on function public.books_wip_sources_current(uuid,uuid[]) from public,anon,authenticated;
grant execute on function public.books_wip_sources_current(uuid,uuid[]) to service_role;
