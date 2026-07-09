-- Bid awards now carry the winning submission's line-item breakdown into the
-- commitment as its schedule of values, instead of always collapsing to a
-- single lump-sum line. The breakdown is only trusted when its sum matches the
-- awarded total; otherwise we keep the lump-sum fallback so the commitment
-- total never drifts from the award.
create or replace function public.run_bid_award_conversion(
  p_org_id uuid,
  p_bid_submission_id uuid,
  p_awarded_by uuid default null::uuid,
  p_notes text default null::text
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_submission public.bid_submissions%rowtype;
  v_invite public.bid_invites%rowtype;
  v_package public.bid_packages%rowtype;
  v_existing_award public.bid_awards%rowtype;
  v_commitment public.commitments%rowtype;
  v_award public.bid_awards%rowtype;
  v_project_vendor_id uuid;
  v_line jsonb;
  v_line_index integer := 0;
  v_lines_sum bigint := 0;
  v_use_breakdown boolean := false;
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
      'budget_line_id', v_package.budget_line_id,
      'awarded_notes', p_notes
    )
  )
  returning *
  into v_commitment;

  -- Prefer the submission's own breakdown when it reconciles to the total.
  if jsonb_typeof(v_submission.line_items) = 'array' and jsonb_array_length(v_submission.line_items) > 0 then
    select coalesce(sum((item->>'amount_cents')::bigint), 0)
    into v_lines_sum
    from jsonb_array_elements(v_submission.line_items) as item
    where (item->>'amount_cents') ~ '^-?[0-9]+$';

    v_use_breakdown := v_lines_sum = v_submission.total_cents;
  end if;

  if v_use_breakdown then
    for v_line in select * from jsonb_array_elements(v_submission.line_items)
    loop
      insert into public.commitment_lines (
        org_id,
        commitment_id,
        cost_code_id,
        budget_line_id,
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
        v_package.budget_line_id,
        coalesce(nullif(v_line->>'description', ''), v_package.title),
        1,
        'LS',
        (v_line->>'amount_cents')::integer,
        v_line_index,
        jsonb_build_object(
          'source', 'bid_award',
          'bid_package_id', v_package.id,
          'bid_submission_id', v_submission.id,
          'submission_line_notes', v_line->>'notes'
        )
      );
      v_line_index := v_line_index + 1;
    end loop;
  elsif v_package.cost_code_id is not null or v_package.budget_line_id is not null then
    insert into public.commitment_lines (
      org_id,
      commitment_id,
      cost_code_id,
      budget_line_id,
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
      v_package.budget_line_id,
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
$$;
