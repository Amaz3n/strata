create or replace function public.carry_forward_books_wip_atomic(p_org_id uuid,p_period_id uuid,p_project_id uuid,p_actor_id uuid,p_note text)
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
  if length(trim(coalesce(p_note,'')))<10 then raise exception 'Confirm why the final contract and estimate remain unchanged'; end if;
  select s.* into v_prior from public.poc_snapshots s
    join public.accounting_periods p on p.org_id=s.org_id and p.period_end=s.as_of and p.status='closed'
    join public.books_close_items c on c.period_id=p.id and c.org_id=p.org_id and c.code='poc_snapshots'
    where s.org_id=p_org_id and s.project_id=p_project_id and s.as_of<v_target.period_end
      and s.preparation->>'kind'='period_prepared'
      and exists(select 1 from jsonb_array_elements(coalesce(c.support_review->'snapshots','[]'::jsonb)) e where e->>'snapshotId'=s.id::text and e->>'inputsHash'=s.inputs_hash)
    order by s.as_of desc,s.created_at desc,s.id desc limit 1;
  if not found then raise exception 'No approved closed-period WIP position is available'; end if;
  select id into v_prior_period from public.accounting_periods where org_id=p_org_id and period_end=v_prior.as_of and status='closed' for share;
  if not found then raise exception 'Prior accounting period was reopened; review its corrected WIP first'; end if;
  if v_prior.eac_cents<=0 or v_prior.revised_contract_cents<=0 or v_prior.cost_to_date_cents<>v_prior.eac_cents or v_prior.earned_revenue_cents<>v_prior.revised_contract_cents then raise exception 'Prior WIP is not a fully earned final estimate'; end if;
  v_sources:=public.books_wip_source_evidence(p_org_id,p_project_id,v_target.period_end);
  if v_sources is distinct from v_prior.preparation->'sources' then raise exception 'Dated costs or billings changed; prepare a revised period-end estimate'; end if;
  select * into v_latest from public.poc_snapshots where org_id=p_org_id and project_id=p_project_id and as_of=v_target.period_end order by created_at desc,id desc limit 1;
  v_basis:=encode(sha256(convert_to(jsonb_build_object('carriedFrom',v_prior.id,'period',p_period_id,'note',trim(p_note))::text,'UTF8')),'hex');
  if found and v_latest.preparation->>'basisHash'=v_basis then return v_latest.id; end if;
  v_hash:=encode(sha256(convert_to(v_basis||coalesce(v_latest.id::text,''),'UTF8')),'hex');
  insert into public.poc_snapshots(org_id,project_id,as_of,original_contract_cents,approved_change_orders_cents,revised_contract_cents,cost_to_date_cents,eac_cents,percent_complete,earned_revenue_cents,billed_cents,over_under_cents,forecast_gross_profit_cents,inputs_hash,warnings,preparation,created_at)
  values(p_org_id,p_project_id,v_target.period_end,v_prior.original_contract_cents,v_prior.approved_change_orders_cents,v_prior.revised_contract_cents,v_prior.cost_to_date_cents,v_prior.eac_cents,1,v_prior.earned_revenue_cents,v_prior.billed_cents,v_prior.over_under_cents,v_prior.forecast_gross_profit_cents,v_hash,v_prior.warnings,
    jsonb_build_object('kind','period_prepared','periodId',p_period_id,'preparedBy',p_actor_id,'preparedAt',now(),'note','Carryforward of approved snapshot '||v_prior.id::text||' from '||v_prior.as_of::text||'. Confirmed unchanged: '||trim(p_note),'sources',v_sources,'basisHash',v_basis,'priorSnapshotId',v_latest.id,'carriedFromSnapshotId',v_prior.id,'carriedFromPeriodId',v_prior_period),
    greatest(clock_timestamp(),v_latest.created_at+interval '1 microsecond')) returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.carry_forward_books_wip_atomic(uuid,uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.carry_forward_books_wip_atomic(uuid,uuid,uuid,uuid,text) to service_role;
