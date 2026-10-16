-- EP08-03 / EP08-05: the bid tables and the price book stop being writable by
-- any org member straight through the data API, and rebid, renewal and
-- rescission keep an exact commercial baseline.
--
-- 1. Bid tables: the permissive `for all ... is_org_member` policies are
--    replaced by per-command policies. Reads stay org.member (the services read
--    that way); writes need bid.write or project.manage (the permissions every
--    bid service already demands). bid_awards is written only by the award and
--    rescind functions, so authenticated loses insert/update/delete on it.
-- 2. Ancestry cannot be re-pointed after the fact: an invite stays on its
--    package, a submission on its invite, a line on its submission, an award on
--    its package and its submission. An award must be of a bid made on the
--    awarded package. A member cannot reparent, retarget or re-home an issued
--    package, nor move its status into or out of 'awarded'.
-- 3. vendor_price_agreements: division-fenced on division_id as well as
--    community_id, org-wide rows are writable only by members whose division
--    scope is unrestricted, writes need price_book.write, and a member can only
--    INSERT a manual/import draft or active row. Every state change (void, end,
--    reprice, supersede, restore) goes through a function that records why.
-- 4. Awarding a price-book package takes a buyer-chosen effective date, ends
--    whatever price the award replaces in that scope (any vendor, same cost
--    type) the day before it starts, records what it displaced on the minted
--    row, and serializes awards for the same scope. Rescinding restores the
--    displaced price exactly, unless it was repriced, voided or edited since,
--    and reports how many purchase orders priced from the voided rows.
-- 5. Void and End require a reason and report the purchase orders affected.
--
-- RBAC: no new key. Rescind, void and end are bid.write / price_book.write (the
-- purchasing manager holds both), and project.manage still passes.

-- ---------------------------------------------------------------------------
-- 1. Bid tables: permission-checked writes.
-- ---------------------------------------------------------------------------

do $$
declare
  v_table text;
  v_policy text;
begin
  foreach v_table in array array[
    'bid_packages', 'bid_invites', 'bid_submissions', 'bid_submission_items',
    'bid_scope_items', 'bid_addenda', 'bid_addendum_acknowledgements',
    'bid_access_tokens', 'bid_portal_drafts', 'bid_awards'
  ] loop
    execute format('drop policy if exists %I on public.%I', v_table || '_access', v_table);
    execute format('create policy %I on public.%I for select to authenticated using (public.is_org_member(org_id))',
      v_table || '_read', v_table);
  end loop;

  foreach v_table in array array[
    'bid_packages', 'bid_invites', 'bid_submissions', 'bid_submission_items',
    'bid_addenda', 'bid_access_tokens'
  ] loop
    v_policy := '(public.has_org_permission(org_id, ''bid.write'') or public.has_org_permission(org_id, ''project.manage''))';
    execute format('create policy %I on public.%I for insert to authenticated with check (%s)', v_table || '_insert', v_table, v_policy);
    execute format('create policy %I on public.%I for update to authenticated using (%s) with check (%s)', v_table || '_update', v_table, v_policy, v_policy);
    execute format('create policy %I on public.%I for delete to authenticated using (%s)', v_table || '_delete', v_table, v_policy);
  end loop;
end $$;

-- A measured quantity synced from a takeoff lands on the package's scope lines
-- under takeoff.write, so that key writes them as well.
create policy bid_scope_items_insert on public.bid_scope_items for insert to authenticated
  with check (public.has_org_permission(org_id, 'bid.write') or public.has_org_permission(org_id, 'project.manage') or public.has_org_permission(org_id, 'takeoff.write'));
create policy bid_scope_items_update on public.bid_scope_items for update to authenticated
  using (public.has_org_permission(org_id, 'bid.write') or public.has_org_permission(org_id, 'project.manage') or public.has_org_permission(org_id, 'takeoff.write'))
  with check (public.has_org_permission(org_id, 'bid.write') or public.has_org_permission(org_id, 'project.manage') or public.has_org_permission(org_id, 'takeoff.write'));
create policy bid_scope_items_delete on public.bid_scope_items for delete to authenticated
  using (public.has_org_permission(org_id, 'bid.write') or public.has_org_permission(org_id, 'project.manage') or public.has_org_permission(org_id, 'takeoff.write'));

-- Portal acknowledgements and drafts are written by the bid portal's service
-- client only; awards by run_bid_award_* / rescind_bid_award only.
revoke insert, update, delete on table public.bid_awards from authenticated;
revoke insert, update, delete on table public.bid_addendum_acknowledgements from authenticated;
revoke insert, update, delete on table public.bid_portal_drafts from authenticated;

-- ---------------------------------------------------------------------------
-- 2. Ancestry and issued-package immutability.
-- ---------------------------------------------------------------------------

-- A child's parent key never changes, for any caller: re-pointing an invite
-- would carry its quotes into another package.
create or replace function public.tg_bid_parent_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_column text := tg_argv[0];
begin
  if to_jsonb(new) ->> v_column is distinct from to_jsonb(old) ->> v_column then
    raise exception 'A % cannot move to another parent', replace(tg_table_name, 'bid_', 'bid ') using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger bid_invites_parent_immutable before update of bid_package_id on public.bid_invites
  for each row execute function public.tg_bid_parent_immutable('bid_package_id');
create trigger bid_submissions_parent_immutable before update of bid_invite_id on public.bid_submissions
  for each row execute function public.tg_bid_parent_immutable('bid_invite_id');
create trigger bid_submission_items_parent_immutable before update of bid_submission_id on public.bid_submission_items
  for each row execute function public.tg_bid_parent_immutable('bid_submission_id');
create trigger bid_scope_items_parent_immutable before update of bid_package_id on public.bid_scope_items
  for each row execute function public.tg_bid_parent_immutable('bid_package_id');
create trigger bid_addenda_parent_immutable before update of bid_package_id on public.bid_addenda
  for each row execute function public.tg_bid_parent_immutable('bid_package_id');
create trigger bid_awards_package_immutable before update of bid_package_id on public.bid_awards
  for each row execute function public.tg_bid_parent_immutable('bid_package_id');
create trigger bid_awards_submission_immutable before update of awarded_submission_id on public.bid_awards
  for each row execute function public.tg_bid_parent_immutable('awarded_submission_id');

-- What a member can do to a package's parent and target. The award and rescind
-- functions, the precon conversion and the service client are not members.
create or replace function public.tg_bid_package_member_fence()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user not in ('anon', 'authenticated') then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.status = 'awarded' then
      raise exception 'A bid package is awarded by awarding a bid' using errcode = '42501';
    end if;
    return new;
  end if;
  if new.status = 'awarded' and old.status is distinct from 'awarded' then
    raise exception 'A bid package is awarded by awarding a bid' using errcode = '42501';
  end if;
  if old.status = 'awarded' and new.status is distinct from 'awarded' then
    raise exception 'An awarded bid package reopens by rescinding its award' using errcode = '42501';
  end if;
  if new.award_target is distinct from old.award_target then
    raise exception 'A bid package''s award target is fixed when it is created' using errcode = '42501';
  end if;
  if new.org_id is distinct from old.org_id
     or new.prospect_id is distinct from old.prospect_id
     or (new.project_id is distinct from old.project_id and old.project_id is not null) then
    raise exception 'A bid package cannot move to another job' using errcode = '42501';
  end if;
  -- Once a package is issued its scope of supply is the record bids were made
  -- against; the budget line may still be linked on the way to an award.
  if (new.community_id is distinct from old.community_id
      or new.house_plan_id is distinct from old.house_plan_id
      or new.cost_code_id is distinct from old.cost_code_id
      or (new.budget_line_id is distinct from old.budget_line_id and old.budget_line_id is not null))
     and (old.status <> 'draft' or exists (
       select 1 from public.bid_invites i where i.org_id = old.org_id and i.bid_package_id = old.id
     )) then
    raise exception 'An issued bid package keeps its community, plan and cost code' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger bid_packages_member_fence before insert or update on public.bid_packages
  for each row execute function public.tg_bid_package_member_fence();

-- The award row must be of a bid made on the awarded package, and the check
-- reads the project hand-off the caller may not see, so it runs as definer.
create or replace function public.guard_bid_award_readiness()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare s public.bid_submissions; p public.bid_packages;
begin
 select * into s from public.bid_submissions where id=new.awarded_submission_id for update;
 select * into p from public.bid_packages where id=new.bid_package_id for update;
 if s.id is null or p.id is null
    or not exists(select 1 from public.bid_invites i where i.id=s.bid_invite_id and i.bid_package_id=p.id and i.org_id=new.org_id) then
   raise exception 'The awarded bid does not belong to this package';
 end if;
 if not s.is_current or s.status not in ('submitted','revised') or (s.valid_until is not null and s.valid_until::date<current_date) or s.scope_revision<>p.scope_revision then raise exception 'This quote must be refreshed or reconfirmed before award'; end if;
 if exists(select 1 from public.bid_addenda a where a.bid_package_id=p.id and not exists(select 1 from public.bid_addendum_acknowledgements ack where ack.bid_addendum_id=a.id and ack.bid_invite_id=s.bid_invite_id)) then raise exception 'The vendor must acknowledge all addenda before award'; end if;
 if exists(select 1 from public.projects pr where pr.id=p.project_id and pr.phase='precon') and not exists(select 1 from public.project_precon_handoffs h join public.contracts c on c.id=h.contract_id and c.org_id=h.org_id where h.org_id=p.org_id and h.project_id=p.project_id and c.status='active' and h.status in ('awarded','baseline_approved','accepted','released')) then raise exception 'Record the signed owner contract and commercial award before committing subcontract costs'; end if;
 if new.awarded_commitment_id is not null then
 update public.commitments set scope=concat_ws(E'\n\n',p.scope,'Vendor exclusions: '||s.exclusions,'Vendor clarifications: '||s.clarifications), metadata=coalesce(metadata,'{}')||jsonb_build_object('bid_scope_revision',s.scope_revision,'bid_submission_version',s.version,'bid_valid_until',s.valid_until,'bid_lead_time_days',s.lead_time_days,'bid_duration_days',s.duration_days,'bid_start_available_on',s.start_available_on,'subcontract_review_required',true) where id=new.awarded_commitment_id;
 end if;
 return new;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Price book: division fence, permission, and write shape.
-- ---------------------------------------------------------------------------

drop policy if exists vendor_price_agreements_org_access on public.vendor_price_agreements;
drop policy if exists vendor_price_agreements_division_scope on public.vendor_price_agreements;

create policy vendor_price_agreements_read on public.vendor_price_agreements
  for select to authenticated using (public.is_org_member(org_id));

-- Inserts only: voiding, ending, repricing, superseding and restoring are
-- functions that record the reason, and none of them is a member's UPDATE.
create policy vendor_price_agreements_insert on public.vendor_price_agreements
  for insert to authenticated with check (public.has_org_permission(org_id, 'price_book.write'));

-- A member limited to some divisions reaches the rows of those divisions and
-- their communities, and reads (but never writes) the org-wide rows.
create policy vendor_price_agreements_division_scope on public.vendor_price_agreements
  as restrictive for all to authenticated
  using (
    org_id = any ((select public.member_division_unscoped_org_ids())::uuid[])
    or (
      (division_id is null or division_id in (select public.member_reachable_division_ids()))
      and (community_id is null or community_id in (select public.member_reachable_community_ids()))
    )
  )
  with check (
    org_id = any ((select public.member_division_unscoped_org_ids())::uuid[])
    or (
      (division_id is not null or community_id is not null)
      and (division_id is null or division_id in (select public.member_reachable_division_ids()))
      and (community_id is null or community_id in (select public.member_reachable_community_ids()))
    )
  );

create or replace function public.tg_vendor_price_agreement_member_insert()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user not in ('anon', 'authenticated') then
    return new;
  end if;
  if new.source not in ('manual', 'import')
     or new.status not in ('draft', 'active')
     or new.superseded_by_id is not null
     or new.source_bid_award_id is not null then
    raise exception 'A price agreement is created as a manual or imported draft or active row; awards, repricing and supersession go through their own paths' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger vendor_price_agreements_member_insert before insert on public.vendor_price_agreements
  for each row execute function public.tg_vendor_price_agreement_member_insert();

-- Reverse lookup for "which purchase orders priced from these agreements".
create index if not exists commitments_source_agreement_ids_idx
  on public.commitments using gin ((metadata -> 'source_agreement_ids'))
  where metadata ? 'source_agreement_ids';

-- The purchase orders (not canceled) that priced a line from any of these
-- agreements. One definition for the rescind result, the void/end result and the
-- confirmation a buyer reads before acting.
create or replace function public.price_agreement_order_count(p_org_id uuid, p_agreement_ids uuid[])
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::integer
  from public.commitments c
  where c.org_id = p_org_id
    and c.status <> 'canceled'
    and c.metadata ? 'source_agreement_ids'
    and (c.metadata -> 'source_agreement_ids') ?| (select coalesce(array_agg(x::text), '{}'::text[]) from unnest(p_agreement_ids) x);
$$;

revoke all on function public.price_agreement_order_count(uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.price_agreement_order_count(uuid, uuid[]) to service_role;

-- ---------------------------------------------------------------------------
-- 4. Awarding a price-book package.
-- ---------------------------------------------------------------------------

drop function if exists public.run_bid_award_price_agreements(uuid, uuid, uuid, text, uuid[]);

create or replace function public.run_bid_award_price_agreements(
  p_org_id uuid,
  p_bid_submission_id uuid,
  p_awarded_by uuid default null,
  p_notes text default null,
  p_accepted_alternate_ids uuid[] default '{}',
  p_effective_from date default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_catalog'
as $$
declare
  v_submission public.bid_submissions%rowtype;
  v_invite public.bid_invites%rowtype;
  v_package public.bid_packages%rowtype;
  v_existing_award public.bid_awards%rowtype;
  v_award public.bid_awards%rowtype;
  v_item record;
  v_agreement_id uuid;
  v_agreement_ids uuid[] := '{}';
  v_displaced_ids uuid[] := '{}';
  v_displaced jsonb;
  v_effective_from date := coalesce(p_effective_from, current_date);
  v_end date := v_effective_from - 1;
begin
  if v_effective_from < current_date or v_effective_from > current_date + 366 then
    raise exception 'The price takes effect from today up to a year ahead';
  end if;

  select * into v_submission from public.bid_submissions
    where org_id = p_org_id and id = p_bid_submission_id for update;
  if not found then raise exception 'Bid submission not found'; end if;
  if not coalesce(v_submission.is_current, false) then
    raise exception 'Only the current submission can be awarded';
  end if;

  select * into v_invite from public.bid_invites
    where org_id = p_org_id and id = v_submission.bid_invite_id for update;
  if not found then raise exception 'Bid invite not found'; end if;

  select * into v_package from public.bid_packages
    where org_id = p_org_id and id = v_invite.bid_package_id for update;
  if not found then raise exception 'Bid package not found'; end if;
  if v_package.award_target <> 'price_agreement' or v_package.project_id is not null
      or v_package.prospect_id is not null then
    raise exception 'Bid package is not a price-agreement package';
  end if;
  if v_package.status = 'cancelled' then raise exception 'Cannot award a cancelled bid package'; end if;

  -- Two packages awarded for the same community and plan each hold their own
  -- row lock; this one lock is what keeps the second from minting beside the
  -- first instead of replacing it.
  perform pg_advisory_xact_lock(hashtextextended(
    'price_book_scope:' || p_org_id::text || ':' || coalesce(v_package.community_id::text, '') || ':' || coalesce(v_package.house_plan_id::text, ''), 0));

  select * into v_existing_award from public.bid_awards
    where org_id = p_org_id and bid_package_id = v_package.id and rescinded_at is null
    order by awarded_at desc limit 1 for update;
  if found then
    if v_existing_award.awarded_submission_id = p_bid_submission_id then
      return jsonb_build_object(
        'award_id', v_existing_award.id,
        'bid_package_id', v_package.id,
        'agreement_ids', coalesce((select jsonb_agg(id) from public.vendor_price_agreements
          where source_bid_award_id = v_existing_award.id), '[]'::jsonb),
        'displaced_ids', '[]'::jsonb
      );
    end if;
    raise exception 'This bid package has already been awarded';
  end if;

  insert into public.bid_awards (
    org_id, bid_package_id, awarded_submission_id, awarded_commitment_id,
    awarded_by, notes, accepted_alternate_ids
  ) values (
    p_org_id, v_package.id, v_submission.id, null, p_awarded_by, p_notes,
    coalesce(p_accepted_alternate_ids, '{}')
  ) returning * into v_award;

  for v_item in
    select
      i.id,
      i.description,
      i.amount_cents,
      i.unit_rate_cents,
      i.quantity,
      s.cost_code_id,
      s.item_type,
      s.unit,
      s.details
    from public.bid_submission_items i
    join public.bid_scope_items s on s.id = i.bid_scope_item_id and s.org_id = i.org_id
    where i.org_id = p_org_id
      and i.bid_submission_id = v_submission.id
      and i.response = 'priced'
      and i.amount_cents is not null
      and s.cost_code_id is not null
      and (s.item_type <> 'alternate' or s.id = any(coalesce(p_accepted_alternate_ids, '{}')))
    order by s.position, i.created_at
  loop
    if v_item.unit is null and v_package.house_plan_id is null then
      raise exception 'Lump-sum price agreements require a house plan';
    end if;

    -- The price this one replaces: the same scope, whichever vendor holds it.
    -- Rows of this award are never displaced by it.
    select coalesce(jsonb_agg(jsonb_build_object(
             'id', old.id, 'prior_effective_to', old.effective_to, 'prior_status', old.status,
             'new_effective_to', case when old.effective_from < v_effective_from then v_end else old.effective_from end
           )), '[]'::jsonb),
           coalesce(array_agg(old.id), '{}')
      into v_displaced, v_displaced_ids
    from public.vendor_price_agreements old
    where old.org_id = p_org_id
      and old.cost_code_id = v_item.cost_code_id
      and old.cost_type is null
      and old.division_id is null
      and old.community_id is not distinct from v_package.community_id
      and old.house_plan_id is not distinct from v_package.house_plan_id
      and old.house_plan_version_id is null
      and old.status = 'active'
      and old.effective_from <= v_effective_from
      and coalesce(old.effective_to, 'infinity'::date) >= v_effective_from
      and old.source_bid_award_id is distinct from v_award.id;

    update public.vendor_price_agreements old
    set effective_to = case when old.effective_from < v_effective_from then v_end else old.effective_from end,
        -- A price that starts in the future leaves the incumbent in force until
        -- the day before; maintenance expires it on the way past. One that was
        -- itself due to start on the same day never takes effect at all.
        status = case when v_effective_from <= current_date or old.effective_from = v_effective_from then 'superseded' else old.status end
    where old.org_id = p_org_id and old.id = any(v_displaced_ids);

    insert into public.vendor_price_agreements (
      org_id, company_id, cost_code_id, community_id, house_plan_id,
      pricing_kind, uom, unit_cost_cents, lump_sum_cents, scope_of_work,
      effective_from, status, source, source_bid_award_id, notes, created_by,
      metadata
    ) values (
      p_org_id, v_invite.company_id, v_item.cost_code_id, v_package.community_id,
      v_package.house_plan_id,
      case when v_item.unit is null then 'lump_sum' else 'unit' end,
      v_item.unit,
      case when v_item.unit is not null then coalesce(v_item.unit_rate_cents,
        round(v_item.amount_cents / greatest(coalesce(v_item.quantity, 1), 1))::bigint) end,
      case when v_item.unit is null then v_item.amount_cents::bigint end,
      coalesce(v_item.details, v_item.description),
      v_effective_from, 'active', 'bid_award', v_award.id, p_notes, p_awarded_by,
      jsonb_build_object('bid_submission_item_id', v_item.id, 'bid_package_id', v_package.id, 'supersedes', v_displaced)
    ) returning id into v_agreement_id;

    update public.vendor_price_agreements
    set superseded_by_id = v_agreement_id
    where org_id = p_org_id and id = any(v_displaced_ids);

    v_agreement_ids := array_append(v_agreement_ids, v_agreement_id);
  end loop;

  if cardinality(v_agreement_ids) = 0 then
    raise exception 'Award has no priced cost-coded scope items';
  end if;

  update public.bid_packages set status = 'awarded', updated_at = now()
    where org_id = p_org_id and id = v_package.id;

  return jsonb_build_object(
    'award_id', v_award.id,
    'bid_package_id', v_package.id,
    'agreement_ids', to_jsonb(v_agreement_ids),
    'displaced_ids', coalesce((
      select jsonb_agg(distinct e ->> 'id')
      from public.vendor_price_agreements m, jsonb_array_elements(m.metadata -> 'supersedes') e
      where m.id = any(v_agreement_ids)
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.run_bid_award_price_agreements(uuid, uuid, uuid, text, uuid[], date) from public, anon, authenticated;
grant execute on function public.run_bid_award_price_agreements(uuid, uuid, uuid, text, uuid[], date) to service_role;

-- ---------------------------------------------------------------------------
-- 5. Rescinding: void what the award minted, put back what it displaced.
-- ---------------------------------------------------------------------------

drop function if exists public.rescind_bid_award(uuid, uuid, uuid, text);

create or replace function public.rescind_bid_award(
  p_org_id uuid,
  p_bid_award_id uuid,
  p_actor_id uuid,
  p_reason text default null
) returns table (
  bid_package_id uuid,
  commitment_id uuid,
  commitment_canceled boolean,
  voided_agreement_ids uuid[],
  restored_agreement_ids uuid[],
  skipped_agreement_ids uuid[],
  affected_po_count integer
)
language plpgsql security definer
set search_path to 'public'
as $$
declare
  v_award record;
  v_bill_count integer;
  v_commitment_canceled boolean := false;
  v_minted uuid[];
  v_voided uuid[];
  v_restored uuid[] := '{}';
  v_skipped uuid[] := '{}';
  v_entry record;
  v_po_count integer := 0;
begin
  select ba.id, ba.org_id, ba.bid_package_id, ba.awarded_commitment_id, ba.rescinded_at
  into v_award
  from bid_awards ba
  where ba.id = p_bid_award_id and ba.org_id = p_org_id
  for update;

  if not found then
    raise exception 'Bid award not found';
  end if;
  if v_award.rescinded_at is not null then
    raise exception 'Bid award is already rescinded';
  end if;

  if v_award.awarded_commitment_id is not null then
    select count(*) into v_bill_count
    from vendor_bills vb
    where vb.org_id = p_org_id and vb.commitment_id = v_award.awarded_commitment_id;

    if v_bill_count > 0 then
      raise exception 'Cannot rescind: % bill(s) already reference the awarded subcontract', v_bill_count;
    end if;

    update commitments c
    set status = 'canceled', updated_at = now()
    where c.id = v_award.awarded_commitment_id
      and c.org_id = p_org_id
      and c.status in ('draft', 'approved');
    v_commitment_canceled := found;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('price_book_award_scope:' || p_org_id::text || ':' || v_award.bid_package_id::text, 0));

  select coalesce(array_agg(vpa.id), '{}') into v_minted
  from vendor_price_agreements vpa
  where vpa.org_id = p_org_id and vpa.source_bid_award_id = p_bid_award_id;

  with voided as (
    update vendor_price_agreements vpa
    set status = 'void',
        metadata = vpa.metadata || jsonb_build_object(
          'voided_by_rescind', jsonb_build_object(
            'bid_award_id', p_bid_award_id, 'actor_id', p_actor_id,
            'reason', p_reason, 'at', now()
          )
        )
    where vpa.org_id = p_org_id
      and vpa.source_bid_award_id = p_bid_award_id
      and vpa.status in ('draft', 'active')
    returning vpa.id
  )
  select coalesce(array_agg(id), '{}') into v_voided from voided;

  -- Put back exactly what the award displaced, unless somebody has touched it
  -- since: the price this award replaced is restored only while it still reads
  -- as the award left it, and only when the minted row it yielded to is void.
  for v_entry in
    select m.id as minted_id, (e ->> 'id')::uuid as old_id,
           (e ->> 'prior_effective_to')::date as prior_effective_to,
           (e ->> 'prior_status') as prior_status,
           (e ->> 'new_effective_to')::date as new_effective_to
    from vendor_price_agreements m, jsonb_array_elements(m.metadata -> 'supersedes') e
    where m.org_id = p_org_id and m.id = any(v_minted)
  loop
    if v_entry.minted_id = any(v_voided)
       and exists (
         select 1 from vendor_price_agreements o
         where o.id = v_entry.old_id and o.org_id = p_org_id
           and o.superseded_by_id = v_entry.minted_id
           and o.effective_to is not distinct from v_entry.new_effective_to
           and o.status in ('superseded', 'active')
       ) then
      update vendor_price_agreements o
      set effective_to = v_entry.prior_effective_to,
          superseded_by_id = null,
          status = case when v_entry.prior_effective_to is not null and v_entry.prior_effective_to < current_date
                        then 'expired' else 'active' end,
          metadata = o.metadata || jsonb_build_object(
            'restored_by_rescind', jsonb_build_object('bid_award_id', p_bid_award_id, 'actor_id', p_actor_id, 'at', now())
          )
      where o.id = v_entry.old_id and o.org_id = p_org_id;
      v_restored := array_append(v_restored, v_entry.old_id);
    else
      v_skipped := array_append(v_skipped, v_entry.old_id);
    end if;
  end loop;

  v_po_count := public.price_agreement_order_count(p_org_id, v_minted);

  update bid_awards ba
  set rescinded_at = now(), rescinded_by = p_actor_id, rescind_reason = p_reason
  where ba.id = p_bid_award_id and ba.org_id = p_org_id;

  -- Reopen the package for re-award (bids are still on file)
  update bid_packages bp
  set status = 'closed', updated_at = now()
  where bp.id = v_award.bid_package_id and bp.org_id = p_org_id;

  return query select v_award.bid_package_id, v_award.awarded_commitment_id, v_commitment_canceled,
    v_voided, v_restored, v_skipped, v_po_count;
end;
$$;

revoke all on function public.rescind_bid_award(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.rescind_bid_award(uuid, uuid, uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- 6. Reprice, void and end carry a reason and report the orders affected.
-- ---------------------------------------------------------------------------

drop function if exists public.reprice_vendor_price_agreement(uuid, uuid, date, bigint, bigint, text, uuid);

create or replace function public.reprice_vendor_price_agreement(
  p_org_id uuid,
  p_agreement_id uuid,
  p_effective_from date,
  p_unit_cost_cents bigint default null,
  p_lump_sum_cents bigint default null,
  p_notes text default null,
  p_actor_id uuid default null,
  p_reason text default null
) returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_catalog'
as $$
declare
  v_old public.vendor_price_agreements%rowtype;
  v_new_id uuid;
begin
  if length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'A reason is required to reprice an agreement';
  end if;
  select * into v_old from public.vendor_price_agreements
    where org_id = p_org_id and id = p_agreement_id for update;
  if not found then raise exception 'Price agreement not found'; end if;
  if v_old.status <> 'active' then raise exception 'Only active agreements can be repriced'; end if;
  if p_effective_from <= v_old.effective_from then
    raise exception 'Reprice effective date must follow the current agreement start';
  end if;
  if v_old.effective_to is not null and p_effective_from > v_old.effective_to then
    raise exception 'Reprice effective date must fall before the agreement ends';
  end if;
  if v_old.pricing_kind = 'unit' and (p_unit_cost_cents is null or p_lump_sum_cents is not null) then
    raise exception 'Unit repricing requires unit cost only';
  end if;
  if v_old.pricing_kind = 'lump_sum' and (p_lump_sum_cents is null or p_unit_cost_cents is not null) then
    raise exception 'Lump-sum repricing requires lump sum only';
  end if;

  insert into public.vendor_price_agreements (
    org_id, company_id, cost_code_id, cost_type, division_id, community_id,
    house_plan_id, house_plan_version_id, pricing_kind, uom, unit_cost_cents,
    lump_sum_cents, scope_of_work, effective_from, effective_to, status,
    source, source_bid_award_id, notes, metadata, created_by
  ) values (
    v_old.org_id, v_old.company_id, v_old.cost_code_id, v_old.cost_type,
    v_old.division_id, v_old.community_id, v_old.house_plan_id,
    v_old.house_plan_version_id, v_old.pricing_kind, v_old.uom,
    p_unit_cost_cents, p_lump_sum_cents, v_old.scope_of_work, p_effective_from,
    v_old.effective_to, 'active', 'manual', null, p_notes,
    (v_old.metadata - 'supersedes') || jsonb_build_object('repriced_from_id', v_old.id, 'reprice_reason', btrim(p_reason)),
    p_actor_id
  ) returning id into v_new_id;

  update public.vendor_price_agreements set
    status = 'superseded', superseded_by_id = v_new_id,
    effective_to = p_effective_from - 1
  where org_id = p_org_id and id = v_old.id;
  return v_new_id;
end;
$$;

revoke all on function public.reprice_vendor_price_agreement(uuid, uuid, date, bigint, bigint, text, uuid, text) from public, anon, authenticated;
grant execute on function public.reprice_vendor_price_agreement(uuid, uuid, date, bigint, bigint, text, uuid, text) to service_role;

create or replace function public.price_agreement_state(
  p_org_id uuid,
  p_agreement_id uuid,
  p_action text,
  p_effective_to date,
  p_reason text,
  p_actor_id uuid
) returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_catalog'
as $$
declare
  v_row public.vendor_price_agreements%rowtype;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_status text;
  v_end date;
  v_orders integer;
begin
  if p_action not in ('void', 'end') then raise exception 'Unknown agreement action'; end if;
  if length(v_reason) < 3 then raise exception 'A reason is required to % an agreement', p_action; end if;
  select * into v_row from public.vendor_price_agreements
    where org_id = p_org_id and id = p_agreement_id for update;
  if not found then raise exception 'Price agreement not found'; end if;

  if p_action = 'void' then
    if v_row.status not in ('draft', 'active') then
      raise exception 'Only draft or active agreements can be voided';
    end if;
    v_status := 'void';
    v_end := v_row.effective_to;
  else
    if v_row.status <> 'active' then raise exception 'Only active agreements can be ended'; end if;
    if p_effective_to is null or p_effective_to < v_row.effective_from then
      raise exception 'The end date cannot fall before the agreement starts';
    end if;
    v_status := case when p_effective_to < current_date then 'expired' else 'active' end;
    v_end := p_effective_to;
  end if;

  update public.vendor_price_agreements set
    status = v_status,
    effective_to = v_end,
    metadata = v_row.metadata || jsonb_build_object('state_change', jsonb_build_object(
      'action', p_action, 'reason', v_reason, 'actor_id', p_actor_id, 'at', now(),
      'prior_status', v_row.status, 'prior_effective_to', v_row.effective_to))
  where org_id = p_org_id and id = p_agreement_id;

  v_orders := public.price_agreement_order_count(p_org_id, array[p_agreement_id]);

  return jsonb_build_object('agreement_id', p_agreement_id, 'affected_po_count', v_orders);
end;
$$;

revoke all on function public.price_agreement_state(uuid, uuid, text, date, text, uuid) from public, anon, authenticated;
grant execute on function public.price_agreement_state(uuid, uuid, text, date, text, uuid) to service_role;
