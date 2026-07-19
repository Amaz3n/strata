-- Workstream 04 phase 3: community/plan rebids whose award target is the price book.

alter table public.bid_packages
  add column if not exists community_id uuid references public.communities(id),
  add column if not exists house_plan_id uuid references public.house_plans(id),
  add column if not exists award_target text not null default 'commitment'
    check (award_target in ('commitment','price_agreement'));

alter table public.bid_packages
  add constraint bid_packages_parent_context check (
    (project_id is not null)::integer
      + (prospect_id is not null)::integer
      + ((community_id is not null) or (house_plan_id is not null))::integer <= 1
  ) not valid,
  add constraint bid_packages_award_target_context check (
    (award_target = 'commitment' and project_id is not null)
    or (award_target = 'price_agreement' and project_id is null and prospect_id is null
      and (community_id is not null or house_plan_id is not null))
    or (prospect_id is not null and award_target = 'commitment')
  ) not valid;

create index bid_packages_community_idx on public.bid_packages (org_id, community_id)
  where community_id is not null;
create index bid_packages_house_plan_idx on public.bid_packages (house_plan_id)
  where house_plan_id is not null;

create or replace function public.run_bid_award_price_agreements(
  p_org_id uuid,
  p_bid_submission_id uuid,
  p_awarded_by uuid default null,
  p_notes text default null,
  p_accepted_alternate_ids uuid[] default '{}'
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
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
  v_effective_from date := current_date;
begin
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

  select * into v_existing_award from public.bid_awards
    where org_id = p_org_id and bid_package_id = v_package.id and rescinded_at is null
    order by awarded_at desc limit 1 for update;
  if found then
    if v_existing_award.awarded_submission_id = p_bid_submission_id then
      return jsonb_build_object(
        'award_id', v_existing_award.id,
        'bid_package_id', v_package.id,
        'agreement_ids', coalesce((select jsonb_agg(id) from public.vendor_price_agreements
          where source_bid_award_id = v_existing_award.id), '[]'::jsonb)
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

    update public.vendor_price_agreements old
    set status = 'superseded', effective_to = case
      when old.effective_from < v_effective_from then v_effective_from - 1
      else v_effective_from
    end
    where old.org_id = p_org_id
      and old.company_id = v_invite.company_id
      and old.cost_code_id = v_item.cost_code_id
      and old.division_id is not distinct from null
      and old.community_id is not distinct from v_package.community_id
      and old.house_plan_id is not distinct from v_package.house_plan_id
      and old.house_plan_version_id is null
      and old.status = 'active'
      and old.effective_from <= v_effective_from;

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
      jsonb_build_object('bid_submission_item_id', v_item.id, 'bid_package_id', v_package.id)
    ) returning id into v_agreement_id;

    update public.vendor_price_agreements
    set superseded_by_id = v_agreement_id
    where org_id = p_org_id
      and company_id = v_invite.company_id
      and cost_code_id = v_item.cost_code_id
      and community_id is not distinct from v_package.community_id
      and house_plan_id is not distinct from v_package.house_plan_id
      and status = 'superseded'
      and effective_to in (v_effective_from - 1, v_effective_from)
      and superseded_by_id is null;
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
    'agreement_ids', to_jsonb(v_agreement_ids)
  );
end;
$$;

revoke all on function public.run_bid_award_price_agreements(uuid, uuid, uuid, text, uuid[]) from public, anon, authenticated;
grant execute on function public.run_bid_award_price_agreements(uuid, uuid, uuid, text, uuid[]) to service_role;
