-- STAGED / UNAPPLIED. Requires package and price publication foundations.
-- Acknowledgment reconciles a historical commit; it never republishes catalog data.
create function public.inspect_catalog_publication(p_org_id uuid,p_actor_id uuid,p_kind text,p_key uuid,p_request jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare cancellation public.catalog_publication_cancellations; package_receipt public.catalog_package_publication_receipts; price_receipt public.catalog_price_publication_receipts;
 c public.selection_packages; price public.selection_catalog_prices; item jsonb; receipt_id uuid; committed_at timestamptz;
 state text:='unchanged'; labels jsonb; can_margin boolean:=false; source_request jsonb; entity_ids uuid[]:='{}'; community uuid; checked_communities uuid[];
begin
 if p_kind not in ('package','prices') or p_kind is null or p_key is null or jsonb_typeof(p_request) is distinct from 'object' then raise exception 'Valid reviewed publication required';end if;
 community:=(p_request->>'communityId')::uuid;
 perform public.assert_catalog_publication_actor(p_org_id,p_actor_id,community);
 if p_kind='package' and (p_request ? 'costCents' or p_request->'expectedPackage' ? 'cost_cents') or p_kind='prices' and jsonb_typeof(p_request->'items')='array' and exists(select 1 from jsonb_array_elements(p_request->'items') x where x ? 'costCents' or x->'expectedPrice' ? 'cost_cents') then
  begin perform public.assert_catalog_publication_actor(p_org_id,p_actor_id,community,'financials.margin.read');
  exception when insufficient_privilege then raise exception 'Margin permission required to reconcile cost-bearing publication' using errcode='42501';end;
 end if;
 begin perform public.assert_catalog_publication_actor(p_org_id,p_actor_id,community,'financials.margin.read');can_margin:=true;exception when insufficient_privilege then can_margin:=false;end;
 checked_communities:=array[community];
 perform pg_advisory_xact_lock(hashtextextended((case when p_kind='package' then 'catalog-package:' else 'catalog-prices:' end)||p_org_id::text||':'||p_key::text,0));
 if exists(select 1 from public.catalog_publication_intents where org_id=p_org_id and kind=p_kind and request_key=p_key and (actor_id<>p_actor_id or request is distinct from p_request)) then raise exception 'Registered publication belongs to different reviewed inputs or actor';end if;
 select review_labels into labels from public.catalog_publication_intents where org_id=p_org_id and kind=p_kind and request_key=p_key and actor_id=p_actor_id;
 select * into cancellation from public.catalog_publication_cancellations where org_id=p_org_id and kind=p_kind and request_key=p_key;
 if found then
  if cancellation.request is distinct from p_request then raise exception 'Cancellation belongs to different reviewed inputs';end if;
  return jsonb_build_object('orgId',p_org_id,'kind',p_kind,'requestKey',p_key,'status','cancelled','receiptId',null,'committedAt',null,'sourceState',null,'entityIds','[]'::jsonb,'cancellationId',cancellation.id,'cancelledAt',cancellation.created_at,'reviewLabels',labels,'canReadMargin',can_margin);
 end if;
 if p_kind='package' then
  select * into package_receipt from public.catalog_package_publication_receipts where org_id=p_org_id and request_key=p_key;
  if found then
   receipt_id:=package_receipt.id;committed_at:=package_receipt.created_at;source_request:=package_receipt.request;
   entity_ids:=array[package_receipt.package_id];
  end if;
 else
  select * into price_receipt from public.catalog_price_publication_receipts where org_id=p_org_id and request_key=p_key;
  if found then receipt_id:=price_receipt.id;committed_at:=price_receipt.created_at;source_request:=price_receipt.request;end if;
 end if;
 if receipt_id is null then return jsonb_build_object('orgId',p_org_id,'kind',p_kind,'requestKey',p_key,'status','not_found','receiptId',null,'committedAt',null,'sourceState',null,'entityIds','[]'::jsonb,'reviewLabels',labels,'canReadMargin',can_margin);end if;
 if source_request is distinct from p_request then raise exception 'Receipt belongs to different reviewed inputs';end if;
 if p_kind='package' then
  select * into c from public.selection_packages where org_id=p_org_id and id=package_receipt.package_id for share;
  if not found then state:='missing';
  else
   if c.community_id is distinct from community then perform public.assert_catalog_publication_actor(p_org_id,p_actor_id,c.community_id);end if;
   perform 1 from public.selection_package_items where org_id=p_org_id and package_id=c.id order by id for share;
   if public.catalog_package_source(c) is distinct from package_receipt.package_source then state:='changed';end if;
  end if;
 else
  for item in select x from jsonb_array_elements(price_receipt.prices) x order by x->>'id' loop
   entity_ids:=array_append(entity_ids,(item->>'id')::uuid);
   select * into price from public.selection_catalog_prices where org_id=p_org_id and id=(item->>'id')::uuid for share;
   if not found then state:='missing';
   else
    if not exists(select 1 from unnest(checked_communities) as checked(value) where checked.value is not distinct from price.community_id) then
     perform public.assert_catalog_publication_actor(p_org_id,p_actor_id,price.community_id);
     checked_communities:=array_append(checked_communities,price.community_id);
    end if;
    if state<>'missing' and public.catalog_price_source(price) is distinct from item then state:='changed';end if;
   end if;
  end loop;
 end if;
 -- No price, cost, request or source JSON is exposed by receipt inspection.
 return jsonb_build_object('orgId',p_org_id,'kind',p_kind,'requestKey',p_key,'status','committed','receiptId',receipt_id,'committedAt',committed_at,'sourceState',state,'entityIds',to_jsonb(entity_ids),'reviewLabels',labels,'canReadMargin',can_margin);
end $$;
revoke all on function public.inspect_catalog_publication(uuid,uuid,text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.inspect_catalog_publication(uuid,uuid,text,uuid,jsonb) to service_role;

create table public.catalog_publication_reconciliations(
 id uuid primary key default gen_random_uuid(),org_id uuid not null references public.orgs(id),ack_key uuid not null,kind text not null check(kind in ('package','prices')),
 request_key uuid not null,actor_id uuid not null references public.app_users(id),price_receipt_id uuid references public.catalog_price_publication_receipts(id),
 package_receipt_id uuid references public.catalog_package_publication_receipts(id),reason text not null check(length(btrim(reason)) between 10 and 1000),
 source_state text not null check(source_state in ('unchanged','changed','missing')),audit_id bigint not null references public.audit_log(id),event_id uuid not null references public.events(id),
 created_at timestamptz not null default now(),unique(org_id,ack_key),check((kind='package' and package_receipt_id is not null and price_receipt_id is null) or (kind='prices' and price_receipt_id is not null and package_receipt_id is null))
);
create index catalog_reconciliation_actor_idx on public.catalog_publication_reconciliations(actor_id);
create index catalog_reconciliation_price_idx on public.catalog_publication_reconciliations(price_receipt_id);
create index catalog_reconciliation_package_idx on public.catalog_publication_reconciliations(package_receipt_id);
create index catalog_reconciliation_audit_idx on public.catalog_publication_reconciliations(audit_id);
create index catalog_reconciliation_event_idx on public.catalog_publication_reconciliations(event_id);
alter table public.catalog_publication_reconciliations enable row level security;
revoke all on public.catalog_publication_reconciliations from public,anon,authenticated,service_role;
grant select on public.catalog_publication_reconciliations to service_role;
create trigger catalog_publication_reconciliation_immutable before update or delete on public.catalog_publication_reconciliations for each row execute function public.guard_catalog_package_publication_receipt();

create function public.acknowledge_catalog_publication(p_org_id uuid,p_actor_id uuid,p_kind text,p_key uuid,p_request jsonb,p_receipt_id uuid,p_ack_key uuid,p_reason text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare inspected jsonb; prior public.catalog_publication_reconciliations; audit_key bigint; event_key uuid;
begin
 if p_ack_key is null or p_receipt_id is null or p_reason is null or length(btrim(p_reason)) not between 10 and 1000 then raise exception 'Reviewed receipt, stable acknowledgment key and reconciliation reason required';end if;
 -- Current permissions and exact original input are checked on initial acknowledgment and replay.
 inspected:=public.inspect_catalog_publication(p_org_id,p_actor_id,p_kind,p_key,p_request);
 if inspected->>'status'<>'committed' or (inspected->>'receiptId')::uuid is distinct from p_receipt_id then raise exception 'Matching committed receipt required; do not discard unconfirmed recovery';end if;
 perform pg_advisory_xact_lock(hashtextextended('catalog-reconciliation:'||p_org_id::text||':'||p_ack_key::text,0));
 select * into prior from public.catalog_publication_reconciliations where org_id=p_org_id and ack_key=p_ack_key;
 if found then
  if prior.kind<>p_kind or prior.request_key<>p_key or prior.actor_id<>p_actor_id or coalesce(prior.price_receipt_id,prior.package_receipt_id)<>p_receipt_id or prior.reason<>btrim(p_reason) then raise exception 'Acknowledgment key belongs to a different reconciliation';end if;
 else
  insert into public.events(org_id,event_type,entity_type,entity_id,payload,channel) values(p_org_id,'catalog_publication_reconciled','catalog_publication_receipt',p_receipt_id,jsonb_build_object('kind',p_kind,'request_key',p_key,'source_state',inspected->>'sourceState','actor_id',p_actor_id),'activity') returning id into event_key;
  insert into public.audit_log(org_id,actor_user_id,action,entity_type,entity_id,after_data,source) values(p_org_id,p_actor_id,'update','catalog_publication_receipt',p_receipt_id,jsonb_build_object('kind',p_kind,'request_key',p_key,'reason',btrim(p_reason),'source_state',inspected->>'sourceState'),'catalog_publication_reconciliation') returning id into audit_key;
  insert into public.catalog_publication_reconciliations(org_id,ack_key,kind,request_key,actor_id,price_receipt_id,package_receipt_id,reason,source_state,audit_id,event_id)
   values(p_org_id,p_ack_key,p_kind,p_key,p_actor_id,case when p_kind='prices' then p_receipt_id end,case when p_kind='package' then p_receipt_id end,btrim(p_reason),inspected->>'sourceState',audit_key,event_key) returning * into prior;
 end if;
 return jsonb_build_object('orgId',p_org_id,'kind',p_kind,'requestKey',p_key,'receiptId',p_receipt_id,'ackKey',p_ack_key,'reconciliationId',prior.id);
end $$;
revoke all on function public.acknowledge_catalog_publication(uuid,uuid,text,uuid,jsonb,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.acknowledge_catalog_publication(uuid,uuid,text,uuid,jsonb,uuid,uuid,text) to service_role;

-- The inspector acquires the publisher's key lock and holds it until commit.
-- Publication first => refuse cancellation; cancellation first => publication is fenced.
create function public.cancel_catalog_publication(p_org_id uuid,p_actor_id uuid,p_kind text,p_key uuid,p_request jsonb,p_reason text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare inspected jsonb; prior public.catalog_publication_cancellations; audit_key bigint; event_key uuid; cancellation_key uuid;
begin
 if p_reason is null or length(btrim(p_reason)) not between 10 and 1000 or octet_length(p_request::text)>524288 then raise exception 'Reviewed publication and cancellation reason required';end if;
 -- Reauthorize original scope and cost-bearing inputs on initial cancellation and replay.
 inspected:=public.inspect_catalog_publication(p_org_id,p_actor_id,p_kind,p_key,p_request);
 if inspected->>'status'='committed' then raise exception 'Publication already committed; acknowledge its receipt instead of cancelling';end if;
 select * into prior from public.catalog_publication_cancellations where org_id=p_org_id and kind=p_kind and request_key=p_key;
 if found then
  if prior.actor_id<>p_actor_id or prior.request is distinct from p_request or prior.reason<>btrim(p_reason) then raise exception 'Cancellation key belongs to a different resolution';end if;
 else
  cancellation_key:=gen_random_uuid();
  insert into public.events(org_id,event_type,entity_type,entity_id,payload,channel) values(p_org_id,'catalog_publication_cancelled','catalog_publication_cancellation',cancellation_key,jsonb_build_object('kind',p_kind,'request_key',p_key,'actor_id',p_actor_id),'activity') returning id into event_key;
  insert into public.audit_log(org_id,actor_user_id,action,entity_type,entity_id,after_data,source) values(p_org_id,p_actor_id,'create','catalog_publication_cancellation',cancellation_key,jsonb_build_object('kind',p_kind,'request_key',p_key,'reason',btrim(p_reason)),'catalog_publication_cancellation') returning id into audit_key;
  insert into public.catalog_publication_cancellations(id,org_id,kind,request_key,actor_id,request,reason,audit_id,event_id,history_sequence) values(cancellation_key,p_org_id,p_kind,p_key,p_actor_id,p_request,btrim(p_reason),audit_key,event_key,public.allocate_catalog_publication_history(p_org_id,p_actor_id,(p_request->>'communityId')::uuid)) returning * into prior;
 end if;
 delete from public.catalog_publication_claims where org_id=p_org_id and intent_id in(select id from public.catalog_publication_intents where org_id=p_org_id and kind=p_kind and request_key=p_key);
 -- Public metadata contains no cost, request body or catalog source values.
 return jsonb_build_object('orgId',p_org_id,'kind',p_kind,'requestKey',p_key,'cancellationId',prior.id,'cancelledAt',prior.created_at);
end $$;
revoke all on function public.cancel_catalog_publication(uuid,uuid,text,uuid,jsonb,text) from public,anon,authenticated;
grant execute on function public.cancel_catalog_publication(uuid,uuid,text,uuid,jsonb,text) to service_role;
