alter table public.poc_snapshots add column preparation jsonb not null default '{}'::jsonb check(jsonb_typeof(preparation)='object');

create or replace function public.books_wip_source_evidence(p_org_id uuid,p_project_id uuid,p_as_of date)
returns jsonb language sql stable security definer set search_path=public as $$
  select jsonb_build_object(
    'costs',coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'incurredOn',c.incurred_on,'cents',c.cost_cents) order by c.id)
      from public.job_cost_entries c where c.org_id=p_org_id and c.project_id=p_project_id and c.status='posted' and c.incurred_on<=p_as_of),'[]'::jsonb),
    'billings',coalesce((select jsonb_agg(jsonb_build_object('id',i.id,'issueDate',i.issue_date,'cents',i.total_cents-coalesce(i.tax_cents,0)+coalesce((select sum(r.amount_cents) from public.retainage r where r.org_id=p_org_id and r.invoice_id=i.id),0)) order by i.id)
      from public.invoices i where i.org_id=p_org_id and i.project_id=p_project_id and i.issue_date<=p_as_of
      and (i.status in ('sent','partial','paid','overdue') or (i.status='void' and i.metadata->>'voided_at'>=((p_as_of+1)::text||'T00:00:00')))
      and coalesce(i.metadata->>'invoice_kind','') <> 'earnest_deposit'
      and not exists(select 1 from public.retainage r where r.org_id=p_org_id and r.release_invoice_id=i.id)),'[]'::jsonb),
    'credits',coalesce((select jsonb_agg(jsonb_build_object('id',a.id,'effectiveDate',a.effective_date,'cents',a.amount_cents-coalesce(a.tax_cents,0)) order by a.id)
      from public.receivable_adjustments a where a.org_id=p_org_id and a.project_id=p_project_id and a.adjustment_type='credit_memo' and a.effective_date<=p_as_of
      and (a.status='posted' or a.voided_at>=((p_as_of+1)::timestamp at time zone 'UTC'))),'[]'::jsonb)
  );
$$;
revoke all on function public.books_wip_source_evidence(uuid,uuid,date) from public,anon,authenticated;
grant execute on function public.books_wip_source_evidence(uuid,uuid,date) to service_role;

create or replace function public.prepare_books_wip_atomic(
  p_org_id uuid,p_period_id uuid,p_project_id uuid,p_actor_id uuid,
  p_original_cents bigint,p_change_orders_cents bigint,p_eac_cents bigint,p_note text
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
  v_id uuid;
  v_preparation jsonb;
  v_prior public.poc_snapshots%rowtype;
begin
  select * into v_period from public.accounting_periods where id=p_period_id and org_id=p_org_id for update;
  if not found then raise exception 'Accounting period not found'; end if;
  if v_period.status not in ('open','reopened') then raise exception 'Reopen the period before preparing WIP'; end if;
  if v_period.period_end > (now() at time zone 'UTC')::date then raise exception 'Cannot prepare future period-end WIP'; end if;
  if not exists(select 1 from public.projects where id=p_project_id and org_id=p_org_id) then raise exception 'Project is outside this organization'; end if;
  if p_actor_id is null or not exists(select 1 from public.app_users where id=p_actor_id) then raise exception 'WIP preparer is required'; end if;
  if length(trim(coalesce(p_note,''))) < 10 then raise exception 'Explain the period-end contract and estimate basis'; end if;
  if p_original_cents is null or p_change_orders_cents is null or p_eac_cents is null or p_original_cents < 0 or p_eac_cents <= 0 then raise exception 'Valid period-end contract and EAC are required'; end if;
  v_contract := p_original_cents+p_change_orders_cents;
  if v_contract <= 0 then raise exception 'Revised contract value must be positive'; end if;
  -- One statement snapshot for all dated operational evidence. Keep the observations
  -- with the immutable WIP row; estimates are explicitly supplied, not inferred from
  -- the current budget and disguised as historical values.
  v_sources := public.books_wip_source_evidence(p_org_id,p_project_id,v_period.period_end);
  select coalesce(sum((value->>'cents')::bigint),0) into v_cost from jsonb_array_elements(v_sources->'costs');
  select coalesce(sum((value->>'cents')::bigint),0) into v_billed from jsonb_array_elements(v_sources->'billings');
  v_billed := v_billed-(select coalesce(sum((value->>'cents')::bigint),0) from jsonb_array_elements(v_sources->'credits'));
  if v_cost<0 then raise exception 'Negative cumulative cost requires correction before WIP preparation'; end if;
  if p_eac_cents<v_cost then raise exception 'EAC cannot be below incurred cost'; end if;
  if greatest(abs(v_cost),abs(v_billed),abs(v_contract),abs(p_eac_cents),abs(p_original_cents),abs(p_change_orders_cents))>9007199254740991 then raise exception 'WIP amounts exceed safe integer cents'; end if;
  v_ratio := least(1::numeric,v_cost::numeric/p_eac_cents);
  v_earned := round(v_contract::numeric*v_ratio);
  v_preparation := jsonb_build_object('kind','period_prepared','periodId',p_period_id,'preparedBy',p_actor_id,'preparedAt',now(),'note',trim(p_note),'sources',v_sources);
  v_hash := encode(sha256(convert_to(jsonb_build_object('asOf',v_period.period_end,'original',p_original_cents,'changes',p_change_orders_cents,'eac',p_eac_cents,'sources',v_sources,'note',trim(p_note))::text,'UTF8')),'hex');
  select * into v_prior from public.poc_snapshots where org_id=p_org_id and project_id=p_project_id and as_of=v_period.period_end order by created_at desc,id desc limit 1;
  if found and v_prior.preparation->>'basisHash'=v_hash then return v_prior.id; end if;
  v_preparation := v_preparation || jsonb_build_object('basisHash',v_hash,'priorSnapshotId',v_prior.id);
  v_hash := encode(sha256(convert_to(v_hash||coalesce(v_prior.id::text,''),'UTF8')),'hex');
  insert into public.poc_snapshots(org_id,project_id,as_of,original_contract_cents,approved_change_orders_cents,revised_contract_cents,cost_to_date_cents,eac_cents,percent_complete,earned_revenue_cents,billed_cents,over_under_cents,forecast_gross_profit_cents,inputs_hash,warnings,preparation,created_at)
  values(p_org_id,p_project_id,v_period.period_end,p_original_cents,p_change_orders_cents,v_contract,v_cost,p_eac_cents,round(v_ratio,5),v_earned,v_billed,v_billed-v_earned,v_contract-p_eac_cents,v_hash,'[]',v_preparation,greatest(clock_timestamp(),v_prior.created_at+interval '1 microsecond'))
  on conflict(org_id,project_id,as_of,inputs_hash) do nothing returning id into v_id;
  if v_id is null then select id into v_id from public.poc_snapshots where org_id=p_org_id and project_id=p_project_id and as_of=v_period.period_end and inputs_hash=v_hash; end if;
  return v_id;
end;
$$;
revoke all on function public.prepare_books_wip_atomic(uuid,uuid,uuid,uuid,bigint,bigint,bigint,text) from public,anon,authenticated;
grant execute on function public.prepare_books_wip_atomic(uuid,uuid,uuid,uuid,bigint,bigint,bigint,text) to service_role;

create or replace function public.books_wip_sources_current(p_org_id uuid,p_snapshot_ids uuid[])
returns boolean language sql stable security definer set search_path=public as $$
  select not exists(
    select 1 from unnest(p_snapshot_ids) requested(id)
    left join public.poc_snapshots s on s.id=requested.id and s.org_id=p_org_id
    where s.id is null or s.preparation->>'kind' is distinct from 'period_prepared'
      or s.preparation->'sources' is distinct from public.books_wip_source_evidence(p_org_id,s.project_id,s.as_of)
  );
$$;
revoke all on function public.books_wip_sources_current(uuid,uuid[]) from public,anon,authenticated;
grant execute on function public.books_wip_sources_current(uuid,uuid[]) to service_role;

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
    if v_snapshot.as_of <> v_period.period_end or (v_item->>'asOf')::date is distinct from v_snapshot.as_of
      or v_snapshot.inputs_hash is distinct from v_item->>'inputsHash'
      or v_snapshot.earned_revenue_cents is distinct from (v_item->>'earnedRevenueCents')::bigint then
      raise exception 'WIP snapshot evidence changed';
    end if;
    if not public.books_wip_sources_current(p_org_id,array[v_snapshot.id]) then raise exception 'WIP source evidence changed or needs period preparation'; end if;
    if v_snapshot.warnings ? 'missing_contract_value' then raise exception 'WIP contract value is missing'; end if;
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
