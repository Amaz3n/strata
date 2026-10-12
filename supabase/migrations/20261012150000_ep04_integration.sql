-- EP04 integration: the pieces the land and spec-disposition workstreams left
-- for one another.
--
-- 1. Search: land contracts are indexed (lib/services/search-index.ts) and
--    carry their community's division, so a division-restricted member finds
--    only the contracts of communities they reach -- the same wall as the
--    contract row itself. The stamp follows the community's division and the
--    contract's community; existing documents are restamped.
-- 2. Holds: while an approved spec disposition names a home's buyer, a hold on
--    that lot for anybody else is refused (tg_lot_reservations_allocate, the
--    trigger every hold insert already runs). createLotHold says the same
--    before it writes.
-- 3. Books development allocations: allocate_books_development_cost is
--    service_role-only (never callable by authenticated), and the review path
--    already checks the phase link before it calls it. The function now checks
--    the link itself, so no service-role caller can reach lots outside the
--    phases a job develops by calling it directly.

set local lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- 1. Land contracts in search.
-- ---------------------------------------------------------------------------

comment on column public.search_documents.division_id is
  'Division of a community, lot, prospect, start package, land deal, entitlement or land contract document, or of a lead-filed estimate, proposal, file or bid package with no project (its lead''s community''s division), stamped by tg_search_documents_stamp_division and kept current by the follow triggers. Null for every other document, and for a lead with no community or a community in no division.';

create or replace function public.tg_search_documents_stamp_division()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_table text;
  v_found boolean;
  v_project_id uuid;
  v_prospect_id uuid;
begin
  new.division_id := case new.entity_type
    when 'community' then (
      select c.division_id from public.communities c where c.org_id = new.org_id and c.id = new.entity_id
    )
    when 'lot' then (
      select l.division_id from public.lots l where l.org_id = new.org_id and l.id = new.entity_id
    )
    when 'prospect' then (
      select c.division_id
      from public.prospects p
      join public.communities c on c.org_id = p.org_id and c.id = p.community_id
      where p.org_id = new.org_id and p.id = new.entity_id
    )
    when 'start_package' then (
      select l.division_id
      from public.start_packages sp
      join public.lots l on l.org_id = sp.org_id and l.id = sp.lot_id
      where sp.org_id = new.org_id and sp.id = new.entity_id
    )
    when 'land_opportunity' then (
      select o.division_id from public.land_opportunities o where o.org_id = new.org_id and o.id = new.entity_id
    )
    when 'land_entitlement' then (
      select c.division_id
      from public.land_entitlements e
      join public.communities c on c.org_id = e.org_id and c.id = e.community_id
      where e.org_id = new.org_id and e.id = new.entity_id
    )
    when 'land_contract' then (
      select c.division_id
      from public.land_contracts lc
      join public.communities c on c.org_id = lc.org_id and c.id = lc.community_id
      where lc.org_id = new.org_id and lc.id = new.entity_id
    )
  end;

  v_table := case new.entity_type
    when 'project' then 'projects'
    when 'bid_package' then 'bid_packages'
    when 'budget' then 'budgets'
    when 'budget_transfer' then 'budget_transfers'
    when 'certified_payroll_report' then 'certified_payroll_reports'
    when 'change_event' then 'change_events'
    when 'change_order' then 'change_orders'
    when 'closing' then 'closings'
    when 'commitment' then 'commitments'
    when 'commitment_change_order' then 'commitment_change_orders'
    when 'contract' then 'contracts'
    when 'daily_log' then 'daily_logs'
    when 'design_studio_appointment' then 'design_studio_appointments'
    when 'drawing_set' then 'drawing_sets'
    when 'drawing_sheet' then 'drawing_sheets'
    when 'estimate' then 'estimates'
    when 'expense' then 'project_expenses'
    when 'file' then 'files'
    when 'inspection' then 'inspections'
    when 'invoice' then 'invoices'
    when 'meeting' then 'meetings'
    when 'meeting_transcript' then 'meeting_transcripts'
    when 'observation' then 'observations'
    when 'pay_application' then 'pay_applications'
    when 'payable' then 'vendor_bills'
    when 'photo' then 'photos'
    when 'portal_access' then 'portal_access_tokens'
    when 'project_email' then 'project_emails'
    when 'project_location' then 'project_locations'
    when 'proposal' then 'proposals'
    when 'punch_item' then 'punch_items'
    when 'rfi' then 'rfis'
    when 'safety_incident' then 'safety_incidents'
    when 'schedule_item' then 'schedule_items'
    when 'spec_section' then 'spec_sections'
    when 'start_package' then 'start_packages'
    when 'submittal' then 'submittals'
    when 'takeoff_condition' then 'takeoff_conditions'
    when 'task' then 'tasks'
    when 'transmittal' then 'transmittals'
    when 'warranty_backcharge' then 'warranty_backcharges'
    when 'warranty_request' then 'warranty_requests'
  end;

  if v_table in ('estimates', 'proposals', 'files', 'bid_packages') then
    execute format('select true, t.project_id, t.prospect_id from public.%I t where t.org_id = $1 and t.id = $2', v_table)
    into v_found, v_project_id, v_prospect_id
    using new.org_id, new.entity_id;
    if v_found then
      new.project_id := v_project_id;
      if v_project_id is null and v_prospect_id is not null then
        new.division_id := (
          select c.division_id
          from public.prospects p
          join public.communities c on c.org_id = p.org_id and c.id = p.community_id
          where p.org_id = new.org_id and p.id = v_prospect_id
        );
      elsif v_project_id is null and v_table = 'bid_packages' then
        -- A package bid for a community (no home, no lead) belongs to that
        -- community's division.
        new.division_id := (
          select c.division_id
          from public.bid_packages b
          join public.communities c on c.org_id = b.org_id and c.id = b.community_id
          where b.org_id = new.org_id and b.id = new.entity_id
        );
      end if;
    end if;
  elsif v_table is not null then
    execute format(
      'select true, t.%I from public.%I t where t.org_id = $1 and t.id = $2',
      case when v_table = 'projects' then 'id' else 'project_id' end,
      v_table
    )
    into v_found, v_project_id
    using new.org_id, new.entity_id;
    if v_found then
      new.project_id := v_project_id;
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.tg_search_documents_stamp_division() from public, anon, authenticated;

drop trigger if exists communities_search_follow_division_land_contracts on public.communities;
create trigger communities_search_follow_division_land_contracts
  after update on public.communities
  for each row
  when (old.division_id is distinct from new.division_id)
  execute function public.tg_search_documents_restamp_children('land_contract', 'land_contracts', 'community_id');

drop trigger if exists land_contracts_search_follow_community on public.land_contracts;
create trigger land_contracts_search_follow_community
  after update of community_id on public.land_contracts
  for each row
  when (old.community_id is distinct from new.community_id)
  execute function public.tg_search_documents_restamp('land_contract');

-- A land contract in a community of no division is reachable only by members
-- who reach every division, exactly as its record is.
drop policy if exists search_documents_division_scope on public.search_documents;
create policy search_documents_division_scope on public.search_documents
  as restrictive
  for all
  to authenticated
  using (
    (
      project_id is null
      or org_id = any ((select public.member_unscoped_org_ids())::uuid[])
      or project_id in (select public.member_reachable_project_ids())
    )
    and (
      entity_type not in (
        'community', 'lot', 'start_package', 'prospect', 'estimate', 'proposal', 'file', 'bid_package',
        'land_opportunity', 'land_entitlement', 'land_contract'
      )
      or (entity_type in ('prospect', 'estimate', 'proposal', 'file', 'bid_package') and division_id is null)
      or org_id = any ((select public.member_division_unscoped_org_ids())::uuid[])
      or division_id in (select public.member_reachable_division_ids())
    )
  )
  with check (
    (
      project_id is null
      or org_id = any ((select public.member_unscoped_org_ids())::uuid[])
      or project_id in (select public.member_reachable_project_ids())
    )
    and (
      entity_type not in (
        'community', 'lot', 'start_package', 'prospect', 'estimate', 'proposal', 'file', 'bid_package',
        'land_opportunity', 'land_entitlement', 'land_contract'
      )
      or (entity_type in ('prospect', 'estimate', 'proposal', 'file', 'bid_package') and division_id is null)
      or org_id = any ((select public.member_division_unscoped_org_ids())::uuid[])
      or division_id in (select public.member_reachable_division_ids())
    )
  );

-- Documents indexed before the stamp knew the type.
update public.search_documents set division_id = null where entity_type = 'land_contract';

-- ---------------------------------------------------------------------------
-- 2. A hold belongs to the approved disposition's buyer.
-- ---------------------------------------------------------------------------

create or replace function public.tg_lot_reservations_allocate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_project uuid;
  v_client uuid;
  v_disposition record;
begin
  if new.status not in ('hold', 'reserved', 'converted') then
    return new;
  end if;
  select project_id into v_project from public.lots where org_id = new.org_id and id = new.lot_id for update;
  if not found then
    raise exception 'Lot not found' using errcode = 'foreign_key_violation';
  end if;

  with expired as (
    update public.lot_reservations
       set status = 'expired', released_at = now(), release_reason = 'Hold expired'
     where org_id = new.org_id
       and lot_id = new.lot_id
       and status = 'hold'
       and expires_at is not null
       and expires_at <= now()
    returning id, org_id, lot_id, community_id
  )
  insert into public.events (org_id, event_type, entity_type, entity_id, payload)
  select org_id, 'lot_hold_expired', 'lot_reservation', id, jsonb_build_object('lot_id', lot_id, 'community_id', community_id)
    from expired;

  if v_project is not null then
    select client_id into v_client from public.projects where org_id = new.org_id and id = v_project;
    if v_client is not null and v_client not in (new.buyer_contact_id, coalesce(new.co_buyer_contact_id, new.buyer_contact_id)) then
      raise exception 'This lot''s home belongs to another buyer. Release that sale before holding the lot.'
        using errcode = 'check_violation';
    end if;
  end if;

  -- An approved disposition has named the home's buyer: until it is carried
  -- out or cancelled, nobody else may hold the lot.
  select d.kind, d.counterparty_contact_id into v_disposition
    from public.spec_dispositions d
   where d.org_id = new.org_id and d.lot_id = new.lot_id and d.status = 'approved'
   limit 1;
  if found and v_disposition.counterparty_contact_id not in (new.buyer_contact_id, coalesce(new.co_buyer_contact_id, new.buyer_contact_id)) then
    raise exception 'This home is being sold through an approved % to another buyer. Cancel the disposition before holding it for someone else.',
      replace(v_disposition.kind, '_', ' ')
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke all on function public.tg_lot_reservations_allocate() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Development cost reaches only the phases its job develops, on every path.
-- ---------------------------------------------------------------------------

create or replace function public.allocate_books_development_cost(p_org_id uuid,p_project_id uuid,p_date date,p_allocations jsonb,p_reference text,p_evidence_url text,p_actor_id uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare source_account uuid; land uuid; available bigint; total bigint; item jsonb; lot public.lots%rowtype; result_id uuid; policy integer; lines jsonb:='[]'; n integer:=0; fingerprint text; refusal text;
begin
 if jsonb_typeof(p_allocations)<>'array' or jsonb_array_length(p_allocations)=0 or p_evidence_url not like 'https://%' or length(btrim(p_reference))<3 then raise exception 'An approved allocation schedule is required'; end if;
 -- The phase link, here as on the proposal and review paths: a service-role
 -- caller reaching this directly must not spread a job's cost past its phases.
 refusal:=public.books_development_allocation_refusal(p_org_id,p_project_id,array(select (x->>'lot_id')::uuid from jsonb_array_elements(p_allocations) x));
 if refusal is not null then raise exception '%', refusal; end if;
 perform 1 from public.lots l where l.org_id=p_org_id and l.id in(select (x->>'lot_id')::uuid from jsonb_array_elements(p_allocations) x) order by l.id for update;
 perform 1 from public.project_financial_settings where org_id=p_org_id and project_id=p_project_id and books_inventory_enabled and books_inventory_completed_on is null and books_inventory_sold_on is null for update;
 if not found then raise exception 'Source project must hold active owned development inventory'; end if;
 select id into source_account from public.gl_accounts where org_id=p_org_id and code='1160' and active;
 select id into land from public.gl_accounts where org_id=p_org_id and code='1120' and active;
 if source_account is null or land is null then raise exception 'Inventory accounts are missing'; end if;
 if (select count(*) from jsonb_array_elements(p_allocations))<>(select count(distinct x->>'lot_id') from jsonb_array_elements(p_allocations) x) then raise exception 'Allocation lots must be unique'; end if;

 fingerprint:=encode(extensions.digest(jsonb_build_array(p_project_id,p_date,(select jsonb_agg(x order by x->>'lot_id') from jsonb_array_elements(p_allocations) x),p_evidence_url)::text,'sha256'),'hex');
 select e.id into result_id from public.journal_entries e where e.org_id=p_org_id and e.posting_key='development_allocation:'||lower(btrim(p_reference));
 if result_id is not null then
   if not exists(select 1 from public.journal_entries e join public.journal_lines l on l.org_id=e.org_id and l.entry_id=e.id where e.id=result_id and e.org_id=p_org_id and e.status='posted' and l.dimensions->>'allocation_hash'=fingerprint) then raise exception 'Allocation reference already has different or reversed details'; end if;
   return result_id;
 end if;
 select coalesce(sum(l.debit_cents-l.credit_cents),0) into available from public.journal_lines l join public.journal_entries e on e.id=l.entry_id and e.org_id=l.org_id where l.org_id=p_org_id and l.project_id=p_project_id and l.account_id=source_account and e.status in('posted','reversed') and e.entry_date<=p_date;
 total:=0;
 for item in select x from jsonb_array_elements(p_allocations) x order by x->>'lot_id' loop
   select * into lot from public.lots where org_id=p_org_id and id=(item->>'lot_id')::uuid;
   if not found or lot.books_acquisition_entry_id is null or lot.status not in('owned','developed','assigned') or exists(select 1 from public.journal_entries where org_id=p_org_id and source_type='inventory_start' and source_id=lot.id and status='posted') then raise exception 'Development allocation requires acquired, unstarted lots'; end if;
   if (item->>'amount_cents')::bigint<=0 then raise exception 'Allocation amounts must be positive'; end if;
   total:=total+(item->>'amount_cents')::bigint; n:=n+1;
   lines:=lines||jsonb_build_array(jsonb_build_object('line_no',n,'account_id',land,'debit_cents',(item->>'amount_cents')::bigint,'credit_cents',0,'dimensions',jsonb_build_object('lot_id',lot.id,'community_id',lot.community_id,'division_id',lot.division_id,'source_project_id',p_project_id,'allocation_hash',fingerprint,'evidence_url',p_evidence_url)));
 end loop;
 if total>available then raise exception 'Allocations exceed recorded development costs at this date'; end if;
 n:=n+1; lines:=lines||jsonb_build_array(jsonb_build_object('line_no',n,'account_id',source_account,'project_id',p_project_id,'debit_cents',0,'credit_cents',total,'dimensions',jsonb_build_object('allocation_hash',fingerprint,'evidence_url',p_evidence_url)));
 select active_policy_version into policy from public.books_settings where org_id=p_org_id;
 result_id:=public.post_books_journal_entry(p_org_id,jsonb_build_object('entry_date',p_date,'entry_kind','adjusting','memo','Allocate development costs: '||p_reference,'posting_key','development_allocation:'||lower(btrim(p_reference)),'projection_version',1,'policy_version',policy,'source_type','inventory_development_allocation','source_id',p_project_id,'created_by',p_actor_id),lines);
 insert into public.job_cost_entries(org_id,project_id,source_type,source_id,incurred_on,cost_cents,status,is_billable,metadata) values(p_org_id,p_project_id,'inventory_event',result_id,p_date,-total,'posted',false,jsonb_build_object('allocation_journal_entry_id',result_id));
 for item in select x from jsonb_array_elements(p_allocations) x loop update public.lots set cost_basis_cents=coalesce(cost_basis_cents,0)+(item->>'amount_cents')::bigint,updated_at=now() where org_id=p_org_id and id=(item->>'lot_id')::uuid; end loop;
 return result_id;
end;
$$;
revoke all on function public.allocate_books_development_cost(uuid,uuid,date,jsonb,text,text,uuid) from public,anon,authenticated;
grant execute on function public.allocate_books_development_cost(uuid,uuid,date,jsonb,text,text,uuid) to service_role;

-- ---------------------------------------------------------------------------
-- An owned lot under an authorized delivery exception can open a start
-- package (LAND-01): the service rule (verticalStartRefusal) and the RPC agree.
-- ---------------------------------------------------------------------------
create or replace function public.open_start_package(p_org_id uuid,p_actor_id uuid,p_lot_id uuid,p_is_financed boolean,p_target_week date,p_home jsonb)
returns jsonb language plpgsql set search_path=public,pg_catalog as $$
declare v_lot public.lots%rowtype; v_scope public.start_packages%rowtype; v_actor public.outbox%rowtype;
  v_pkg public.start_packages%rowtype; v_home uuid; v_created boolean:=false;
begin
  perform public.assert_starts_desk_caller();
  if p_org_id is null or p_actor_id is null or p_lot_id is null or p_is_financed is null then raise exception 'Invalid start package request'; end if;
  select * into v_lot from public.lots where org_id=p_org_id and id=p_lot_id for update;
  if not found then raise exception 'Lot not found' using errcode='42501'; end if;
  -- Delivering land is what makes a lot developed, so owned land enters only
  -- under an authorized delivery exception (lot_delivery_exceptions).
  if v_lot.status not in ('developed','assigned') and not (v_lot.status='owned' and exists(
    select 1 from public.lot_delivery_exceptions e where e.org_id=p_org_id and e.lot_id=p_lot_id and e.revoked_at is null)) then
    raise exception 'Only developed or assigned lots, or owned lots with a delivery exception, can enter the start pipeline.'; end if;
  if exists(select 1 from public.start_packages where lot_id=p_lot_id and status<>'cancelled') then
    raise exception 'This lot already has an active start package.' using errcode='23505'; end if;
  v_scope.org_id:=p_org_id; v_scope.lot_id:=v_lot.id; v_scope.community_id:=v_lot.community_id; v_scope.project_id:=v_lot.project_id;
  v_actor.org_id:=p_org_id; v_actor.job_type:='start_release'; v_actor.payload:=jsonb_build_object('actor_id',p_actor_id);
  perform public.assert_starts_actor_permission(v_actor,v_scope,'start.write');
  v_home:=v_lot.project_id;
  if v_home is null then
    perform public.assert_starts_actor_permission(v_actor,v_scope,'project.manage');
    v_home:=public.create_start_home(p_org_id,p_actor_id,v_lot,p_home);
    perform public.link_start_home(p_org_id,p_actor_id,v_lot,v_home);
    v_created:=true;
  end if;
  insert into public.start_packages(org_id,lot_id,community_id,project_id,is_financed,target_week)
    values(p_org_id,v_lot.id,v_lot.community_id,v_home,p_is_financed,p_target_week) returning * into v_pkg;
  insert into public.start_package_gates(org_id,start_package_id,gate_definition_id)
    select p_org_id,v_pkg.id,d.id from public.start_gate_definitions d where d.org_id=p_org_id and d.is_active order by d.id;
  insert into public.audit_log(org_id,actor_user_id,action,entity_type,entity_id,after_data,source)
    values(p_org_id,p_actor_id,'insert','start_package',v_pkg.id,to_jsonb(v_pkg),'starts.package_opened');
  insert into public.events(org_id,event_type,entity_type,entity_id,payload,channel)
    values(p_org_id,'start_package.opened','start_package',v_pkg.id,jsonb_build_object('lot_id',v_lot.id,'community_id',v_lot.community_id,
      'project_id',v_home,'created_home',v_created,'actor_id',p_actor_id),'activity');
  insert into public.outbox(org_id,job_type,payload) values(p_org_id,'reindex_search',jsonb_build_object('entity_type','start_package','entity_id',v_pkg.id));
  return jsonb_build_object('start_package_id',v_pkg.id,'project_id',v_home,'created_home',v_created);
end $$;
