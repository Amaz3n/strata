alter table public.bid_packages
  add column if not exists cost_code_id uuid references public.cost_codes(id) on delete set null;

create index if not exists bid_packages_org_cost_code_idx
  on public.bid_packages (org_id, cost_code_id);

create or replace function public.run_bid_award_conversion(
  p_org_id uuid,
  p_bid_submission_id uuid,
  p_awarded_by uuid default null,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_submission public.bid_submissions%rowtype;
  v_invite public.bid_invites%rowtype;
  v_package public.bid_packages%rowtype;
  v_existing_award public.bid_awards%rowtype;
  v_commitment public.commitments%rowtype;
  v_award public.bid_awards%rowtype;
  v_project_vendor_id uuid;
begin
  select *
  into v_submission
  from public.bid_submissions
  where org_id = p_org_id
    and id = p_bid_submission_id
  for update;

  if not found then
    raise exception 'Bid submission not found';
  end if;

  if coalesce(v_submission.is_current, false) = false then
    raise exception 'Only the current submission can be awarded';
  end if;

  if v_submission.total_cents is null then
    raise exception 'Submission total is required to award';
  end if;

  select *
  into v_invite
  from public.bid_invites
  where org_id = p_org_id
    and id = v_submission.bid_invite_id
  for update;

  if not found then
    raise exception 'Bid invite not found';
  end if;

  select *
  into v_package
  from public.bid_packages
  where org_id = p_org_id
    and id = v_invite.bid_package_id
  for update;

  if not found then
    raise exception 'Bid package not found';
  end if;

  if v_package.status = 'cancelled' then
    raise exception 'Cannot award a cancelled bid package';
  end if;

  select *
  into v_existing_award
  from public.bid_awards
  where org_id = p_org_id
    and bid_package_id = v_package.id
  order by awarded_at desc
  limit 1
  for update;

  if found then
    if v_existing_award.awarded_submission_id = p_bid_submission_id and v_existing_award.awarded_commitment_id is not null then
      return jsonb_build_object(
        'award_id', v_existing_award.id,
        'commitment_id', v_existing_award.awarded_commitment_id,
        'bid_package_id', v_package.id
      );
    end if;
    raise exception 'This bid package has already been awarded';
  end if;

  insert into public.commitments (
    org_id,
    project_id,
    company_id,
    title,
    status,
    total_cents,
    currency,
    issued_at,
    metadata
  )
  values (
    p_org_id,
    v_package.project_id,
    v_invite.company_id,
    concat(v_package.title, ' - Award'),
    'draft',
    v_submission.total_cents,
    coalesce(v_submission.currency, 'usd'),
    now(),
    jsonb_build_object(
      'source', 'bid_award',
      'bid_package_id', v_package.id,
      'bid_submission_id', v_submission.id,
      'cost_code_id', v_package.cost_code_id,
      'awarded_notes', p_notes
    )
  )
  returning *
  into v_commitment;

  if v_package.cost_code_id is not null then
    insert into public.commitment_lines (
      org_id,
      commitment_id,
      cost_code_id,
      description,
      quantity,
      unit,
      unit_cost_cents,
      sort_order,
      metadata
    )
    values (
      p_org_id,
      v_commitment.id,
      v_package.cost_code_id,
      coalesce(nullif(v_package.scope, ''), v_package.title),
      1,
      'LS',
      v_submission.total_cents,
      0,
      jsonb_build_object(
        'source', 'bid_award',
        'bid_package_id', v_package.id,
        'bid_submission_id', v_submission.id
      )
    );
  end if;

  insert into public.project_vendors (
    org_id,
    project_id,
    company_id,
    role,
    scope,
    status,
    notes
  )
  values (
    p_org_id,
    v_package.project_id,
    v_invite.company_id,
    'subcontractor',
    coalesce(v_package.trade, v_package.title),
    'active',
    coalesce(p_notes, concat('Awarded from bid package ', v_package.title))
  )
  on conflict (project_id, company_id)
  do update set
    role = excluded.role,
    scope = coalesce(public.project_vendors.scope, excluded.scope),
    status = 'active',
    notes = case
      when public.project_vendors.notes is null or public.project_vendors.notes = '' then excluded.notes
      else public.project_vendors.notes
    end,
    updated_at = now()
  returning id
  into v_project_vendor_id;

  insert into public.bid_awards (
    org_id,
    bid_package_id,
    awarded_submission_id,
    awarded_commitment_id,
    awarded_by,
    notes
  )
  values (
    p_org_id,
    v_package.id,
    v_submission.id,
    v_commitment.id,
    p_awarded_by,
    p_notes
  )
  returning *
  into v_award;

  update public.bid_packages
  set status = 'awarded', updated_at = now()
  where org_id = p_org_id
    and id = v_package.id;

  return jsonb_build_object(
    'award_id', v_award.id,
    'commitment_id', v_commitment.id,
    'bid_package_id', v_package.id,
    'project_vendor_id', v_project_vendor_id
  );
end;
$function$;
