-- Close integrity, WIP review and carryforward, expected losses, bank statement evidence, projection receipts, source revisions, posted-account evidence and the tax workpaper (B01, B04, B08.1, B09, B10.3, B12.1).
--
-- Consolidated before deploy (2026-10-09) from 21 unapplied migrations, in their
-- original order; each section is marked with the file it came from.

-- ==== 20261003002108_books_close_control_integrity ====
-- Close owns POC and retained earnings while ordinary posting remains frozen.
-- Check both insertion and posting of an existing draft. SHARE conflicts with
-- status updates; KEY SHARE does not protect against a non-key status update.
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
    new.source_type = 'revenue_recognition' and new.entry_kind = 'poc'
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

drop trigger if exists journal_entries_guard_period_posting on public.journal_entries;
create trigger journal_entries_guard_period_posting
  before insert or update of status, period_id, entry_date, source_type, source_id, entry_kind
  on public.journal_entries
  for each row execute function public.books_guard_period_posting();

revoke all on function public.books_guard_period_posting() from public, anon, authenticated;

-- ==== 20261003010157_books_wip_review ====
-- Save WIP review under the same period lock used by close. Snapshot rows are immutable.
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
revoke all on function public.review_books_wip_atomic(uuid,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.review_books_wip_atomic(uuid,uuid,uuid,jsonb) to service_role;

create or replace function public.books_guard_wip_snapshot_period()
returns trigger language plpgsql set search_path = public as $$
declare v_status text;
begin
  select status into v_status from public.accounting_periods
    where org_id=new.org_id and new.as_of between period_start and period_end for share;
  if v_status in ('reviewing','closed') then
    raise exception 'WIP evidence is frozen while its accounting period is %',v_status;
  end if;
  return new;
end;
$$;
create trigger poc_snapshots_period_guard before insert on public.poc_snapshots
  for each row execute function public.books_guard_wip_snapshot_period();
revoke all on function public.books_guard_wip_snapshot_period() from public,anon,authenticated;

-- ==== 20261003011254_books_historical_wip_preparation ====
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

-- ==== 20261003012630_books_completed_wip_carryforward ====
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

-- ==== 20261003013441_books_wip_input_integrity ====
-- Exact cent arithmetic and non-overridable WIP input integrity controls.
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
  v_earned := div(v_contract::numeric*v_cost*2+p_eac_cents,p_eac_cents::numeric*2);
  if abs(v_billed::numeric-v_earned)>9007199254740991 then raise exception 'WIP over-under exceeds safe integer cents'; end if;
  v_preparation := jsonb_build_object('calculationVersion',2,'kind','period_prepared','periodId',p_period_id,'preparedBy',p_actor_id,'preparedAt',now(),'note',trim(p_note),'sources',v_sources);
  v_hash := encode(sha256(convert_to(jsonb_build_object('calculationVersion',2,'asOf',v_period.period_end,'original',p_original_cents,'changes',p_change_orders_cents,'eac',p_eac_cents,'sources',v_sources,'note',trim(p_note))::text,'UTF8')),'hex');
  select * into v_prior from public.poc_snapshots where org_id=p_org_id and project_id=p_project_id and as_of=v_period.period_end order by created_at desc,id desc limit 1;
  if found and v_prior.preparation->>'basisHash'=v_hash and v_prior.earned_revenue_cents=v_earned and v_prior.billed_cents=v_billed and v_prior.cost_to_date_cents=v_cost then return v_prior.id; end if;
  v_preparation := v_preparation || jsonb_build_object('basisHash',v_hash,'priorSnapshotId',v_prior.id);
  v_hash := encode(sha256(convert_to(v_hash||coalesce(v_prior.id::text,''),'UTF8')),'hex');
  insert into public.poc_snapshots(org_id,project_id,as_of,original_contract_cents,approved_change_orders_cents,revised_contract_cents,cost_to_date_cents,eac_cents,percent_complete,earned_revenue_cents,billed_cents,over_under_cents,forecast_gross_profit_cents,inputs_hash,warnings,preparation,created_at)
  values(p_org_id,p_project_id,v_period.period_end,p_original_cents,p_change_orders_cents,v_contract,v_cost,p_eac_cents,round(v_ratio,5),v_earned,v_billed,v_billed-v_earned,v_contract-p_eac_cents,v_hash,'[]',v_preparation,greatest(clock_timestamp(),v_prior.created_at+interval '1 microsecond'))
  on conflict(org_id,project_id,as_of,inputs_hash) do nothing returning id into v_id;
  if v_id is null then select id into v_id from public.poc_snapshots where org_id=p_org_id and project_id=p_project_id and as_of=v_period.period_end and inputs_hash=v_hash; end if;
  return v_id;
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

create or replace function public.books_wip_sources_current(p_org_id uuid,p_snapshot_ids uuid[])
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

-- ==== 20261003014320_books_expected_loss_provisions ====
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

-- ==== 20261003020408_books_export_snapshot ====
-- STABLE is essential: every table SELECT uses the calling query's MVCC snapshot.
-- Never accept caller-controlled table names or expose this RPC to browser roles.
create or replace function public.capture_books_export_snapshot(p_org_id uuid)
returns jsonb language plpgsql stable security invoker
set search_path = pg_catalog, public
as $$
declare
  v_table text;
  v_rows jsonb;
  v_tables jsonb := '{}'::jsonb;
begin
  if p_org_id is null then raise exception 'Export organization is required'; end if;
  foreach v_table in array array[
    'closings',
    'closing_checklist_items',
    'lot_takedowns',
    'lot_reservations',
    'budgets',
    'budget_lines',
    'commitments',
    'commitment_lines',
    'change_orders',
    'file_links',
    'project_financial_settings',
    'divisions',
    'communities',
    'community_phases',
    'lots',
    'contracts',
    'cost_codes',
    'time_entries',
    'warranty_requests',
    'warranty_service_visits',
    'warranty_backcharges',
    'org_funding_sources',
    'disbursements',
    'payment_runs',
    'payment_run_items',
    'receivable_adjustments',
    'books_deposit_batches',
    'books_deposit_batch_items',
    'receivable_payment_groups',
    'receivable_payment_group_items',
    'books_overhead_budgets',
    'books_overhead_budget_lines',
    'books_settings',
    'accounting_policies',
    'accounting_account_mappings',
    'gl_accounts',
    'accounting_facts',
    'journal_entries',
    'journal_lines',
    'accounting_periods',
    'accounting_reconciliation_runs',
    'accounting_reconciliation_items',
    'poc_snapshots',
    'books_comparison_runs',
    'books_comparison_items',
    'opening_balance_batches',
    'opening_balance_lines',
    'opening_balance_approvals',
    'bank_accounts',
    'bank_transactions',
    'bank_transaction_details',
    'bank_receipts',
    'bank_transaction_revisions',
    'bank_transaction_matches',
    'bank_reconciliations',
    'bank_reconciliation_items',
    'bank_rules',
    'coding_rules',
    'books_debt_instruments',
    'books_debt_events',
    'books_fixed_assets',
    'books_fixed_asset_events',
    'books_tax_jurisdictions',
    'books_tax_filings',
    'books_greenfield_launches',
    'books_journal_proposals',
    'books_cutover_runs',
    'books_cutover_approvals',
    'books_close_items',
    'recurring_posting_templates',
    'recurring_posting_lines',
    'financial_statement_snapshots',
    'tax_policy_versions',
    'companies',
    'contacts',
    'projects',
    'invoices',
    'invoice_lines',
    'payments',
    'payment_allocations',
    'payment_reversals',
    'vendor_bills',
    'bill_lines',
    'project_expenses',
    'project_expense_lines',
    'job_cost_entries',
    'billable_costs',
    'retainage',
    'files',
    'audit_log'
  ] loop
    execute format('select coalesce(jsonb_agg(to_jsonb(t) order by t.id), ''[]''::jsonb) from public.%I t where t.org_id = $1', v_table)
      into v_rows using p_org_id;
    v_tables := v_tables || jsonb_build_object(v_table, v_rows);
  end loop;
  return jsonb_build_object('orgId', p_org_id, 'capturedAt', statement_timestamp(),
    'databaseSnapshot', pg_current_snapshot()::text, 'tables', v_tables);
end;
$$;
revoke all on function public.capture_books_export_snapshot(uuid) from public, anon, authenticated;
grant execute on function public.capture_books_export_snapshot(uuid) to service_role;

-- ==== 20261003020833_books_bank_statement_sequence ====
-- Validate statement sequencing before an accountant spends time reconciling it.
create or replace function public.books_validate_statement_sequence()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare previous public.bank_reconciliations%rowtype;
begin
  if tg_op='UPDATE' then
    if new.org_id is distinct from old.org_id or new.bank_account_id is distinct from old.bank_account_id then
      raise exception 'Bank statements cannot be reassigned to another account or organization';
    end if;
    if old.status='closed' then raise exception 'Reopen the bank statement before changing its balances or dates'; end if;
  end if;
  perform 1 from public.bank_accounts where id=new.bank_account_id and org_id=new.org_id for update;
  if not found then raise exception 'Bank account not found in organization'; end if;
  if new.statement_start is null or new.statement_end is null or new.statement_end<new.statement_start then
    raise exception 'Statement end must be on or after statement start';
  end if;
  if abs(new.beginning_balance_cents::numeric)>9007199254740991 or abs(new.ending_balance_cents::numeric)>9007199254740991
    or abs(new.ending_balance_cents::numeric-new.beginning_balance_cents::numeric)>9007199254740991 then
    raise exception 'Statement balances exceed safe integer cents';
  end if;
  if exists(select 1 from public.bank_reconciliations where org_id=new.org_id and bank_account_id=new.bank_account_id and id<>new.id
    and statement_start<=new.statement_end and statement_end>=new.statement_start) then
    raise exception 'Bank statement dates overlap an existing reconciliation';
  end if;
  select * into previous from public.bank_reconciliations where org_id=new.org_id and bank_account_id=new.bank_account_id
    and status='closed' and id<>new.id order by statement_end desc limit 1;
  if previous.id is not null and (previous.statement_end+1<>new.statement_start or previous.ending_balance_cents<>new.beginning_balance_cents) then
    raise exception 'Statement dates and opening balance must continue the previous closed reconciliation';
  end if;
  if tg_op='INSERT' and exists(select 1 from public.bank_reconciliations where org_id=new.org_id and bank_account_id=new.bank_account_id and status<>'closed') then
    raise exception 'Finish or remove the existing open bank statement before starting another';
  end if;
  return new;
end;
$$;
revoke all on function public.books_validate_statement_sequence() from public,anon,authenticated;
create trigger books_statement_sequence_guard before insert or update of org_id,bank_account_id,statement_start,statement_end,beginning_balance_cents,ending_balance_cents
on public.bank_reconciliations for each row execute function public.books_validate_statement_sequence();

-- ==== 20261003021045_books_bank_statement_evidence ====
-- Preserve the transaction display along with closed accounting proof.
-- The proof carries each item's economic fields (not its regenerated row id or
-- timestamps) in a stable order, so an unchanged statement recloses to the same digest.
create or replace function public.close_books_bank_reconciliation_atomic(p_org_id uuid, p_reconciliation_id uuid, p_actor_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  rec public.bank_reconciliations%rowtype;
  bank public.bank_accounts%rowtype;
  previous public.bank_reconciliations%rowtype;
  direction_factor integer;
  movement bigint;
  books bigint;
  outstanding bigint;
  proof jsonb;
  proof_digest text;
begin
  select * into rec from public.bank_reconciliations where org_id=p_org_id and id=p_reconciliation_id;
  if not found then raise exception 'Bank reconciliation not found'; end if;
  select * into bank from public.bank_accounts where org_id=p_org_id and id=rec.bank_account_id for update;
  if bank.gl_account_id is null then raise exception 'Map the bank account before reconciliation'; end if;
  select * into rec from public.bank_reconciliations where org_id=p_org_id and id=p_reconciliation_id for update;
  if rec.status='closed' then return jsonb_build_object('id',rec.id,'digest',rec.digest); end if;
  select case when account_type='liability' then -1 else 1 end into direction_factor
    from public.gl_accounts where org_id=p_org_id and id=bank.gl_account_id;
  select * into previous from public.bank_reconciliations where org_id=p_org_id and bank_account_id=bank.id
    and status='closed' and id<>rec.id order by statement_end desc limit 1;
  if previous.id is not null and (previous.statement_end + 1 <> rec.statement_start or previous.ending_balance_cents <> rec.beginning_balance_cents) then
    raise exception 'Statement dates and opening balance must continue the previous closed reconciliation';
  end if;
  if exists(select 1 from public.bank_transactions t where t.org_id=p_org_id and t.bank_account_id=bank.id
    and t.lifecycle_status='posted' and not t.excluded and t.transaction_date between rec.statement_start and rec.statement_end
    and abs(t.amount_cents) <> (select coalesce(sum(m.matched_amount_cents),0) from public.bank_transaction_matches m
      where m.org_id=p_org_id and m.bank_transaction_id=t.id and m.status='confirmed' and m.journal_line_id is not null)) then
    raise exception 'Every included statement transaction must be fully matched';
  end if;
  select coalesce(sum(case when direction='inflow' then amount_cents else -amount_cents end),0)*direction_factor into movement
    from public.bank_transactions where org_id=p_org_id and bank_account_id=bank.id and lifecycle_status='posted'
      and not excluded and transaction_date between rec.statement_start and rec.statement_end;
  if rec.beginning_balance_cents + movement <> rec.ending_balance_cents then raise exception 'Statement opening plus activity does not equal statement ending balance'; end if;
  select coalesce(sum(l.debit_cents-l.credit_cents),0)*direction_factor into books
    from public.journal_lines l join public.journal_entries e on e.id=l.entry_id and e.org_id=l.org_id
    where l.org_id=p_org_id and l.account_id=bank.gl_account_id and e.status in ('posted','reversed') and e.entry_date<=rec.statement_end;
  delete from public.bank_reconciliation_items where org_id=p_org_id and reconciliation_id=rec.id;
  insert into public.bank_reconciliation_items(org_id,reconciliation_id,bank_transaction_id,journal_line_id,amount_cents,item_status)
    select p_org_id,rec.id,t.id,m.journal_line_id,m.matched_amount_cents,'cleared'
    from public.bank_transactions t join public.bank_transaction_matches m on m.bank_transaction_id=t.id and m.org_id=t.org_id
    where t.org_id=p_org_id and t.bank_account_id=bank.id and t.lifecycle_status='posted' and not t.excluded
      and t.transaction_date between rec.statement_start and rec.statement_end and m.status='confirmed';
  -- Unmatched book lines, including book-only checks and deposits, bridge bank to GL.
  insert into public.bank_reconciliation_items(org_id,reconciliation_id,journal_line_id,amount_cents,item_status)
    select p_org_id,rec.id,l.id,
      (case when l.debit_cents>0 then 1 else -1 end)*(l.debit_cents+l.credit_cents-coalesce(m.cleared,0))*direction_factor,'outstanding'
    from public.journal_lines l join public.journal_entries e on e.id=l.entry_id and e.org_id=l.org_id
    left join lateral (select sum(mt.matched_amount_cents) cleared from public.bank_transaction_matches mt
      join public.bank_transactions t on t.id=mt.bank_transaction_id and t.org_id=mt.org_id
      where mt.org_id=p_org_id and mt.journal_line_id=l.id and mt.status='confirmed' and t.lifecycle_status='posted'
        and not t.excluded and t.transaction_date<=rec.statement_end) m on true
    where l.org_id=p_org_id and l.account_id=bank.gl_account_id and e.status in ('posted','reversed') and e.entry_date<=rec.statement_end
      -- The opening position is not an outstanding item, except the cutover checks
      -- and deposits imported as their own opening lines until the bank clears them.
      and (e.entry_kind<>'opening' or l.dimensions->>'bank_opening_role'='outstanding_item')
      and l.debit_cents+l.credit_cents<>coalesce(m.cleared,0);
  select coalesce(sum(amount_cents),0) into outstanding from public.bank_reconciliation_items
    where org_id=p_org_id and reconciliation_id=rec.id and item_status='outstanding';
  if rec.ending_balance_cents+outstanding<>books then raise exception 'Adjusted statement balance does not equal GL: statement %, outstanding %, GL %',rec.ending_balance_cents,outstanding,books; end if;
  select jsonb_build_object('version',1,'statement_start',rec.statement_start,'statement_end',rec.statement_end,
    'beginning_balance_cents',rec.beginning_balance_cents,'ending_balance_cents',rec.ending_balance_cents,
    'book_balance_cents',books,'outstanding_balance_cents',outstanding,'account_id',bank.gl_account_id,
    'direction_factor',direction_factor,'items',coalesce(jsonb_agg(jsonb_build_object('bank_transaction_id',i.bank_transaction_id,'journal_line_id',i.journal_line_id,'amount_cents',i.amount_cents,'item_status',i.item_status)
      order by i.item_status,i.bank_transaction_id nulls last,i.journal_line_id nulls last,i.amount_cents),'[]'::jsonb)) into proof
    from public.bank_reconciliation_items i where i.org_id=p_org_id and i.reconciliation_id=rec.id;
  proof := proof || jsonb_build_object('version',2,'statement_transactions',(
    select coalesce(jsonb_agg(jsonb_build_object(
      'id',t.id,'transaction_date',t.transaction_date,'description',t.description,'merchant_name',t.merchant_name,
      'direction',t.direction,'amount_cents',t.amount_cents,'excluded',t.excluded,
      'matches',coalesce((select jsonb_agg(jsonb_build_object('matched_amount_cents',m.matched_amount_cents,'status',m.status) order by m.id)
        from public.bank_transaction_matches m where m.org_id=t.org_id and m.bank_transaction_id=t.id and m.status='confirmed'),'[]'::jsonb)
    ) order by t.transaction_date,t.id),'[]'::jsonb)
    from public.bank_transactions t where t.org_id=p_org_id and t.bank_account_id=bank.id
      and t.lifecycle_status='posted' and t.transaction_date between rec.statement_start and rec.statement_end
  ));
  proof_digest:=encode(extensions.digest(proof::text,'sha256'),'hex');
  update public.bank_reconciliations set status='closed',cleared_balance_cents=books,difference_cents=0,
    book_balance_cents=books,outstanding_balance_cents=outstanding,evidence=proof,digest=proof_digest,closed_by=p_actor_id,closed_at=now()
    where org_id=p_org_id and id=rec.id;
  return jsonb_build_object('id',rec.id,'digest',proof_digest);
end;
$$;
revoke all on function public.close_books_bank_reconciliation_atomic(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.close_books_bank_reconciliation_atomic(uuid,uuid,uuid) to service_role;

-- Imported cutover checks and deposits are opening lines that the bank later
-- clears; the rest of the opening position can never be matched.
create or replace function public.validate_books_bank_match()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  txn public.bank_transactions%rowtype;
  bank public.bank_accounts%rowtype;
  jl public.journal_lines%rowtype;
  entry_status text;
  entry_kind_value text;
  used_cents bigint;
begin
  if tg_op = 'UPDATE' and (new.org_id <> old.org_id or new.bank_transaction_id <> old.bank_transaction_id
      or new.journal_line_id is distinct from old.journal_line_id) then
    raise exception 'A bank match cannot be reassigned; reverse it and create a new match';
  end if;
  select * into txn from public.bank_transactions where id = new.bank_transaction_id and org_id = new.org_id;
  if not found then raise exception 'Bank transaction not found in organization'; end if;
  select * into bank from public.bank_accounts where id = txn.bank_account_id and org_id = new.org_id for update;
  if not found then raise exception 'Bank account not found in organization'; end if;
  if exists (select 1 from public.bank_reconciliations r where r.org_id = new.org_id
    and r.bank_account_id = bank.id and r.status = 'closed' and txn.transaction_date <= r.statement_end) then
    raise exception 'Reopen the bank reconciliation before changing its matches';
  end if;
  select * into txn from public.bank_transactions where id = new.bank_transaction_id and org_id = new.org_id for update;
  if new.status <> 'confirmed' then return new; end if;
  if txn.lifecycle_status <> 'posted' or txn.excluded then raise exception 'Only posted, included bank transactions can be matched'; end if;
  if new.journal_line_id is null or new.match_type = 'excluded' then
    raise exception 'A confirmed match requires a journal line; exclusion is a separate reviewed action';
  end if;
  select * into jl from public.journal_lines where id = new.journal_line_id and org_id = new.org_id for update;
  if not found or jl.account_id is distinct from bank.gl_account_id then raise exception 'Journal line must belong to the mapped bank account and organization'; end if;
  select status, entry_kind into entry_status, entry_kind_value from public.journal_entries where id = jl.entry_id and org_id = new.org_id;
  if entry_status not in('posted','reversed') then raise exception 'Only an economic journal line can receive a new match'; end if;
  if entry_kind_value = 'opening' and coalesce(jl.dimensions->>'bank_opening_role','') <> 'outstanding_item' then
    raise exception 'Only an imported outstanding check or deposit can clear against the opening balance';
  end if;
  if (txn.direction = 'inflow' and jl.debit_cents <= 0) or (txn.direction = 'outflow' and jl.credit_cents <= 0) then
    raise exception 'Bank and journal line directions differ';
  end if;
  select coalesce(sum(matched_amount_cents),0) into used_cents from public.bank_transaction_matches
    where org_id = new.org_id and bank_transaction_id = txn.id and status = 'confirmed' and id <> new.id;
  if used_cents + new.matched_amount_cents > abs(txn.amount_cents) then raise exception 'Matches exceed bank transaction capacity'; end if;
  select coalesce(sum(matched_amount_cents),0) into used_cents from public.bank_transaction_matches
    where journal_line_id = jl.id and status = 'confirmed' and id <> new.id;
  if used_cents + new.matched_amount_cents > jl.debit_cents + jl.credit_cents then raise exception 'Matches exceed journal line capacity'; end if;
  return new;
end;
$$;
revoke all on function public.validate_books_bank_match() from public, anon, authenticated;

-- ==== 20261003022656_books_projection_receipts ====
create table public.books_projection_receipts (
 id uuid primary key default gen_random_uuid(),
 org_id uuid not null references public.orgs(id) on delete cascade,
 source_type text not null,
 source_id uuid not null,
 source_observed_at timestamptz not null,
 fact_id uuid not null references public.accounting_facts(id),
 journal_id uuid not null references public.journal_entries(id),
 checked_at timestamptz not null default now(),
 unique(org_id,source_type,source_id)
);
alter table public.books_projection_receipts enable row level security;
revoke all on public.books_projection_receipts from anon,authenticated;
grant select,insert,update,delete on public.books_projection_receipts to service_role;

create or replace function public.record_books_projection_receipt(p_org_id uuid,p_source_type text,p_source_id uuid,p_source_observed_at timestamptz,p_fact_id uuid,p_journal_id uuid)
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if p_source_observed_at is null then raise exception 'Source observation timestamp is required'; end if;
 perform 1 from public.accounting_facts f join public.journal_entries j on j.fact_id=f.id and j.org_id=f.org_id
 where f.org_id=p_org_id and f.id=p_fact_id and f.source_type=p_source_type and f.source_id=p_source_id
 and j.id=p_journal_id and j.status='posted' for share of j;
 if not found then raise exception 'Projection receipt requires a posted journal for this source and organization'; end if;
 insert into public.books_projection_receipts(org_id,source_type,source_id,source_observed_at,fact_id,journal_id)
 values(p_org_id,p_source_type,p_source_id,p_source_observed_at,p_fact_id,p_journal_id)
 on conflict(org_id,source_type,source_id) do update set source_observed_at=excluded.source_observed_at,
 fact_id=excluded.fact_id,journal_id=excluded.journal_id,checked_at=clock_timestamp()
 where books_projection_receipts.source_observed_at<=excluded.source_observed_at;
end;
$$;
revoke all on function public.record_books_projection_receipt(uuid,text,uuid,timestamptz,uuid,uuid) from public,anon,authenticated;
grant execute on function public.record_books_projection_receipt(uuid,text,uuid,timestamptz,uuid,uuid) to service_role;

-- STABLE is essential: every table SELECT uses the calling query's MVCC snapshot.
-- Never accept caller-controlled table names or expose this RPC to browser roles.
create or replace function public.capture_books_export_snapshot(p_org_id uuid)
returns jsonb language plpgsql stable security invoker
set search_path = pg_catalog, public
as $$
declare
  v_table text;
  v_rows jsonb;
  v_tables jsonb := '{}'::jsonb;
begin
  if p_org_id is null then raise exception 'Export organization is required'; end if;
  foreach v_table in array array[
    'closings',
    'closing_checklist_items',
    'lot_takedowns',
    'lot_reservations',
    'budgets',
    'budget_lines',
    'commitments',
    'commitment_lines',
    'change_orders',
    'file_links',
    'project_financial_settings',
    'divisions',
    'communities',
    'community_phases',
    'lots',
    'contracts',
    'cost_codes',
    'time_entries',
    'warranty_requests',
    'warranty_service_visits',
    'warranty_backcharges',
    'org_funding_sources',
    'disbursements',
    'payment_runs',
    'payment_run_items',
    'receivable_adjustments',
    'books_deposit_batches',
    'books_deposit_batch_items',
    'receivable_payment_groups',
    'receivable_payment_group_items',
    'books_overhead_budgets',
    'books_overhead_budget_lines',
    'books_settings',
    'accounting_policies',
    'accounting_account_mappings',
    'gl_accounts',
    'books_projection_receipts',
    'accounting_facts',
    'journal_entries',
    'journal_lines',
    'accounting_periods',
    'accounting_reconciliation_runs',
    'accounting_reconciliation_items',
    'poc_snapshots',
    'books_comparison_runs',
    'books_comparison_items',
    'opening_balance_batches',
    'opening_balance_lines',
    'opening_balance_approvals',
    'bank_accounts',
    'bank_transactions',
    'bank_transaction_details',
    'bank_receipts',
    'bank_transaction_revisions',
    'bank_transaction_matches',
    'bank_reconciliations',
    'bank_reconciliation_items',
    'bank_rules',
    'coding_rules',
    'books_debt_instruments',
    'books_debt_events',
    'books_fixed_assets',
    'books_fixed_asset_events',
    'books_tax_jurisdictions',
    'books_tax_filings',
    'books_greenfield_launches',
    'books_journal_proposals',
    'books_cutover_runs',
    'books_cutover_approvals',
    'books_close_items',
    'recurring_posting_templates',
    'recurring_posting_lines',
    'financial_statement_snapshots',
    'tax_policy_versions',
    'companies',
    'contacts',
    'projects',
    'invoices',
    'invoice_lines',
    'payments',
    'payment_allocations',
    'payment_reversals',
    'vendor_bills',
    'bill_lines',
    'project_expenses',
    'project_expense_lines',
    'job_cost_entries',
    'billable_costs',
    'retainage',
    'files',
    'audit_log'
  ] loop
    execute format('select coalesce(jsonb_agg(to_jsonb(t) order by t.id), ''[]''::jsonb) from public.%I t where t.org_id = $1', v_table)
      into v_rows using p_org_id;
    v_tables := v_tables || jsonb_build_object(v_table, v_rows);
  end loop;
  return jsonb_build_object('orgId', p_org_id, 'capturedAt', statement_timestamp(),
    'databaseSnapshot', pg_current_snapshot()::text, 'tables', v_tables);
end;
$$;
revoke all on function public.capture_books_export_snapshot(uuid) from public, anon, authenticated;
grant execute on function public.capture_books_export_snapshot(uuid) to service_role;

-- ==== 20261003023206_books_source_revision_invalidation ====
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

-- ==== 20261003115030_books_wip_revenue_allocations ====
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

-- ==== 20261003122336_books_payment_allocation_revisions ====
-- Child allocation edits must enter incremental projection and invalidate prior receipts.
create trigger zz_books_payment_source_revision before update on public.payments
for each row execute function public.books_advance_source_revision();

create or replace function public.books_touch_payment_allocation_source()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if tg_op in ('UPDATE','DELETE') then
    update public.payments set updated_at=clock_timestamp() where id=old.payment_id and org_id=old.org_id;
  end if;
  if tg_op='INSERT' or (tg_op='UPDATE' and (new.payment_id is distinct from old.payment_id or new.org_id is distinct from old.org_id)) then
    update public.payments set updated_at=clock_timestamp() where id=new.payment_id and org_id=new.org_id;
  end if;
  return null;
end;
$$;
revoke all on function public.books_touch_payment_allocation_source() from public,anon,authenticated;
create trigger books_payment_allocation_source_touch after insert or update or delete on public.payment_allocations
for each row execute function public.books_touch_payment_allocation_source();

-- ==== 20261003130622_books_invoice_income_evidence ====
-- One statement snapshot for invoice revision, native chart selection and lines.
-- Service-only and invoker rights: this never turns membership into chart access.
create or replace function public.books_invoice_income_evidence(p_org_id uuid,p_invoice_ids uuid[])
returns jsonb language sql stable security invoker set search_path=pg_catalog,public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',i.id,'updated_at',i.updated_at,
    'lines',coalesce((select jsonb_agg(jsonb_build_object(
      'id',l.id,'quantity',l.quantity::text,'unit_price_cents',l.unit_price_cents,
      'cost_code_id',l.cost_code_id,'metadata',l.metadata,
      'selected_account',case when a.id is null then null else jsonb_build_object('id',a.id,'code',a.code,'account_type',a.account_type,'active',a.active) end
    ) order by l.id) from public.invoice_lines l
    left join public.gl_accounts a on a.org_id=i.org_id and a.id::text=l.metadata->>'arc_books_gl_account_id'
    where l.org_id=i.org_id and l.invoice_id=i.id),'[]'::jsonb)
  ) order by i.id),'[]'::jsonb)
  from public.invoices i where i.org_id=p_org_id and i.id=any(p_invoice_ids);
$$;
revoke all on function public.books_invoice_income_evidence(uuid,uuid[]) from public,anon,authenticated;
grant execute on function public.books_invoice_income_evidence(uuid,uuid[]) to service_role;

-- ==== 20261003135441_books_posted_account_classification ====
-- Classification belongs to the posting, not to today's mutable chart.
create or replace function public.books_capture_account_classification()
returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
declare
  account public.gl_accounts%rowtype;
  reversal uuid;
  original public.journal_lines%rowtype;
  classification jsonb;
begin
  select * into account from public.gl_accounts where id=new.account_id and org_id=new.org_id;
  if not found then raise exception 'GL account must belong to the line organization'; end if;
  select reversal_of_entry_id into reversal from public.journal_entries where id=new.entry_id and org_id=new.org_id;
  if not found then raise exception 'Journal entry must belong to the line organization'; end if;
  if reversal is not null then
    select * into original from public.journal_lines
    where entry_id=reversal and org_id=new.org_id and line_no=new.line_no;
    if not found or original.account_id<>new.account_id
      or original.project_id is distinct from new.project_id
      or original.company_id is distinct from new.company_id
      or original.debit_cents<>new.credit_cents or original.credit_cents<>new.debit_cents then
      raise exception 'Reversal line must exactly reverse its original posting';
    end if;
    new.dimensions:=original.dimensions;
    classification:=original.dimensions->'books_account_classification';
    if classification is null then
      classification:=jsonb_build_object('version',1,'account_id',new.account_id,'legacy_unknown',true);
    end if;
  else
    classification:=jsonb_build_object('version',1,'account_id',account.id,'code',account.code,
      'account_type',account.account_type,'subtype',account.subtype,
      'normal_balance',account.normal_balance,'cash_flow_category',account.cash_flow_category);
  end if;
  new.dimensions:=coalesce(new.dimensions,'{}'::jsonb)||jsonb_build_object('books_account_classification',classification);
  return new;
end;
$$;
revoke all on function public.books_capture_account_classification() from public,anon,authenticated;
create trigger zz_books_capture_account_classification before insert on public.journal_lines
for each row execute function public.books_capture_account_classification();

-- Exact individual lines alone would still allow a balanced subset reversal.
create or replace function public.books_validate_complete_reversal()
returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
declare original uuid; entry_identifier uuid; entry_status text;
begin
  if tg_table_name='journal_entries' then entry_identifier:=new.id; else entry_identifier:=new.entry_id; end if;
  select reversal_of_entry_id,status into original,entry_status from public.journal_entries where id=entry_identifier and org_id=new.org_id;
  if original is not null and entry_status in ('posted','reversed') and
    (select count(*) from public.journal_lines where entry_id=entry_identifier and org_id=new.org_id)<>
    (select count(*) from public.journal_lines where entry_id=original and org_id=new.org_id) then
    raise exception 'Reversal must include every original journal line';
  end if;
  return null;
end;
$$;
revoke all on function public.books_validate_complete_reversal() from public,anon,authenticated;
create constraint trigger books_complete_reversal after insert on public.journal_lines
deferrable initially deferred for each row execute function public.books_validate_complete_reversal();
create constraint trigger books_complete_reversal_entry after insert or update on public.journal_entries
deferrable initially deferred for each row execute function public.books_validate_complete_reversal();

-- ==== 20261003144925_books_fee_snapshot_evidence ====
-- Include separately collected Arc Pay fees in the same MVCC recovery/report snapshot.
create or replace function public.capture_books_export_snapshot(p_org_id uuid)
returns jsonb language plpgsql stable security invoker
set search_path = pg_catalog, public
as $$
declare
  v_table text;
  v_rows jsonb;
  v_tables jsonb := '{}'::jsonb;
begin
  if p_org_id is null then raise exception 'Export organization is required'; end if;
  foreach v_table in array array[
    'closings',
    'closing_checklist_items',
    'lot_takedowns',
    'lot_reservations',
    'budgets',
    'budget_lines',
    'commitments',
    'commitment_lines',
    'change_orders',
    'file_links',
    'project_financial_settings',
    'divisions',
    'communities',
    'community_phases',
    'lots',
    'contracts',
    'cost_codes',
    'time_entries',
    'warranty_requests',
    'warranty_service_visits',
    'warranty_backcharges',
    'org_funding_sources',
    'disbursements',
    'payment_runs',
    'payment_run_items',
    'payment_run_fee_charges',
    'receivable_adjustments',
    'books_deposit_batches',
    'books_deposit_batch_items',
    'receivable_payment_groups',
    'receivable_payment_group_items',
    'books_overhead_budgets',
    'books_overhead_budget_lines',
    'books_settings',
    'accounting_policies',
    'accounting_account_mappings',
    'gl_accounts',
    'books_projection_receipts',
    'accounting_facts',
    'journal_entries',
    'journal_lines',
    'accounting_periods',
    'accounting_reconciliation_runs',
    'accounting_reconciliation_items',
    'poc_snapshots',
    'books_comparison_runs',
    'books_comparison_items',
    'opening_balance_batches',
    'opening_balance_lines',
    'opening_balance_approvals',
    'bank_accounts',
    'bank_transactions',
    'bank_transaction_details',
    'bank_receipts',
    'bank_transaction_revisions',
    'bank_transaction_matches',
    'bank_reconciliations',
    'bank_reconciliation_items',
    'bank_rules',
    'coding_rules',
    'books_debt_instruments',
    'books_debt_events',
    'books_fixed_assets',
    'books_fixed_asset_events',
    'books_tax_jurisdictions',
    'books_tax_filings',
    'books_greenfield_launches',
    'books_journal_proposals',
    'books_cutover_runs',
    'books_cutover_approvals',
    'books_close_items',
    'recurring_posting_templates',
    'recurring_posting_lines',
    'financial_statement_snapshots',
    'tax_policy_versions',
    'companies',
    'contacts',
    'projects',
    'invoices',
    'invoice_lines',
    'payments',
    'payment_allocations',
    'payment_reversals',
    'vendor_bills',
    'bill_lines',
    'project_expenses',
    'project_expense_lines',
    'job_cost_entries',
    'billable_costs',
    'retainage',
    'files',
    'audit_log'
  ] loop
    execute format('select coalesce(jsonb_agg(to_jsonb(t) order by t.id), ''[]''::jsonb) from public.%I t where t.org_id = $1', v_table)
      into v_rows using p_org_id;
    v_tables := v_tables || jsonb_build_object(v_table, v_rows);
  end loop;
  return jsonb_build_object('orgId', p_org_id, 'capturedAt', statement_timestamp(),
    'databaseSnapshot', pg_current_snapshot()::text, 'tables', v_tables);
end;
$$;
revoke all on function public.capture_books_export_snapshot(uuid) from public, anon, authenticated;
grant execute on function public.capture_books_export_snapshot(uuid) to service_role;

-- ==== 20261003161950_books_tax_adjustment_workpapers ====
-- Separate reviewed tax workpapers. No operational facts or GL entries are posted.
create table public.books_tax_adjustment_workpapers (
 id uuid primary key default gen_random_uuid(),
 org_id uuid not null references public.orgs(id),
 period_start date not null, period_end date not null,
 status text not null default 'draft' check(status in('draft','approved','superseded','withdrawn')),
 base_digest text not null check(base_digest ~ '^[a-f0-9]{64}$'),
 base_snapshot jsonb not null,
 lines jsonb not null check(jsonb_typeof(lines)='array' and jsonb_array_length(lines) between 1 and 500),
 prepared_by uuid not null references public.app_users(id), prepared_at timestamptz not null default now(),
 reviewed_by uuid references public.app_users(id), reviewed_at timestamptz, review_notes text,
 closed_by uuid references public.app_users(id), closed_at timestamptz, close_reason text,
 supersedes_id uuid, idempotency_key text not null,
 unique(org_id,id), unique(org_id,idempotency_key),
 foreign key(org_id,supersedes_id) references public.books_tax_adjustment_workpapers(org_id,id),
 check(period_start<=period_end and period_end-period_start<=370),
 check(jsonb_typeof(base_snapshot)='object' and base_snapshot->>'basis'='cash' and (base_snapshot->>'version')::int=1 and base_snapshot->>'start_date'=period_start::text and base_snapshot->>'end_date'=period_end::text),
 check((status in('draft','withdrawn') and reviewed_by is null and reviewed_at is null) or (status in('approved','superseded') and reviewed_by is not null and reviewed_by<>prepared_by and reviewed_at is not null and coalesce(length(trim(review_notes)),0)>=10)),
 check((status in('draft','approved') and closed_by is null and closed_at is null) or (status in('withdrawn','superseded') and closed_by is not null and closed_at is not null and coalesce(length(trim(close_reason)),0)>=10))
);
create index books_tax_workpaper_period_idx on public.books_tax_adjustment_workpapers(org_id,period_start,period_end,status);
create unique index books_tax_workpaper_approved_period_idx on public.books_tax_adjustment_workpapers(org_id,period_start,period_end) where status='approved';
alter table public.books_tax_adjustment_workpapers enable row level security;
revoke all on public.books_tax_adjustment_workpapers from public,anon,authenticated;
grant select,insert,update on public.books_tax_adjustment_workpapers to service_role;

create function public.guard_books_tax_workpaper() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
declare item jsonb; seen uuid[]:='{}'; line_id uuid; amount numeric;
begin
 if tg_op='DELETE' then raise exception 'Tax workpaper history cannot be deleted'; end if;
 if new.status='approved' and (coalesce(length(trim(new.review_notes)),0)<10 or new.reviewed_by is null or new.reviewed_by=new.prepared_by or not exists(select 1 from public.memberships where org_id=new.org_id and user_id=new.reviewed_by and status='active')) then raise exception 'Tax approval requires substantive notes and a separate active reviewer'; end if;
 if new.status in('withdrawn','superseded') and (coalesce(length(trim(new.close_reason)),0)<10 or not exists(select 1 from public.memberships where org_id=new.org_id and user_id=new.closed_by and status='active')) then raise exception 'Tax workpaper closure requires substantive notes and active organization actor'; end if;
 if tg_op='INSERT' or new.status='approved' then
  if public.books_tax_source_revision(public.capture_books_export_snapshot(new.org_id),new.period_end) is distinct from new.base_snapshot->>'source_revision' then raise exception 'Cash source revision changed before workpaper transition'; end if;
 end if;
 if tg_op='UPDATE' then
  if to_jsonb(new)-array['status','reviewed_by','reviewed_at','review_notes','closed_by','closed_at','close_reason'] is distinct from to_jsonb(old)-array['status','reviewed_by','reviewed_at','review_notes','closed_by','closed_at','close_reason'] then raise exception 'Tax workpaper evidence is immutable'; end if;
  if not ((old.status='draft' and new.status='approved') or (old.status='draft' and new.status='withdrawn') or (old.status='approved' and new.status='superseded' and new.reviewed_by=old.reviewed_by and new.reviewed_at=old.reviewed_at and new.review_notes=old.review_notes)) then raise exception 'Invalid tax workpaper transition'; end if;
 else
  if new.status<>'draft' then raise exception 'Tax workpapers must start as drafts'; end if;
  if not exists(select 1 from public.memberships where org_id=new.org_id and user_id=new.prepared_by and status='active') then raise exception 'Tax preparer must be an active organization member'; end if;
  if new.base_snapshot->>'basis' is distinct from 'cash' or new.base_snapshot->>'version' is distinct from '1' or new.base_snapshot->>'start_date' is distinct from new.period_start::text or new.base_snapshot->>'end_date' is distinct from new.period_end::text or coalesce(new.base_snapshot->>'source_revision','') !~ '^[a-f0-9]{64}$' then raise exception 'Tax workpaper requires exact dated cash basis and source revision'; end if;
  if coalesce(jsonb_typeof(new.base_snapshot->'net_income_cents'),'')<>'number' or abs((new.base_snapshot->>'net_income_cents')::numeric)>9007199254740991 or (new.base_snapshot->>'net_income_cents')::numeric<>trunc((new.base_snapshot->>'net_income_cents')::numeric) then raise exception 'Tax base requires exact safe integer cents'; end if;
  for item in select value from jsonb_array_elements(new.lines) loop
   line_id:=(item->>'id')::uuid;
   if line_id is null or line_id=any(seen) then raise exception 'Missing or duplicate tax adjustment identity'; end if;
   seen:=array_append(seen,line_id);
   amount:=(item->>'amount_cents')::numeric;
   if jsonb_typeof(item->'amount_cents') is distinct from 'number' or amount is null or amount=0 or amount<>trunc(amount) or abs(amount)>9007199254740991 or coalesce(item->>'kind','') not in('permanent','timing') or coalesce(length(trim(item->>'description')),0)<10 or coalesce(length(trim(item->>'evidence_reference')),0)<3 then raise exception 'Tax adjustments require signed exact cents, classification, explanation and evidence'; end if;
   if item->>'project_id' is not null and not exists(select 1 from public.projects where id=(item->>'project_id')::uuid and org_id=new.org_id) then raise exception 'Tax adjustment project is outside organization'; end if;
   if item->>'evidence_file_id' is not null and not exists(select 1 from public.files where id=(item->>'evidence_file_id')::uuid and org_id=new.org_id) then raise exception 'Tax adjustment evidence file is outside organization'; end if;
  end loop;
  if exists(select 1 from jsonb_array_elements(new.lines) group by value->>'kind' having abs(sum((value->>'amount_cents')::numeric))>9007199254740991) then raise exception 'Tax adjustment category exceeds exact safe cents'; end if;
  if abs((select sum((value->>'amount_cents')::numeric) from jsonb_array_elements(new.lines)))>9007199254740991 or abs((new.base_snapshot->>'net_income_cents')::numeric+(select sum((value->>'amount_cents')::numeric) from jsonb_array_elements(new.lines)))>9007199254740991 then raise exception 'Tax workpaper aggregate exceeds exact safe cents'; end if;
 end if;
 return new;
end $$;
create trigger books_tax_workpaper_guard before insert or update or delete on public.books_tax_adjustment_workpapers for each row execute function public.guard_books_tax_workpaper();
revoke all on function public.guard_books_tax_workpaper() from public,anon,authenticated;

create function public.prepare_books_tax_workpaper(p_org_id uuid,p_actor_id uuid,p_period_start date,p_period_end date,p_base_digest text,p_base_snapshot jsonb,p_lines jsonb,p_idempotency_key text,p_supersedes_id uuid default null)
returns uuid language plpgsql security invoker set search_path=pg_catalog,public as $$
declare existing public.books_tax_adjustment_workpapers; result uuid;
begin
 if not exists(select 1 from public.memberships where org_id=p_org_id and user_id=p_actor_id and status='active') then raise exception 'Tax preparer must be an active organization member'; end if;
 if p_org_id is null or p_actor_id is null or coalesce(length(trim(p_idempotency_key)),0)<10 then raise exception 'Tax workpaper scope, actor and retry key are required'; end if;
 perform pg_advisory_xact_lock(hashtextextended('tax-workpaper:'||p_org_id::text,0));
 select * into existing from public.books_tax_adjustment_workpapers where org_id=p_org_id and idempotency_key=p_idempotency_key;
 if found then
  if existing.prepared_by<>p_actor_id or existing.period_start<>p_period_start or existing.period_end<>p_period_end or existing.base_digest<>p_base_digest or existing.base_snapshot<>p_base_snapshot or existing.lines<>p_lines or existing.supersedes_id is distinct from p_supersedes_id then raise exception 'Tax workpaper retry key has different evidence'; end if;
  return existing.id;
 end if;
 if public.books_tax_source_revision(public.capture_books_export_snapshot(p_org_id),p_period_end) is distinct from p_base_snapshot->>'source_revision' then raise exception 'Cash source revision changed before preparation'; end if;
 if p_supersedes_id is not null and not exists(select 1 from public.books_tax_adjustment_workpapers where org_id=p_org_id and id=p_supersedes_id and status='approved' and period_start=p_period_start and period_end=p_period_end) then raise exception 'Replacement requires an approved workpaper for the same exact period'; end if;
 insert into public.books_tax_adjustment_workpapers(org_id,period_start,period_end,base_digest,base_snapshot,lines,prepared_by,idempotency_key,supersedes_id) values(p_org_id,p_period_start,p_period_end,p_base_digest,p_base_snapshot,p_lines,p_actor_id,p_idempotency_key,p_supersedes_id) returning id into result;
 return result;
end $$;
revoke all on function public.prepare_books_tax_workpaper(uuid,uuid,date,date,text,jsonb,jsonb,text,uuid) from public,anon,authenticated;
grant execute on function public.prepare_books_tax_workpaper(uuid,uuid,date,date,text,jsonb,jsonb,text,uuid) to service_role;

create function public.review_books_tax_workpaper(p_org_id uuid,p_id uuid,p_actor_id uuid,p_current_base_digest text,p_notes text)
returns uuid language plpgsql security invoker set search_path=pg_catalog,public as $$
declare item public.books_tax_adjustment_workpapers;
begin
 perform pg_advisory_xact_lock(hashtextextended('tax-workpaper:'||p_org_id::text,0));
 select * into item from public.books_tax_adjustment_workpapers where org_id=p_org_id and id=p_id for update;
 if not found then raise exception 'Tax workpaper not found in organization'; end if;
 if not exists(select 1 from public.memberships where org_id=p_org_id and user_id=p_actor_id and status='active') or p_actor_id=item.prepared_by then raise exception 'Tax workpaper requires a different active organization reviewer'; end if;
 if public.books_tax_source_revision(public.capture_books_export_snapshot(p_org_id),item.period_end) is distinct from item.base_snapshot->>'source_revision' then raise exception 'Cash source revision changed before review'; end if;
 if p_current_base_digest is distinct from item.base_digest then raise exception 'Cash books changed since preparation; prepare a replacement'; end if;
 if coalesce(length(trim(p_notes)),0)<10 then raise exception 'Substantive tax review notes required'; end if;
 if item.status='approved' and item.reviewed_by=p_actor_id and item.review_notes=p_notes then return item.id; end if;
 if item.status<>'draft' then raise exception 'Only draft tax workpapers can be reviewed'; end if;
 if item.supersedes_id is not null then
  update public.books_tax_adjustment_workpapers set status='superseded',closed_by=p_actor_id,closed_at=now(),close_reason=p_notes where org_id=p_org_id and id=item.supersedes_id and status='approved' and period_start=item.period_start and period_end=item.period_end;
  if not found then raise exception 'Replacement target is no longer approved'; end if;
 end if;
 if exists(select 1 from public.books_tax_adjustment_workpapers where org_id=p_org_id and status='approved' and period_start=item.period_start and period_end=item.period_end) then raise exception 'Only one workpaper may be approved for an exact period'; end if;
 update public.books_tax_adjustment_workpapers set status='approved',reviewed_by=p_actor_id,reviewed_at=now(),review_notes=p_notes where id=item.id;
 return item.id;
end $$;
revoke all on function public.review_books_tax_workpaper(uuid,uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.review_books_tax_workpaper(uuid,uuid,uuid,text,text) to service_role;

-- Only the posted history through cutoff and its current operational sources
-- contribute to this revision. New future-period transactions and workpaper
-- writes must not invalidate an already reviewed prior-period basis.
create function public.books_tax_source_revision(p_snapshot jsonb,p_end date)
returns text language plpgsql immutable security invoker set search_path=pg_catalog,public,extensions as $$
declare entries jsonb; facts jsonb; proof jsonb; t text; source_ids text[]; rows jsonb;
begin
 select coalesce(jsonb_agg(value order by value->>'id'),'[]') into entries from jsonb_array_elements(p_snapshot->'tables'->'journal_entries') where value->>'status' in('posted','reversed') and (value->>'entry_date')::date<=p_end;
 select coalesce(jsonb_agg(value order by value->>'id'),'[]') into facts from jsonb_array_elements(p_snapshot->'tables'->'accounting_facts') f where exists(select 1 from jsonb_array_elements(entries) e where e->>'fact_id'=f.value->>'id');
 proof:=jsonb_build_object('entries',entries,'facts',facts);
 select array_agg(value->>'source_id') into source_ids from jsonb_array_elements(facts);
 select coalesce(jsonb_agg(value order by value->>'id'),'[]') into rows from jsonb_array_elements(p_snapshot->'tables'->'journal_lines') l where exists(select 1 from jsonb_array_elements(entries) e where e->>'id'=l.value->>'entry_id');
 proof:=proof||jsonb_build_object('lines',rows);
 select coalesce(jsonb_agg(value order by value->>'source_type',value->>'source_id'),'[]') into rows from jsonb_array_elements(p_snapshot->'tables'->'books_projection_receipts') r where exists(select 1 from jsonb_array_elements(facts) f where f->>'source_type'=r.value->>'source_type' and f->>'source_id'=r.value->>'source_id');
 proof:=proof||jsonb_build_object('receipts',rows);
 foreach t in array array['invoices','vendor_bills','payments','project_expenses','payment_reversals','payment_run_fee_charges'] loop
  select coalesce(jsonb_agg(value order by value->>'id'),'[]') into rows from jsonb_array_elements(p_snapshot->'tables'->t) r where exists(select 1 from jsonb_array_elements(facts) f where f->>'source_id'=r.value->>'id' and f->>'source_type'=any(case t when 'invoices' then array['invoice'] when 'vendor_bills' then array['vendor_bill'] when 'payments' then array['invoice_payment','bill_payment'] when 'project_expenses' then array['expense'] when 'payment_reversals' then array['payment_reversal'] else array['ap_fee_charge'] end))
   or (t='payments' and r.value->>'status' in('completed','succeeded','paid','refunded') and substring(r.value->>'received_at',1,10)::date<=p_end)
   or (t='project_expenses' and r.value->>'status' in('approved','locked') and (r.value->>'expense_date')::date<=p_end)
   or (t='payment_reversals' and r.value->>'status'='succeeded' and substring(r.value->>'occurred_at',1,10)::date<=p_end)
   or (t='payment_run_fee_charges' and r.value->>'status'='succeeded' and substring(r.value->>'settled_at',1,10)::date<=p_end);
  select coalesce(source_ids,'{}')||coalesce(array_agg(value->>'id'),'{}') into source_ids from jsonb_array_elements(rows);
  proof:=proof||jsonb_build_object(t,rows);
 end loop;
 foreach t in array array['invoice_lines','bill_lines','project_expense_lines','payment_allocations'] loop
  select coalesce(jsonb_agg(value order by value->>'id'),'[]') into rows from jsonb_array_elements(p_snapshot->'tables'->t) r where (case t when 'invoice_lines' then r.value->>'invoice_id' when 'bill_lines' then r.value->>'bill_id' when 'project_expense_lines' then r.value->>'expense_id' else r.value->>'payment_id' end)=any(source_ids);
  proof:=proof||jsonb_build_object(t,rows);
 end loop;
 select coalesce(jsonb_agg(value order by value->>'id'),'[]') into rows from jsonb_array_elements(p_snapshot->'tables'->'receivable_adjustments') r where r.value->>'invoice_id'=any(source_ids) and (r.value->>'effective_date')::date<=p_end;
 proof:=proof||jsonb_build_object('receivable_adjustments',rows);
 return encode(digest(proof::text,'sha256'),'hex');
end $$;
revoke all on function public.books_tax_source_revision(jsonb,date) from public,anon,authenticated;
grant execute on function public.books_tax_source_revision(jsonb,date) to service_role;

create function public.capture_books_tax_workpaper_context(p_org_id uuid,p_period_end date)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare snapshot jsonb;
begin
 if p_period_end is null then raise exception 'Tax workpaper cutoff required'; end if;
 snapshot:=public.capture_books_export_snapshot(p_org_id);
 return snapshot||jsonb_build_object('taxSourceRevision',public.books_tax_source_revision(snapshot,p_period_end));
end $$;
revoke all on function public.capture_books_tax_workpaper_context(uuid,date) from public,anon,authenticated;
grant execute on function public.capture_books_tax_workpaper_context(uuid,date) to service_role;

-- Include separately collected Arc Pay fees in the same MVCC recovery/report snapshot.
create or replace function public.capture_books_export_snapshot(p_org_id uuid)
returns jsonb language plpgsql stable security invoker
set search_path = pg_catalog, public
as $$
declare
  v_table text;
  v_rows jsonb;
  v_tables jsonb := '{}'::jsonb;
begin
  if p_org_id is null then raise exception 'Export organization is required'; end if;
  foreach v_table in array array[
    'closings',
    'closing_checklist_items',
    'lot_takedowns',
    'lot_reservations',
    'budgets',
    'budget_lines',
    'commitments',
    'commitment_lines',
    'change_orders',
    'file_links',
    'project_financial_settings',
    'divisions',
    'communities',
    'community_phases',
    'lots',
    'contracts',
    'cost_codes',
    'time_entries',
    'warranty_requests',
    'warranty_service_visits',
    'warranty_backcharges',
    'org_funding_sources',
    'disbursements',
    'payment_runs',
    'payment_run_items',
    'payment_run_fee_charges',
    'receivable_adjustments',
    'books_deposit_batches',
    'books_deposit_batch_items',
    'receivable_payment_groups',
    'receivable_payment_group_items',
    'books_tax_adjustment_workpapers',
    'books_overhead_budgets',
    'books_overhead_budget_lines',
    'books_settings',
    'accounting_policies',
    'accounting_account_mappings',
    'gl_accounts',
    'books_projection_receipts',
    'accounting_facts',
    'journal_entries',
    'journal_lines',
    'accounting_periods',
    'accounting_reconciliation_runs',
    'accounting_reconciliation_items',
    'poc_snapshots',
    'books_comparison_runs',
    'books_comparison_items',
    'opening_balance_batches',
    'opening_balance_lines',
    'opening_balance_approvals',
    'bank_accounts',
    'bank_transactions',
    'bank_transaction_details',
    'bank_receipts',
    'bank_transaction_revisions',
    'bank_transaction_matches',
    'bank_reconciliations',
    'bank_reconciliation_items',
    'bank_rules',
    'coding_rules',
    'books_debt_instruments',
    'books_debt_events',
    'books_fixed_assets',
    'books_fixed_asset_events',
    'books_tax_jurisdictions',
    'books_tax_filings',
    'books_greenfield_launches',
    'books_journal_proposals',
    'books_cutover_runs',
    'books_cutover_approvals',
    'books_close_items',
    'recurring_posting_templates',
    'recurring_posting_lines',
    'financial_statement_snapshots',
    'tax_policy_versions',
    'companies',
    'contacts',
    'projects',
    'invoices',
    'invoice_lines',
    'payments',
    'payment_allocations',
    'payment_reversals',
    'vendor_bills',
    'bill_lines',
    'project_expenses',
    'project_expense_lines',
    'job_cost_entries',
    'billable_costs',
    'retainage',
    'files',
    'audit_log'
  ] loop
    execute format('select coalesce(jsonb_agg(to_jsonb(t) order by t.id), ''[]''::jsonb) from public.%I t where t.org_id = $1', v_table)
      into v_rows using p_org_id;
    v_tables := v_tables || jsonb_build_object(v_table, v_rows);
  end loop;
  return jsonb_build_object('orgId', p_org_id, 'capturedAt', statement_timestamp(),
    'databaseSnapshot', pg_current_snapshot()::text, 'tables', v_tables);
end;
$$;
revoke all on function public.capture_books_export_snapshot(uuid) from public, anon, authenticated;
grant execute on function public.capture_books_export_snapshot(uuid) to service_role;

-- ==== 20261003172517_books_tax_confirmation_withdrawal ====
-- Explicit no-adjustment confirmations and audited draft withdrawal.
alter table public.books_tax_adjustment_workpapers add column preparation_notes text not null default '';
alter table public.books_tax_adjustment_workpapers drop constraint books_tax_adjustment_workpapers_lines_check;
alter table public.books_tax_adjustment_workpapers add constraint books_tax_workpaper_lines_check check(jsonb_typeof(lines)='array' and jsonb_array_length(lines) between 0 and 500);
alter table public.books_tax_adjustment_workpapers add constraint books_tax_workpaper_confirmation_check check(length(preparation_notes)<=2000 and (jsonb_array_length(lines)>0 or length(trim(preparation_notes))>=10));
create or replace function public.guard_books_tax_workpaper() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
declare item jsonb; seen uuid[]:='{}'; line_id uuid; amount numeric;
begin
 if tg_op='DELETE' then raise exception 'Tax workpaper history cannot be deleted'; end if;
 if new.status='approved' and (coalesce(length(trim(new.review_notes)),0)<10 or new.reviewed_by is null or new.reviewed_by=new.prepared_by or not exists(select 1 from public.memberships where org_id=new.org_id and user_id=new.reviewed_by and status='active')) then raise exception 'Tax approval requires substantive notes and a separate active reviewer'; end if;
 if new.status in('withdrawn','superseded') and (coalesce(length(trim(new.close_reason)),0)<10 or not exists(select 1 from public.memberships where org_id=new.org_id and user_id=new.closed_by and status='active')) then raise exception 'Tax workpaper closure requires substantive notes and active organization actor'; end if;
 if tg_op='INSERT' or new.status='approved' then
  if public.books_tax_source_revision(public.capture_books_export_snapshot(new.org_id),new.period_end) is distinct from new.base_snapshot->>'source_revision' then raise exception 'Cash source revision changed before workpaper transition'; end if;
 end if;
 if tg_op='UPDATE' then
  if to_jsonb(new)-array['status','reviewed_by','reviewed_at','review_notes','closed_by','closed_at','close_reason'] is distinct from to_jsonb(old)-array['status','reviewed_by','reviewed_at','review_notes','closed_by','closed_at','close_reason'] then raise exception 'Tax workpaper evidence is immutable'; end if;
  if not ((old.status='draft' and new.status='approved') or (old.status='draft' and new.status='withdrawn') or (old.status='approved' and new.status='superseded' and new.reviewed_by=old.reviewed_by and new.reviewed_at=old.reviewed_at and new.review_notes=old.review_notes)) then raise exception 'Invalid tax workpaper transition'; end if;
 else
  if new.status<>'draft' then raise exception 'Tax workpapers must start as drafts'; end if;
  if not exists(select 1 from public.memberships where org_id=new.org_id and user_id=new.prepared_by and status='active') then raise exception 'Tax preparer must be an active organization member'; end if;
  if new.base_snapshot->>'basis' is distinct from 'cash' or new.base_snapshot->>'version' is distinct from '1' or new.base_snapshot->>'start_date' is distinct from new.period_start::text or new.base_snapshot->>'end_date' is distinct from new.period_end::text or coalesce(new.base_snapshot->>'source_revision','') !~ '^[a-f0-9]{64}$' then raise exception 'Tax workpaper requires exact dated cash basis and source revision'; end if;
  if coalesce(jsonb_typeof(new.base_snapshot->'net_income_cents'),'')<>'number' or abs((new.base_snapshot->>'net_income_cents')::numeric)>9007199254740991 or (new.base_snapshot->>'net_income_cents')::numeric<>trunc((new.base_snapshot->>'net_income_cents')::numeric) then raise exception 'Tax base requires exact safe integer cents'; end if;
  for item in select value from jsonb_array_elements(new.lines) loop
   line_id:=(item->>'id')::uuid;
   if line_id is null or line_id=any(seen) then raise exception 'Missing or duplicate tax adjustment identity'; end if;
   seen:=array_append(seen,line_id);
   amount:=(item->>'amount_cents')::numeric;
   if jsonb_typeof(item->'amount_cents') is distinct from 'number' or amount is null or amount=0 or amount<>trunc(amount) or abs(amount)>9007199254740991 or coalesce(item->>'kind','') not in('permanent','timing') or coalesce(length(trim(item->>'description')),0)<10 or coalesce(length(trim(item->>'evidence_reference')),0)<3 then raise exception 'Tax adjustments require signed exact cents, classification, explanation and evidence'; end if;
   if item->>'project_id' is not null and not exists(select 1 from public.projects where id=(item->>'project_id')::uuid and org_id=new.org_id) then raise exception 'Tax adjustment project is outside organization'; end if;
   if item->>'evidence_file_id' is not null and not exists(select 1 from public.files where id=(item->>'evidence_file_id')::uuid and org_id=new.org_id) then raise exception 'Tax adjustment evidence file is outside organization'; end if;
  end loop;
  if exists(select 1 from jsonb_array_elements(new.lines) group by value->>'kind' having abs(sum((value->>'amount_cents')::numeric))>9007199254740991) then raise exception 'Tax adjustment category exceeds exact safe cents'; end if;
  if abs((select coalesce(sum((value->>'amount_cents')::numeric),0) from jsonb_array_elements(new.lines)))>9007199254740991 or abs((new.base_snapshot->>'net_income_cents')::numeric+(select coalesce(sum((value->>'amount_cents')::numeric),0) from jsonb_array_elements(new.lines)))>9007199254740991 then raise exception 'Tax workpaper aggregate exceeds exact safe cents'; end if;
 end if;
 return new;
end $$;
drop function public.prepare_books_tax_workpaper(uuid,uuid,date,date,text,jsonb,jsonb,text,uuid);
create function public.prepare_books_tax_workpaper(p_org_id uuid,p_actor_id uuid,p_period_start date,p_period_end date,p_base_digest text,p_base_snapshot jsonb,p_lines jsonb,p_idempotency_key text,p_supersedes_id uuid default null,p_preparation_notes text default '')
returns uuid language plpgsql security invoker set search_path=pg_catalog,public as $$
declare existing public.books_tax_adjustment_workpapers; result uuid;
begin
 if not exists(select 1 from public.memberships where org_id=p_org_id and user_id=p_actor_id and status='active') then raise exception 'Tax preparer must be an active organization member'; end if;
 if p_org_id is null or p_actor_id is null or coalesce(length(trim(p_idempotency_key)),0)<10 then raise exception 'Tax workpaper scope, actor and retry key are required'; end if;
 perform pg_advisory_xact_lock(hashtextextended('tax-workpaper:'||p_org_id::text,0));
 select * into existing from public.books_tax_adjustment_workpapers where org_id=p_org_id and idempotency_key=p_idempotency_key;
 if found then
  if existing.prepared_by<>p_actor_id or existing.period_start<>p_period_start or existing.period_end<>p_period_end or existing.base_digest<>p_base_digest or existing.base_snapshot<>p_base_snapshot or existing.lines<>p_lines or existing.supersedes_id is distinct from p_supersedes_id or existing.preparation_notes is distinct from p_preparation_notes then raise exception 'Tax workpaper retry key has different evidence'; end if;
  return existing.id;
 end if;
 if public.books_tax_source_revision(public.capture_books_export_snapshot(p_org_id),p_period_end) is distinct from p_base_snapshot->>'source_revision' then raise exception 'Cash source revision changed before preparation'; end if;
 if p_supersedes_id is not null and not exists(select 1 from public.books_tax_adjustment_workpapers where org_id=p_org_id and id=p_supersedes_id and status='approved' and period_start=p_period_start and period_end=p_period_end) then raise exception 'Replacement requires an approved workpaper for the same exact period'; end if;
 insert into public.books_tax_adjustment_workpapers(org_id,period_start,period_end,base_digest,base_snapshot,lines,prepared_by,idempotency_key,supersedes_id,preparation_notes) values(p_org_id,p_period_start,p_period_end,p_base_digest,p_base_snapshot,p_lines,p_actor_id,p_idempotency_key,p_supersedes_id,p_preparation_notes) returning id into result;
 return result;
end $$;
revoke all on function public.prepare_books_tax_workpaper(uuid,uuid,date,date,text,jsonb,jsonb,text,uuid,text) from public,anon,authenticated;
grant execute on function public.prepare_books_tax_workpaper(uuid,uuid,date,date,text,jsonb,jsonb,text,uuid,text) to service_role;


create function public.withdraw_books_tax_workpaper(p_org_id uuid,p_id uuid,p_actor_id uuid,p_reason text)
returns uuid language plpgsql security invoker set search_path=pg_catalog,public as $$
declare item public.books_tax_adjustment_workpapers;
begin
 if not exists(select 1 from public.memberships where org_id=p_org_id and user_id=p_actor_id and status='active') then raise exception 'Tax withdrawal requires active organization actor'; end if;
 if coalesce(length(trim(p_reason)),0)<10 or length(p_reason)>2000 then raise exception 'Substantive tax withdrawal reason required'; end if;
 perform pg_advisory_xact_lock(hashtextextended('tax-workpaper:'||p_org_id::text,0));
 select * into item from public.books_tax_adjustment_workpapers where org_id=p_org_id and id=p_id for update;
 if not found then raise exception 'Tax workpaper not found in organization'; end if;
 if item.status='withdrawn' and item.closed_by=p_actor_id and item.close_reason=p_reason then return item.id; end if;
 if item.status<>'draft' then raise exception 'Only draft tax workpapers can be withdrawn'; end if;
 update public.books_tax_adjustment_workpapers set status='withdrawn',closed_by=p_actor_id,closed_at=now(),close_reason=p_reason where id=item.id;
 return item.id;
end $$;
revoke all on function public.withdraw_books_tax_workpaper(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.withdraw_books_tax_workpaper(uuid,uuid,uuid,text) to service_role;

-- ==== 20261003175333_books_tax_attachment_evidence ====
-- Freeze document identity inside immutable tax lines. Live file pointers may advance.
create function public.guard_books_tax_attachment_evidence() returns trigger
language plpgsql security invoker set search_path=pg_catalog,public as $$
declare item jsonb; proof jsonb; source public.files; version_id uuid;
begin
 if tg_op='UPDATE' and new.status<>'approved' then return new; end if;
 for item in select value from jsonb_array_elements(new.lines) loop
  proof:=item->'evidence_snapshot';
  if item->>'evidence_file_id' is null then
   if proof is not null and proof<>'null'::jsonb then raise exception 'Tax attachment requires referenced file'; end if;
   continue;
  end if;
  if not exists(select 1 from public.files where org_id=new.org_id and id=(item->>'evidence_file_id')::uuid) then raise exception 'Tax adjustment evidence file is outside organization'; end if;
  if jsonb_typeof(proof) is distinct from 'object' or proof->>'version' is distinct from '1'
   or proof->>'org_id' is distinct from new.org_id::text or proof->>'file_id' is distinct from item->>'evidence_file_id'
   or coalesce(proof->>'checksum','') !~ '^[a-f0-9]{64}$' or coalesce(length(proof->>'file_name'),0)=0
   or jsonb_typeof(proof->'size_bytes') is distinct from 'number'
   or not (proof ? 'document_version_id') or not (proof ? 'mime_type')
   or left(coalesce(proof->>'storage_path',''),length(new.org_id::text)+1)<>new.org_id::text||'/'
   or proof->>'storage_path' ~ '(^|/)\.\.?(/|$)' or strpos(proof->>'storage_path',chr(92))>0 or strpos(proof->>'storage_path','//')>0 then
   raise exception 'Tax attachment requires frozen scoped version, path, exact size and checksum evidence';
  end if;
  if (proof->>'size_bytes')::numeric<0 or (proof->>'size_bytes')::numeric>9007199254740991 or (proof->>'size_bytes')::numeric<>trunc((proof->>'size_bytes')::numeric) then raise exception 'Tax attachment requires exact safe byte size'; end if;
  version_id:=(proof->>'document_version_id')::uuid;
  if tg_op='INSERT' then
   perform pg_advisory_xact_lock(hashtextextended('tax-attachment:'||new.org_id::text||':'||(item->>'evidence_file_id'),0));
   select * into source from public.files where org_id=new.org_id and id=(item->>'evidence_file_id')::uuid for share;
   if not found or source.current_version_id is distinct from version_id or source.storage_path is distinct from proof->>'storage_path'
    or source.file_name is distinct from proof->>'file_name' or source.mime_type is distinct from proof->>'mime_type'
    or source.checksum is distinct from proof->>'checksum' or source.size_bytes is distinct from (proof->>'size_bytes')::bigint then
    raise exception 'Tax attachment file metadata changed before preparation';
   end if;
   if version_id is not null then
    perform 1 from public.doc_versions where id=version_id and org_id=new.org_id and file_id=source.id and storage_path=source.storage_path and checksum=source.checksum and size_bytes=source.size_bytes for share;
    if not found then raise exception 'Tax attachment document version mismatch'; end if;
   end if;
  end if;
 end loop;
 return new;
end $$;
revoke all on function public.guard_books_tax_attachment_evidence() from public,anon,authenticated;
create trigger books_tax_attachment_evidence before insert or update on public.books_tax_adjustment_workpapers for each row execute function public.guard_books_tax_attachment_evidence();
create index books_tax_attachment_references_idx on public.books_tax_adjustment_workpapers using gin(lines jsonb_path_ops);

-- Internal trigger needs a restricted read of service-only workpapers during ordinary document deletion.
-- No browser EXECUTE grant; no caller-controlled query or cross-organization row is returned.
create function public.protect_books_tax_document_evidence() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if tg_table_name='files' then
  perform pg_advisory_xact_lock(hashtextextended('tax-attachment:'||old.org_id::text||':'||old.id::text,0));
 else
  perform pg_advisory_xact_lock(hashtextextended('tax-attachment:'||old.org_id::text||':'||old.file_id::text,0));
 end if;
 if tg_table_name='files' then
  if exists(select 1 from public.books_tax_adjustment_workpapers where org_id=old.org_id and lines @> jsonb_build_array(jsonb_build_object('evidence_file_id',old.id))) then
   if tg_op='DELETE' then raise exception 'Tax workpaper document history cannot be deleted'; end if;
   if new.id is distinct from old.id or new.org_id is distinct from old.org_id then raise exception 'Tax workpaper document history identity is immutable'; end if;
   if new.storage_path is distinct from old.storage_path and not exists(select 1 from public.doc_versions where org_id=old.org_id and file_id=old.id and storage_path=old.storage_path and checksum=old.checksum and size_bytes=old.size_bytes) then raise exception 'Missing retained original tax document version'; end if;
  end if;
 else
  if tg_op='UPDATE' and to_jsonb(new)-array['label','notes'] is not distinct from to_jsonb(old)-array['label','notes'] then return new; end if;
  if exists(select 1 from public.books_tax_adjustment_workpapers where org_id=old.org_id and (lines @> jsonb_build_array(jsonb_build_object('evidence_snapshot',jsonb_build_object('document_version_id',old.id))) or lines @> jsonb_build_array(jsonb_build_object('evidence_file_id',old.file_id,'evidence_snapshot',jsonb_build_object('storage_path',old.storage_path))))) then raise exception 'Tax workpaper document version evidence is immutable'; end if;
 end if;
 if tg_op='DELETE' then return old; end if;
 return new;
end $$;
revoke all on function public.protect_books_tax_document_evidence() from public,anon,authenticated;
create trigger books_tax_file_history before update or delete on public.files for each row execute function public.protect_books_tax_document_evidence();
create trigger books_tax_version_history before update or delete on public.doc_versions for each row execute function public.protect_books_tax_document_evidence();

-- ==== 20261003182146_books_export_document_versions ====
-- Include current and historical document version identities in the same export snapshot.
create or replace function public.capture_books_export_snapshot(p_org_id uuid)
returns jsonb language plpgsql stable security invoker
set search_path = pg_catalog, public
as $$
declare
  v_table text;
  v_rows jsonb;
  v_tables jsonb := '{}'::jsonb;
begin
  if p_org_id is null then raise exception 'Export organization is required'; end if;
  foreach v_table in array array[
    'closings',
    'closing_checklist_items',
    'lot_takedowns',
    'lot_reservations',
    'budgets',
    'budget_lines',
    'commitments',
    'commitment_lines',
    'change_orders',
    'file_links',
    'project_financial_settings',
    'divisions',
    'communities',
    'community_phases',
    'lots',
    'contracts',
    'cost_codes',
    'time_entries',
    'warranty_requests',
    'warranty_service_visits',
    'warranty_backcharges',
    'org_funding_sources',
    'disbursements',
    'payment_runs',
    'payment_run_items',
    'payment_run_fee_charges',
    'receivable_adjustments',
    'books_deposit_batches',
    'books_deposit_batch_items',
    'receivable_payment_groups',
    'receivable_payment_group_items',
    'books_tax_adjustment_workpapers',
    'books_overhead_budgets',
    'books_overhead_budget_lines',
    'books_settings',
    'accounting_policies',
    'accounting_account_mappings',
    'gl_accounts',
    'books_projection_receipts',
    'accounting_facts',
    'journal_entries',
    'journal_lines',
    'accounting_periods',
    'accounting_reconciliation_runs',
    'accounting_reconciliation_items',
    'poc_snapshots',
    'books_comparison_runs',
    'books_comparison_items',
    'opening_balance_batches',
    'opening_balance_lines',
    'opening_balance_approvals',
    'bank_accounts',
    'bank_transactions',
    'bank_transaction_details',
    'bank_receipts',
    'bank_transaction_revisions',
    'bank_transaction_matches',
    'bank_reconciliations',
    'bank_reconciliation_items',
    'bank_rules',
    'coding_rules',
    'books_debt_instruments',
    'books_debt_events',
    'books_fixed_assets',
    'books_fixed_asset_events',
    'books_tax_jurisdictions',
    'books_tax_filings',
    'books_greenfield_launches',
    'books_journal_proposals',
    'books_cutover_runs',
    'books_cutover_approvals',
    'books_close_items',
    'recurring_posting_templates',
    'recurring_posting_lines',
    'financial_statement_snapshots',
    'tax_policy_versions',
    'companies',
    'contacts',
    'projects',
    'invoices',
    'invoice_lines',
    'payments',
    'payment_allocations',
    'payment_reversals',
    'vendor_bills',
    'bill_lines',
    'project_expenses',
    'project_expense_lines',
    'job_cost_entries',
    'billable_costs',
    'retainage',
    'doc_versions',
    'files',
    'audit_log'
  ] loop
    execute format('select coalesce(jsonb_agg(to_jsonb(t) order by t.id), ''[]''::jsonb) from public.%I t where t.org_id = $1', v_table)
      into v_rows using p_org_id;
    v_tables := v_tables || jsonb_build_object(v_table, v_rows);
  end loop;
  return jsonb_build_object('orgId', p_org_id, 'capturedAt', statement_timestamp(),
    'databaseSnapshot', pg_current_snapshot()::text, 'tables', v_tables);
end;
$$;
revoke all on function public.capture_books_export_snapshot(uuid) from public, anon, authenticated;
grant execute on function public.capture_books_export_snapshot(uuid) to service_role;

-- ==== 20261003192751_books_tax_attachment_lock_order ====
-- Row triggers execute after a writer may already own the file/version tuple.
-- Never wait for the evidence mutex from this reverse lock order: fail with
-- retryable serialization status instead. The transaction is rolled back, so
-- no partial metadata/history can survive a contended operation. Preparation
-- uses the same nonwaiting lock, including workpapers with multiple files.
create or replace function public.guard_books_tax_attachment_evidence() returns trigger
language plpgsql security invoker set search_path=pg_catalog,public as $$
declare item jsonb; proof jsonb; source public.files; version_id uuid;
begin
 if tg_op='UPDATE' and new.status<>'approved' then return new; end if;
 for item in select value from jsonb_array_elements(new.lines) loop
  proof:=item->'evidence_snapshot';
  if item->>'evidence_file_id' is null then
   if proof is not null and proof<>'null'::jsonb then raise exception 'Tax attachment requires referenced file'; end if;
   continue;
  end if;
  if not exists(select 1 from public.files where org_id=new.org_id and id=(item->>'evidence_file_id')::uuid) then raise exception 'Tax adjustment evidence file is outside organization'; end if;
  if jsonb_typeof(proof) is distinct from 'object' or proof->>'version' is distinct from '1'
   or proof->>'org_id' is distinct from new.org_id::text or proof->>'file_id' is distinct from item->>'evidence_file_id'
   or coalesce(proof->>'checksum','') !~ '^[a-f0-9]{64}$' or coalesce(length(proof->>'file_name'),0)=0
   or jsonb_typeof(proof->'size_bytes') is distinct from 'number'
   or not (proof ? 'document_version_id') or not (proof ? 'mime_type')
   or left(coalesce(proof->>'storage_path',''),length(new.org_id::text)+1)<>new.org_id::text||'/'
   or proof->>'storage_path' ~ '(^|/)\.\.?(/|$)' or strpos(proof->>'storage_path',chr(92))>0 or strpos(proof->>'storage_path','//')>0 then
   raise exception 'Tax attachment requires frozen scoped version, path, exact size and checksum evidence';
  end if;
  if (proof->>'size_bytes')::numeric<0 or (proof->>'size_bytes')::numeric>9007199254740991 or (proof->>'size_bytes')::numeric<>trunc((proof->>'size_bytes')::numeric) then raise exception 'Tax attachment requires exact safe byte size'; end if;
  version_id:=(proof->>'document_version_id')::uuid;
  if tg_op='INSERT' then
   if not pg_try_advisory_xact_lock(hashtextextended('tax-attachment:'||new.org_id::text||':'||(item->>'evidence_file_id'),0)) then raise exception 'Document evidence is changing concurrently; retry the operation' using errcode='40001'; end if;
   select * into source from public.files where org_id=new.org_id and id=(item->>'evidence_file_id')::uuid for share;
   if not found or source.current_version_id is distinct from version_id or source.storage_path is distinct from proof->>'storage_path'
    or source.file_name is distinct from proof->>'file_name' or source.mime_type is distinct from proof->>'mime_type'
    or source.checksum is distinct from proof->>'checksum' or source.size_bytes is distinct from (proof->>'size_bytes')::bigint then
    raise exception 'Tax attachment file metadata changed before preparation';
   end if;
   if version_id is not null then
    perform 1 from public.doc_versions where id=version_id and org_id=new.org_id and file_id=source.id and storage_path=source.storage_path and checksum=source.checksum and size_bytes=source.size_bytes for share;
    if not found then raise exception 'Tax attachment document version mismatch'; end if;
   end if;
  end if;
 end loop;
 return new;
end $$;
revoke all on function public.guard_books_tax_attachment_evidence() from public,anon,authenticated;

create or replace function public.protect_books_tax_document_evidence() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if tg_table_name='files' then
  if not pg_try_advisory_xact_lock(hashtextextended('tax-attachment:'||old.org_id::text||':'||old.id::text,0)) then raise exception 'Document evidence is changing concurrently; retry the operation' using errcode='40001'; end if;
 else
  if not pg_try_advisory_xact_lock(hashtextextended('tax-attachment:'||old.org_id::text||':'||old.file_id::text,0)) then raise exception 'Document evidence is changing concurrently; retry the operation' using errcode='40001'; end if;
 end if;
 if tg_table_name='files' then
  if exists(select 1 from public.books_tax_adjustment_workpapers where org_id=old.org_id and lines @> jsonb_build_array(jsonb_build_object('evidence_file_id',old.id))) then
   if tg_op='DELETE' then raise exception 'Tax workpaper document history cannot be deleted'; end if;
   if new.id is distinct from old.id or new.org_id is distinct from old.org_id then raise exception 'Tax workpaper document history identity is immutable'; end if;
   if new.storage_path is not distinct from old.storage_path and (new.checksum is distinct from old.checksum or new.size_bytes is distinct from old.size_bytes)
    and exists(select 1 from public.books_tax_adjustment_workpapers where org_id=old.org_id and lines @> jsonb_build_array(jsonb_build_object('evidence_file_id',old.id,'evidence_snapshot',jsonb_build_object('storage_path',old.storage_path)))) then
    raise exception 'Tax workpaper original object metadata is immutable';
   end if;
   if new.storage_path is distinct from old.storage_path and not exists(select 1 from public.doc_versions where org_id=old.org_id and file_id=old.id and storage_path=old.storage_path and checksum=old.checksum and size_bytes=old.size_bytes) then raise exception 'Missing retained original tax document version'; end if;
  end if;
 else
  if tg_op='UPDATE' and to_jsonb(new)-array['label','notes'] is not distinct from to_jsonb(old)-array['label','notes'] then return new; end if;
  if exists(select 1 from public.books_tax_adjustment_workpapers where org_id=old.org_id and (lines @> jsonb_build_array(jsonb_build_object('evidence_snapshot',jsonb_build_object('document_version_id',old.id))) or lines @> jsonb_build_array(jsonb_build_object('evidence_file_id',old.file_id,'evidence_snapshot',jsonb_build_object('storage_path',old.storage_path))))) then raise exception 'Tax workpaper document version evidence is immutable'; end if;
 end if;
 if tg_op='DELETE' then return old; end if;
 return new;
end $$;
revoke all on function public.protect_books_tax_document_evidence() from public,anon,authenticated;
