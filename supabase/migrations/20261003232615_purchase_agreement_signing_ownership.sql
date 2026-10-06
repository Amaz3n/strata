-- STAGED / UNAPPLIED. Requires durable signing and recipient-binding migrations.
-- Legacy duplicate/unknown packets require human reconciliation; never pick a winner.
do $$ begin
 if exists(select 1 from public.documents where source_entity_type='contract' and metadata->>'purchase_agreement'='true'
   group by org_id,source_entity_id having count(*)>1) then raise exception 'Reconcile duplicate purchase agreement signing documents before ownership rollout'; end if;
end $$;
create unique index documents_purchase_agreement_owner_unique on public.documents(org_id,source_entity_id)
 where source_entity_type='contract' and metadata->>'purchase_agreement'='true';

create function public.assert_agreement_signing_actor(p_org_id uuid,p_project_id uuid,p_actor_id uuid)
returns void language plpgsql security definer set search_path=public,pg_catalog as $$
declare
 members uuid[]; org_roles uuid[]; project_roles uuid[]; platform_roles uuid[]; all_roles uuid[];
 base_permissions text[]; org_permissions text[]; project_permissions text[]; platform_permissions text[];
 grants text[]; denies text[]; effective text[]; org_effective text[];
 assigned_only boolean; division_assigned boolean; project_member boolean; home_division uuid; divisions uuid[];
begin
 if p_org_id is null or p_project_id is null or p_actor_id is null then raise exception 'Agreement signing authorization identity is required' using errcode='42501'; end if;
 -- Parent locks also fence FK-backed new memberships, project grants and role
 -- permission/override inserts. Validate actual FK/lock order in full-schema QA.
 perform 1 from public.app_users where id=p_actor_id for update;
 if not found then raise exception 'Agreement signing actor not found' using errcode='42501'; end if;
 perform 1 from public.permissions where key='sales.manage' for share;
 if not found then raise exception 'Agreement signing write permission is not registered' using errcode='42501'; end if;
 select division_id into home_division from public.projects where id=p_project_id and org_id=p_org_id for share;
 if not found then raise exception 'Agreement signing authorization home belongs to another organization or is unavailable' using errcode='42501'; end if;
 perform 1 from public.memberships where org_id=p_org_id and user_id=p_actor_id order by id for update;
 perform 1 from public.project_members where org_id=p_org_id and project_id=p_project_id and user_id=p_actor_id order by id for update;
 perform 1 from public.platform_memberships where user_id=p_actor_id order by id for update;
 select coalesce(array_agg(id),'{}'),coalesce(array_agg(distinct role_id),'{}'),coalesce(bool_or(project_scope='assigned'),false),coalesce(bool_or(division_scope='assigned'),false)
 into members,org_roles,assigned_only,division_assigned from public.memberships where org_id=p_org_id and user_id=p_actor_id and status='active';
 select coalesce(array_agg(distinct role_id),'{}'),count(*)>0 into project_roles,project_member from public.project_members where org_id=p_org_id and project_id=p_project_id and user_id=p_actor_id and status='active';
 select coalesce(array_agg(distinct role_id),'{}') into platform_roles from public.platform_memberships where user_id=p_actor_id and status='active';
 all_roles:=org_roles||project_roles||platform_roles;
 -- Permission removals are fenced by their existing-row SHARE locks. Adding
 -- another role grant cannot revoke an already-proven allow; SHARE here avoids
 -- serializing all signing work for every actor using the same role.
 perform 1 from public.roles where id=any(all_roles) order by id for share;
 perform 1 from public.role_permissions where role_id=any(all_roles) order by role_id,permission_key for share;
 perform 1 from public.membership_permission_overrides where membership_id=any(members) order by membership_id,permission_key for share;
 select coalesce(array_agg(distinct permission_key),'{}') into base_permissions from public.role_permissions where role_id=any(org_roles);
 select coalesce(array_agg(distinct permission_key),'{}') into project_permissions from public.role_permissions where role_id=any(project_roles);
 -- Evaluate expiry after waits for all locked permission facts.
 select coalesce(array_agg(distinct rp.permission_key),'{}') into platform_permissions from public.platform_memberships pm join public.role_permissions rp on rp.role_id=pm.role_id
 where pm.user_id=p_actor_id and pm.status='active' and (pm.expires_at is null or pm.expires_at>clock_timestamp());
 if '*'=any(platform_permissions) or 'platform.org.access'=any(platform_permissions) then return; end if;
 select coalesce(array_agg(permission_key) filter(where effect='grant'),'{}'),coalesce(array_agg(permission_key) filter(where effect='deny'),'{}') into grants,denies
 from public.membership_permission_overrides where membership_id=any(members);
 org_permissions:=base_permissions||grants;
 select coalesce(array_agg(distinct x),'{}') into org_effective from unnest(org_permissions||platform_permissions) x where not(x=any(denies));
 if 'sales.manage'=any(denies) or not('sales.manage'=any(org_effective) or '*'=any(org_effective)) then raise exception 'Agreement signing actor lacks organization write permission' using errcode='42501'; end if;
 if not project_member and not('*'=any(org_permissions) or 'org.admin'=any(org_permissions) or (not assigned_only and ('project.read'=any(org_permissions) or 'project.manage'=any(org_permissions)))) then
  raise exception 'Agreement signing home is outside actor assigned project access' using errcode='42501';
 end if;
 select coalesce(array_agg(distinct x),'{}') into effective from unnest(org_permissions||project_permissions||platform_permissions) x where not(x=any(denies));
 if not('sales.manage'=any(effective) or '*'=any(effective)) then raise exception 'Agreement signing actor lacks home write permission' using errcode='42501'; end if;
 if division_assigned and not('org.admin'=any(base_permissions)) then
  perform 1 from public.membership_divisions where membership_id=any(members) order by membership_id,division_id for share;
  select coalesce(array_agg(distinct division_id),'{}') into divisions from public.membership_divisions where membership_id=any(members);
  if home_division is null or not(home_division=any(divisions)) then raise exception 'Agreement signing home is outside actor division access' using errcode='42501'; end if;
 end if;
end $$;
revoke all on function public.assert_agreement_signing_actor(uuid,uuid,uuid) from public,anon,authenticated,service_role;

create function public.purchase_agreement_signing_input(p_contract public.contracts)
returns jsonb language sql immutable set search_path='' as $$
 select jsonb_build_object('id',p_contract.id,'org_id',p_contract.org_id,'project_id',p_contract.project_id,
 'title',p_contract.title,'number',p_contract.number,'terms',p_contract.terms,'snapshot',p_contract.snapshot,
 'total_cents',p_contract.total_cents,'currency',p_contract.currency,'effective_date',p_contract.effective_date,
 'buyer_contact_id',p_contract.buyer_contact_id,'co_buyer_contact_id',p_contract.co_buyer_contact_id);
$$;
revoke all on function public.purchase_agreement_signing_input(public.contracts) from public,anon,authenticated,service_role;

create function public.reserve_purchase_agreement_document(p_org_id uuid,p_contract_id uuid,p_actor_id uuid,p_expected jsonb,p_file_id uuid default null,p_recipients jsonb default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.contracts; d public.documents; home uuid; source_input jsonb; recipients jsonb; buyer jsonb; co_buyer jsonb; builder jsonb; builder_id uuid; f public.files; configuration jsonb; lot public.lots; reservation_count integer;
begin
 select project_id into home from public.contracts where id=p_contract_id and org_id=p_org_id and contract_type='purchase_agreement';
 if not found then raise exception 'Purchase agreement not found'; end if;
 perform pg_advisory_xact_lock(hashtextextended('agreement-packet:'||p_org_id::text||':'||p_contract_id::text,0));
 perform public.assert_agreement_signing_actor(p_org_id,home,p_actor_id);
 select * into c from public.contracts where id=p_contract_id and org_id=p_org_id and contract_type='purchase_agreement' for update;
 if not found or c.project_id is distinct from home or c.status is distinct from 'draft' then raise exception 'Draft purchase agreement ownership changed'; end if;
 source_input:=public.purchase_agreement_signing_input(c);
 if source_input is distinct from p_expected then raise exception 'Agreement source changed; review it before preparing signatures'; end if;
 configuration:=c.snapshot->'purchase_agreement'->'configuration';
 if jsonb_typeof(configuration) is distinct from 'object' or not(configuration ?& array['lot_id','house_plan_id','house_plan_version_id','elevation_id','swing']) then raise exception 'Saved agreement home configuration needs reconciliation'; end if;
 select * into lot from public.lots where org_id=p_org_id and id=(configuration->>'lot_id')::uuid for share;
 if not found or lot.status is null or lot.status not in ('owned','developed','assigned','started') or lot.project_id is distinct from home or lot.house_plan_id is distinct from (configuration->>'house_plan_id')::uuid
   or lot.house_plan_version_id is distinct from (configuration->>'house_plan_version_id')::uuid or lot.house_plan_elevation_id is distinct from (configuration->>'elevation_id')::uuid
   or lot.swing is distinct from configuration->>'swing' then raise exception 'Saved agreement home configuration needs reconciliation'; end if;
 perform 1 from public.lot_reservations where org_id=p_org_id and contract_id=c.id order by id for update;
 select count(*) into reservation_count from public.lot_reservations where org_id=p_org_id and contract_id=c.id;
 if reservation_count<>1 or not exists(select 1 from public.lot_reservations where org_id=p_org_id and contract_id=c.id and lot_id=lot.id and status='reserved') then
   raise exception 'Saved agreement reservation ownership needs reconciliation';
 end if;
 if c.buyer_contact_id is null or c.buyer_contact_id=c.co_buyer_contact_id then raise exception 'Agreement buyer identity is invalid'; end if;
 select * into d from public.documents where org_id=p_org_id and source_entity_type='contract' and source_entity_id=c.id and metadata->>'purchase_agreement'='true' for update;
 if found then
   if d.metadata->'agreement_signing_input' is distinct from source_input or d.project_id is distinct from home or d.status not in ('draft','sent','signed') then
     raise exception 'Existing agreement signing document requires reconciliation';
   end if;
   builder_id:=(d.metadata->'draft_recipients'->-1->>'user_id')::uuid;
 else builder_id:=p_actor_id;
 end if;
 -- Freeze the current bound identities through this transaction. Existing packets
 -- keep their original builder signer even when another authorized member resumes.
 perform 1 from public.contacts where org_id=p_org_id and id in (c.buyer_contact_id,c.co_buyer_contact_id) order by id for share;
 select jsonb_build_object('type','contact','contact_id',id,'user_id',null,'name',full_name,'email',email,'role','signer','signer_role','buyer','sequence',1,'required',true)
 into buyer from public.contacts where org_id=p_org_id and id=c.buyer_contact_id and coalesce(email,'')<>'';
 if buyer is null then raise exception 'Agreement buyer contact unavailable'; end if;
 if c.co_buyer_contact_id is not null then
   select jsonb_build_object('type','contact','contact_id',id,'user_id',null,'name',full_name,'email',email,'role','signer','signer_role','co_buyer','sequence',1,'required',true)
   into co_buyer from public.contacts where org_id=p_org_id and id=c.co_buyer_contact_id and coalesce(email,'')<>'';
   if co_buyer is null then raise exception 'Agreement co-buyer contact unavailable'; end if;
 end if;
 perform 1 from public.app_users where id=builder_id for share;
 perform 1 from public.memberships where org_id=p_org_id and user_id=builder_id and status='active' order by id for share;
 if not found then raise exception 'Agreement builder signer is not an active organization member'; end if;
 select jsonb_build_object('type','internal_user','contact_id',null,'user_id',id,'name',full_name,'email',email,'role','signer','signer_role','builder','sequence',2,'required',true)
 into builder from public.app_users where id=builder_id and coalesce(email,'')<>'';
 if builder is null then raise exception 'Agreement builder signer unavailable'; end if;
 recipients:=jsonb_build_array(buyer)||case when co_buyer is null then '[]'::jsonb else jsonb_build_array(co_buyer) end||jsonb_build_array(builder);
 if exists(select 1 from jsonb_array_elements(recipients) r where coalesce(r->>'email','') !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$') then raise exception 'Valid agreement signer emails required'; end if;
 if d.id is not null then
   select * into f from public.files where id=d.source_file_id and org_id=p_org_id and project_id=home and archived_at is null for share;
   if not found or d.metadata->'agreement_source_file' is distinct from jsonb_build_object('file_id',f.id,'sha256',f.checksum,'size_bytes',f.size_bytes,'storage_path',f.storage_path,'mime_type',f.mime_type,'source',f.source,'visibility',f.visibility,'current_version_id',f.current_version_id) then
     raise exception 'Agreement source file evidence changed; reconcile the existing packet';
   end if;
   if d.metadata->'draft_recipients' is distinct from recipients then raise exception 'Agreement signer details changed; reconcile the existing packet'; end if;
   return to_jsonb(d);
 end if;
 if p_file_id is null then return null; end if;
 if recipients is distinct from p_recipients then raise exception 'Agreement PDF recipients changed; review before preparing signatures'; end if;
 select * into f from public.files where id=p_file_id and org_id=p_org_id and project_id=home and archived_at is null for share;
 if not found or f.mime_type is distinct from 'application/pdf' or f.source is distinct from 'generated' or f.visibility is distinct from 'private' or coalesce(f.checksum,'') !~ '^[0-9a-f]{64}$' or coalesce(f.size_bytes,0)<=0 then raise exception 'Verified private agreement source file required'; end if;
 insert into public.documents(org_id,project_id,document_type,title,source_file_id,source_entity_type,source_entity_id,created_by,metadata)
 values(p_org_id,home,'contract',c.title,f.id,'contract',c.id,p_actor_id,jsonb_build_object('contract_id',c.id,'purchase_agreement',true,'agreement_signing_input',source_input,'draft_recipients',recipients,'agreement_source_file',jsonb_build_object('file_id',f.id,'sha256',f.checksum,'size_bytes',f.size_bytes,'storage_path',f.storage_path,'mime_type',f.mime_type,'source',f.source,'visibility',f.visibility,'current_version_id',f.current_version_id))) returning * into d;
 insert into public.events(org_id,event_type,entity_type,entity_id,payload,channel) values(p_org_id,'purchase_agreement_signing_prepared','contract',c.id,jsonb_build_object('document_id',d.id,'actor_id',p_actor_id),'activity');
 insert into public.audit_log(org_id,actor_user_id,action,entity_type,entity_id,after_data,source)
 values(p_org_id,p_actor_id,'insert','document',d.id,to_jsonb(d),'agreement_signing_ownership');
 return to_jsonb(d);
end $$;
revoke all on function public.reserve_purchase_agreement_document(uuid,uuid,uuid,jsonb,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.reserve_purchase_agreement_document(uuid,uuid,uuid,jsonb,uuid,jsonb) to service_role;

create function public.publish_purchase_agreement_document(p_org_id uuid,p_document_id uuid,p_actor_id uuid,p_source jsonb)
returns uuid language plpgsql security definer set search_path='' as $$
declare d public.documents; reserved jsonb; f public.files;
begin
 select * into d from public.documents where id=p_document_id and org_id=p_org_id and source_entity_type='contract' and metadata->>'purchase_agreement'='true';
 if not found then raise exception 'Owned agreement signing document not found'; end if;
 reserved:=public.reserve_purchase_agreement_document(p_org_id,d.source_entity_id,p_actor_id,d.metadata->'agreement_signing_input');
 if reserved->>'id' is distinct from d.id::text then raise exception 'Agreement signing ownership changed'; end if;
 select * into f from public.files where id=d.source_file_id and org_id=p_org_id and project_id=d.project_id and archived_at is null for share;
 if not found or f.checksum is distinct from p_source->>'sha256' or f.size_bytes::text is distinct from p_source->>'size_bytes' then raise exception 'Agreement signing source integrity changed'; end if;
 perform set_config('arc.agreement_signing_publication',d.id::text,true);
 return public.send_esign_document(p_org_id,d.id,p_actor_id,p_source,reserved->'metadata'->'draft_recipients',jsonb_build_object('contract_id',d.source_entity_id,'purchase_agreement',true),d.title,'Review and sign your new home purchase agreement.',null);
end $$;
revoke all on function public.publish_purchase_agreement_document(uuid,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.publish_purchase_agreement_document(uuid,uuid,uuid,jsonb) to service_role;

create function public.guard_agreement_signing_document() returns trigger language plpgsql set search_path='' as $$
begin
 if current_user in ('anon','authenticated') and tg_op<>'DELETE' and new.metadata ? 'agreement_signing_input'
   and (tg_op='INSERT' or not(old.metadata ? 'agreement_signing_input')) then
   raise exception 'Agreement signing ownership requires its trusted reservation transaction';
 end if;
 if old.metadata ? 'agreement_signing_input' then
   if tg_op='DELETE' then raise exception 'Agreement signing ownership is retained'; end if;
   if new.id is distinct from old.id or new.org_id is distinct from old.org_id or new.project_id is distinct from old.project_id or new.source_entity_id is distinct from old.source_entity_id
     or new.source_entity_type is distinct from old.source_entity_type or new.source_file_id is distinct from old.source_file_id or new.title is distinct from old.title
     or new.current_revision is distinct from old.current_revision or new.created_by is distinct from old.created_by
     or new.metadata->'agreement_signing_input' is distinct from old.metadata->'agreement_signing_input'
     or new.metadata->'agreement_source_file' is distinct from old.metadata->'agreement_source_file'
     or new.metadata->'draft_recipients' is distinct from old.metadata->'draft_recipients' or new.metadata->>'purchase_agreement' is distinct from old.metadata->>'purchase_agreement' then
     raise exception 'Agreement signing source and ownership are immutable';
   end if;
 end if;
 if tg_op='DELETE' then return old; end if; return new;
end $$;
create trigger agreement_signing_document_ownership before insert or update or delete on public.documents for each row execute function public.guard_agreement_signing_document();
