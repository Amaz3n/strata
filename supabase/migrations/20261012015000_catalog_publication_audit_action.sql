-- Price and package requests are validated at registration, not only at
-- publication. A claim is released only by a receipt or a cancellation, so a
-- request the publisher was always going to refuse (an unreleased plan version,
-- an inactive plan, an archived or out-of-scope subject, unavailable package
-- options) used to strand its claim and block the designer's next save until
-- they cancelled it in Publication history. The checks now live in one
-- validator per kind that registration and the publisher both call (cutoff
-- rules already worked this way). A refusal that depends on review freshness
-- (the cell or package changed since it was reviewed) still keeps the claim:
-- that is the recovery design.

create function public.validate_catalog_price_publication_request(p_org_id uuid,p_request jsonb) returns void
language plpgsql security definer set search_path='' as $$
declare community uuid:=(p_request->>'communityId')::uuid; item jsonb; subject uuid; version_id uuid; plan_id uuid;
begin
 if jsonb_typeof(p_request->'items') is distinct from 'array' or jsonb_array_length(p_request->'items') not between 1 and 500 then raise exception 'Price publication must contain 1 to 500 reviewed cells';end if;
 if (select count(distinct coalesce(x->>'optionId',x->>'packageId')||':'||(x->>'housePlanVersionId')) from jsonb_array_elements(p_request->'items') x)<>jsonb_array_length(p_request->'items') then raise exception 'Duplicate or incomplete price address';end if;
 for item in select x from jsonb_array_elements(p_request->'items') x order by coalesce(x->>'optionId',x->>'packageId'),x->>'housePlanVersionId' loop
  if jsonb_typeof(item) is distinct from 'object' or num_nonnulls(item->>'optionId',item->>'packageId')<>1 or not(item ? 'expectedPrice')
    or jsonb_typeof(item->'priceCents') is distinct from 'number' or coalesce(item->>'priceCents','') !~ '^[0-9]+$'
    or jsonb_typeof(item->'isAvailable') is distinct from 'boolean'
    or item ? 'costCents' and item->>'costCents' is not null and (jsonb_typeof(item->'costCents')<>'number' or item->>'costCents' !~ '^[0-9]+$') then raise exception 'Valid reviewed price cell required';end if;
  subject:=coalesce(item->>'optionId',item->>'packageId')::uuid;version_id:=(item->>'housePlanVersionId')::uuid;
  if item->>'optionId' is not null then
   perform 1 from public.selection_options where org_id=p_org_id and id=subject and not is_archived and (community_id is null or community_id=community) for share;
  else
   perform 1 from public.selection_packages where org_id=p_org_id and id=subject and not is_archived and (community_id is null or community_id=community) for share;
  end if;
  if not found then raise exception 'Price subject is unavailable or outside this community';end if;
  select house_plan_id into plan_id from public.house_plan_versions where org_id=p_org_id and id=version_id and status='released' for share;
  if not found then raise exception 'Price requires a released plan version in this organization';end if;
  perform 1 from public.house_plans where org_id=p_org_id and id=plan_id and status='active' for share;
  if not found then raise exception 'Price plan is not active in this organization';end if;
 end loop;
end $$;
revoke all on function public.validate_catalog_price_publication_request(uuid,jsonb) from public,anon,authenticated,service_role;

create function public.validate_catalog_package_publication_request(p_org_id uuid,p_request jsonb) returns void
language plpgsql security definer set search_path='' as $$
declare community uuid:=(p_request->>'communityId')::uuid; ids uuid[]; option_count integer; category_count integer;
begin
 if jsonb_typeof(p_request->'optionIds') is distinct from 'array' or jsonb_array_length(p_request->'optionIds') not between 1 and 100
  or jsonb_typeof(p_request->'name') is distinct from 'string' or length(btrim(p_request->>'name')) not between 1 and 160
  or jsonb_typeof(p_request->'priceCents') is distinct from 'number' or jsonb_typeof(p_request->'sortOrder') is distinct from 'number'
  or coalesce(p_request->>'priceCents','') !~ '^[0-9]+$' or coalesce(p_request->>'sortOrder','') !~ '^[0-9]+$'
  or (p_request->>'sortOrder')::integer>10000 or jsonb_typeof(p_request->'isAvailable') is distinct from 'boolean'
  or p_request->>'costCents' is not null and (jsonb_typeof(p_request->'costCents') is distinct from 'number' or p_request->>'costCents' !~ '^[0-9]+$')
  or p_request->>'description' is not null and jsonb_typeof(p_request->'description') is distinct from 'string'
  or p_request->>'imageUrl' is not null and jsonb_typeof(p_request->'imageUrl') is distinct from 'string'
  or length(coalesce(p_request->>'description',''))>2000 or length(coalesce(p_request->>'imageUrl',''))>2000 then raise exception 'Valid catalog package publication required';end if;
 if p_request ? 'editArchived' and (p_request->'editArchived' is distinct from 'true'::jsonb or p_request ? 'isArchived' or p_request->>'id' is null or not(p_request ? 'expectedPackage')) then raise exception 'Reviewed archived package repair required';end if;
 if p_request ? 'isArchived' and (jsonb_typeof(p_request->'isArchived') is distinct from 'boolean' or p_request->>'id' is null or not(p_request ? 'expectedPackage') or p_request ? 'costCents') then raise exception 'Reviewed existing package lifecycle required';end if;
 select array_agg(x::uuid order by x::uuid) into ids from jsonb_array_elements_text(p_request->'optionIds') x;
 if cardinality(ids)<>(select count(distinct x) from unnest(ids) x) then raise exception 'Duplicate package option';end if;
 if coalesce((p_request->>'isArchived')::boolean,false) is not true then
 perform 1 from public.selection_options where org_id=p_org_id and id=any(ids) order by id for share;
 select count(*),count(distinct category_id) into option_count,category_count from public.selection_options
  where org_id=p_org_id and id=any(ids) and not is_archived and is_available and (community_id is null or community_id=community);
 if option_count<>cardinality(ids) or category_count<>cardinality(ids) then raise exception 'Package requires available options in scope and one option per category';end if;
 perform 1 from public.selection_categories where org_id=p_org_id and id in(select category_id from public.selection_options where org_id=p_org_id and id=any(ids)) order by id for share;
 select count(distinct coalesce(k.parent_category_id,k.id)) into category_count from public.selection_options o join public.selection_categories k on k.org_id=o.org_id and k.id=o.category_id where o.org_id=p_org_id and o.id=any(ids);
 if category_count<>cardinality(ids) then raise exception 'A package can include only one option per effective category';end if;
 perform 1 from public.selection_categories where org_id=p_org_id and id in(select k.parent_category_id from public.selection_options o join public.selection_categories k on k.org_id=o.org_id and k.id=o.category_id where o.org_id=p_org_id and o.id=any(ids)) order by id for share;
 if exists(select 1 from public.selection_options o join public.selection_categories k on k.org_id=o.org_id and k.id=o.category_id left join public.selection_categories base on base.org_id=k.org_id and base.id=k.parent_category_id where o.org_id=p_org_id and o.id=any(ids) and k.parent_category_id is not null and (base.id is null or base.community_id is not null or k.community_id is null)) then raise exception 'Package category override ancestry is invalid';end if;
 if exists(select 1 from public.selection_options o left join public.selection_categories k on k.org_id=o.org_id and k.id=o.category_id where o.org_id=p_org_id and o.id=any(ids)
  and (k.id is null or k.is_archived or (k.community_id is not null and k.community_id is distinct from community))) then raise exception 'Package category is unavailable in this scope';end if;
 end if;
end $$;
revoke all on function public.validate_catalog_package_publication_request(uuid,jsonb) from public,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.publish_catalog_prices_contents(p_org_id uuid,p_actor_id uuid,p_key uuid,p_request jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare community uuid; item jsonb; c public.selection_catalog_prices; receipt public.catalog_price_publication_receipts;
 subject uuid; version_id uuid; expected jsonb; saved jsonb:='[]'; exposed jsonb; event_key uuid; audit_key bigint; can_margin boolean:=false;
begin
 if p_key is null or jsonb_typeof(p_request) is distinct from 'object' then raise exception 'Reviewed price publication and stable request key required';end if;
 community:=(p_request->>'communityId')::uuid;
 perform public.assert_catalog_publication_actor(p_org_id,p_actor_id,community);
 begin perform public.assert_catalog_publication_actor(p_org_id,p_actor_id,community,'financials.margin.read');can_margin:=true;exception when insufficient_privilege then can_margin:=false;end;
 if not can_margin and jsonb_typeof(p_request->'items')='array' and exists(select 1 from jsonb_array_elements(p_request->'items') x where x ? 'costCents' or x->'expectedPrice' ? 'cost_cents') then raise exception 'Margin permission required to review or change catalog costs' using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtextextended('catalog-prices:'||p_org_id::text||':'||p_key::text,0));
 if exists(select 1 from public.catalog_publication_intents where org_id=p_org_id and kind='prices' and request_key=p_key and (actor_id<>p_actor_id or request is distinct from p_request)) then raise exception 'Registered publication belongs to different reviewed inputs or actor';end if;
 if exists(select 1 from public.catalog_publication_claims publication_claim join public.catalog_publication_intents i on i.org_id=publication_claim.org_id and i.id=publication_claim.intent_id where publication_claim.org_id=p_org_id and publication_claim.actor_id=p_actor_id and publication_claim.kind='prices' and publication_claim.scope_key=coalesce(community::text,'org') and i.request_key<>p_key) then raise exception 'Resolve the previous registered request in Publication history before another save';end if;
 if exists(select 1 from public.catalog_publication_cancellations where org_id=p_org_id and kind='prices' and request_key=p_key) then raise exception 'Publication request was cancelled; review current catalog and use a new request key';end if;
 select * into receipt from public.catalog_price_publication_receipts where org_id=p_org_id and request_key=p_key;
 if found then
  if receipt.request is distinct from p_request then raise exception 'Price publication key owns different reviewed inputs';end if;
  for item in select x from jsonb_array_elements(receipt.prices) x order by x->>'id' loop
   select * into c from public.selection_catalog_prices where org_id=p_org_id and id=(item->>'id')::uuid for share;
   if not found or public.catalog_price_source(c) is distinct from item then raise exception 'Published prices changed; review current prices before another save';end if;
  end loop;
  select coalesce(jsonb_agg(case when can_margin then x else x-'cost_cents' end),'[]') into exposed from jsonb_array_elements(receipt.prices) x;
  return jsonb_build_object('orgId',p_org_id,'receiptId',receipt.id,'created',false,'prices',exposed);
 end if;
 perform public.validate_catalog_price_publication_request(p_org_id,p_request);
 for item in select x from jsonb_array_elements(p_request->'items') x order by coalesce(x->>'optionId',x->>'packageId'),x->>'housePlanVersionId' loop
  if item ? 'costCents' and not can_margin then raise exception 'Margin permission required to change catalog costs' using errcode='42501';end if;
  subject:=coalesce(item->>'optionId',item->>'packageId')::uuid;version_id:=(item->>'housePlanVersionId')::uuid;
  perform pg_advisory_xact_lock(hashtextextended('catalog-price-cell:'||p_org_id::text||':'||subject::text||':'||version_id::text||':'||coalesce(community::text,'org'),0));
  select * into c from public.selection_catalog_prices where org_id=p_org_id and house_plan_version_id=version_id and community_id is not distinct from community
    and (case when item->>'optionId' is not null then option_id=subject else package_id=subject end) for update;
  expected:=case when c.id is null then 'null'::jsonb else jsonb_build_object('id',c.id,'price_cents',c.price_cents,'is_available',c.is_available) end;
  if c.id is not null and item->'expectedPrice' ? 'cost_cents' then expected:=expected||jsonb_build_object('cost_cents',c.cost_cents);end if;
  if c.id is not null and item ? 'costCents' and not(item->'expectedPrice' ? 'cost_cents') then raise exception 'Review current cost before changing margin';end if;
  if item->'expectedPrice' is distinct from expected then raise exception 'Price changed; review the current cell before publishing';end if;
  if c.id is null then
   insert into public.selection_catalog_prices(org_id,option_id,package_id,house_plan_version_id,community_id,price_cents,cost_cents,is_available)
   values(p_org_id,(item->>'optionId')::uuid,(item->>'packageId')::uuid,version_id,community,(item->>'priceCents')::integer,(item->>'costCents')::integer,(item->>'isAvailable')::boolean) returning * into c;
  else
   update public.selection_catalog_prices set price_cents=(item->>'priceCents')::integer,cost_cents=case when item ? 'costCents' then (item->>'costCents')::integer else cost_cents end,is_available=(item->>'isAvailable')::boolean where org_id=p_org_id and id=c.id returning * into c;
  end if;
  saved:=saved||jsonb_build_array(public.catalog_price_source(c));
 end loop;
 insert into public.events(org_id,event_type,entity_type,entity_id,payload,channel) values(p_org_id,'option_catalog_updated','selection_catalog_price',p_key,jsonb_build_object('operation','price_publication','cell_count',jsonb_array_length(saved),'actor_id',p_actor_id),'activity') returning id into event_key;
 insert into public.audit_log(org_id,actor_user_id,action,entity_type,entity_id,after_data,source) values(p_org_id,p_actor_id,'update','selection_catalog_price',p_key,saved,'catalog_price_publication') returning id into audit_key;
 insert into public.catalog_price_publication_receipts(org_id,request_key,actor_id,request,prices,event_id,audit_id,history_sequence) values(p_org_id,p_key,p_actor_id,p_request,saved,event_key,audit_key,public.allocate_catalog_publication_history(p_org_id,p_actor_id,community)) returning * into receipt;
 delete from public.catalog_publication_claims where org_id=p_org_id and intent_id in(select id from public.catalog_publication_intents where org_id=p_org_id and kind='prices' and request_key=p_key);
 select jsonb_agg(case when can_margin then x else x-'cost_cents' end) into exposed from jsonb_array_elements(saved) x;
 return jsonb_build_object('orgId',p_org_id,'receiptId',receipt.id,'created',true,'prices',exposed);
end $$;

-- The catalog publication chain (20261004012839, 20261004072434) audited its intent and
-- cancellation rows with action 'create', which public.audit_action does not
-- have (insert, update, delete). Every registration therefore failed the moment
-- atomic publication became the only catalog write path. Those rows are now
-- audited as 'insert'; registration also runs the validators above.

CREATE OR REPLACE FUNCTION public.register_catalog_publication(p_org_id uuid, p_actor_id uuid, p_kind text, p_key uuid, p_request jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  else
   if p_kind='package' then perform public.validate_catalog_package_publication_request(p_org_id,p_request);
   else perform public.validate_catalog_price_publication_request(p_org_id,p_request);end if;
   captured_labels:=public.capture_catalog_publication_review(p_org_id,p_kind,p_request);
  end if;
  intent_key:=gen_random_uuid();sequence_key:=public.allocate_catalog_publication_history(p_org_id,p_actor_id,community);
  insert into public.events(org_id,event_type,entity_type,entity_id,payload,channel) values(p_org_id,'catalog_publication_prepared','catalog_publication_intent',intent_key,jsonb_build_object('kind',p_kind,'request_key',p_key,'actor_id',p_actor_id),'activity') returning id into event_key;
  insert into public.audit_log(org_id,actor_user_id,action,entity_type,entity_id,after_data,source) values(p_org_id,p_actor_id,'insert','catalog_publication_intent',intent_key,jsonb_build_object('kind',p_kind,'request_key',p_key),'catalog_publication_intent') returning id into audit_key;
  insert into public.catalog_publication_intents(id,org_id,actor_id,kind,request_key,request,history_sequence,audit_id,event_id,review_labels) values(intent_key,p_org_id,p_actor_id,p_kind,p_key,p_request,sequence_key,audit_key,event_key,captured_labels) returning * into prior;
  begin
   insert into public.catalog_publication_claims(org_id,actor_id,kind,scope_key,intent_id) values(p_org_id,p_actor_id,p_kind,coalesce(community::text,'org'),prior.id);
  exception when unique_violation then raise exception 'Resolve the previous registered request in Publication history before another save';end;
 end if;
 return jsonb_build_object('orgId',p_org_id,'actorId',p_actor_id,'kind',p_kind,'requestKey',p_key,'intentId',prior.id,'status',state);
end $function$
;

CREATE OR REPLACE FUNCTION public.cancel_catalog_publication(p_org_id uuid, p_actor_id uuid, p_kind text, p_key uuid, p_request jsonb, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  insert into public.audit_log(org_id,actor_user_id,action,entity_type,entity_id,after_data,source) values(p_org_id,p_actor_id,'insert','catalog_publication_cancellation',cancellation_key,jsonb_build_object('kind',p_kind,'request_key',p_key,'reason',btrim(p_reason)),'catalog_publication_cancellation') returning id into audit_key;
  insert into public.catalog_publication_cancellations(id,org_id,kind,request_key,actor_id,request,reason,audit_id,event_id,history_sequence) values(cancellation_key,p_org_id,p_kind,p_key,p_actor_id,p_request,btrim(p_reason),audit_key,event_key,public.allocate_catalog_publication_history(p_org_id,p_actor_id,(p_request->>'communityId')::uuid)) returning * into prior;
 end if;
 delete from public.catalog_publication_claims where org_id=p_org_id and intent_id in(select id from public.catalog_publication_intents where org_id=p_org_id and kind=p_kind and request_key=p_key);
 -- Public metadata contains no cost, request body or catalog source values.
 return jsonb_build_object('orgId',p_org_id,'kind',p_kind,'requestKey',p_key,'cancellationId',prior.id,'cancelledAt',prior.created_at);
end $function$
;

-- The package and group publishers and the warranty courtesy inspection put a
-- text CASE ('insert'/'update') straight into audit_log.action, which Postgres
-- refuses (text is not public.audit_action); the CASE is now cast. The package
-- publisher's request checks moved into its validator above.

CREATE OR REPLACE FUNCTION public.publish_catalog_package_contents(p_org_id uuid, p_actor_id uuid, p_key uuid, p_request jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare c public.selection_packages; receipt public.catalog_package_publication_receipts; target uuid; community uuid; ids uuid[]; source jsonb; old_source jsonb; audit_key bigint; event_key uuid; can_margin boolean:=false;
begin
 if p_key is null or jsonb_typeof(p_request) is distinct from 'object' then raise exception 'Reviewed publication and stable request key required';end if;
 community:=(p_request->>'communityId')::uuid;
 perform public.assert_catalog_publication_actor(p_org_id,p_actor_id,community);
 begin perform public.assert_catalog_publication_actor(p_org_id,p_actor_id,community,'financials.margin.read');can_margin:=true;exception when insufficient_privilege then can_margin:=false;end;
 if (p_request ? 'costCents' or p_request->'expectedPackage' ? 'cost_cents') and not can_margin then raise exception 'Margin permission required to review or change package cost' using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtextextended('catalog-package:'||p_org_id::text||':'||p_key::text,0));
 if exists(select 1 from public.catalog_publication_intents where org_id=p_org_id and kind='package' and request_key=p_key and (actor_id<>p_actor_id or request is distinct from p_request)) then raise exception 'Registered publication belongs to different reviewed inputs or actor';end if;
 if exists(select 1 from public.catalog_publication_claims publication_claim join public.catalog_publication_intents i on i.org_id=publication_claim.org_id and i.id=publication_claim.intent_id where publication_claim.org_id=p_org_id and publication_claim.actor_id=p_actor_id and publication_claim.kind='package' and publication_claim.scope_key=coalesce(community::text,'org') and i.request_key<>p_key) then raise exception 'Resolve the previous registered request in Publication history before another save';end if;
 if exists(select 1 from public.catalog_publication_cancellations where org_id=p_org_id and kind='package' and request_key=p_key) then raise exception 'Publication request was cancelled; review current catalog and use a new request key';end if;
 select * into receipt from public.catalog_package_publication_receipts where org_id=p_org_id and request_key=p_key;
 if found then
  if receipt.request is distinct from p_request then raise exception 'Publication request key already owns different reviewed inputs';end if;
  select * into c from public.selection_packages where org_id=p_org_id and id=receipt.package_id for update;
  perform public.assert_catalog_publication_actor(p_org_id,p_actor_id,c.community_id);
  perform 1 from public.selection_package_items where org_id=p_org_id and package_id=c.id order by id for share;
  if c.id is null or public.catalog_package_source(c) is distinct from receipt.package_source then raise exception 'Published package changed; review its current contents before saving again';end if;
  return jsonb_build_object('orgId',p_org_id,'receiptId',receipt.id,'package',case when can_margin then receipt.package_source else receipt.package_source-'cost_cents' end,'created',false,'canReadMargin',can_margin);
 end if;
 perform public.validate_catalog_package_publication_request(p_org_id,p_request);
 select array_agg(x::uuid order by x::uuid) into ids from jsonb_array_elements_text(p_request->'optionIds') x;
 target:=(p_request->>'id')::uuid;
 if target is null and p_request ? 'expectedPackage' then raise exception 'A reviewed existing package requires its original package identity';end if;
 if target is not null then
  select * into c from public.selection_packages where org_id=p_org_id and id=target for update;
  if not found then raise exception 'Package belongs to another organization or is unavailable';end if;
  perform public.assert_catalog_publication_actor(p_org_id,p_actor_id,c.community_id);
  perform 1 from public.selection_package_items where org_id=p_org_id and package_id=target order by id for share;
  old_source:=public.catalog_package_source(c);
  if p_request ? 'costCents' and not(p_request->'expectedPackage' ? 'cost_cents') then raise exception 'Review current package cost before changing margin';end if;
  if not(p_request->'expectedPackage' ? 'cost_cents') then old_source:=old_source-'cost_cents';end if;
  if p_request->'expectedPackage' is distinct from old_source then raise exception 'Package changed; review its current contents before saving again';end if;
  if c.is_archived and not(p_request ? 'isArchived') and not(p_request ? 'editArchived') then raise exception 'Review archived contents before editing them';end if;
  if p_request ? 'editArchived' and (not c.is_archived or community is distinct from c.community_id) then raise exception 'Repair must preserve the original archived package scope and state';end if;
  if p_request ? 'isArchived' and (community is distinct from c.community_id or p_request->>'name' is distinct from c.name or p_request->>'description' is distinct from c.description or p_request->>'imageUrl' is distinct from c.image_url or (p_request->>'priceCents')::integer is distinct from c.price_cents or (p_request->>'isAvailable')::boolean is distinct from c.is_available or (p_request->>'sortOrder')::integer is distinct from c.sort_order or to_jsonb(ids) is distinct from old_source->'option_ids') then raise exception 'Archive or restore must preserve the reviewed package contents';end if;
  update public.selection_packages set is_archived=case when p_request ? 'isArchived' then (p_request->>'isArchived')::boolean else is_archived end,community_id=community,name=btrim(p_request->>'name'),description=p_request->>'description',image_url=p_request->>'imageUrl',
   price_cents=(p_request->>'priceCents')::integer,cost_cents=case when p_request ? 'costCents' then (p_request->>'costCents')::integer else cost_cents end,is_available=(p_request->>'isAvailable')::boolean,sort_order=(p_request->>'sortOrder')::integer,updated_at=clock_timestamp()
   where org_id=p_org_id and id=target returning * into c;
 else
  insert into public.selection_packages(org_id,community_id,name,description,image_url,price_cents,cost_cents,is_available,sort_order)
  values(p_org_id,community,btrim(p_request->>'name'),p_request->>'description',p_request->>'imageUrl',(p_request->>'priceCents')::integer,(p_request->>'costCents')::integer,(p_request->>'isAvailable')::boolean,(p_request->>'sortOrder')::integer) returning * into c;
 end if;
 if not(p_request ? 'isArchived') then
 delete from public.selection_package_items where org_id=p_org_id and package_id=c.id;
 insert into public.selection_package_items(org_id,package_id,option_id) select p_org_id,c.id,unnest(ids);
 end if;
 source:=public.catalog_package_source(c);
 insert into public.events(org_id,event_type,entity_type,entity_id,payload,channel) values(p_org_id,'option_catalog_updated','selection_package',c.id,jsonb_build_object('operation',(case when target is null then 'insert' else 'update' end)::public.audit_action,'request_key',p_key,'actor_id',p_actor_id),'activity') returning id into event_key;
 insert into public.audit_log(org_id,actor_user_id,action,entity_type,entity_id,after_data,source) values(p_org_id,p_actor_id,(case when target is null then 'insert' else 'update' end)::public.audit_action,'selection_package',c.id,source,'catalog_package_publication') returning id into audit_key;
 insert into public.catalog_package_publication_receipts(org_id,request_key,package_id,actor_id,request,package_source,audit_id,event_id,history_sequence) values(p_org_id,p_key,c.id,p_actor_id,p_request,source,audit_key,event_key,public.allocate_catalog_publication_history(p_org_id,p_actor_id,community)) returning * into receipt;
 delete from public.catalog_publication_claims where org_id=p_org_id and intent_id in(select id from public.catalog_publication_intents where org_id=p_org_id and kind='package' and request_key=p_key);
 return jsonb_build_object('orgId',p_org_id,'receiptId',receipt.id,'package',case when can_margin then source else source-'cost_cents' end,'created',true,'canReadMargin',can_margin);
end $function$
;

CREATE OR REPLACE FUNCTION public.publish_catalog_group_contents(p_org_id uuid, p_actor_id uuid, p_key uuid, p_request jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
 insert into public.events(org_id,event_type,entity_type,entity_id,payload,channel) values(p_org_id,'option_catalog_updated','selection_group',g.id,jsonb_build_object('operation',(case when target is null then 'insert' else 'update' end)::public.audit_action,'request_key',p_key,'actor_id',p_actor_id),'activity') returning id into event_key;
 insert into public.audit_log(org_id,actor_user_id,action,entity_type,entity_id,after_data,source) values(p_org_id,p_actor_id,(case when target is null then 'insert' else 'update' end)::public.audit_action,'selection_group',g.id,source,'catalog_group_publication') returning id into audit_key;
 insert into public.catalog_group_publication_receipts(org_id,request_key,group_id,actor_id,request,group_source,audit_id,event_id,history_sequence) values(p_org_id,p_key,g.id,p_actor_id,p_request,source,audit_key,event_key,public.allocate_catalog_publication_history(p_org_id,p_actor_id,community)) returning * into receipt;
 delete from public.catalog_publication_claims where org_id=p_org_id and intent_id in(select id from public.catalog_publication_intents where org_id=p_org_id and kind='group' and request_key=p_key);
 return jsonb_build_object('orgId',p_org_id,'actorId',p_actor_id,'receiptId',receipt.id,'historySequence',receipt.history_sequence::text,'group',source,'created',true);
end $function$
;

CREATE OR REPLACE FUNCTION public.reserve_warranty_courtesy_inspection(p_org_id uuid, p_coverage_id uuid, p_milestone text, p_as_of date, p_actor_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_catalog'
AS $function$
declare
 c public.project_warranty_coverage; r public.warranty_courtesy_reservations;
 req public.warranty_requests; e public.events; target public.warranty_sla_targets;
 v_due date; v_severity text; v_title text; v_event uuid; v_audit bigint;
 v_existing integer; v_number integer; v_attempt integer; v_adopted boolean:=false;
 v_now timestamptz:=clock_timestamp();
begin
 if p_org_id is null or p_coverage_id is null or p_as_of is null or p_milestone is null or p_milestone not in ('day_30','month_11') then
  raise exception 'Courtesy inspection scope and milestone are required';
 end if;
 if p_actor_id is not null then
  perform 1 from public.memberships where org_id=p_org_id and user_id=p_actor_id and status='active' order by id for update;
  if not found then raise exception 'Courtesy coordinator is no longer an active organization member' using errcode='42501'; end if;
 end if;
 select * into c from public.project_warranty_coverage where id=p_coverage_id and org_id=p_org_id for share;
 if not found then raise exception 'Warranty coverage not found in organization'; end if;
 perform 1 from public.projects where id=c.project_id and org_id=p_org_id for share;
 if not found then raise exception 'Warranty home scope is invalid'; end if;
 -- All milestone/number reservations for this home share a transaction lock.
 perform pg_advisory_xact_lock(hashtextextended('warranty-courtesy:'||p_org_id||':'||c.project_id,0));
 v_due:=case when p_milestone='day_30' then c.effective_date+30 else (c.effective_date+interval '11 months')::date end;
 select * into r from public.warranty_courtesy_reservations where org_id=p_org_id and project_id=c.project_id and milestone=p_milestone;
 if found then
  if r.coverage_id<>c.id or r.effective_date<>c.effective_date or r.due_on<>v_due then raise exception 'Courtesy coverage evidence changed; reconcile original reservation'; end if;
  select * into req from public.warranty_requests where id=r.request_id and org_id=p_org_id and project_id=c.project_id;
  if not found or req.metadata->>'courtesy_milestone' is distinct from p_milestone or req.metadata->>'courtesy_due_on' is distinct from v_due::text then
   raise exception 'Reserved courtesy request evidence changed';
  end if;
  select * into e from public.events where id=r.event_id and org_id=p_org_id and entity_type='warranty_request' and entity_id=req.id and event_type='warranty_courtesy_inspection_created';
  if not found or e.payload->>'project_id' is distinct from c.project_id::text or e.payload->>'milestone' is distinct from p_milestone or e.payload->>'due_on' is distinct from v_due::text then raise exception 'Reserved courtesy event evidence changed'; end if;
  perform 1 from public.audit_log where id=r.audit_id and org_id=p_org_id and entity_type='warranty_request' and entity_id=req.id
    and actor_user_id is not distinct from r.actor_id and source='warranty_courtesy_reservation'
    and after_data->>'coverage_id'=c.id::text and after_data->>'courtesy_milestone'=p_milestone and after_data->>'due_on'=v_due::text;
  if not found then raise exception 'Reserved courtesy audit evidence changed'; end if;
  return jsonb_build_object('reservation_id',r.id,'request_id',r.request_id,'status','existing','due_on',r.due_on);
 end if;
 if v_due<p_as_of-60 or v_due>p_as_of+14 then return jsonb_build_object('status','not_due'); end if;
 v_severity:=case when p_milestone='day_30' then 'routine_30' else 'routine_60' end;
 v_title:=case when p_milestone='day_30' then '30-day courtesy inspection' else '11-month courtesy inspection' end;
 select count(*) into v_existing from public.warranty_requests where org_id=p_org_id and project_id=c.project_id and metadata->>'courtesy_milestone'=p_milestone;
 if v_existing>1 then raise exception 'Historical courtesy requests are ambiguous; reconcile duplicates'; end if;
 if v_existing=1 then
  select * into req from public.warranty_requests where org_id=p_org_id and project_id=c.project_id and metadata->>'courtesy_milestone'=p_milestone for share;
  if req.metadata->>'courtesy_due_on' is distinct from v_due::text then raise exception 'Historical courtesy due date does not match coverage'; end if;
  v_adopted:=true;
 else
  select * into target from public.warranty_sla_targets where org_id=p_org_id and severity=v_severity;
  if found and (target.first_response_hours is null or target.first_response_hours<=0 or target.resolution_days is null or target.resolution_days<=0) then raise exception 'Invalid warranty SLA target'; end if;
  -- Non-courtesy writers still use the project number unique constraint.
  for v_attempt in 1..5 loop
   select coalesce(max(request_number),0)+1 into v_number from public.warranty_requests where project_id=c.project_id;
   begin
    insert into public.warranty_requests(org_id,project_id,request_number,title,description,status,priority,severity,category,coverage_status,source,cost_dump_flag,scheduled_date,first_response_due_at,resolution_due_at,metadata)
    values(p_org_id,c.project_id,v_number,v_title,'Scheduled courtesy inspection due '||v_due||'.','open','normal',v_severity,'Courtesy inspection','in_warranty','office',false,v_due,
      v_now+make_interval(hours=>coalesce(target.first_response_hours,case when v_severity='routine_30' then 72 else 120 end)),
      v_now+make_interval(days=>coalesce(target.resolution_days,case when v_severity='routine_30' then 30 else 60 end)),
      jsonb_build_object('courtesy_milestone',p_milestone,'courtesy_due_on',v_due)) returning * into req;
    exit;
   exception when unique_violation then
    if v_attempt=5 then raise; end if;
   end;
  end loop;
 end if;
 select count(*) into v_existing from public.events where org_id=p_org_id and entity_type='warranty_request' and entity_id=req.id and event_type='warranty_courtesy_inspection_created';
 if v_existing>1 then raise exception 'Historical courtesy events are ambiguous'; end if;
 if v_existing=1 then
  select * into e from public.events where org_id=p_org_id and entity_type='warranty_request' and entity_id=req.id and event_type='warranty_courtesy_inspection_created';
  if e.payload->>'project_id' is distinct from c.project_id::text or e.payload->>'milestone' is distinct from p_milestone or e.payload->>'due_on' is distinct from v_due::text then raise exception 'Historical courtesy event evidence differs'; end if;
  v_event:=e.id;
 else
  insert into public.events(org_id,event_type,entity_type,entity_id,payload,channel)
  values(p_org_id,'warranty_courtesy_inspection_created','warranty_request',req.id,jsonb_build_object('project_id',c.project_id,'milestone',p_milestone,'due_on',v_due)||jsonb_strip_nulls(jsonb_build_object('actor_id',p_actor_id)),'activity') returning id into v_event;
 end if;
 insert into public.audit_log(org_id,actor_user_id,action,entity_type,entity_id,after_data,source)
 values(p_org_id,p_actor_id,(case when v_adopted then 'update' else 'insert' end)::public.audit_action,'warranty_request',req.id,
  jsonb_build_object('coverage_id',c.id,'courtesy_milestone',p_milestone,'due_on',v_due,'adopted',v_adopted),'warranty_courtesy_reservation') returning id into v_audit;
 insert into public.warranty_courtesy_reservations(org_id,project_id,coverage_id,milestone,effective_date,due_on,request_id,event_id,audit_id,actor_id,origin)
 values(p_org_id,c.project_id,c.id,p_milestone,c.effective_date,v_due,req.id,v_event,v_audit,p_actor_id,case when p_actor_id is null then 'system' else 'coordinator' end) returning * into r;
 return jsonb_build_object('reservation_id',r.id,'request_id',r.request_id,'status',case when v_adopted then 'adopted' else 'created' end,'due_on',r.due_on);
end;
$function$
;
