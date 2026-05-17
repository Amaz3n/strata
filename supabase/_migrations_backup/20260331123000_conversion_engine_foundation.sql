create table if not exists public.conversion_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  conversion_type text not null,
  source_entity_type text not null,
  source_entity_id uuid not null,
  target_entity_type text,
  target_entity_id uuid,
  project_id uuid references public.projects(id) on delete set null,
  status text not null default 'pending' check (status in ('pending', 'running', 'completed', 'failed')),
  triggered_by uuid references public.app_users(id) on delete set null,
  error_message text,
  metadata jsonb not null default '{}'::jsonb,
  result jsonb not null default '{}'::jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.conversion_run_steps (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  conversion_run_id uuid not null references public.conversion_runs(id) on delete cascade,
  step_key text not null,
  status text not null default 'pending' check (status in ('pending', 'running', 'completed', 'failed')),
  details jsonb not null default '{}'::jsonb,
  error_message text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (conversion_run_id, step_key)
);

create index if not exists conversion_runs_org_status_idx on public.conversion_runs (org_id, status, created_at desc);
create index if not exists conversion_runs_source_idx on public.conversion_runs (org_id, source_entity_type, source_entity_id);
create index if not exists conversion_runs_project_idx on public.conversion_runs (project_id, created_at desc);
create index if not exists conversion_run_steps_run_idx on public.conversion_run_steps (conversion_run_id, created_at asc);
create index if not exists conversion_run_steps_org_status_idx on public.conversion_run_steps (org_id, status, created_at desc);

alter table public.conversion_runs enable row level security;
alter table public.conversion_run_steps enable row level security;

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'conversion_runs'
      and policyname = 'conversion_runs_access'
  ) then
    create policy conversion_runs_access
      on public.conversion_runs
      for all
      using ((auth.role() = 'service_role'::text) or public.is_org_member(org_id))
      with check ((auth.role() = 'service_role'::text) or public.is_org_member(org_id));
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'conversion_run_steps'
      and policyname = 'conversion_run_steps_access'
  ) then
    create policy conversion_run_steps_access
      on public.conversion_run_steps
      for all
      using ((auth.role() = 'service_role'::text) or public.is_org_member(org_id))
      with check ((auth.role() = 'service_role'::text) or public.is_org_member(org_id));
  end if;
end
$$;

drop trigger if exists conversion_runs_set_updated_at on public.conversion_runs;
create trigger conversion_runs_set_updated_at
  before update on public.conversion_runs
  for each row execute function public.tg_set_updated_at();

drop trigger if exists conversion_run_steps_set_updated_at on public.conversion_run_steps;
create trigger conversion_run_steps_set_updated_at
  before update on public.conversion_run_steps
  for each row execute function public.tg_set_updated_at();

create or replace function public.run_proposal_acceptance_conversion(
  p_org_id uuid,
  p_proposal_id uuid,
  p_project_id uuid,
  p_signature_data jsonb,
  p_executed_file_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_proposal public.proposals%rowtype;
  v_contract public.contracts%rowtype;
  v_budget_id uuid;
  v_budget_status text;
  v_signed_at timestamptz;
  v_effective_date date;
  v_contract_created boolean := false;
  v_budget_created boolean := false;
  v_allowance_count integer := 0;
  v_project_opportunity_id uuid;
begin
  if p_project_id is null then
    raise exception 'Project is required for proposal acceptance';
  end if;

  select *
  into v_proposal
  from public.proposals
  where org_id = p_org_id
    and id = p_proposal_id
  for update;

  if not found then
    raise exception 'Proposal not found';
  end if;

  if v_proposal.valid_until is not null
    and v_proposal.valid_until < current_date
    and coalesce(v_proposal.status, 'draft') <> 'accepted' then
    raise exception 'Proposal has expired';
  end if;

  v_signed_at := coalesce((p_signature_data ->> 'signed_at')::timestamptz, now());
  v_effective_date := v_signed_at::date;

  update public.proposals
  set
    project_id = p_project_id,
    signature_data = coalesce(p_signature_data, signature_data),
    status = case when status = 'accepted' then status else 'accepted' end,
    accepted_at = case when status = 'accepted' then accepted_at else v_signed_at end,
    updated_at = now()
  where org_id = p_org_id
    and id = p_proposal_id
  returning *
  into v_proposal;

  select *
  into v_contract
  from public.contracts
  where org_id = p_org_id
    and proposal_id = p_proposal_id
  order by created_at desc
  limit 1
  for update;

  if not found then
    insert into public.contracts (
      org_id,
      project_id,
      proposal_id,
      number,
      title,
      status,
      total_cents,
      currency,
      signed_at,
      effective_date,
      terms,
      signature_data,
      snapshot
    )
    values (
      p_org_id,
      p_project_id,
      p_proposal_id,
      concat('C-', coalesce(nullif(regexp_replace(coalesce(v_proposal.number, ''), '^P-?', ''), ''), left(v_proposal.id::text, 6))),
      coalesce(v_proposal.title, 'Contract'),
      'active',
      v_proposal.total_cents,
      coalesce(v_proposal.currency, 'usd'),
      v_signed_at,
      v_effective_date,
      v_proposal.terms,
      p_signature_data,
      coalesce(v_proposal.snapshot, '{}'::jsonb)
        || case
          when p_executed_file_id is null then '{}'::jsonb
          else jsonb_build_object(
            'esign',
            jsonb_build_object(
              'executed_file_id', p_executed_file_id,
              'source', p_signature_data ->> 'source',
              'envelope_id', p_signature_data ->> 'envelope_id',
              'document_id', p_signature_data ->> 'document_id'
            )
          )
        end
    )
    returning *
    into v_contract;

    v_contract_created := true;
  else
    update public.contracts
    set
      project_id = p_project_id,
      status = case when status = 'draft' then 'active' else status end,
      total_cents = coalesce(v_proposal.total_cents, total_cents),
      signed_at = coalesce(signed_at, v_signed_at),
      effective_date = coalesce(effective_date, v_effective_date),
      terms = coalesce(v_proposal.terms, terms),
      signature_data = coalesce(p_signature_data, signature_data),
      snapshot = coalesce(snapshot, '{}'::jsonb)
        || coalesce(v_proposal.snapshot, '{}'::jsonb)
        || case
          when p_executed_file_id is null then '{}'::jsonb
          else jsonb_build_object(
            'esign',
            jsonb_build_object(
              'executed_file_id', p_executed_file_id,
              'source', p_signature_data ->> 'source',
              'envelope_id', p_signature_data ->> 'envelope_id',
              'document_id', p_signature_data ->> 'document_id'
            )
          )
        end,
      updated_at = now()
    where id = v_contract.id
    returning *
    into v_contract;
  end if;

  update public.draw_schedules
  set contract_id = v_contract.id, updated_at = now()
  where org_id = p_org_id
    and project_id = p_project_id
    and contract_id is null;

  if p_executed_file_id is not null
    and not exists (
      select 1
      from public.file_links
      where org_id = p_org_id
        and file_id = p_executed_file_id
        and entity_type = 'contract'
        and entity_id = v_contract.id
        and coalesce(link_role, '') = 'executed_contract'
    ) then
    insert into public.file_links (
      org_id,
      file_id,
      project_id,
      entity_type,
      entity_id,
      created_by,
      link_role
    )
    values (
      p_org_id,
      p_executed_file_id,
      p_project_id,
      'contract',
      v_contract.id,
      null,
      'executed_contract'
    );
  end if;

  select id, status
  into v_budget_id, v_budget_status
  from public.budgets
  where org_id = p_org_id
    and project_id = p_project_id
    and metadata ->> 'source_proposal_id' = p_proposal_id::text
  order by created_at desc
  limit 1
  for update;

  if v_budget_id is null then
    insert into public.budgets (
      org_id,
      project_id,
      status,
      total_cents,
      currency,
      metadata
    )
    values (
      p_org_id,
      p_project_id,
      'approved',
      coalesce((
        select sum((coalesce(unit_cost_cents, 0) * coalesce(quantity, 1))::integer)
        from public.proposal_lines
        where proposal_id = p_proposal_id
          and line_type <> 'section'
          and (coalesce(is_optional, false) = false or coalesce(is_selected, true) = true)
      ), 0),
      'usd',
      jsonb_build_object(
        'source', 'proposal_acceptance',
        'source_proposal_id', p_proposal_id,
        'source_contract_id', v_contract.id
      )
    )
    returning id, status
    into v_budget_id, v_budget_status;

    v_budget_created := true;
  elsif v_budget_status = 'locked' then
    raise exception 'Budget is locked and cannot be updated from proposal acceptance';
  else
    update public.budgets
    set
      status = case when status = 'locked' then status else 'approved' end,
      total_cents = coalesce((
        select sum((coalesce(unit_cost_cents, 0) * coalesce(quantity, 1))::integer)
        from public.proposal_lines
        where proposal_id = p_proposal_id
          and line_type <> 'section'
          and (coalesce(is_optional, false) = false or coalesce(is_selected, true) = true)
      ), 0),
      metadata = coalesce(metadata, '{}'::jsonb)
        || jsonb_build_object(
          'source', 'proposal_acceptance',
          'source_proposal_id', p_proposal_id,
          'source_contract_id', v_contract.id
        ),
      updated_at = now()
    where id = v_budget_id;
  end if;

  delete from public.budget_lines
  where budget_id = v_budget_id
    and metadata ->> 'source_proposal_id' = p_proposal_id::text;

  insert into public.budget_lines (
    org_id,
    budget_id,
    cost_code_id,
    description,
    amount_cents,
    metadata,
    sort_order
  )
  select
    p_org_id,
    v_budget_id,
    line.cost_code_id,
    line.description,
    (coalesce(line.unit_cost_cents, 0) * coalesce(line.quantity, 1))::integer,
    jsonb_build_object(
      'source', 'proposal_acceptance',
      'source_proposal_id', p_proposal_id,
      'source_proposal_line_id', line.id,
      'line_type', line.line_type
    ),
    coalesce(line.sort_order, 0)
  from public.proposal_lines line
  where line.proposal_id = p_proposal_id
    and line.line_type <> 'section'
    and (coalesce(line.is_optional, false) = false or coalesce(line.is_selected, true) = true);

  insert into public.allowances (
    org_id,
    project_id,
    contract_id,
    name,
    budget_cents,
    metadata
  )
  select
    p_org_id,
    p_project_id,
    v_contract.id,
    line.description,
    coalesce(line.allowance_cents, (coalesce(line.unit_cost_cents, 0) * coalesce(line.quantity, 1))::integer),
    jsonb_build_object(
      'source', 'proposal_acceptance',
      'source_proposal_id', p_proposal_id,
      'source_proposal_line_id', line.id
    )
  from public.proposal_lines line
  where line.proposal_id = p_proposal_id
    and line.line_type = 'allowance'
    and not exists (
      select 1
      from public.allowances allowance
      where allowance.org_id = p_org_id
        and allowance.project_id = p_project_id
        and allowance.contract_id = v_contract.id
        and allowance.metadata ->> 'source_proposal_line_id' = line.id::text
    );

  get diagnostics v_allowance_count = row_count;

  update public.projects
  set
    status = case when status in ('planning', 'bidding', 'on_hold') then 'active' else status end,
    total_value = coalesce(v_proposal.total_cents, total_value),
    updated_at = now()
  where org_id = p_org_id
    and id = p_project_id;

  select opportunity_id
  into v_project_opportunity_id
  from public.projects
  where org_id = p_org_id
    and id = p_project_id;

  if v_project_opportunity_id is not null then
    update public.opportunities
    set status = 'won', updated_at = now()
    where org_id = p_org_id
      and id = v_project_opportunity_id
      and status <> 'won';

    update public.proposals
    set opportunity_id = v_project_opportunity_id
    where org_id = p_org_id
      and id = p_proposal_id
      and opportunity_id is distinct from v_project_opportunity_id;
  end if;

  return jsonb_build_object(
    'proposal_id', v_proposal.id,
    'project_id', p_project_id,
    'contract_id', v_contract.id,
    'budget_id', v_budget_id,
    'contract_created_now', v_contract_created,
    'budget_created_now', v_budget_created,
    'allowance_count', v_allowance_count
  );
end;
$function$;

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
      'awarded_notes', p_notes
    )
  )
  returning *
  into v_commitment;

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

update public.estimates as estimate
set opportunity_id = project.opportunity_id
from public.projects as project
where estimate.project_id = project.id
  and estimate.org_id = project.org_id
  and estimate.opportunity_id is null
  and project.opportunity_id is not null;

update public.proposals as proposal
set opportunity_id = project.opportunity_id
from public.projects as project
where proposal.project_id = project.id
  and proposal.org_id = project.org_id
  and proposal.opportunity_id is null
  and project.opportunity_id is not null;

insert into public.project_vendors (
  org_id,
  project_id,
  company_id,
  role,
  scope,
  status,
  notes
)
select
  bp.org_id,
  bp.project_id,
  bi.company_id,
  'subcontractor',
  coalesce(bp.trade, bp.title),
  'active',
  'Backfilled from awarded bid'
from public.bid_awards ba
join public.bid_packages bp on bp.id = ba.bid_package_id and bp.org_id = ba.org_id
join public.bid_submissions bs on bs.id = ba.awarded_submission_id and bs.org_id = ba.org_id
join public.bid_invites bi on bi.id = bs.bid_invite_id and bi.org_id = ba.org_id
where ba.awarded_commitment_id is not null
on conflict (project_id, company_id) do nothing;
