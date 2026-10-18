-- STAGED / UNAPPLIED. Requires catalog revisions and creation receipts.
-- Draft and active purchase agreements reserve capacity. Void/deletion release it.
-- Reconcile existing snapshots and limits before application; never invent history.
-- Freeze both writers across historical backfill and trigger installation.
begin;
lock table public.contracts,public.incentives in access exclusive mode;
create table public.agreement_incentive_capacity (
 org_id uuid not null references public.orgs(id),
 incentive_id uuid not null,
 used_count bigint not null default 0 check(used_count>=0),
 max_uses integer check(max_uses is null or max_uses>0),
 status text not null,
 community_id uuid,
 effective_start date, effective_end date,
 requires_approval boolean not null, approved_at text,
 primary key(org_id,incentive_id),
 check(max_uses is null or used_count<=max_uses)
);
alter table public.agreement_incentive_capacity enable row level security;
revoke all on public.agreement_incentive_capacity from public,anon,authenticated,service_role;
grant select on public.agreement_incentive_capacity to authenticated,service_role;
create policy agreement_incentive_capacity_org_read on public.agreement_incentive_capacity for select to authenticated using(public.is_org_member(org_id));

create function public.agreement_consumed_incentives(p_snapshot jsonb) returns uuid[]
language plpgsql immutable set search_path='' as $$
declare items jsonb:=p_snapshot#>'{purchase_agreement,pricing,incentives}'; ids uuid[]; explicit_ids uuid[];
begin
 if items is null then items:='[]'; end if;
 if jsonb_typeof(items)<>'array' or jsonb_array_length(items)>50 then raise exception 'Agreement incentive evidence is malformed'; end if;
 if exists(select 1 from jsonb_array_elements(items) x where jsonb_typeof(x)<>'object' or coalesce(x->>'incentiveId','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then raise exception 'Agreement incentive identity is malformed'; end if;
 select coalesce(array_agg((x->>'incentiveId')::uuid order by (x->>'incentiveId')::uuid),'{}') into ids from jsonb_array_elements(items) x;
 if cardinality(ids)<>(select count(distinct x) from unnest(ids) x) then raise exception 'Duplicate agreement incentive identity'; end if;
 if p_snapshot#>'{purchase_agreement,incentive_ids}' is not null then
  if jsonb_typeof(p_snapshot#>'{purchase_agreement,incentive_ids}')<>'array' then raise exception 'Agreement incentive identities differ from pricing'; end if;
  select coalesce(array_agg(x::uuid order by x::uuid),'{}') into explicit_ids from jsonb_array_elements_text(p_snapshot#>'{purchase_agreement,incentive_ids}') x;
  if ids is distinct from explicit_ids then raise exception 'Agreement incentive identities differ from pricing'; end if;
 end if;
 return ids;
end $$;
revoke all on function public.agreement_consumed_incentives(jsonb) from public,anon,authenticated,service_role;

insert into public.agreement_incentive_capacity(org_id,incentive_id,max_uses,status,community_id,effective_start,effective_end,requires_approval,approved_at)
 select org_id,id,max_uses,status,community_id,effective_start,effective_end,requires_approval,metadata->>'approved_at' from public.incentives;
do $$declare c public.contracts; key uuid;begin
 for c in select * from public.contracts where contract_type='purchase_agreement' and status in ('draft','active') order by org_id,id loop
  foreach key in array public.agreement_consumed_incentives(c.snapshot) loop
   update public.agreement_incentive_capacity set used_count=used_count+1 where org_id=c.org_id and incentive_id=key;
   if not found then raise exception 'Existing agreement incentive needs reconciliation: %',c.id; end if;
  end loop;
 end loop;
end $$;

-- Policy writes contend on the same row as consumption; mirrored policy avoids
-- stale limit reads after waits, including transactions with older snapshots.
create function public.synchronize_agreement_incentive_capacity() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if tg_op<>'INSERT' then
  perform 1 from public.agreement_incentive_capacity where org_id=old.org_id and incentive_id=old.id for update;
  if not found then raise exception 'Incentive capacity evidence is unavailable'; end if;
  if tg_op='DELETE' or new.org_id is distinct from old.org_id or new.id is distinct from old.id then
   delete from public.agreement_incentive_capacity where org_id=old.org_id and incentive_id=old.id and used_count=0;
   if not found then raise exception 'An incentive reserved by agreements cannot be deleted or moved'; end if;
  end if;
 end if;
 if tg_op<>'DELETE' then
  insert into public.agreement_incentive_capacity(org_id,incentive_id,max_uses,status,community_id,effective_start,effective_end,requires_approval,approved_at)
   values(new.org_id,new.id,new.max_uses,new.status,new.community_id,new.effective_start,new.effective_end,new.requires_approval,new.metadata->>'approved_at')
   on conflict(org_id,incentive_id) do update set max_uses=excluded.max_uses,status=excluded.status,community_id=excluded.community_id,
    effective_start=excluded.effective_start,effective_end=excluded.effective_end,requires_approval=excluded.requires_approval,approved_at=excluded.approved_at;
  return new;
 end if;
 return old;
end $$;
revoke all on function public.synchronize_agreement_incentive_capacity() from public,anon,authenticated,service_role;
create trigger agreement_incentive_capacity_policy before insert or update or delete on public.incentives for each row execute function public.synchronize_agreement_incentive_capacity();

create function public.lock_agreement_incentive_capacity(p_org_id uuid,p_ids jsonb) returns void
language plpgsql security definer set search_path='' as $$
declare key uuid;
begin
 if jsonb_typeof(p_ids) is distinct from 'array' or jsonb_array_length(p_ids)>50 then raise exception 'Verified incentive identities required'; end if;
 for key in select distinct x::uuid from jsonb_array_elements_text(p_ids) x order by x::uuid loop
  perform 1 from public.agreement_incentive_capacity where org_id=p_org_id and incentive_id=key for update;
  if not found then raise exception 'Incentive capacity evidence is unavailable'; end if;
 end loop;
end $$;
revoke all on function public.lock_agreement_incentive_capacity(uuid,jsonb) from public,anon,authenticated,service_role;

create function public.account_agreement_incentive_capacity() returns trigger
language plpgsql security definer set search_path='' as $$
declare old_org uuid; new_org uuid; old_ids uuid[]:='{}'; new_ids uuid[]:='{}'; k record; delta integer; capacity public.agreement_incentive_capacity; today date:=(clock_timestamp() at time zone 'UTC')::date;
begin
 if tg_op<>'INSERT' and old.contract_type='purchase_agreement' and old.status in ('draft','active') then old_org:=old.org_id;old_ids:=public.agreement_consumed_incentives(old.snapshot);end if;
 if tg_op<>'DELETE' and new.contract_type='purchase_agreement' and new.status in ('draft','active') then new_org:=new.org_id;new_ids:=public.agreement_consumed_incentives(new.snapshot);end if;
 for k in select org,id from (select old_org org,unnest(old_ids) id union select new_org,unnest(new_ids)) keys order by org,id loop
  delta:=(case when k.org=new_org and k.id=any(new_ids) then 1 else 0 end)-(case when k.org=old_org and k.id=any(old_ids) then 1 else 0 end);
  if delta=0 then continue;end if;
  select * into capacity from public.agreement_incentive_capacity where org_id=k.org and incentive_id=k.id for update;
  if not found then raise exception 'Incentive capacity evidence is unavailable';end if;
  if delta>0 and (capacity.status<>'active' or capacity.effective_start>today or capacity.effective_end<today
    or capacity.requires_approval and nullif(capacity.approved_at,'') is null
    or capacity.max_uses is not null and capacity.used_count>=capacity.max_uses) then
   raise exception 'Incentive is unavailable or exhausted; review a fresh quote' using detail='AGREEMENT_QUOTE_CHANGED';
  end if;
  if delta>0 and capacity.community_id is not null and not exists(select 1 from public.lots where org_id=new.org_id and project_id=new.project_id and community_id=capacity.community_id) then raise exception 'Incentive belongs to another community';end if;
  update public.agreement_incentive_capacity set used_count=used_count+delta where org_id=k.org and incentive_id=k.id;
 end loop;
 return null;
end $$;
revoke all on function public.account_agreement_incentive_capacity() from public,anon,authenticated,service_role;
create trigger agreement_incentive_capacity_account after insert or update or delete on public.contracts for each row execute function public.account_agreement_incentive_capacity();
create function public.forbid_agreement_capacity_truncate() returns trigger language plpgsql set search_path='' as $$begin raise exception 'Truncating agreements bypasses incentive capacity evidence';end $$;
revoke all on function public.forbid_agreement_capacity_truncate() from public,anon,authenticated,service_role;
create trigger agreement_incentive_capacity_no_truncate before truncate on public.contracts for each statement execute function public.forbid_agreement_capacity_truncate();
commit;
