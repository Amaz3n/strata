-- STAGED / UNAPPLIED. Requires catalog revisions and package publication actor helper.
create index catalog_price_plan_columns_idx on public.house_plans(org_id,lower(name),id) where status='active';
create index catalog_price_released_versions_idx on public.house_plan_versions(org_id,house_plan_id,version_number desc,id) where status='released';
create function public.catalog_price_source(p_price public.selection_catalog_prices) returns jsonb language sql set search_path='' as $$
 select jsonb_build_object('id',p_price.id,'option_id',p_price.option_id,'package_id',p_price.package_id,'house_plan_version_id',p_price.house_plan_version_id,'community_id',p_price.community_id,'price_cents',p_price.price_cents,'cost_cents',p_price.cost_cents,'is_available',p_price.is_available);
$$;
revoke all on function public.catalog_price_source(public.selection_catalog_prices) from public,anon,authenticated,service_role;
create table public.catalog_price_publication_receipts(
 id uuid primary key default gen_random_uuid(),org_id uuid not null references public.orgs(id),request_key uuid not null,
 actor_id uuid not null references public.app_users(id),request jsonb not null,prices jsonb not null,
 event_id uuid not null references public.events(id),audit_id bigint not null references public.audit_log(id),history_sequence bigint not null check(history_sequence>0),created_at timestamptz not null default now(),unique(org_id,request_key)
);
create index catalog_price_publication_actor_idx on public.catalog_price_publication_receipts(actor_id);
create index catalog_price_publication_event_idx on public.catalog_price_publication_receipts(event_id);
create index catalog_price_publication_audit_idx on public.catalog_price_publication_receipts(audit_id);
alter table public.catalog_price_publication_receipts enable row level security;
revoke all on public.catalog_price_publication_receipts from public,anon,authenticated,service_role;
grant select on public.catalog_price_publication_receipts to service_role;
create trigger catalog_price_publication_receipt_immutable before update or delete on public.catalog_price_publication_receipts for each row execute function public.guard_catalog_package_publication_receipt();

create function public.publish_catalog_prices_contents(p_org_id uuid,p_actor_id uuid,p_key uuid,p_request jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare community uuid; item jsonb; c public.selection_catalog_prices; receipt public.catalog_price_publication_receipts;
 subject uuid; version_id uuid; plan_id uuid; expected jsonb; saved jsonb:='[]'; exposed jsonb; event_key uuid; audit_key bigint; can_margin boolean:=false;
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
 if jsonb_typeof(p_request->'items') is distinct from 'array' or jsonb_array_length(p_request->'items') not between 1 and 500 then raise exception 'Price publication must contain 1 to 500 reviewed cells';end if;
 if (select count(distinct coalesce(x->>'optionId',x->>'packageId')||':'||(x->>'housePlanVersionId')) from jsonb_array_elements(p_request->'items') x)<>jsonb_array_length(p_request->'items') then raise exception 'Duplicate or incomplete price address';end if;
 for item in select x from jsonb_array_elements(p_request->'items') x order by coalesce(x->>'optionId',x->>'packageId'),x->>'housePlanVersionId' loop
  if jsonb_typeof(item) is distinct from 'object' or num_nonnulls(item->>'optionId',item->>'packageId')<>1 or not(item ? 'expectedPrice')
    or jsonb_typeof(item->'priceCents') is distinct from 'number' or coalesce(item->>'priceCents','') !~ '^[0-9]+$'
    or jsonb_typeof(item->'isAvailable') is distinct from 'boolean'
    or item ? 'costCents' and item->>'costCents' is not null and (jsonb_typeof(item->'costCents')<>'number' or item->>'costCents' !~ '^[0-9]+$') then raise exception 'Valid reviewed price cell required';end if;
  if item ? 'costCents' and not can_margin then raise exception 'Margin permission required to change catalog costs' using errcode='42501';end if;
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
revoke all on function public.publish_catalog_prices_contents(uuid,uuid,uuid,jsonb) from public,anon,authenticated,service_role;

create function public.read_catalog_price_matrix(p_org_id uuid,p_actor_id uuid,p_community_id uuid,p_option_ids uuid[],p_page integer default 1,p_latest_only boolean default true) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb; can_margin boolean:=false;
begin
 if p_latest_only is null or p_page is null or p_page not between 1 and 10000 or p_option_ids is null or cardinality(p_option_ids)>20 then raise exception 'Bounded pricing window required';end if;
 perform public.assert_catalog_publication_actor(p_org_id,p_actor_id,p_community_id,'selections.read');
 begin perform public.assert_catalog_publication_actor(p_org_id,p_actor_id,p_community_id,'financials.margin.read');can_margin:=true;exception when insufficient_privilege then can_margin:=false;end;
 if (select count(*) from public.selection_options where org_id=p_org_id and id=any(p_option_ids) and not is_archived and (community_id is null or community_id=p_community_id))<>cardinality(p_option_ids) then raise exception 'Pricing options are outside the current catalog scope';end if;
 with page as materialized(select p.id plan_id,p.name plan_name,v.id version_id,coalesce(v.label,'v'||v.version_number::text) version_label,v.version_number from public.house_plans p join public.house_plan_versions v on v.org_id=p.org_id and v.house_plan_id=p.id where p.org_id=p_org_id and p.status='active' and v.status='released'
  and (not p_latest_only or not exists(select 1 from public.house_plan_versions newer where newer.org_id=v.org_id and newer.house_plan_id=v.house_plan_id and newer.status='released' and (newer.version_number>v.version_number or newer.version_number=v.version_number and newer.id<v.id)))
  order by lower(p.name),p.id,v.version_number desc,v.id offset ((p_page-1)*20) limit 21),
 columns as materialized(select * from page order by lower(plan_name),plan_id,version_number desc,version_id limit 20),
 effective as (select distinct on(option_id,house_plan_version_id) * from public.selection_catalog_prices where org_id=p_org_id and option_id=any(p_option_ids) and house_plan_version_id in(select version_id from columns) and (community_id is null or community_id=p_community_id) order by option_id,house_plan_version_id,(community_id is not null) desc)
 select jsonb_build_object('orgId',p_org_id,'plans',coalesce((select jsonb_agg(jsonb_build_object('planId',plan_id,'planName',plan_name,'versionId',version_id,'versionLabel',version_label) order by lower(plan_name),plan_id,version_number desc,version_id) from columns),'[]'),
 'cells',coalesce((select jsonb_object_agg(option_id::text||':'||house_plan_version_id::text,jsonb_build_object('priceCents',price_cents,'isAvailable',is_available,'isOverride',true,'ownPrice',case when community_id is not distinct from p_community_id then jsonb_build_object('id',id,'price_cents',price_cents,'is_available',is_available) else 'null'::jsonb end)||case when can_margin then jsonb_build_object('costCents',cost_cents) else '{}' end) from effective),'{}'),
 'planPage',p_page,'hasMorePlans',(select count(*)>20 from page),'canReadMargin',can_margin) into result;
 return result;
end $$;
revoke all on function public.read_catalog_price_matrix(uuid,uuid,uuid,uuid[],integer,boolean) from public,anon,authenticated;
grant execute on function public.read_catalog_price_matrix(uuid,uuid,uuid,uuid[],integer,boolean) to service_role;
