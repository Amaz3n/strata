-- STAGED / UNAPPLIED. Atomic package publication foundation; other catalog
-- publication workflows and direct writer cutover still require verification.
create function public.assert_catalog_publication_actor(p_org_id uuid,p_actor_id uuid,p_community_id uuid,p_permission text default 'selections.catalog.manage') returns void
language plpgsql security definer set search_path='' as $$
declare members uuid[]; org_roles uuid[]; platform_roles uuid[]; all_roles uuid[]; base_permissions text[]; platform_permissions text[];
 grants text[]; denies text[]; effective text[]; assigned boolean; community_division uuid; divisions uuid[];
begin
 if p_permission not in ('selections.catalog.manage','selections.read','financials.margin.read') or p_permission is null then raise exception 'Invalid catalog permission';end if;
 if p_org_id is null or p_actor_id is null then raise exception 'Catalog publication authorization required' using errcode='42501';end if;
 perform 1 from public.app_users where id=p_actor_id for update;
 if not found then raise exception 'Catalog publication actor is unavailable' using errcode='42501';end if;
 perform 1 from public.permissions where key=p_permission for share;
 if not found then raise exception 'Catalog management permission is not registered' using errcode='42501';end if;
 if p_community_id is not null then
  select division_id into community_division from public.communities where id=p_community_id and org_id=p_org_id for share;
  if not found then raise exception 'Catalog community belongs to another organization or is unavailable' using errcode='42501';end if;
 end if;
 perform 1 from public.memberships where org_id=p_org_id and user_id=p_actor_id order by id for update;
 perform 1 from public.platform_memberships where user_id=p_actor_id order by id for update;
 select coalesce(array_agg(id),'{}'),coalesce(array_agg(distinct role_id),'{}'),coalesce(bool_or(division_scope='assigned'),false)
 into members,org_roles,assigned from public.memberships where org_id=p_org_id and user_id=p_actor_id and status='active';
 select coalesce(array_agg(distinct role_id),'{}') into platform_roles from public.platform_memberships where user_id=p_actor_id and status='active';
 all_roles:=org_roles||platform_roles;
 perform 1 from public.roles where id=any(all_roles) order by id for share;
 perform 1 from public.role_permissions where role_id=any(all_roles) order by role_id,permission_key for share;
 perform 1 from public.membership_permission_overrides where membership_id=any(members) order by membership_id,permission_key for share;
 select coalesce(array_agg(distinct permission_key),'{}') into base_permissions from public.role_permissions where role_id=any(org_roles);
 select coalesce(array_agg(distinct rp.permission_key),'{}') into platform_permissions from public.platform_memberships pm join public.role_permissions rp on rp.role_id=pm.role_id
 where pm.user_id=p_actor_id and pm.status='active' and (pm.expires_at is null or pm.expires_at>clock_timestamp());
 if '*'=any(platform_permissions) or 'platform.org.access'=any(platform_permissions) then return;end if;
 select coalesce(array_agg(permission_key) filter(where effect='grant'),'{}'),coalesce(array_agg(permission_key) filter(where effect='deny'),'{}') into grants,denies
 from public.membership_permission_overrides where membership_id=any(members);
 select coalesce(array_agg(distinct x),'{}') into effective from unnest(base_permissions||grants||platform_permissions) x where not(x=any(denies));
 if p_permission=any(denies) or not(p_permission=any(effective) or '*'=any(effective)) then raise exception 'Catalog actor lacks organization management permission' using errcode='42501';end if;
 if assigned and not('org.admin'=any(base_permissions)) and (p_permission='selections.catalog.manage' or p_community_id is not null) then
  perform 1 from public.membership_divisions where membership_id=any(members) order by membership_id,division_id for share;
  select coalesce(array_agg(distinct division_id),'{}') into divisions from public.membership_divisions where membership_id=any(members);
  if p_community_id is null or community_division is null or not(community_division=any(divisions)) then raise exception 'Catalog publication is outside actor division access' using errcode='42501';end if;
 end if;
end $$;
revoke all on function public.assert_catalog_publication_actor(uuid,uuid,uuid,text) from public,anon,authenticated,service_role;

create function public.catalog_package_source(p_package public.selection_packages) returns jsonb
language sql set search_path='' as $$
 select jsonb_build_object('id',p_package.id,'community_id',p_package.community_id,'name',p_package.name,'description',p_package.description,'image_url',p_package.image_url,
  'price_cents',p_package.price_cents,'cost_cents',p_package.cost_cents,'is_available',p_package.is_available,'is_archived',p_package.is_archived,'sort_order',p_package.sort_order,
  'option_ids',coalesce((select jsonb_agg(option_id order by option_id) from public.selection_package_items where org_id=p_package.org_id and package_id=p_package.id),'[]'));
$$;
revoke all on function public.catalog_package_source(public.selection_packages) from public,anon,authenticated,service_role;
-- A transactional counter per actor/scope orders outcomes by commit and avoids
-- exposing global cross-tenant activity through sequence gaps.
create table public.catalog_publication_history_heads(
 org_id uuid not null references public.orgs(id),actor_id uuid not null references public.app_users(id),scope_key text not null,
 last_sequence bigint not null check(last_sequence>0),updated_at timestamptz not null default now(),primary key(org_id,actor_id,scope_key)
);
create index catalog_history_head_actor_idx on public.catalog_publication_history_heads(actor_id);
alter table public.catalog_publication_history_heads enable row level security;
revoke all on public.catalog_publication_history_heads from public,anon,authenticated,service_role;
create function public.allocate_catalog_publication_history(p_org_id uuid,p_actor_id uuid,p_community_id uuid) returns bigint
language plpgsql security definer set search_path='' as $$
declare allocated bigint;
begin
 insert into public.catalog_publication_history_heads(org_id,actor_id,scope_key,last_sequence) values(p_org_id,p_actor_id,coalesce(p_community_id::text,'org'),1)
 on conflict(org_id,actor_id,scope_key) do update set last_sequence=public.catalog_publication_history_heads.last_sequence+1,updated_at=now() returning last_sequence into allocated;
 return allocated;
end $$;
revoke all on function public.allocate_catalog_publication_history(uuid,uuid,uuid) from public,anon,authenticated,service_role;
create table public.catalog_package_publication_receipts(
 id uuid primary key default gen_random_uuid(),org_id uuid not null references public.orgs(id),request_key uuid not null,
 package_id uuid not null references public.selection_packages(id),actor_id uuid not null references public.app_users(id),request jsonb not null,
 package_source jsonb not null,audit_id bigint not null references public.audit_log(id),event_id uuid not null references public.events(id),
 history_sequence bigint not null check(history_sequence>0),created_at timestamptz not null default now(),unique(org_id,request_key)
);
create index catalog_package_publication_package_idx on public.catalog_package_publication_receipts(package_id);
create index catalog_package_publication_actor_idx on public.catalog_package_publication_receipts(actor_id);
create index catalog_package_publication_audit_idx on public.catalog_package_publication_receipts(audit_id);
create index catalog_package_publication_event_idx on public.catalog_package_publication_receipts(event_id);
alter table public.catalog_package_publication_receipts enable row level security;
revoke all on public.catalog_package_publication_receipts from public,anon,authenticated,service_role;
grant select on public.catalog_package_publication_receipts to service_role;
create function public.guard_catalog_package_publication_receipt() returns trigger language plpgsql set search_path='' as $$begin raise exception 'Catalog publication receipt is immutable';end $$;
revoke all on function public.guard_catalog_package_publication_receipt() from public,anon,authenticated,service_role;
create trigger catalog_package_publication_receipt_immutable before update or delete on public.catalog_package_publication_receipts for each row execute function public.guard_catalog_package_publication_receipt();


-- Private immutable tombstones share each publisher's request lock. A cancelled
-- key can never be reused, even with changed inputs or by another actor.
create table public.catalog_publication_cancellations(
 id uuid primary key default gen_random_uuid(),org_id uuid not null references public.orgs(id),kind text not null check(kind in ('package','prices')),
 request_key uuid not null,actor_id uuid not null references public.app_users(id),request jsonb not null check(jsonb_typeof(request)='object'),
 reason text not null check(length(btrim(reason)) between 10 and 1000),audit_id bigint not null references public.audit_log(id),event_id uuid not null references public.events(id),
 history_sequence bigint not null check(history_sequence>0),created_at timestamptz not null default now(),unique(org_id,kind,request_key)
);
create index catalog_cancellation_actor_idx on public.catalog_publication_cancellations(actor_id);
create index catalog_cancellation_audit_idx on public.catalog_publication_cancellations(audit_id);
create index catalog_cancellation_event_idx on public.catalog_publication_cancellations(event_id);
alter table public.catalog_publication_cancellations enable row level security;
revoke all on public.catalog_publication_cancellations from public,anon,authenticated,service_role;
grant select on public.catalog_publication_cancellations to service_role;
create trigger catalog_publication_cancellation_immutable before update or delete on public.catalog_publication_cancellations for each row execute function public.guard_catalog_package_publication_receipt();

-- Immutable intent plus a bounded active pointer: one unresolved request per
-- actor/kind/scope. Closing a pointer never deletes the original evidence.
create table public.catalog_publication_intents(
 id uuid primary key default gen_random_uuid(),org_id uuid not null references public.orgs(id),actor_id uuid not null references public.app_users(id),
 kind text not null check(kind in ('package','prices')),request_key uuid not null,request jsonb not null check(jsonb_typeof(request)='object'),review_labels jsonb not null check(jsonb_typeof(review_labels)='object'),
 history_sequence bigint not null check(history_sequence>0),audit_id bigint not null references public.audit_log(id),event_id uuid not null references public.events(id),
 created_at timestamptz not null default now(),unique(org_id,kind,request_key),unique(org_id,actor_id,kind,id)
);
create index catalog_intent_actor_idx on public.catalog_publication_intents(actor_id);
create index catalog_intent_audit_idx on public.catalog_publication_intents(audit_id);
create index catalog_intent_event_idx on public.catalog_publication_intents(event_id);
alter table public.catalog_publication_intents enable row level security;
revoke all on public.catalog_publication_intents from public,anon,authenticated,service_role;
grant select on public.catalog_publication_intents to service_role;
create trigger catalog_publication_intent_immutable before update or delete on public.catalog_publication_intents for each row execute function public.guard_catalog_package_publication_receipt();
create table public.catalog_publication_claims(
 org_id uuid not null,actor_id uuid not null,kind text not null,scope_key text not null,intent_id uuid not null,
 primary key(org_id,actor_id,kind,scope_key),foreign key(org_id,actor_id,kind,intent_id) references public.catalog_publication_intents(org_id,actor_id,kind,id)
);
create index catalog_claim_intent_idx on public.catalog_publication_claims(org_id,actor_id,kind,intent_id);
alter table public.catalog_publication_claims enable row level security;
revoke all on public.catalog_publication_claims from public,anon,authenticated,service_role;

create function public.publish_catalog_package_contents(p_org_id uuid,p_actor_id uuid,p_key uuid,p_request jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare c public.selection_packages; receipt public.catalog_package_publication_receipts; target uuid; community uuid; ids uuid[]; source jsonb; old_source jsonb; audit_key bigint; event_key uuid; option_count integer; category_count integer; can_margin boolean:=false;
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
 insert into public.events(org_id,event_type,entity_type,entity_id,payload,channel) values(p_org_id,'option_catalog_updated','selection_package',c.id,jsonb_build_object('operation',case when target is null then 'insert' else 'update' end,'request_key',p_key,'actor_id',p_actor_id),'activity') returning id into event_key;
 insert into public.audit_log(org_id,actor_user_id,action,entity_type,entity_id,after_data,source) values(p_org_id,p_actor_id,case when target is null then 'insert' else 'update' end,'selection_package',c.id,source,'catalog_package_publication') returning id into audit_key;
 insert into public.catalog_package_publication_receipts(org_id,request_key,package_id,actor_id,request,package_source,audit_id,event_id,history_sequence) values(p_org_id,p_key,c.id,p_actor_id,p_request,source,audit_key,event_key,public.allocate_catalog_publication_history(p_org_id,p_actor_id,community)) returning * into receipt;
 delete from public.catalog_publication_claims where org_id=p_org_id and intent_id in(select id from public.catalog_publication_intents where org_id=p_org_id and kind='package' and request_key=p_key);
 return jsonb_build_object('orgId',p_org_id,'receiptId',receipt.id,'package',case when can_margin then source else source-'cost_cents' end,'created',true,'canReadMargin',can_margin);
end $$;
revoke all on function public.publish_catalog_package_contents(uuid,uuid,uuid,jsonb) from public,anon,authenticated,service_role;
