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
