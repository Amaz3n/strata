-- Design-studio catalog publication: reconciliation, intents, history, pending scopes, the archived package queue, package member discovery and search indexes, and group publication with its recovery.
--
-- Consolidated before deploy (2026-10-09) from 9 unapplied migrations, in their
-- original order; each section is marked with the file it came from.

-- ==== 20261004025518_catalog_publication_reconciliation ====
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

-- ==== 20261004033000_catalog_publication_intents ====
-- STAGED / UNAPPLIED. Requires complete revision/package/price/reconciliation foundations.
-- Public names are captured at registration, separate from the exact write body.
-- Missing/out-of-scope subjects remain unnamed; no current or source costs appear.
create function public.capture_catalog_publication_review(p_org_id uuid,p_kind text,p_request jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare community uuid:=(p_request->>'communityId')::uuid; labels jsonb;
begin
 if p_kind='package' then
  select jsonb_build_object('kind','package','options',jsonb_agg(jsonb_build_object('optionId',x.value::uuid,'name',left(to_jsonb(o)->>'name',200)) order by x.ordinality)) into labels
  from jsonb_array_elements_text(p_request->'optionIds') with ordinality x(value,ordinality)
  left join public.selection_options o on o.org_id=p_org_id and o.id=x.value::uuid and (o.community_id is null or o.community_id=community);
 else
  select jsonb_build_object('kind','prices','items',jsonb_agg(jsonb_build_object('optionId',(x.value->>'optionId')::uuid,'packageId',(x.value->>'packageId')::uuid,'housePlanVersionId',(x.value->>'housePlanVersionId')::uuid,
   'subjectName',left(case when x.value->>'optionId' is not null then to_jsonb(o)->>'name' else p.name end,200),'planName',left(h.name,200),'versionLabel',left(coalesce(nullif(v.label,''),'v'||v.version_number::text),200)) order by x.ordinality)) into labels
  from jsonb_array_elements(p_request->'items') with ordinality x(value,ordinality)
  left join public.selection_options o on o.org_id=p_org_id and o.id=(x.value->>'optionId')::uuid and (o.community_id is null or o.community_id=community)
  left join public.selection_packages p on p.org_id=p_org_id and p.id=(x.value->>'packageId')::uuid and (p.community_id is null or p.community_id=community)
  left join public.house_plan_versions v on v.org_id=p_org_id and v.id=(x.value->>'housePlanVersionId')::uuid
  left join public.house_plans h on h.org_id=p_org_id and h.id=v.house_plan_id;
 end if;
 return labels;
end $$;
revoke all on function public.capture_catalog_publication_review(uuid,text,jsonb) from public,anon,authenticated,service_role;

create function public.register_catalog_publication(p_org_id uuid,p_actor_id uuid,p_kind text,p_key uuid,p_request jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare prior public.catalog_publication_intents; community uuid; recorded_body jsonb; recorded_actor uuid; state text:='prepared';
 intent_key uuid; audit_key bigint; event_key uuid; sequence_key bigint; captured_labels jsonb;
begin
 if p_kind is null or p_kind not in ('package','prices') or p_key is null or jsonb_typeof(p_request) is distinct from 'object' or length(p_request::text)>512000 then raise exception 'Valid reviewed publication required';end if;
 if p_kind='package' and (jsonb_typeof(p_request->'optionIds') is distinct from 'array' or jsonb_array_length(p_request->'optionIds') not between 1 and 100) or p_kind='prices' and (jsonb_typeof(p_request->'items') is distinct from 'array' or jsonb_array_length(p_request->'items') not between 1 and 500) then raise exception 'Bounded reviewed publication required';end if;
 if p_kind='package' and exists(select 1 from jsonb_array_elements_text(p_request->'optionIds') x group by x::uuid having count(*)>1) then raise exception 'Choose each package option only once';end if;
 community:=(p_request->>'communityId')::uuid;
 perform public.assert_catalog_publication_actor(p_org_id,p_actor_id,community);
 if p_kind='package' and (p_request ? 'costCents' or p_request->'expectedPackage' ? 'cost_cents') or p_kind='prices' and exists(select 1 from jsonb_array_elements(p_request->'items') x where x ? 'costCents' or x->'expectedPrice' ? 'cost_cents') then
  begin perform public.assert_catalog_publication_actor(p_org_id,p_actor_id,community,'financials.margin.read');
  exception when insufficient_privilege then raise exception 'Margin permission required to register cost-bearing publication' using errcode='42501';end;
 end if;
 perform pg_advisory_xact_lock(hashtextextended((case when p_kind='package' then 'catalog-package:' else 'catalog-prices:' end)||p_org_id::text||':'||p_key::text,0));
 select * into prior from public.catalog_publication_intents where org_id=p_org_id and kind=p_kind and request_key=p_key;
 if found and (prior.actor_id<>p_actor_id or prior.request is distinct from p_request) then raise exception 'Registered publication belongs to different reviewed inputs or actor';end if;
 select request,actor_id into recorded_body,recorded_actor from public.catalog_publication_cancellations where org_id=p_org_id and kind=p_kind and request_key=p_key;
 if found then state:='cancelled';
 elsif p_kind='package' then
  select request,actor_id into recorded_body,recorded_actor from public.catalog_package_publication_receipts where org_id=p_org_id and request_key=p_key;
  if found then state:='committed';end if;
 else
  select request,actor_id into recorded_body,recorded_actor from public.catalog_price_publication_receipts where org_id=p_org_id and request_key=p_key;
  if found then state:='committed';end if;
 end if;
 if state<>'prepared' then
  if recorded_actor<>p_actor_id or recorded_body is distinct from p_request then raise exception 'Recorded outcome belongs to different reviewed inputs or actor';end if;
 elsif prior.id is not null then
  if not exists(select 1 from public.catalog_publication_claims where org_id=p_org_id and actor_id=p_actor_id and kind=p_kind and scope_key=coalesce(community::text,'org') and intent_id=prior.id) then raise exception 'Registered request needs administrator recovery; keep its evidence';end if;
 else
  if exists(select 1 from public.catalog_publication_claims where org_id=p_org_id and actor_id=p_actor_id and kind=p_kind and scope_key=coalesce(community::text,'org')) then raise exception 'Resolve the previous registered request in Publication history before another save';end if;
  captured_labels:=public.capture_catalog_publication_review(p_org_id,p_kind,p_request);
  intent_key:=gen_random_uuid();sequence_key:=public.allocate_catalog_publication_history(p_org_id,p_actor_id,community);
  insert into public.events(org_id,event_type,entity_type,entity_id,payload,channel) values(p_org_id,'catalog_publication_prepared','catalog_publication_intent',intent_key,jsonb_build_object('kind',p_kind,'request_key',p_key,'actor_id',p_actor_id),'activity') returning id into event_key;
  insert into public.audit_log(org_id,actor_user_id,action,entity_type,entity_id,after_data,source) values(p_org_id,p_actor_id,'create','catalog_publication_intent',intent_key,jsonb_build_object('kind',p_kind,'request_key',p_key),'catalog_publication_intent') returning id into audit_key;
  insert into public.catalog_publication_intents(id,org_id,actor_id,kind,request_key,request,history_sequence,audit_id,event_id,review_labels) values(intent_key,p_org_id,p_actor_id,p_kind,p_key,p_request,sequence_key,audit_key,event_key,captured_labels) returning * into prior;
  begin
   insert into public.catalog_publication_claims(org_id,actor_id,kind,scope_key,intent_id) values(p_org_id,p_actor_id,p_kind,coalesce(community::text,'org'),prior.id);
  exception when unique_violation then raise exception 'Resolve the previous registered request in Publication history before another save';end;
 end if;
 return jsonb_build_object('orgId',p_org_id,'actorId',p_actor_id,'kind',p_kind,'requestKey',p_key,'intentId',prior.id,'status',state);
end $$;
revoke all on function public.register_catalog_publication(uuid,uuid,text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.register_catalog_publication(uuid,uuid,text,uuid,jsonb) to service_role;

-- Public write gateways cannot bypass durable registration. Historical receipts
-- created before registration remain replayable under their exact original actor
-- and body. The content functions are private, including to service_role.
create function public.assert_registered_catalog_publication(p_org_id uuid,p_actor_id uuid,p_kind text,p_key uuid,p_request jsonb) returns void
language plpgsql security definer set search_path='' as $$
declare prior public.catalog_publication_intents; community uuid; terminal boolean;
begin
 if p_kind is null or p_kind not in ('package','prices') or p_key is null or jsonb_typeof(p_request) is distinct from 'object' then raise exception 'Valid reviewed publication required';end if;
 community:=(p_request->>'communityId')::uuid;
 perform public.assert_catalog_publication_actor(p_org_id,p_actor_id,community);
 if p_kind='package' and (p_request ? 'costCents' or p_request->'expectedPackage' ? 'cost_cents') or p_kind='prices' and exists(select 1 from jsonb_array_elements(p_request->'items') x where x ? 'costCents' or x->'expectedPrice' ? 'cost_cents') then
  begin perform public.assert_catalog_publication_actor(p_org_id,p_actor_id,community,'financials.margin.read');
  exception when insufficient_privilege then raise exception 'Margin permission required to publish cost-bearing request' using errcode='42501';end;
 end if;
 perform pg_advisory_xact_lock(hashtextextended((case when p_kind='package' then 'catalog-package:' else 'catalog-prices:' end)||p_org_id::text||':'||p_key::text,0));
 select * into prior from public.catalog_publication_intents where org_id=p_org_id and kind=p_kind and request_key=p_key;
 if not found then
  if p_kind='package' and exists(select 1 from public.catalog_package_publication_receipts where org_id=p_org_id and request_key=p_key and actor_id=p_actor_id and request=p_request) or p_kind='prices' and exists(select 1 from public.catalog_price_publication_receipts where org_id=p_org_id and request_key=p_key and actor_id=p_actor_id and request=p_request) then return;end if;
  raise exception 'Register the original request before publication';
 end if;
 if prior.actor_id<>p_actor_id or prior.request is distinct from p_request then raise exception 'Registered publication belongs to different reviewed inputs or actor';end if;
 terminal:=exists(select 1 from public.catalog_publication_cancellations where org_id=p_org_id and kind=p_kind and request_key=p_key)
  or p_kind='package' and exists(select 1 from public.catalog_package_publication_receipts where org_id=p_org_id and request_key=p_key)
  or p_kind='prices' and exists(select 1 from public.catalog_price_publication_receipts where org_id=p_org_id and request_key=p_key);
 if not terminal and not exists(select 1 from public.catalog_publication_claims where org_id=p_org_id and actor_id=p_actor_id and kind=p_kind and scope_key=coalesce(community::text,'org') and intent_id=prior.id) then raise exception 'Registered request needs administrator recovery; keep its evidence';end if;
end $$;
revoke all on function public.assert_registered_catalog_publication(uuid,uuid,text,uuid,jsonb) from public,anon,authenticated,service_role;

create function public.publish_catalog_package_atomic(p_org_id uuid,p_actor_id uuid,p_key uuid,p_request jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 perform public.assert_registered_catalog_publication(p_org_id,p_actor_id,'package',p_key,p_request);
 return public.publish_catalog_package_contents(p_org_id,p_actor_id,p_key,p_request);
end $$;
revoke all on function public.publish_catalog_package_atomic(uuid,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.publish_catalog_package_atomic(uuid,uuid,uuid,jsonb) to service_role;

create function public.publish_catalog_prices_atomic(p_org_id uuid,p_actor_id uuid,p_key uuid,p_request jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 perform public.assert_registered_catalog_publication(p_org_id,p_actor_id,'prices',p_key,p_request);
 return public.publish_catalog_prices_contents(p_org_id,p_actor_id,p_key,p_request);
end $$;
revoke all on function public.publish_catalog_prices_atomic(uuid,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.publish_catalog_prices_atomic(uuid,uuid,uuid,jsonb) to service_role;

-- ==== 20261004034500_catalog_publication_history ====
-- STAGED / UNAPPLIED. Requires the complete revision/package/price/reconciliation chain.
-- The transactional scope counter serializes outcome allocation through commit.
-- Reading its last committed value gives an immutable bound for later pages;
-- a delayed writer cannot appear below it. No global activity counter is exposed.
create unique index catalog_package_history_idx on public.catalog_package_publication_receipts(org_id,actor_id,(coalesce(lower(request->>'communityId'),'org')),history_sequence desc);
create unique index catalog_price_history_idx on public.catalog_price_publication_receipts(org_id,actor_id,(coalesce(lower(request->>'communityId'),'org')),history_sequence desc);
create unique index catalog_cancellation_history_idx on public.catalog_publication_cancellations(org_id,actor_id,(coalesce(lower(request->>'communityId'),'org')),history_sequence desc);

create unique index catalog_intent_history_idx on public.catalog_publication_intents(org_id,actor_id,(coalesce(lower(request->>'communityId'),'org')),history_sequence desc);

create function public.list_catalog_publication_history(p_org_id uuid,p_actor_id uuid,p_community_id uuid,p_cursor jsonb default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare through_sequence bigint; before_sequence bigint; entries jsonb; next_cursor jsonb; pending_requests jsonb;
begin
 perform public.assert_catalog_publication_actor(p_org_id,p_actor_id,p_community_id);
 if p_cursor is null then
  select last_sequence into through_sequence from public.catalog_publication_history_heads where org_id=p_org_id and actor_id=p_actor_id and scope_key=coalesce(p_community_id::text,'org');
  through_sequence:=coalesce(through_sequence,0);
 else
  if jsonb_typeof(p_cursor) is distinct from 'object' or coalesce(p_cursor->>'throughSequence','') !~ '^[0-9]{1,19}$' or coalesce(p_cursor->>'beforeSequence','') !~ '^[0-9]{1,19}$' then raise exception 'Valid history cursor required';end if;
  through_sequence:=(p_cursor->>'throughSequence')::bigint;before_sequence:=(p_cursor->>'beforeSequence')::bigint;
  if before_sequence<1 or before_sequence>through_sequence then raise exception 'Valid history cursor required';end if;
  if through_sequence>coalesce((select last_sequence from public.catalog_publication_history_heads where org_id=p_org_id and actor_id=p_actor_id and scope_key=coalesce(p_community_id::text,'org')),0) then raise exception 'Valid history cursor required';end if;
 end if;
 with packages as (
  select id,request_key,'package'::text kind,'package'::text record_type,'committed'::text status,created_at,history_sequence,true outcome_recorded,1 item_count
   from public.catalog_package_publication_receipts where org_id=p_org_id and actor_id=p_actor_id and coalesce(lower(request->>'communityId'),'org')=coalesce(p_community_id::text,'org') and history_sequence<=through_sequence
   and (before_sequence is null or history_sequence<before_sequence) order by history_sequence desc limit 26
 ),prices as (
  select id,request_key,'prices'::text kind,'prices'::text record_type,'committed'::text status,created_at,history_sequence,true outcome_recorded,jsonb_array_length(prices) item_count
   from public.catalog_price_publication_receipts where org_id=p_org_id and actor_id=p_actor_id and coalesce(lower(request->>'communityId'),'org')=coalesce(p_community_id::text,'org') and history_sequence<=through_sequence
   and (before_sequence is null or history_sequence<before_sequence) order by history_sequence desc limit 26
 ),cancellations as (
  select id,request_key,kind,'cancellation'::text record_type,'cancelled'::text status,created_at,history_sequence,true outcome_recorded,case when kind='package' then 1 else jsonb_array_length(request->'items') end item_count
   from public.catalog_publication_cancellations where org_id=p_org_id and actor_id=p_actor_id and coalesce(lower(request->>'communityId'),'org')=coalesce(p_community_id::text,'org') and history_sequence<=through_sequence
   and (before_sequence is null or history_sequence<before_sequence) order by history_sequence desc limit 26
 ),intents as (
  select i.id,i.request_key,i.kind,'intent'::text record_type,'registered'::text status,i.created_at,i.history_sequence,
   (exists(select 1 from public.catalog_package_publication_receipts r where i.kind='package' and r.org_id=i.org_id and r.request_key=i.request_key and r.history_sequence<=through_sequence)
    or exists(select 1 from public.catalog_price_publication_receipts r where i.kind='prices' and r.org_id=i.org_id and r.request_key=i.request_key and r.history_sequence<=through_sequence)
    or exists(select 1 from public.catalog_publication_cancellations r where r.org_id=i.org_id and r.kind=i.kind and r.request_key=i.request_key and r.history_sequence<=through_sequence)) outcome_recorded,
   case when i.kind='package' then 1 else jsonb_array_length(i.request->'items') end item_count
   from public.catalog_publication_intents i where i.org_id=p_org_id and i.actor_id=p_actor_id and coalesce(lower(i.request->>'communityId'),'org')=coalesce(p_community_id::text,'org') and i.history_sequence<=through_sequence
   and (before_sequence is null or i.history_sequence<before_sequence) order by i.history_sequence desc limit 26
 ),merged as (
  select * from packages union all select * from prices union all select * from cancellations union all select * from intents
 ),page as (
  select * from merged order by history_sequence desc limit 26
 ) select coalesce(jsonb_agg(jsonb_build_object('id',id,'requestKey',request_key,'kind',kind,'type',record_type,'status',status,'occurredAt',created_at,'sequence',history_sequence::text,'outcomeRecorded',outcome_recorded,'itemCount',item_count) order by history_sequence desc),'[]'::jsonb) into entries from page;
 if jsonb_array_length(entries)>25 then next_cursor:=jsonb_build_object('throughSequence',through_sequence::text,'beforeSequence',entries->24->>'sequence');entries:=entries-25;end if;
 -- Current unresolved pointers are bounded independently of the history page.
 select coalesce(jsonb_agg(jsonb_build_object('id',i.id,'requestKey',i.request_key,'kind',i.kind,'type','intent','status','registered','occurredAt',i.created_at,'sequence',i.history_sequence::text,'outcomeRecorded',false,'itemCount',case when i.kind='package' then 1 else jsonb_array_length(i.request->'items') end) order by i.history_sequence desc),'[]'::jsonb) into pending_requests
 from public.catalog_publication_claims c join public.catalog_publication_intents i on i.org_id=c.org_id and i.id=c.intent_id
 where c.org_id=p_org_id and c.actor_id=p_actor_id and c.scope_key=coalesce(p_community_id::text,'org');
 return jsonb_build_object('orgId',p_org_id,'actorId',p_actor_id,'communityId',p_community_id,'entries',entries,'nextCursor',next_cursor,'pendingRequests',pending_requests);
end $$;
revoke all on function public.list_catalog_publication_history(uuid,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.list_catalog_publication_history(uuid,uuid,uuid,jsonb) to service_role;

create function public.read_catalog_publication_request(p_org_id uuid,p_actor_id uuid,p_community_id uuid,p_type text,p_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare request_body jsonb; request_id uuid; publication_kind text; outcome_status text;
begin
 if p_id is null or p_type is null or p_type not in ('package','prices','cancellation','intent') then raise exception 'Valid publication outcome required';end if;
 perform public.assert_catalog_publication_actor(p_org_id,p_actor_id,p_community_id);
 if p_type='package' then
  select request,request_key into request_body,request_id from public.catalog_package_publication_receipts where org_id=p_org_id and actor_id=p_actor_id and id=p_id and coalesce(lower(request->>'communityId'),'org')=coalesce(p_community_id::text,'org');publication_kind:='package';outcome_status:='committed';
 elsif p_type='prices' then
  select request,request_key into request_body,request_id from public.catalog_price_publication_receipts where org_id=p_org_id and actor_id=p_actor_id and id=p_id and coalesce(lower(request->>'communityId'),'org')=coalesce(p_community_id::text,'org');publication_kind:='prices';outcome_status:='committed';
 elsif p_type='intent' then
  select request,request_key,kind into request_body,request_id,publication_kind from public.catalog_publication_intents where org_id=p_org_id and actor_id=p_actor_id and id=p_id and coalesce(lower(request->>'communityId'),'org')=coalesce(p_community_id::text,'org');outcome_status:='registered';
 else
  select request,request_key,kind into request_body,request_id,publication_kind from public.catalog_publication_cancellations where org_id=p_org_id and actor_id=p_actor_id and id=p_id and coalesce(lower(request->>'communityId'),'org')=coalesce(p_community_id::text,'org');outcome_status:='cancelled';
 end if;
 if request_body is null then raise exception 'Publication outcome is unavailable in this user and scope';end if;
 if publication_kind='package' and (request_body ? 'costCents' or request_body->'expectedPackage' ? 'cost_cents') or publication_kind='prices' and exists(select 1 from jsonb_array_elements(request_body->'items') x where x ? 'costCents' or x->'expectedPrice' ? 'cost_cents') then
  begin perform public.assert_catalog_publication_actor(p_org_id,p_actor_id,p_community_id,'financials.margin.read');
  exception when insufficient_privilege then raise exception 'Margin permission required to recover cost-bearing publication' using errcode='42501';end;
 end if;
 return jsonb_build_object('orgId',p_org_id,'actorId',p_actor_id,'communityId',p_community_id,'outcomeId',p_id,'kind',publication_kind,'type',p_type,'status',outcome_status,'requestKey',request_id,'request',request_body);
end $$;
revoke all on function public.read_catalog_publication_request(uuid,uuid,uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.read_catalog_publication_request(uuid,uuid,uuid,text,uuid) to service_role;

-- ==== 20261004043000_catalog_publication_pending_scopes ====
-- STAGED / UNAPPLIED. Requires the complete catalog intent/history chain.
-- This is a live own-actor queue, not an immutable historical snapshot. Refresh
-- newest after changes; absence never proves an in-flight publication failed.
create index catalog_intent_actor_pending_order_idx on public.catalog_publication_intents(org_id,actor_id,created_at desc,id desc);

create function public.can_review_catalog_publication_scope(p_org_id uuid,p_actor_id uuid,p_community_id uuid) returns boolean
language plpgsql security definer set search_path='' as $$
begin
 perform public.assert_catalog_publication_actor(p_org_id,p_actor_id,p_community_id);
 return true;
exception when insufficient_privilege then return false;
end $$;
revoke all on function public.can_review_catalog_publication_scope(uuid,uuid,uuid) from public,anon,authenticated,service_role;

create function public.list_pending_catalog_publications(p_org_id uuid,p_actor_id uuid,p_before uuid default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare boundary public.catalog_publication_intents; candidate record; rows jsonb:='[]'::jsonb; continuation uuid; last_visible uuid; community_name text;
begin
 if p_org_id is null or p_actor_id is null then raise exception 'Publication queue context required' using errcode='42501';end if;
 if p_before is not null then
  select * into boundary from public.catalog_publication_intents where org_id=p_org_id and actor_id=p_actor_id and id=p_before;
  if not found or not public.can_review_catalog_publication_scope(p_org_id,p_actor_id,(boundary.request->>'communityId')::uuid) then raise exception 'Queue continuation is unavailable; refresh newest requests' using errcode='42501';end if;
 end if;
 -- Sort the bounded-by-active-claims source before calling authorization.
 -- A WHERE authorization predicate before an ORDER BY could check every claim
 -- even when the first 26 sorted requests are already accessible.
 for candidate in
  with active_claims as materialized (
   select * from public.catalog_publication_claims where org_id=p_org_id and actor_id=p_actor_id
  )
  select i.id,i.request_key,i.kind,i.created_at,(i.request->>'communityId')::uuid community_id,
   case when i.kind='package' then 1 else jsonb_array_length(i.request->'items') end item_count
  from active_claims claim
  join public.catalog_publication_intents i on claim.org_id=i.org_id and claim.actor_id=i.actor_id and claim.intent_id=i.id and claim.kind=i.kind and claim.scope_key=coalesce((i.request->>'communityId')::uuid::text,'org')
  where i.org_id=p_org_id and i.actor_id=p_actor_id and (p_before is null or (i.created_at,i.id)<(boundary.created_at,boundary.id))
  order by i.created_at desc,i.id desc
 loop
  if not public.can_review_catalog_publication_scope(p_org_id,p_actor_id,candidate.community_id) then continue;end if;
  if jsonb_array_length(rows)=25 then continuation:=last_visible;exit;end if;
  select left(to_jsonb(c)->>'name',200) into community_name from public.communities c where c.org_id=p_org_id and c.id=candidate.community_id;
  rows:=rows||jsonb_build_array(jsonb_build_object('id',candidate.id,'requestKey',candidate.request_key,'kind',candidate.kind,'communityId',candidate.community_id,'communityName',community_name,'occurredAt',to_char(candidate.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'itemCount',candidate.item_count));
  last_visible:=candidate.id;
 end loop;
 return jsonb_build_object('orgId',p_org_id,'actorId',p_actor_id,'entries',rows,'nextCursor',continuation);
end $$;
revoke all on function public.list_pending_catalog_publications(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.list_pending_catalog_publications(uuid,uuid,uuid) to service_role;

-- ==== 20261004050000_catalog_archived_package_queue ====
-- STAGED / UNAPPLIED. Requires catalog publication actor/source foundations.
create index catalog_package_archived_scope_idx on public.selection_packages(org_id,community_id,id desc) where is_archived;
create function public.list_archived_catalog_packages(p_org_id uuid,p_actor_id uuid,p_community_id uuid,p_before uuid default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare row public.selection_packages; rows jsonb:='[]'; continuation uuid; last_visible uuid; can_margin boolean:=false; source jsonb;
begin
 perform public.assert_catalog_publication_actor(p_org_id,p_actor_id,p_community_id);
 begin perform public.assert_catalog_publication_actor(p_org_id,p_actor_id,p_community_id,'financials.margin.read');can_margin:=true;exception when insufficient_privilege then can_margin:=false;end;
 for row in select * from public.selection_packages where org_id=p_org_id and community_id is not distinct from p_community_id and is_archived and (p_before is null or id<p_before) order by id desc limit 26 loop
  if jsonb_array_length(rows)=25 then continuation:=last_visible;exit;end if;
  source:=public.catalog_package_source(row);
  rows:=rows||jsonb_build_array(case when can_margin then source else source-'cost_cents' end);last_visible:=row.id;
 end loop;
 return jsonb_build_object('orgId',p_org_id,'actorId',p_actor_id,'communityId',p_community_id,'packages',rows,'canReadMargin',can_margin,'nextCursor',continuation);
end $$;
revoke all on function public.list_archived_catalog_packages(uuid,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.list_archived_catalog_packages(uuid,uuid,uuid,uuid) to service_role;

-- ==== 20261004060000_catalog_package_member_discovery ====
-- STAGED / UNAPPLIED. Read foundation; UI cutover and scale plans remain gated.
create index catalog_member_option_scope_idx on public.selection_options(org_id,community_id,id);
create index catalog_member_option_override_idx on public.selection_options(org_id,community_id,parent_option_id) where parent_option_id is not null;
create index catalog_member_category_override_idx on public.selection_categories(org_id,community_id,parent_category_id) where parent_category_id is not null;
create function public.discover_catalog_package_members(p_org_id uuid,p_actor_id uuid,p_community_id uuid,p_query text default '',p_before uuid default null,p_ids uuid[] default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare items jsonb; continuation uuid; needle text:=lower(btrim(coalesce(p_query,''))); pattern text;
begin
 perform public.assert_catalog_publication_actor(p_org_id,p_actor_id,p_community_id);
 if length(needle)>200 or p_ids is not null and (cardinality(p_ids)>100 or cardinality(p_ids)<>(select count(distinct x) from unnest(p_ids) x) or p_before is not null or needle<>'') then raise exception 'Bounded catalog member discovery required';end if;
 pattern:='%'||replace(replace(replace(needle,E'\\',E'\\\\'),'%',E'\\%'),'_',E'\\_')||'%';
 with candidates as not materialized (
  select o.id,o.name,c.id source_category_id,c.parent_category_id,c.name source_category_name,
   coalesce(override.id,c.id) category_id,coalesce(override.parent_category_id,c.parent_category_id,c.id) category_key,
   coalesce(override.name,c.name) category_name,
   not o.is_archived and o.is_available and c.id is not null and not c.is_archived and not coalesce(override.is_archived,false) and (override.id is null or c.community_id is null)
    and (o.parent_option_id is null or o.community_id is not null and exists(select 1 from public.selection_options parent where parent.org_id=p_org_id and parent.id=o.parent_option_id and parent.community_id is null and parent.category_id=coalesce(c.parent_category_id,c.id)))
    and not exists(select 1 from public.selection_options other where other.org_id=p_org_id and other.community_id=p_community_id and other.parent_option_id=o.id)
    and (c.parent_category_id is null or exists(select 1 from public.selection_categories base where base.org_id=p_org_id and base.id=c.parent_category_id and base.community_id is null and c.community_id is not null)) available
  from public.selection_options o
  left join public.selection_categories c on c.org_id=p_org_id and c.id=o.category_id and (c.community_id is null or c.community_id=p_community_id)
  left join lateral (select k.* from public.selection_categories k where k.org_id=p_org_id and k.community_id=p_community_id and k.parent_category_id=c.id order by k.id limit 1) override on true
  where o.org_id=p_org_id and (o.community_id is null or o.community_id=p_community_id)
   and (p_ids is null or o.id=any(p_ids)) and (p_before is null or o.id>p_before)
 ), result_rows as (
  select c.id,c.name,c.category_id,c.category_key,c.category_name,c.available
  from candidates c where p_ids is null and c.available and (needle='' or lower(c.name) like pattern or lower(c.category_name) like pattern or c.id::text like pattern)
  order by c.id limit 21
 ), selected_rows as (
  select x.id,c.name,c.category_id,c.category_key,c.category_name,coalesce(c.available,false) available from unnest(p_ids) x(id) left join candidates c on c.id=x.id
 ), numbered as (
  select *,row_number() over(order by id) position from (select * from result_rows union all select * from selected_rows) combined
 )
 select coalesce(jsonb_agg(jsonb_build_object('id',id,'name',left(name,200),'categoryId',category_id,'categoryKey',category_key,'categoryName',left(category_name,200),'available',available) order by id) filter(where p_ids is not null or position<=20),'[]'::jsonb),
  case when p_ids is null and max(position)=21 then (array_agg(id order by id))[20] else null end
 into items,continuation from numbered;
 return jsonb_build_object('orgId',p_org_id,'actorId',p_actor_id,'communityId',p_community_id,'query',needle,'selectedIds',to_jsonb(p_ids),'items',items,'nextCursor',continuation);
end $$;
revoke all on function public.discover_catalog_package_members(uuid,uuid,uuid,text,uuid,uuid[]) from public,anon,authenticated;
grant execute on function public.discover_catalog_package_members(uuid,uuid,uuid,text,uuid,uuid[]) to service_role;

-- ==== 20261004060100_catalog_package_member_search_indexes ====
-- STAGED / UNAPPLIED. public.pg_trgm is present in the authoritative base schema.
-- Verify actual plans and index-build operational impact before rollout.
create index catalog_member_option_name_search_idx on public.selection_options using gin (lower(name) public.gin_trgm_ops);
create index catalog_member_category_name_search_idx on public.selection_categories using gin (lower(name) public.gin_trgm_ops);

-- ==== 20261004065019_catalog_group_publication ====
-- STAGED / UNAPPLIED. Owner-only transaction foundation. No application gateway:
-- durable intent/claim/review/reconciliation and legacy writer cutover remain required.
create index catalog_group_scope_seek_idx on public.selection_groups(org_id,community_id,id);
create index catalog_group_members_seek_idx on public.selection_group_categories(org_id,group_id,id);
create trigger agreement_catalog_revision after insert or update or delete on public.selection_groups for each row execute function public.advance_agreement_catalog_revision();
create trigger agreement_catalog_no_truncate before truncate on public.selection_groups for each statement execute function public.forbid_agreement_catalog_truncate();
create trigger agreement_catalog_revision after insert or update or delete on public.selection_group_categories for each row execute function public.advance_agreement_catalog_revision();
create trigger agreement_catalog_no_truncate before truncate on public.selection_group_categories for each statement execute function public.forbid_agreement_catalog_truncate();

create function public.catalog_group_source(p_group public.selection_groups) returns jsonb
language sql set search_path='' as $$
 select jsonb_build_object('id',p_group.id,'community_id',p_group.community_id,'name',p_group.name,
  'schedule_task_key',p_group.schedule_task_key,'cutoff_offset_days',p_group.cutoff_offset_days,
  'cutoff_anchor',p_group.cutoff_anchor,'sort_order',p_group.sort_order,'is_archived',p_group.is_archived,
  'category_ids',coalesce((select jsonb_agg(category_id order by category_id) from public.selection_group_categories where org_id=p_group.org_id and group_id=p_group.id),'[]'));
$$;
revoke all on function public.catalog_group_source(public.selection_groups) from public,anon,authenticated,service_role;
create table public.catalog_group_publication_receipts(
 id uuid primary key default gen_random_uuid(),org_id uuid not null references public.orgs(id),request_key uuid not null,
 group_id uuid not null references public.selection_groups(id),actor_id uuid not null references public.app_users(id),
 request jsonb not null check(jsonb_typeof(request)='object'),group_source jsonb not null check(jsonb_typeof(group_source)='object'),
 audit_id bigint not null references public.audit_log(id),event_id uuid not null references public.events(id),
 history_sequence bigint not null check(history_sequence>0),
 created_at timestamptz not null default now(),unique(org_id,request_key)
);
create index catalog_group_receipt_group_idx on public.catalog_group_publication_receipts(group_id);
create index catalog_group_receipt_actor_idx on public.catalog_group_publication_receipts(actor_id);
create index catalog_group_receipt_audit_idx on public.catalog_group_publication_receipts(audit_id);
create index catalog_group_receipt_event_idx on public.catalog_group_publication_receipts(event_id);
alter table public.catalog_group_publication_receipts enable row level security;
revoke all on public.catalog_group_publication_receipts from public,anon,authenticated,service_role;
create trigger catalog_group_receipt_immutable before update or delete on public.catalog_group_publication_receipts for each row execute function public.guard_catalog_package_publication_receipt();

-- Canonical versions include only public category definition fields. Never
-- include hidden financial columns or mutable timestamps in an exposed digest.
create function public.catalog_group_category_review(p_org_id uuid,p_ids uuid[]) returns jsonb
language sql set search_path='' as $$
 with selected as (select id,parent_category_id from public.selection_categories where org_id=p_org_id and id=any(p_ids)),
 references_set as (select id from selected union select parent_category_id from selected where parent_category_id is not null),
 definitions as (select c.id,jsonb_build_object(
  'id',c.id,'community_id',c.community_id,'parent_category_id',c.parent_category_id,
  'name',to_jsonb(c)->'name','description',to_jsonb(c)->'description','image_url',to_jsonb(c)->'image_url',
  'sort_order',to_jsonb(c)->'sort_order','is_archived',c.is_archived) definition
  from public.selection_categories c join references_set r on r.id=c.id where c.org_id=p_org_id)
 select coalesce(jsonb_agg(jsonb_build_object('id',id,'definition',definition,
  'definitionHash',encode(sha256(convert_to(definition::text,'UTF8')),'hex')) order by id),'[]') from definitions;
$$;
revoke all on function public.catalog_group_category_review(uuid,uuid[]) from public,anon,authenticated,service_role;

-- Project versions from the same definition snapshot used by original review.
create function public.catalog_group_category_versions(p_org_id uuid,p_ids uuid[]) returns jsonb
language sql set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object('id',item->'id','definitionHash',item->'definitionHash') order by item->>'id'),'[]')
 from jsonb_array_elements(public.catalog_group_category_review(p_org_id,p_ids)) item;
$$;
revoke all on function public.catalog_group_category_versions(uuid,uuid[]) from public,anon,authenticated,service_role;

create function public.publish_catalog_group_contents(p_org_id uuid,p_actor_id uuid,p_key uuid,p_request jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare g public.selection_groups; receipt public.catalog_group_publication_receipts; community uuid; target uuid;
 ids uuid[]; parent_ids uuid[]; current_parents uuid[]; source jsonb; audit_key bigint; event_key uuid;
begin
 if p_key is null or jsonb_typeof(p_request) is distinct from 'object' or pg_column_size(p_request)>65536
  or not(p_request ?& array['id','communityId','name','scheduleTaskKey','cutoffOffsetDays','cutoffAnchor','sortOrder','categoryIds','expectedGroup','expectedCategoryVersions'])
  or exists(select 1 from jsonb_object_keys(p_request) k where k<>all(array['id','communityId','name','scheduleTaskKey','cutoffOffsetDays','cutoffAnchor','sortOrder','categoryIds','expectedGroup','expectedCategoryVersions'])) then raise exception 'Complete reviewed cutoff rule request and stable key required';end if;
 if jsonb_typeof(p_request->'id') not in ('string','null') or jsonb_typeof(p_request->'communityId') not in ('string','null')
  or jsonb_typeof(p_request->'name') is distinct from 'string' or length(btrim(p_request->>'name')) not between 1 and 120
  or jsonb_typeof(p_request->'scheduleTaskKey') is distinct from 'string' or length(btrim(p_request->>'scheduleTaskKey')) not between 1 and 160
  or jsonb_typeof(p_request->'categoryIds') is distinct from 'array' or jsonb_array_length(p_request->'categoryIds')>100
  or jsonb_typeof(p_request->'expectedCategoryVersions') is distinct from 'array' or jsonb_array_length(p_request->'expectedCategoryVersions')>200
  or jsonb_typeof(p_request->'cutoffOffsetDays') is distinct from 'number' or p_request->>'cutoffOffsetDays' !~ '^-?[0-9]+$'
  or jsonb_typeof(p_request->'sortOrder') is distinct from 'number' or p_request->>'sortOrder' !~ '^[0-9]+$'
  or p_request->>'cutoffAnchor' not in ('start','end') or jsonb_typeof(p_request->'cutoffAnchor') is distinct from 'string' then raise exception 'Invalid bounded cutoff rule fields';end if;
 if (p_request->>'cutoffOffsetDays')::numeric not between -365 and 365 or (p_request->>'sortOrder')::numeric>10000 then raise exception 'Invalid cutoff rule numeric bounds';end if;
 if exists(select 1 from jsonb_array_elements(p_request->'expectedCategoryVersions') v where jsonb_typeof(v) is distinct from 'object'
  or not(v ?& array['id','definitionHash']) or exists(select 1 from jsonb_object_keys(v) k where k<>all(array['id','definitionHash']))
  or jsonb_typeof(v->'id') is distinct from 'string' or v->>'id' !~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' or jsonb_typeof(v->'definitionHash') is distinct from 'string' or v->>'definitionHash' !~ '^[0-9a-f]{64}$') then raise exception 'Canonical reviewed category versions required';end if;
 community:=(p_request->>'communityId')::uuid;target:=(p_request->>'id')::uuid;
 if target is null and p_request->'expectedGroup'<>'null'::jsonb or target is not null and jsonb_typeof(p_request->'expectedGroup') is distinct from 'object' then raise exception 'Original cutoff rule review required';end if;
 perform public.assert_catalog_publication_actor(p_org_id,p_actor_id,community);
 perform pg_advisory_xact_lock(hashtextextended('catalog-group:'||p_org_id::text||':'||p_key::text,0));
 select * into receipt from public.catalog_group_publication_receipts where org_id=p_org_id and request_key=p_key;
 if found then
  if receipt.actor_id<>p_actor_id or receipt.request is distinct from p_request then raise exception 'Cutoff rule key belongs to another actor or reviewed request';end if;
  select * into g from public.selection_groups where org_id=p_org_id and id=receipt.group_id for update;
  if not found or g.community_id is distinct from community then raise exception 'Published cutoff rule scope changed';end if;
  perform 1 from public.selection_group_categories where org_id=p_org_id and group_id=g.id order by id for share;
  if public.catalog_group_source(g) is distinct from receipt.group_source then raise exception 'Published cutoff rule changed; reconcile its original outcome';end if;
  perform public.assert_catalog_publication_actor(p_org_id,p_actor_id,community);
  return jsonb_build_object('orgId',p_org_id,'actorId',p_actor_id,'receiptId',receipt.id,'historySequence',receipt.history_sequence::text,'group',receipt.group_source,'created',false);
 end if;
 if target is not null then
  select * into g from public.selection_groups where org_id=p_org_id and id=target for update;
  if not found or g.is_archived or g.community_id is distinct from community then raise exception 'Original cutoff rule scope is unavailable';end if;
  perform 1 from public.selection_group_categories where org_id=p_org_id and group_id=g.id order by id for update;
  if public.catalog_group_source(g) is distinct from p_request->'expectedGroup' then raise exception 'Cutoff rule changed since its original review';end if;
 end if;
 if exists(select 1 from jsonb_array_elements(p_request->'categoryIds') x where jsonb_typeof(x)<>'string') then raise exception 'Category UUID references required';end if;
 select coalesce(array_agg(x::uuid order by x::uuid),'{}') into ids from jsonb_array_elements_text(p_request->'categoryIds') x;
 if cardinality(ids)<>(select count(distinct x) from unnest(ids) x) then raise exception 'Cutoff rule category references must be unique';end if;
 select coalesce(array_agg(distinct parent_category_id) filter(where parent_category_id is not null),'{}') into parent_ids from public.selection_categories where org_id=p_org_id and id=any(ids);
 -- Lock the combined child/root set once in UUID order. If a parent changed
 -- between discovery and lock acquisition, reject an unprotected new root.
 perform 1 from public.selection_categories where org_id=p_org_id and id=any(ids||parent_ids) order by id for share;
 select coalesce(array_agg(distinct parent_category_id) filter(where parent_category_id is not null),'{}') into current_parents from public.selection_categories where org_id=p_org_id and id=any(ids);
 if not(current_parents<@parent_ids) then raise exception 'Cutoff rule category ancestry changed during review';end if;
 parent_ids:=current_parents;
 if (select count(*) from public.selection_categories where org_id=p_org_id and id=any(ids) and not is_archived
  and (community_id is null or community_id=community) and (parent_category_id is null or community_id is not null))<>cardinality(ids) then raise exception 'Cutoff rule categories are outside active original scope';end if;
 if (select count(*) from public.selection_categories where org_id=p_org_id and id=any(parent_ids) and community_id is null and parent_category_id is null and not is_archived)<>cardinality(parent_ids) then raise exception 'Cutoff rule category ancestry changed or is unavailable';end if;
 if public.catalog_group_category_versions(p_org_id,ids) is distinct from p_request->'expectedCategoryVersions' then raise exception 'Category definitions changed since their original review';end if;
 perform public.assert_catalog_publication_actor(p_org_id,p_actor_id,community);
 if target is null then
  insert into public.selection_groups(org_id,community_id,name,schedule_task_key,cutoff_offset_days,cutoff_anchor,sort_order)
   values(p_org_id,community,btrim(p_request->>'name'),btrim(p_request->>'scheduleTaskKey'),(p_request->>'cutoffOffsetDays')::integer,p_request->>'cutoffAnchor',(p_request->>'sortOrder')::integer) returning * into g;
 else
  update public.selection_groups set name=btrim(p_request->>'name'),schedule_task_key=btrim(p_request->>'scheduleTaskKey'),cutoff_offset_days=(p_request->>'cutoffOffsetDays')::integer,cutoff_anchor=p_request->>'cutoffAnchor',sort_order=(p_request->>'sortOrder')::integer where org_id=p_org_id and id=target returning * into g;
 end if;
 delete from public.selection_group_categories where org_id=p_org_id and group_id=g.id;
 insert into public.selection_group_categories(org_id,group_id,category_id) select p_org_id,g.id,unnest(ids);
 source:=public.catalog_group_source(g);
 insert into public.events(org_id,event_type,entity_type,entity_id,payload,channel) values(p_org_id,'option_catalog_updated','selection_group',g.id,jsonb_build_object('operation',case when target is null then 'insert' else 'update' end,'request_key',p_key,'actor_id',p_actor_id),'activity') returning id into event_key;
 insert into public.audit_log(org_id,actor_user_id,action,entity_type,entity_id,after_data,source) values(p_org_id,p_actor_id,case when target is null then 'insert' else 'update' end,'selection_group',g.id,source,'catalog_group_publication') returning id into audit_key;
 insert into public.catalog_group_publication_receipts(org_id,request_key,group_id,actor_id,request,group_source,audit_id,event_id,history_sequence) values(p_org_id,p_key,g.id,p_actor_id,p_request,source,audit_key,event_key,public.allocate_catalog_publication_history(p_org_id,p_actor_id,community)) returning * into receipt;
 return jsonb_build_object('orgId',p_org_id,'actorId',p_actor_id,'receiptId',receipt.id,'historySequence',receipt.history_sequence::text,'group',source,'created',true);
end $$;
revoke all on function public.publish_catalog_group_contents(uuid,uuid,uuid,jsonb) from public,anon,authenticated,service_role;

-- ==== 20261004072434_catalog_group_publication_recovery ====
-- STAGED / UNAPPLIED. Requires the full catalog lifecycle and group foundations.
-- Extend the existing lifecycle: one intent/claim/cancellation/history per kind.
alter table public.catalog_publication_intents drop constraint catalog_publication_intents_kind_check;
alter table public.catalog_publication_intents add constraint catalog_publication_intents_kind_check check(kind in ('package','prices','group'));
alter table public.catalog_publication_cancellations drop constraint catalog_publication_cancellations_kind_check;
alter table public.catalog_publication_cancellations add constraint catalog_publication_cancellations_kind_check check(kind in ('package','prices','group'));
alter table public.catalog_publication_reconciliations add column group_receipt_id uuid references public.catalog_group_publication_receipts(id);
create index catalog_reconciliation_group_idx on public.catalog_publication_reconciliations(group_receipt_id);
alter table public.catalog_publication_reconciliations drop constraint catalog_publication_reconciliations_kind_check;
alter table public.catalog_publication_reconciliations add constraint catalog_publication_reconciliations_kind_check check(kind in ('package','prices','group'));
alter table public.catalog_publication_reconciliations drop constraint catalog_publication_reconciliations_check;
alter table public.catalog_publication_reconciliations add constraint catalog_publication_reconciliations_check check(
 (kind='package' and package_receipt_id is not null and price_receipt_id is null and group_receipt_id is null)
 or (kind='prices' and price_receipt_id is not null and package_receipt_id is null and group_receipt_id is null)
 or (kind='group' and group_receipt_id is not null and package_receipt_id is null and price_receipt_id is null));
create unique index catalog_group_history_idx on public.catalog_group_publication_receipts(org_id,actor_id,(coalesce(lower(request->>'communityId'),'org')),history_sequence desc);


create function public.validate_catalog_group_publication_request(p_request jsonb) returns void
language plpgsql set search_path='' as $$
declare community uuid;target uuid;
begin
 if jsonb_typeof(p_request) is distinct from 'object' or pg_column_size(p_request)>65536
  or not(p_request ?& array['id','communityId','name','scheduleTaskKey','cutoffOffsetDays','cutoffAnchor','sortOrder','categoryIds','expectedGroup','expectedCategoryVersions'])
  or exists(select 1 from jsonb_object_keys(p_request) k where k<>all(array['id','communityId','name','scheduleTaskKey','cutoffOffsetDays','cutoffAnchor','sortOrder','categoryIds','expectedGroup','expectedCategoryVersions'])) then raise exception 'Complete reviewed cutoff rule request and stable key required';end if;
 if jsonb_typeof(p_request->'id') not in ('string','null') or jsonb_typeof(p_request->'communityId') not in ('string','null')
  or jsonb_typeof(p_request->'name') is distinct from 'string' or length(btrim(p_request->>'name')) not between 1 and 120
  or jsonb_typeof(p_request->'scheduleTaskKey') is distinct from 'string' or length(btrim(p_request->>'scheduleTaskKey')) not between 1 and 160
  or jsonb_typeof(p_request->'categoryIds') is distinct from 'array' or jsonb_array_length(p_request->'categoryIds')>100
  or jsonb_typeof(p_request->'expectedCategoryVersions') is distinct from 'array' or jsonb_array_length(p_request->'expectedCategoryVersions')>200
  or jsonb_typeof(p_request->'cutoffOffsetDays') is distinct from 'number' or p_request->>'cutoffOffsetDays' !~ '^-?[0-9]+$'
  or jsonb_typeof(p_request->'sortOrder') is distinct from 'number' or p_request->>'sortOrder' !~ '^[0-9]+$'
  or p_request->>'cutoffAnchor' not in ('start','end') or jsonb_typeof(p_request->'cutoffAnchor') is distinct from 'string' then raise exception 'Invalid bounded cutoff rule fields';end if;
 if (p_request->>'cutoffOffsetDays')::numeric not between -365 and 365 or (p_request->>'sortOrder')::numeric>10000 then raise exception 'Invalid cutoff rule numeric bounds';end if;
 if exists(select 1 from jsonb_array_elements(p_request->'expectedCategoryVersions') v where jsonb_typeof(v) is distinct from 'object'
  or not(v ?& array['id','definitionHash']) or exists(select 1 from jsonb_object_keys(v) k where k<>all(array['id','definitionHash']))
  or jsonb_typeof(v->'id') is distinct from 'string' or v->>'id' !~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' or jsonb_typeof(v->'definitionHash') is distinct from 'string' or v->>'definitionHash' !~ '^[0-9a-f]{64}$') then raise exception 'Canonical reviewed category versions required';end if;
 community:=(p_request->>'communityId')::uuid;target:=(p_request->>'id')::uuid;
 if target is null and p_request->'expectedGroup'<>'null'::jsonb or target is not null and jsonb_typeof(p_request->'expectedGroup') is distinct from 'object' then raise exception 'Original cutoff rule review required';end if;
end $$;
revoke all on function public.validate_catalog_group_publication_request(jsonb) from public,anon,authenticated,service_role;


create or replace function public.register_catalog_publication(p_org_id uuid,p_actor_id uuid,p_kind text,p_key uuid,p_request jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare prior public.catalog_publication_intents; community uuid; recorded_body jsonb; recorded_actor uuid; state text:='prepared';
 intent_key uuid; audit_key bigint; event_key uuid; sequence_key bigint; captured_labels jsonb;
begin
 if p_kind is null or p_kind not in ('package','prices','group') or p_key is null or jsonb_typeof(p_request) is distinct from 'object' or length(p_request::text)>512000 then raise exception 'Valid reviewed publication required';end if;
 if p_kind='package' and (jsonb_typeof(p_request->'optionIds') is distinct from 'array' or jsonb_array_length(p_request->'optionIds') not between 1 and 100) or p_kind='prices' and (jsonb_typeof(p_request->'items') is distinct from 'array' or jsonb_array_length(p_request->'items') not between 1 and 500) then raise exception 'Bounded reviewed publication required';end if;
 if p_kind='package' and exists(select 1 from jsonb_array_elements_text(p_request->'optionIds') x group by x::uuid having count(*)>1) then raise exception 'Choose each package option only once';end if;
 community:=(p_request->>'communityId')::uuid;
 perform public.assert_catalog_publication_actor(p_org_id,p_actor_id,community);
 if p_kind='package' and (p_request ? 'costCents' or p_request->'expectedPackage' ? 'cost_cents') or p_kind='prices' and exists(select 1 from jsonb_array_elements(p_request->'items') x where x ? 'costCents' or x->'expectedPrice' ? 'cost_cents') then
  begin perform public.assert_catalog_publication_actor(p_org_id,p_actor_id,community,'financials.margin.read');
  exception when insufficient_privilege then raise exception 'Margin permission required to register cost-bearing publication' using errcode='42501';end;
 end if;
 perform pg_advisory_xact_lock(hashtextextended((case when p_kind='package' then 'catalog-package:' when p_kind='group' then 'catalog-group:' else 'catalog-prices:' end)||p_org_id::text||':'||p_key::text,0));
 select * into prior from public.catalog_publication_intents where org_id=p_org_id and kind=p_kind and request_key=p_key;
 if found and (prior.actor_id<>p_actor_id or prior.request is distinct from p_request) then raise exception 'Registered publication belongs to different reviewed inputs or actor';end if;
 select request,actor_id into recorded_body,recorded_actor from public.catalog_publication_cancellations where org_id=p_org_id and kind=p_kind and request_key=p_key;
 if found then state:='cancelled';
 elsif p_kind='package' then
  select request,actor_id into recorded_body,recorded_actor from public.catalog_package_publication_receipts where org_id=p_org_id and request_key=p_key;
  if found then state:='committed';end if;
 elsif p_kind='group' then
  select request,actor_id into recorded_body,recorded_actor from public.catalog_group_publication_receipts where org_id=p_org_id and request_key=p_key;
  if found then state:='committed';end if;
 else
  select request,actor_id into recorded_body,recorded_actor from public.catalog_price_publication_receipts where org_id=p_org_id and request_key=p_key;
  if found then state:='committed';end if;
 end if;
 if state<>'prepared' then
  if recorded_actor<>p_actor_id or recorded_body is distinct from p_request then raise exception 'Recorded outcome belongs to different reviewed inputs or actor';end if;
 elsif prior.id is not null then
  if not exists(select 1 from public.catalog_publication_claims where org_id=p_org_id and actor_id=p_actor_id and kind=p_kind and scope_key=coalesce(community::text,'org') and intent_id=prior.id) then raise exception 'Registered request needs administrator recovery; keep its evidence';end if;
 else
  if exists(select 1 from public.catalog_publication_claims where org_id=p_org_id and actor_id=p_actor_id and kind=p_kind and scope_key=coalesce(community::text,'org')) then raise exception 'Resolve the previous registered request in Publication history before another save';end if;
  if p_kind='group' then
   perform public.validate_catalog_group_publication_request(p_request);
   -- Lock original selected/root rows before capturing public definitions. Never
   -- replace the request's reviewed hashes with fresh hashes during registration.
   perform 1 from public.selection_categories where org_id=p_org_id and id in (
    select (v->>'id')::uuid from jsonb_array_elements(p_request->'expectedCategoryVersions') v) order by id for share;
   if exists(select 1 from jsonb_array_elements_text(p_request->'categoryIds') x group by x::uuid having count(*)>1) then raise exception 'Cutoff rule category references must be unique';end if;
   if (select count(*) from public.selection_categories where org_id=p_org_id and id in(select x::uuid from jsonb_array_elements_text(p_request->'categoryIds') x)
    and not is_archived and (community_id is null or community_id=community) and (parent_category_id is null or community_id is not null))<>jsonb_array_length(p_request->'categoryIds') then raise exception 'Cutoff rule categories are outside active original scope';end if;
   if exists(select 1 from public.selection_categories c where c.org_id=p_org_id and c.id in(select x::uuid from jsonb_array_elements_text(p_request->'categoryIds') x) and c.parent_category_id is not null
    and not exists(select 1 from public.selection_categories root where root.org_id=p_org_id and root.id=c.parent_category_id and root.community_id is null and root.parent_category_id is null and not root.is_archived)) then raise exception 'Cutoff rule category ancestry changed or is unavailable';end if;
   captured_labels:=jsonb_build_object('kind','group','categories',public.catalog_group_category_review(p_org_id,array(select x::uuid from jsonb_array_elements_text(p_request->'categoryIds') x)));
   if public.catalog_group_category_versions(p_org_id,array(select x::uuid from jsonb_array_elements_text(p_request->'categoryIds') x)) is distinct from p_request->'expectedCategoryVersions' then raise exception 'Category definitions changed since their original review';end if;
   if exists(select 1 from jsonb_array_elements(captured_labels->'categories') c where c->'definition'->'community_id'<>'null'::jsonb and (c->'definition'->>'community_id')::uuid is distinct from community) then raise exception 'Cutoff rule categories are outside active original scope';end if;
  else captured_labels:=public.capture_catalog_publication_review(p_org_id,p_kind,p_request);end if;
  intent_key:=gen_random_uuid();sequence_key:=public.allocate_catalog_publication_history(p_org_id,p_actor_id,community);
  insert into public.events(org_id,event_type,entity_type,entity_id,payload,channel) values(p_org_id,'catalog_publication_prepared','catalog_publication_intent',intent_key,jsonb_build_object('kind',p_kind,'request_key',p_key,'actor_id',p_actor_id),'activity') returning id into event_key;
  insert into public.audit_log(org_id,actor_user_id,action,entity_type,entity_id,after_data,source) values(p_org_id,p_actor_id,'create','catalog_publication_intent',intent_key,jsonb_build_object('kind',p_kind,'request_key',p_key),'catalog_publication_intent') returning id into audit_key;
  insert into public.catalog_publication_intents(id,org_id,actor_id,kind,request_key,request,history_sequence,audit_id,event_id,review_labels) values(intent_key,p_org_id,p_actor_id,p_kind,p_key,p_request,sequence_key,audit_key,event_key,captured_labels) returning * into prior;
  begin
   insert into public.catalog_publication_claims(org_id,actor_id,kind,scope_key,intent_id) values(p_org_id,p_actor_id,p_kind,coalesce(community::text,'org'),prior.id);
  exception when unique_violation then raise exception 'Resolve the previous registered request in Publication history before another save';end;
 end if;
 return jsonb_build_object('orgId',p_org_id,'actorId',p_actor_id,'kind',p_kind,'requestKey',p_key,'intentId',prior.id,'status',state);
end $$;

create or replace function public.assert_registered_catalog_publication(p_org_id uuid,p_actor_id uuid,p_kind text,p_key uuid,p_request jsonb) returns void
language plpgsql security definer set search_path='' as $$
declare prior public.catalog_publication_intents; community uuid; terminal boolean;
begin
 if p_kind is null or p_kind not in ('package','prices','group') or p_key is null or jsonb_typeof(p_request) is distinct from 'object' then raise exception 'Valid reviewed publication required';end if;
 community:=(p_request->>'communityId')::uuid;
 perform public.assert_catalog_publication_actor(p_org_id,p_actor_id,community);
 if p_kind='package' and (p_request ? 'costCents' or p_request->'expectedPackage' ? 'cost_cents') or p_kind='prices' and exists(select 1 from jsonb_array_elements(p_request->'items') x where x ? 'costCents' or x->'expectedPrice' ? 'cost_cents') then
  begin perform public.assert_catalog_publication_actor(p_org_id,p_actor_id,community,'financials.margin.read');
  exception when insufficient_privilege then raise exception 'Margin permission required to publish cost-bearing request' using errcode='42501';end;
 end if;
 perform pg_advisory_xact_lock(hashtextextended((case when p_kind='package' then 'catalog-package:' when p_kind='group' then 'catalog-group:' else 'catalog-prices:' end)||p_org_id::text||':'||p_key::text,0));
 select * into prior from public.catalog_publication_intents where org_id=p_org_id and kind=p_kind and request_key=p_key;
 if not found then
  if p_kind='package' and exists(select 1 from public.catalog_package_publication_receipts where org_id=p_org_id and request_key=p_key and actor_id=p_actor_id and request=p_request) or p_kind='prices' and exists(select 1 from public.catalog_price_publication_receipts where org_id=p_org_id and request_key=p_key and actor_id=p_actor_id and request=p_request) or p_kind='group' and exists(select 1 from public.catalog_group_publication_receipts where org_id=p_org_id and request_key=p_key and actor_id=p_actor_id and request=p_request) then return;end if;
  raise exception 'Register the original request before publication';
 end if;
 if prior.actor_id<>p_actor_id or prior.request is distinct from p_request then raise exception 'Registered publication belongs to different reviewed inputs or actor';end if;
 terminal:=exists(select 1 from public.catalog_publication_cancellations where org_id=p_org_id and kind=p_kind and request_key=p_key)
  or p_kind='package' and exists(select 1 from public.catalog_package_publication_receipts where org_id=p_org_id and request_key=p_key)
  or p_kind='prices' and exists(select 1 from public.catalog_price_publication_receipts where org_id=p_org_id and request_key=p_key)
  or p_kind='group' and exists(select 1 from public.catalog_group_publication_receipts where org_id=p_org_id and request_key=p_key);
 if not terminal and not exists(select 1 from public.catalog_publication_claims where org_id=p_org_id and actor_id=p_actor_id and kind=p_kind and scope_key=coalesce(community::text,'org') and intent_id=prior.id) then raise exception 'Registered request needs administrator recovery; keep its evidence';end if;
end $$;

create or replace function public.publish_catalog_group_contents(p_org_id uuid,p_actor_id uuid,p_key uuid,p_request jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare g public.selection_groups; receipt public.catalog_group_publication_receipts; community uuid; target uuid;
 ids uuid[]; parent_ids uuid[]; current_parents uuid[]; source jsonb; audit_key bigint; event_key uuid;
begin
 if p_key is null then raise exception 'Complete reviewed cutoff rule request and stable key required';end if;
 perform public.validate_catalog_group_publication_request(p_request);
 community:=(p_request->>'communityId')::uuid;target:=(p_request->>'id')::uuid;
 perform public.assert_catalog_publication_actor(p_org_id,p_actor_id,community);
 perform pg_advisory_xact_lock(hashtextextended('catalog-group:'||p_org_id::text||':'||p_key::text,0));
 if exists(select 1 from public.catalog_publication_intents where org_id=p_org_id and kind='group' and request_key=p_key and (actor_id<>p_actor_id or request is distinct from p_request)) then raise exception 'Registered publication belongs to different reviewed inputs or actor';end if;
 if exists(select 1 from public.catalog_publication_claims c join public.catalog_publication_intents i on i.org_id=c.org_id and i.id=c.intent_id where c.org_id=p_org_id and c.actor_id=p_actor_id and c.kind='group' and c.scope_key=coalesce(community::text,'org') and i.request_key<>p_key) then raise exception 'Resolve the previous registered request in Publication history before another save';end if;
 if exists(select 1 from public.catalog_publication_cancellations where org_id=p_org_id and kind='group' and request_key=p_key) then raise exception 'Publication request was cancelled; review current catalog and use a new request key';end if;
 select * into receipt from public.catalog_group_publication_receipts where org_id=p_org_id and request_key=p_key;
 if found then
  if receipt.actor_id<>p_actor_id or receipt.request is distinct from p_request then raise exception 'Cutoff rule key belongs to another actor or reviewed request';end if;
  select * into g from public.selection_groups where org_id=p_org_id and id=receipt.group_id for update;
  if not found or g.community_id is distinct from community then raise exception 'Published cutoff rule scope changed';end if;
  perform 1 from public.selection_group_categories where org_id=p_org_id and group_id=g.id order by id for share;
  if public.catalog_group_source(g) is distinct from receipt.group_source then raise exception 'Published cutoff rule changed; reconcile its original outcome';end if;
  perform public.assert_catalog_publication_actor(p_org_id,p_actor_id,community);
  return jsonb_build_object('orgId',p_org_id,'actorId',p_actor_id,'receiptId',receipt.id,'historySequence',receipt.history_sequence::text,'group',receipt.group_source,'created',false);
 end if;
 if target is not null then
  select * into g from public.selection_groups where org_id=p_org_id and id=target for update;
  if not found or g.is_archived or g.community_id is distinct from community then raise exception 'Original cutoff rule scope is unavailable';end if;
  perform 1 from public.selection_group_categories where org_id=p_org_id and group_id=g.id order by id for update;
  if public.catalog_group_source(g) is distinct from p_request->'expectedGroup' then raise exception 'Cutoff rule changed since its original review';end if;
 end if;
 if exists(select 1 from jsonb_array_elements(p_request->'categoryIds') x where jsonb_typeof(x)<>'string') then raise exception 'Category UUID references required';end if;
 select coalesce(array_agg(x::uuid order by x::uuid),'{}') into ids from jsonb_array_elements_text(p_request->'categoryIds') x;
 if cardinality(ids)<>(select count(distinct x) from unnest(ids) x) then raise exception 'Cutoff rule category references must be unique';end if;
 select coalesce(array_agg(distinct parent_category_id) filter(where parent_category_id is not null),'{}') into parent_ids from public.selection_categories where org_id=p_org_id and id=any(ids);
 -- Lock the combined child/root set once in UUID order. If a parent changed
 -- between discovery and lock acquisition, reject an unprotected new root.
 perform 1 from public.selection_categories where org_id=p_org_id and id=any(ids||parent_ids) order by id for share;
 select coalesce(array_agg(distinct parent_category_id) filter(where parent_category_id is not null),'{}') into current_parents from public.selection_categories where org_id=p_org_id and id=any(ids);
 if not(current_parents<@parent_ids) then raise exception 'Cutoff rule category ancestry changed during review';end if;
 parent_ids:=current_parents;
 if (select count(*) from public.selection_categories where org_id=p_org_id and id=any(ids) and not is_archived
  and (community_id is null or community_id=community) and (parent_category_id is null or community_id is not null))<>cardinality(ids) then raise exception 'Cutoff rule categories are outside active original scope';end if;
 if (select count(*) from public.selection_categories where org_id=p_org_id and id=any(parent_ids) and community_id is null and parent_category_id is null and not is_archived)<>cardinality(parent_ids) then raise exception 'Cutoff rule category ancestry changed or is unavailable';end if;
 if public.catalog_group_category_versions(p_org_id,ids) is distinct from p_request->'expectedCategoryVersions' then raise exception 'Category definitions changed since their original review';end if;
 perform public.assert_catalog_publication_actor(p_org_id,p_actor_id,community);
 if target is null then
  insert into public.selection_groups(org_id,community_id,name,schedule_task_key,cutoff_offset_days,cutoff_anchor,sort_order)
   values(p_org_id,community,btrim(p_request->>'name'),btrim(p_request->>'scheduleTaskKey'),(p_request->>'cutoffOffsetDays')::integer,p_request->>'cutoffAnchor',(p_request->>'sortOrder')::integer) returning * into g;
 else
  update public.selection_groups set name=btrim(p_request->>'name'),schedule_task_key=btrim(p_request->>'scheduleTaskKey'),cutoff_offset_days=(p_request->>'cutoffOffsetDays')::integer,cutoff_anchor=p_request->>'cutoffAnchor',sort_order=(p_request->>'sortOrder')::integer where org_id=p_org_id and id=target returning * into g;
 end if;
 delete from public.selection_group_categories where org_id=p_org_id and group_id=g.id;
 insert into public.selection_group_categories(org_id,group_id,category_id) select p_org_id,g.id,unnest(ids);
 source:=public.catalog_group_source(g);
 insert into public.events(org_id,event_type,entity_type,entity_id,payload,channel) values(p_org_id,'option_catalog_updated','selection_group',g.id,jsonb_build_object('operation',case when target is null then 'insert' else 'update' end,'request_key',p_key,'actor_id',p_actor_id),'activity') returning id into event_key;
 insert into public.audit_log(org_id,actor_user_id,action,entity_type,entity_id,after_data,source) values(p_org_id,p_actor_id,case when target is null then 'insert' else 'update' end,'selection_group',g.id,source,'catalog_group_publication') returning id into audit_key;
 insert into public.catalog_group_publication_receipts(org_id,request_key,group_id,actor_id,request,group_source,audit_id,event_id,history_sequence) values(p_org_id,p_key,g.id,p_actor_id,p_request,source,audit_key,event_key,public.allocate_catalog_publication_history(p_org_id,p_actor_id,community)) returning * into receipt;
 delete from public.catalog_publication_claims where org_id=p_org_id and intent_id in(select id from public.catalog_publication_intents where org_id=p_org_id and kind='group' and request_key=p_key);
 return jsonb_build_object('orgId',p_org_id,'actorId',p_actor_id,'receiptId',receipt.id,'historySequence',receipt.history_sequence::text,'group',source,'created',true);
end $$;

create or replace function public.inspect_catalog_publication(p_org_id uuid,p_actor_id uuid,p_kind text,p_key uuid,p_request jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare cancellation public.catalog_publication_cancellations; package_receipt public.catalog_package_publication_receipts; price_receipt public.catalog_price_publication_receipts;
 g public.selection_groups; group_receipt public.catalog_group_publication_receipts; c public.selection_packages; price public.selection_catalog_prices; item jsonb; receipt_id uuid; committed_at timestamptz;
 state text:='unchanged'; labels jsonb; can_margin boolean:=false; source_request jsonb; entity_ids uuid[]:='{}'; community uuid; checked_communities uuid[];
begin
 if p_kind not in ('package','prices','group') or p_kind is null or p_key is null or jsonb_typeof(p_request) is distinct from 'object' then raise exception 'Valid reviewed publication required';end if;
 community:=(p_request->>'communityId')::uuid;
 perform public.assert_catalog_publication_actor(p_org_id,p_actor_id,community);
 if p_kind='package' and (p_request ? 'costCents' or p_request->'expectedPackage' ? 'cost_cents') or p_kind='prices' and jsonb_typeof(p_request->'items')='array' and exists(select 1 from jsonb_array_elements(p_request->'items') x where x ? 'costCents' or x->'expectedPrice' ? 'cost_cents') then
  begin perform public.assert_catalog_publication_actor(p_org_id,p_actor_id,community,'financials.margin.read');
  exception when insufficient_privilege then raise exception 'Margin permission required to reconcile cost-bearing publication' using errcode='42501';end;
 end if;
 begin perform public.assert_catalog_publication_actor(p_org_id,p_actor_id,community,'financials.margin.read');can_margin:=true;exception when insufficient_privilege then can_margin:=false;end;
 checked_communities:=array[community];
 perform pg_advisory_xact_lock(hashtextextended((case when p_kind='package' then 'catalog-package:' when p_kind='group' then 'catalog-group:' else 'catalog-prices:' end)||p_org_id::text||':'||p_key::text,0));
 if exists(select 1 from public.catalog_publication_intents where org_id=p_org_id and kind=p_kind and request_key=p_key and (actor_id<>p_actor_id or request is distinct from p_request)) then raise exception 'Registered publication belongs to different reviewed inputs or actor';end if;
 select review_labels into labels from public.catalog_publication_intents where org_id=p_org_id and kind=p_kind and request_key=p_key and actor_id=p_actor_id;
 select * into cancellation from public.catalog_publication_cancellations where org_id=p_org_id and kind=p_kind and request_key=p_key;
 if found then
  if (p_kind='group' and cancellation.actor_id<>p_actor_id) or cancellation.request is distinct from p_request then raise exception 'Cancellation belongs to different reviewed inputs';end if;
  return jsonb_build_object('orgId',p_org_id,'kind',p_kind,'requestKey',p_key,'status','cancelled','receiptId',null,'committedAt',null,'sourceState',null,'entityIds','[]'::jsonb,'cancellationId',cancellation.id,'cancelledAt',cancellation.created_at,'reviewLabels',labels,'canReadMargin',can_margin);
 end if;
 if p_kind='package' then
  select * into package_receipt from public.catalog_package_publication_receipts where org_id=p_org_id and request_key=p_key;
  if found then
   receipt_id:=package_receipt.id;committed_at:=package_receipt.created_at;source_request:=package_receipt.request;
   entity_ids:=array[package_receipt.package_id];
  end if;
 elsif p_kind='group' then
  select * into group_receipt from public.catalog_group_publication_receipts where org_id=p_org_id and request_key=p_key;
  if found then
   if group_receipt.actor_id<>p_actor_id then raise exception 'Receipt belongs to another actor';end if;
   receipt_id:=group_receipt.id;committed_at:=group_receipt.created_at;source_request:=group_receipt.request;entity_ids:=array[group_receipt.group_id];
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
 elsif p_kind='group' then
  select * into g from public.selection_groups where org_id=p_org_id and id=group_receipt.group_id for share;
  if not found then state:='missing';else
   if g.community_id is distinct from community then perform public.assert_catalog_publication_actor(p_org_id,p_actor_id,g.community_id);end if;
   perform 1 from public.selection_group_categories where org_id=p_org_id and group_id=g.id order by id for share;
   if public.catalog_group_source(g) is distinct from group_receipt.group_source then state:='changed';end if;
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

create or replace function public.acknowledge_catalog_publication(p_org_id uuid,p_actor_id uuid,p_kind text,p_key uuid,p_request jsonb,p_receipt_id uuid,p_ack_key uuid,p_reason text) returns jsonb
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
  if prior.kind<>p_kind or prior.request_key<>p_key or prior.actor_id<>p_actor_id or coalesce(prior.price_receipt_id,prior.package_receipt_id,prior.group_receipt_id)<>p_receipt_id or prior.reason<>btrim(p_reason) then raise exception 'Acknowledgment key belongs to a different reconciliation';end if;
 else
  insert into public.events(org_id,event_type,entity_type,entity_id,payload,channel) values(p_org_id,'catalog_publication_reconciled','catalog_publication_receipt',p_receipt_id,jsonb_build_object('kind',p_kind,'request_key',p_key,'source_state',inspected->>'sourceState','actor_id',p_actor_id),'activity') returning id into event_key;
  insert into public.audit_log(org_id,actor_user_id,action,entity_type,entity_id,after_data,source) values(p_org_id,p_actor_id,'update','catalog_publication_receipt',p_receipt_id,jsonb_build_object('kind',p_kind,'request_key',p_key,'reason',btrim(p_reason),'source_state',inspected->>'sourceState'),'catalog_publication_reconciliation') returning id into audit_key;
  insert into public.catalog_publication_reconciliations(org_id,ack_key,kind,request_key,actor_id,price_receipt_id,package_receipt_id,group_receipt_id,reason,source_state,audit_id,event_id)
   values(p_org_id,p_ack_key,p_kind,p_key,p_actor_id,case when p_kind='prices' then p_receipt_id end,case when p_kind='package' then p_receipt_id end,case when p_kind='group' then p_receipt_id end,btrim(p_reason),inspected->>'sourceState',audit_key,event_key) returning * into prior;
 end if;
 return jsonb_build_object('orgId',p_org_id,'kind',p_kind,'requestKey',p_key,'receiptId',p_receipt_id,'ackKey',p_ack_key,'reconciliationId',prior.id);
end $$;

create or replace function public.list_catalog_publication_history(p_org_id uuid,p_actor_id uuid,p_community_id uuid,p_cursor jsonb default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare through_sequence bigint; before_sequence bigint; entries jsonb; next_cursor jsonb; pending_requests jsonb;
begin
 perform public.assert_catalog_publication_actor(p_org_id,p_actor_id,p_community_id);
 if p_cursor is null then
  select last_sequence into through_sequence from public.catalog_publication_history_heads where org_id=p_org_id and actor_id=p_actor_id and scope_key=coalesce(p_community_id::text,'org');
  through_sequence:=coalesce(through_sequence,0);
 else
  if jsonb_typeof(p_cursor) is distinct from 'object' or coalesce(p_cursor->>'throughSequence','') !~ '^[0-9]{1,19}$' or coalesce(p_cursor->>'beforeSequence','') !~ '^[0-9]{1,19}$' then raise exception 'Valid history cursor required';end if;
  through_sequence:=(p_cursor->>'throughSequence')::bigint;before_sequence:=(p_cursor->>'beforeSequence')::bigint;
  if before_sequence<1 or before_sequence>through_sequence then raise exception 'Valid history cursor required';end if;
  if through_sequence>coalesce((select last_sequence from public.catalog_publication_history_heads where org_id=p_org_id and actor_id=p_actor_id and scope_key=coalesce(p_community_id::text,'org')),0) then raise exception 'Valid history cursor required';end if;
 end if;
 with packages as (
  select id,request_key,'package'::text kind,'package'::text record_type,'committed'::text status,created_at,history_sequence,true outcome_recorded,1 item_count
   from public.catalog_package_publication_receipts where org_id=p_org_id and actor_id=p_actor_id and coalesce(lower(request->>'communityId'),'org')=coalesce(p_community_id::text,'org') and history_sequence<=through_sequence
   and (before_sequence is null or history_sequence<before_sequence) order by history_sequence desc limit 26
 ),groups as (
  select id,request_key,'group'::text kind,'group'::text record_type,'committed'::text status,created_at,history_sequence,true outcome_recorded,1 item_count
   from public.catalog_group_publication_receipts where org_id=p_org_id and actor_id=p_actor_id and coalesce(lower(request->>'communityId'),'org')=coalesce(p_community_id::text,'org') and history_sequence<=through_sequence
   and (before_sequence is null or history_sequence<before_sequence) order by history_sequence desc limit 26
 ),prices as (
  select id,request_key,'prices'::text kind,'prices'::text record_type,'committed'::text status,created_at,history_sequence,true outcome_recorded,jsonb_array_length(prices) item_count
   from public.catalog_price_publication_receipts where org_id=p_org_id and actor_id=p_actor_id and coalesce(lower(request->>'communityId'),'org')=coalesce(p_community_id::text,'org') and history_sequence<=through_sequence
   and (before_sequence is null or history_sequence<before_sequence) order by history_sequence desc limit 26
 ),cancellations as (
  select id,request_key,kind,'cancellation'::text record_type,'cancelled'::text status,created_at,history_sequence,true outcome_recorded,case when kind in ('package','group') then 1 else jsonb_array_length(request->'items') end item_count
   from public.catalog_publication_cancellations where org_id=p_org_id and actor_id=p_actor_id and coalesce(lower(request->>'communityId'),'org')=coalesce(p_community_id::text,'org') and history_sequence<=through_sequence
   and (before_sequence is null or history_sequence<before_sequence) order by history_sequence desc limit 26
 ),intents as (
  select i.id,i.request_key,i.kind,'intent'::text record_type,'registered'::text status,i.created_at,i.history_sequence,
   (exists(select 1 from public.catalog_package_publication_receipts r where i.kind='package' and r.org_id=i.org_id and r.request_key=i.request_key and r.history_sequence<=through_sequence)
    or exists(select 1 from public.catalog_group_publication_receipts r where i.kind='group' and r.org_id=i.org_id and r.request_key=i.request_key and r.history_sequence<=through_sequence)
    or exists(select 1 from public.catalog_price_publication_receipts r where i.kind='prices' and r.org_id=i.org_id and r.request_key=i.request_key and r.history_sequence<=through_sequence)
    or exists(select 1 from public.catalog_publication_cancellations r where r.org_id=i.org_id and r.kind=i.kind and r.request_key=i.request_key and r.history_sequence<=through_sequence)) outcome_recorded,
   case when i.kind in ('package','group') then 1 else jsonb_array_length(i.request->'items') end item_count
   from public.catalog_publication_intents i where i.org_id=p_org_id and i.actor_id=p_actor_id and coalesce(lower(i.request->>'communityId'),'org')=coalesce(p_community_id::text,'org') and i.history_sequence<=through_sequence
   and (before_sequence is null or i.history_sequence<before_sequence) order by i.history_sequence desc limit 26
 ),merged as (
  select * from packages union all select * from groups union all select * from prices union all select * from cancellations union all select * from intents
 ),page as (
  select * from merged order by history_sequence desc limit 26
 ) select coalesce(jsonb_agg(jsonb_build_object('id',id,'requestKey',request_key,'kind',kind,'type',record_type,'status',status,'occurredAt',created_at,'sequence',history_sequence::text,'outcomeRecorded',outcome_recorded,'itemCount',item_count) order by history_sequence desc),'[]'::jsonb) into entries from page;
 if jsonb_array_length(entries)>25 then next_cursor:=jsonb_build_object('throughSequence',through_sequence::text,'beforeSequence',entries->24->>'sequence');entries:=entries-25;end if;
 -- Current unresolved pointers are bounded independently of the history page.
 select coalesce(jsonb_agg(jsonb_build_object('id',i.id,'requestKey',i.request_key,'kind',i.kind,'type','intent','status','registered','occurredAt',i.created_at,'sequence',i.history_sequence::text,'outcomeRecorded',false,'itemCount',case when i.kind in ('package','group') then 1 else jsonb_array_length(i.request->'items') end) order by i.history_sequence desc),'[]'::jsonb) into pending_requests
 from public.catalog_publication_claims c join public.catalog_publication_intents i on i.org_id=c.org_id and i.id=c.intent_id
 where c.org_id=p_org_id and c.actor_id=p_actor_id and c.scope_key=coalesce(p_community_id::text,'org');
 return jsonb_build_object('orgId',p_org_id,'actorId',p_actor_id,'communityId',p_community_id,'entries',entries,'nextCursor',next_cursor,'pendingRequests',pending_requests);
end $$;

create or replace function public.read_catalog_publication_request(p_org_id uuid,p_actor_id uuid,p_community_id uuid,p_type text,p_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare request_body jsonb; request_id uuid; publication_kind text; outcome_status text;
begin
 if p_id is null or p_type is null or p_type not in ('package','prices','group','cancellation','intent') then raise exception 'Valid publication outcome required';end if;
 perform public.assert_catalog_publication_actor(p_org_id,p_actor_id,p_community_id);
 if p_type='package' then
  select request,request_key into request_body,request_id from public.catalog_package_publication_receipts where org_id=p_org_id and actor_id=p_actor_id and id=p_id and coalesce(lower(request->>'communityId'),'org')=coalesce(p_community_id::text,'org');publication_kind:='package';outcome_status:='committed';
 elsif p_type='prices' then
  select request,request_key into request_body,request_id from public.catalog_price_publication_receipts where org_id=p_org_id and actor_id=p_actor_id and id=p_id and coalesce(lower(request->>'communityId'),'org')=coalesce(p_community_id::text,'org');publication_kind:='prices';outcome_status:='committed';
 elsif p_type='group' then
  select request,request_key into request_body,request_id from public.catalog_group_publication_receipts where org_id=p_org_id and actor_id=p_actor_id and id=p_id and coalesce(lower(request->>'communityId'),'org')=coalesce(p_community_id::text,'org');publication_kind:='group';outcome_status:='committed';
 elsif p_type='intent' then
  select request,request_key,kind into request_body,request_id,publication_kind from public.catalog_publication_intents where org_id=p_org_id and actor_id=p_actor_id and id=p_id and coalesce(lower(request->>'communityId'),'org')=coalesce(p_community_id::text,'org');outcome_status:='registered';
 else
  select request,request_key,kind into request_body,request_id,publication_kind from public.catalog_publication_cancellations where org_id=p_org_id and actor_id=p_actor_id and id=p_id and coalesce(lower(request->>'communityId'),'org')=coalesce(p_community_id::text,'org');outcome_status:='cancelled';
 end if;
 if request_body is null then raise exception 'Publication outcome is unavailable in this user and scope';end if;
 if publication_kind='package' and (request_body ? 'costCents' or request_body->'expectedPackage' ? 'cost_cents') or publication_kind='prices' and exists(select 1 from jsonb_array_elements(request_body->'items') x where x ? 'costCents' or x->'expectedPrice' ? 'cost_cents') then
  begin perform public.assert_catalog_publication_actor(p_org_id,p_actor_id,p_community_id,'financials.margin.read');
  exception when insufficient_privilege then raise exception 'Margin permission required to recover cost-bearing publication' using errcode='42501';end;
 end if;
 return jsonb_build_object('orgId',p_org_id,'actorId',p_actor_id,'communityId',p_community_id,'outcomeId',p_id,'kind',publication_kind,'type',p_type,'status',outcome_status,'requestKey',request_id,'request',request_body);
end $$;

create or replace function public.list_pending_catalog_publications(p_org_id uuid,p_actor_id uuid,p_before uuid default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare boundary public.catalog_publication_intents; candidate record; rows jsonb:='[]'::jsonb; continuation uuid; last_visible uuid; community_name text;
begin
 if p_org_id is null or p_actor_id is null then raise exception 'Publication queue context required' using errcode='42501';end if;
 if p_before is not null then
  select * into boundary from public.catalog_publication_intents where org_id=p_org_id and actor_id=p_actor_id and id=p_before;
  if not found or not public.can_review_catalog_publication_scope(p_org_id,p_actor_id,(boundary.request->>'communityId')::uuid) then raise exception 'Queue continuation is unavailable; refresh newest requests' using errcode='42501';end if;
 end if;
 -- Sort the bounded-by-active-claims source before calling authorization.
 -- A WHERE authorization predicate before an ORDER BY could check every claim
 -- even when the first 26 sorted requests are already accessible.
 for candidate in
  with active_claims as materialized (
   select * from public.catalog_publication_claims where org_id=p_org_id and actor_id=p_actor_id
  )
  select i.id,i.request_key,i.kind,i.created_at,(i.request->>'communityId')::uuid community_id,
   case when i.kind in ('package','group') then 1 else jsonb_array_length(i.request->'items') end item_count
  from active_claims claim
  join public.catalog_publication_intents i on claim.org_id=i.org_id and claim.actor_id=i.actor_id and claim.intent_id=i.id and claim.kind=i.kind and claim.scope_key=coalesce((i.request->>'communityId')::uuid::text,'org')
  where i.org_id=p_org_id and i.actor_id=p_actor_id and (p_before is null or (i.created_at,i.id)<(boundary.created_at,boundary.id))
  order by i.created_at desc,i.id desc
 loop
  if not public.can_review_catalog_publication_scope(p_org_id,p_actor_id,candidate.community_id) then continue;end if;
  if jsonb_array_length(rows)=25 then continuation:=last_visible;exit;end if;
  select left(to_jsonb(c)->>'name',200) into community_name from public.communities c where c.org_id=p_org_id and c.id=candidate.community_id;
  rows:=rows||jsonb_build_array(jsonb_build_object('id',candidate.id,'requestKey',candidate.request_key,'kind',candidate.kind,'communityId',candidate.community_id,'communityName',community_name,'occurredAt',to_char(candidate.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'itemCount',candidate.item_count));
  last_visible:=candidate.id;
 end loop;
 return jsonb_build_object('orgId',p_org_id,'actorId',p_actor_id,'entries',rows,'nextCursor',continuation);
end $$;

create function public.publish_catalog_group_atomic(p_org_id uuid,p_actor_id uuid,p_key uuid,p_request jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 perform public.assert_registered_catalog_publication(p_org_id,p_actor_id,'group',p_key,p_request);
 return public.publish_catalog_group_contents(p_org_id,p_actor_id,p_key,p_request);
end $$;
revoke all on function public.publish_catalog_group_atomic(uuid,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.publish_catalog_group_atomic(uuid,uuid,uuid,jsonb) to service_role;


-- Original review is a separate authorized read, never a publisher-side refresh.
create function public.review_catalog_group_categories(p_org_id uuid,p_actor_id uuid,p_community_id uuid,p_ids uuid[]) returns jsonb
language plpgsql security definer set search_path='' as $$
declare parents uuid[]; current_parents uuid[]; snapshot jsonb;
begin
 if p_ids is null or cardinality(p_ids)>100 or array_ndims(p_ids)>1
  or exists(select 1 from unnest(p_ids) x where x is null)
  or cardinality(p_ids)<>(select count(distinct x) from unnest(p_ids) x) then raise exception 'Review at most 100 unique category references';end if;
 perform public.assert_catalog_publication_actor(p_org_id,p_actor_id,p_community_id);
 select coalesce(array_agg(distinct parent_category_id) filter(where parent_category_id is not null),'{}') into parents from public.selection_categories where org_id=p_org_id and id=any(p_ids);
 perform 1 from public.selection_categories where org_id=p_org_id and id=any(p_ids||parents) order by id for share;
 select coalesce(array_agg(distinct parent_category_id) filter(where parent_category_id is not null),'{}') into current_parents from public.selection_categories where org_id=p_org_id and id=any(p_ids);
 if not(current_parents<@parents) then raise exception 'Category ancestry changed during review';end if;
 if (select count(*) from public.selection_categories where org_id=p_org_id and id=any(p_ids) and not is_archived
  and (community_id is null or community_id=p_community_id) and (parent_category_id is null or community_id is not null))<>cardinality(p_ids) then raise exception 'Cutoff rule categories are outside active original scope';end if;
 if (select count(*) from public.selection_categories where org_id=p_org_id and id=any(current_parents) and community_id is null and parent_category_id is null and not is_archived)<>cardinality(current_parents) then raise exception 'Cutoff rule category ancestry changed or is unavailable';end if;
 snapshot:=public.catalog_group_category_review(p_org_id,p_ids);
 perform public.assert_catalog_publication_actor(p_org_id,p_actor_id,p_community_id);
 return jsonb_build_object('orgId',p_org_id,'actorId',p_actor_id,'communityId',p_community_id,'categories',snapshot);
end $$;
revoke all on function public.review_catalog_group_categories(uuid,uuid,uuid,uuid[]) from public,anon,authenticated;
grant execute on function public.review_catalog_group_categories(uuid,uuid,uuid,uuid[]) to service_role;
