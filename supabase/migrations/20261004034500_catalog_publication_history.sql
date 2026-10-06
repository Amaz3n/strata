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
