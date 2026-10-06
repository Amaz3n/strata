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
