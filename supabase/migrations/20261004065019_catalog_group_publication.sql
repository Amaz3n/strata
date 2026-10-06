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
