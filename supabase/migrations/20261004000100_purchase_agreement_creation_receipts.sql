-- STAGED / UNAPPLIED. Requires open-home ownership and agreement signing ownership.
-- Requires 20261004000030_agreement_catalog_revisions.sql.
-- Activation requires 20261004011501_agreement_incentive_capacity.sql, atomic catalog publication and full-schema QA.
create table public.purchase_agreement_creation_receipts (
 id uuid primary key default gen_random_uuid(),
 org_id uuid not null references public.orgs(id),
 project_id uuid not null references public.projects(id),
 lot_id uuid not null references public.lots(id),
 reservation_id uuid not null references public.lot_reservations(id),
 contract_id uuid not null references public.contracts(id),
 actor_id uuid not null references public.app_users(id),
 request jsonb not null,
 contract_source jsonb not null,
 event_id uuid not null references public.events(id),
 audit_id bigint not null references public.audit_log(id),
 created_at timestamptz not null default now(),
 unique(org_id,reservation_id), unique(contract_id)
);
create index agreement_creation_receipt_project_idx on public.purchase_agreement_creation_receipts(project_id);
create index agreement_creation_receipt_lot_idx on public.purchase_agreement_creation_receipts(lot_id);
create index agreement_creation_receipt_actor_idx on public.purchase_agreement_creation_receipts(actor_id);
create index agreement_creation_receipt_event_idx on public.purchase_agreement_creation_receipts(event_id);
create index agreement_creation_receipt_audit_idx on public.purchase_agreement_creation_receipts(audit_id);
alter table public.purchase_agreement_creation_receipts enable row level security;
revoke all on public.purchase_agreement_creation_receipts from public,anon,authenticated;
grant select,insert on public.purchase_agreement_creation_receipts to service_role;
create function public.guard_agreement_creation_receipt() returns trigger
language plpgsql set search_path='' as $$
begin raise exception 'Purchase agreement creation receipt is immutable'; end $$;
create trigger purchase_agreement_creation_receipt_immutable before update or delete on public.purchase_agreement_creation_receipts
 for each row execute function public.guard_agreement_creation_receipt();

create function public.create_purchase_agreement_atomic(p_org_id uuid,p_reservation_id uuid,p_actor_id uuid,p_request jsonb,p_expected jsonb default null,p_snapshot jsonb default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
 receipt public.purchase_agreement_creation_receipts; r public.lot_reservations; l public.lots; c public.contracts;
 home uuid; lot_key uuid; configuration jsonb; pricing jsonb; expected jsonb;
 version public.house_plan_versions; plan public.house_plans; elevation public.house_plan_elevations;
 offer public.community_plan_availability; event_key uuid; audit_key bigint; contract_key uuid:=gen_random_uuid();
 offer_date date:=(clock_timestamp() at time zone 'UTC')::date; total bigint; effective date;
begin
 if p_org_id is null or p_reservation_id is null or p_actor_id is null or jsonb_typeof(p_request) is distinct from 'object'
   or p_request->>'reservationId' is distinct from p_reservation_id::text or coalesce(p_request->>'expectedQuoteHash','') !~ '^[a-f0-9]{64}$' then
   raise exception 'Valid purchase agreement creation identity and reviewed request required';
 end if;
 perform pg_advisory_xact_lock(hashtextextended('agreement-create:'||p_org_id::text||':'||p_reservation_id::text,0));
 select * into receipt from public.purchase_agreement_creation_receipts where org_id=p_org_id and reservation_id=p_reservation_id;
 if found then
   perform public.assert_agreement_signing_actor(p_org_id,receipt.project_id,p_actor_id);
   perform 1 from public.projects where org_id=p_org_id and id=receipt.project_id and property_type='production' for share;
   if not found then raise exception 'Purchase agreement creation requires an actual production home'; end if;
   if receipt.request is distinct from p_request then raise exception 'The reservation already has a creation receipt for different reviewed inputs; reconcile its agreement'; end if;
   select * into c from public.contracts where org_id=p_org_id and id=receipt.contract_id;
   if not found or public.purchase_agreement_signing_input(c) is distinct from receipt.contract_source then
     raise exception 'The receipted agreement source changed; reconcile it before resuming';
   end if;
   return jsonb_build_object('receipt_id',receipt.id,'created',false,'contract',to_jsonb(c));
 end if;
 select l0.project_id,l0.id into home,lot_key from public.lot_reservations r0 join public.lots l0 on l0.id=r0.lot_id and l0.org_id=r0.org_id
 where r0.org_id=p_org_id and r0.id=p_reservation_id;
 if not found or home is null then raise exception 'Reserved lot with an actual home is required'; end if;
 perform public.assert_agreement_signing_actor(p_org_id,home,p_actor_id);
 perform 1 from public.projects where org_id=p_org_id and id=home and property_type='production' for share;
 if not found then raise exception 'Purchase agreement creation requires an actual production home'; end if;
 if p_snapshot is null then return null; end if; -- Read-only receipt probe.
 -- Lock referenced keys before the revision fence. FK checks during the lot
 -- update must not wait on a catalog deletion holding a row -> revision lock.
 perform 1 from public.orgs where id=p_org_id for key share;
 perform 1 from public.house_plans where org_id=p_org_id and id=(p_snapshot->'purchase_agreement'->'configuration'->>'house_plan_id')::uuid for key share;
 perform 1 from public.house_plan_versions where org_id=p_org_id and id=(p_snapshot->'purchase_agreement'->'configuration'->>'house_plan_version_id')::uuid for key share;
 perform 1 from public.house_plan_elevations where org_id=p_org_id and id=(p_snapshot->'purchase_agreement'->'configuration'->>'elevation_id')::uuid for key share;
 -- Capacity locks precede the revision lock, matching incentive policy writers.
 perform public.lock_agreement_incentive_capacity(p_org_id,p_request->'incentiveIds');
 perform public.assert_agreement_catalog_revision(p_org_id,p_expected->>'catalog_revision');
 if p_snapshot->'purchase_agreement'->'pricing'->>'catalogRevision' is distinct from p_expected->>'catalog_revision' then raise exception 'Quote catalog revision does not match commit evidence'; end if;
 select * into l from public.lots where org_id=p_org_id and id=lot_key for update;
 select * into r from public.lot_reservations where org_id=p_org_id and id=p_reservation_id for update;
 if l.id is null or r.id is null or l.project_id is distinct from home or r.lot_id is distinct from l.id or r.community_id is distinct from l.community_id
   or r.status is distinct from 'reserved' or r.contract_id is not null or l.status not in ('owned','developed','assigned','started')
   or p_request->>'lotId' is distinct from l.id::text then raise exception 'Reservation or actual-home ownership changed; no agreement was created'; end if;
 expected:=jsonb_build_object('reservation',jsonb_build_object('id',r.id,'org_id',r.org_id,'community_id',r.community_id,'lot_id',r.lot_id,
   'status',r.status,'contract_id',r.contract_id,'buyer_contact_id',r.buyer_contact_id,'co_buyer_contact_id',r.co_buyer_contact_id,'deposit_invoice_id',r.deposit_invoice_id),
   'lot',jsonb_build_object('id',l.id,'org_id',l.org_id,'community_id',l.community_id,'project_id',l.project_id,'status',l.status,'premium_cents',l.premium_cents,
   'house_plan_id',l.house_plan_id,'house_plan_version_id',l.house_plan_version_id,'house_plan_elevation_id',l.house_plan_elevation_id,'swing',l.swing),'catalog_revision',p_expected->>'catalog_revision');
 if expected is distinct from p_expected then raise exception 'Reservation or lot facts changed; review the sale again'; end if;
 if exists(select 1 from public.contracts where org_id=p_org_id and project_id=home and contract_type='purchase_agreement' and status in ('draft','active')) then
   raise exception 'This home already has an open purchase agreement; reconcile it';
 end if;
 if r.buyer_contact_id is null or r.buyer_contact_id=r.co_buyer_contact_id then raise exception 'Valid agreement buyer identity required'; end if;
 perform 1 from public.contacts where org_id=p_org_id and id=r.buyer_contact_id for share;
 if not found then raise exception 'Agreement buyer belongs to another organization or is unavailable'; end if;
 if r.co_buyer_contact_id is not null then
   perform 1 from public.contacts where org_id=p_org_id and id=r.co_buyer_contact_id for share;
   if not found then raise exception 'Agreement co-buyer belongs to another organization or is unavailable'; end if;
 end if;
 configuration:=p_snapshot->'purchase_agreement'->'configuration'; pricing:=p_snapshot->'purchase_agreement'->'pricing';
 if jsonb_typeof(configuration) is distinct from 'object' or jsonb_typeof(pricing) is distinct from 'object'
   or not(configuration ?& array['lot_id','house_plan_id','house_plan_version_id','elevation_id','swing','option_items'])
   or jsonb_typeof(configuration->'option_items') is distinct from 'array' or jsonb_typeof(p_request->'incentiveIds') is distinct from 'array'
   or configuration->>'lot_id' is distinct from l.id::text or coalesce(configuration->>'swing','') not in ('left','right')
   or pricing->>'quoteHash' is distinct from p_request->>'expectedQuoteHash'
   or configuration->'option_items' is distinct from p_request->'optionItems'
   or p_snapshot->'purchase_agreement'->'incentive_ids' is distinct from p_request->'incentiveIds'
   or jsonb_array_length(configuration->'option_items')>200 or jsonb_array_length(p_request->'incentiveIds')>50
   or p_snapshot->'purchase_agreement'->'deposits' is distinct from (case when r.deposit_invoice_id is null then '[]'::jsonb else jsonb_build_array(jsonb_build_object('invoice_id',r.deposit_invoice_id,'kind','earnest_deposit')) end) then raise exception 'Reviewed agreement configuration and quote required'; end if;
 if pricing->>'lotId' is distinct from l.id::text or pricing->>'communityId' is distinct from l.community_id::text
   or pricing->>'housePlanId' is distinct from configuration->>'house_plan_id' or pricing->>'housePlanVersionId' is distinct from configuration->>'house_plan_version_id'
   or pricing->>'elevationId' is distinct from configuration->>'elevation_id' or pricing->>'swing' is distinct from configuration->>'swing'
   or (p_request ? 'housePlanVersionId' and p_request->>'housePlanVersionId' is distinct from configuration->>'house_plan_version_id')
   or (p_request ? 'elevationId' and p_request->>'elevationId' is distinct from configuration->>'elevation_id')
   or (p_request ? 'swing' and p_request->>'swing' is distinct from configuration->>'swing') then raise exception 'Reviewed quote and configuration identities do not match'; end if;
 if coalesce(pricing->>'totalCents','') !~ '^[0-9]+$' then raise exception 'Agreement total must be integer cents'; end if;
 total:=(pricing->>'totalCents')::bigint;
 if total>9007199254740991 then raise exception 'Agreement total exceeds supported integer cents'; end if;
 select * into version from public.house_plan_versions where org_id=p_org_id and id=(configuration->>'house_plan_version_id')::uuid;
 if not found or version.status is distinct from 'released' or version.house_plan_id is distinct from (configuration->>'house_plan_id')::uuid then raise exception 'Released plan version ancestry changed'; end if;
 select * into plan from public.house_plans where org_id=p_org_id and id=version.house_plan_id;
 if not found or plan.status is distinct from 'active' then raise exception 'Agreement plan is no longer active'; end if;
 if l.house_plan_id is not null and l.house_plan_id<>plan.id or l.house_plan_version_id is not null and l.house_plan_version_id<>version.id
   or l.house_plan_elevation_id is not null and l.house_plan_elevation_id is distinct from (configuration->>'elevation_id')::uuid
   or l.swing<>'either' and l.swing<>configuration->>'swing' then raise exception 'Pinned home configuration changed'; end if;
 if configuration->>'elevation_id' is not null then
   select * into elevation from public.house_plan_elevations where org_id=p_org_id and id=(configuration->>'elevation_id')::uuid;
   if not found or elevation.house_plan_id<>plan.id or elevation.is_active is distinct from true then raise exception 'Active elevation ancestry changed'; end if;
 end if;
 offer_date:=(clock_timestamp() at time zone 'UTC')::date;
 select * into offer from public.community_plan_availability where org_id=p_org_id and community_id=l.community_id and house_plan_id=plan.id
   and elevation_id is not distinct from (configuration->>'elevation_id')::uuid and is_available
   and (effective_start is null or effective_start<=offer_date) and (effective_end is null or effective_end>=offer_date);
 if not found or offer.base_price_cents is distinct from (pricing->>'basePriceCents')::bigint
   or l.premium_cents is distinct from (pricing->>'lotPremiumCents')::bigint then raise exception 'Community base price or lot premium changed; review the quote again' using detail='AGREEMENT_QUOTE_CHANGED'; end if;
 effective:=coalesce((p_request->>'effectiveDate')::date,offer_date);
 if length(coalesce(p_request->>'terms',''))>20000 then raise exception 'Agreement terms exceed supported length'; end if;
 insert into public.contracts(id,org_id,project_id,number,title,status,contract_type,total_cents,currency,terms,effective_date,snapshot,buyer_contact_id,co_buyer_contact_id)
 values(contract_key,p_org_id,home,'PA-'||extract(year from offer_date)::text||'-'||left(replace(contract_key::text,'-',''),12),
   'Purchase Agreement — Lot '||l.lot_number,'draft','purchase_agreement',total,'usd',p_request->>'terms',effective,p_snapshot,r.buyer_contact_id,r.co_buyer_contact_id) returning * into c;
 update public.lot_reservations set contract_id=c.id where id=r.id and org_id=p_org_id;
 update public.lots set house_plan_id=plan.id,house_plan_version_id=version.id,house_plan_elevation_id=(configuration->>'elevation_id')::uuid,swing=configuration->>'swing'
 where id=l.id and org_id=p_org_id;
 insert into public.events(org_id,event_type,entity_type,entity_id,payload,channel)
 values(p_org_id,'purchase_agreement_created','contract',c.id,jsonb_build_object('project_id',home,'total_cents',total,'reservation_id',r.id,'actor_id',p_actor_id),'activity') returning id into event_key;
 insert into public.audit_log(org_id,actor_user_id,action,entity_type,entity_id,after_data,source)
 values(p_org_id,p_actor_id,'insert','contract',c.id,to_jsonb(c),'purchase_agreement_creation') returning id into audit_key;
 insert into public.purchase_agreement_creation_receipts(org_id,project_id,lot_id,reservation_id,contract_id,actor_id,request,contract_source,event_id,audit_id)
 values(p_org_id,home,l.id,r.id,c.id,p_actor_id,p_request,public.purchase_agreement_signing_input(c),event_key,audit_key) returning * into receipt;
 return jsonb_build_object('receipt_id',receipt.id,'created',true,'contract',to_jsonb(c));
end $$;
revoke all on function public.create_purchase_agreement_atomic(uuid,uuid,uuid,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.create_purchase_agreement_atomic(uuid,uuid,uuid,jsonb,jsonb,jsonb) to service_role;
