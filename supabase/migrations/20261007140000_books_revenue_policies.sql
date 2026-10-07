-- B11.1: how a job earns revenue is a dated record, not whatever the project's
-- billing settings say today. A policy names the project (or one of its
-- contracts), the revenue recognition method, the billing method it was chosen
-- for, the date it takes effect and why. One person proposes it and a different
-- person approves it; rows are never edited or deleted, so earlier periods keep
-- the policy that was in force for them.
--
-- A job nobody has reviewed gets one `inferred` row, recorded by Arc from its
-- billing settings the first time it is projected. From then on the record, not
-- the settings, decides: changing a job's billing model later cannot quietly
-- change how its earlier documents earned revenue. Confirming or changing an
-- inferred policy goes through the same proposal and approval.

create table public.books_revenue_policies (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  contract_id uuid references public.contracts(id) on delete restrict,
  method text not null check (method in ('percentage_of_completion','closing')),
  billing_method text not null check (billing_method in ('fixed_price','cost_plus_percent','cost_plus_fixed_fee','cost_plus_gmp','time_and_materials','purchase_agreement')),
  effective_from date not null,
  rationale text not null check (length(trim(rationale)) between 10 and 4000),
  supersedes_id uuid references public.books_revenue_policies(id) on delete restrict,
  status text not null default 'proposed' check (status in ('inferred','proposed','approved','rejected')),
  prepared_by uuid references public.app_users(id),
  prepared_at timestamptz not null default clock_timestamp(),
  reviewed_by uuid references public.app_users(id),
  reviewed_at timestamptz,
  review_note text,
  constraint books_revenue_policies_review_check check ((status in ('inferred','proposed')) = (reviewed_by is null and reviewed_at is null)),
  constraint books_revenue_policies_preparer_check check ((status = 'inferred') = (prepared_by is null)),
  constraint books_revenue_policies_independent_check check (reviewed_by is null or reviewed_by <> prepared_by)
);
create index books_revenue_policies_scope_idx on public.books_revenue_policies (org_id, project_id, contract_id, effective_from desc);
create unique index books_revenue_policies_one_inferred_idx on public.books_revenue_policies (org_id, project_id, coalesce(contract_id, '00000000-0000-0000-0000-000000000000'::uuid)) where status = 'inferred';
create index books_revenue_policies_contract_idx on public.books_revenue_policies (contract_id) where contract_id is not null;
create index books_revenue_policies_prepared_by_idx on public.books_revenue_policies (prepared_by);
create index books_revenue_policies_reviewed_by_idx on public.books_revenue_policies (reviewed_by) where reviewed_by is not null;
create index books_revenue_policies_supersedes_idx on public.books_revenue_policies (supersedes_id) where supersedes_id is not null;
alter table public.books_revenue_policies enable row level security;
create policy books_revenue_policies_read on public.books_revenue_policies
  for select to authenticated using (public.has_org_permission(org_id, 'books.read'));
grant select on public.books_revenue_policies to authenticated;

-- Only the review decision is ever written after a policy is proposed, once.
create or replace function public.books_guard_revenue_policy()
returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'DELETE' then raise exception 'Revenue policies are kept; propose a new one to change a policy'; end if;
  if old.status <> 'proposed' then raise exception 'A recorded revenue policy cannot change; propose a new one'; end if;
  if (new.org_id, new.project_id, new.contract_id, new.method, new.billing_method, new.effective_from, new.rationale, new.supersedes_id, new.prepared_by, new.prepared_at)
    is distinct from (old.org_id, old.project_id, old.contract_id, old.method, old.billing_method, old.effective_from, old.rationale, old.supersedes_id, old.prepared_by, old.prepared_at) then
    raise exception 'Only the review decision of a revenue policy can be recorded';
  end if;
  return new;
end;
$$;
revoke all on function public.books_guard_revenue_policy() from public, anon, authenticated;
create trigger books_revenue_policies_guard before update or delete on public.books_revenue_policies
  for each row execute function public.books_guard_revenue_policy();

create or replace function public.propose_books_revenue_policy(
  p_org_id uuid, p_project_id uuid, p_contract_id uuid, p_method text, p_billing_method text,
  p_effective_from date, p_rationale text, p_actor_id uuid
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_prior uuid; v_id uuid;
begin
  perform 1 from public.projects where id = p_project_id and org_id = p_org_id for update;
  if not found then raise exception 'Project is outside this organization'; end if;
  if p_actor_id is null or not exists(select 1 from public.app_users where id = p_actor_id) then raise exception 'A preparer is required'; end if;
  if p_contract_id is not null and not exists(select 1 from public.contracts where id = p_contract_id and org_id = p_org_id and project_id = p_project_id and parent_contract_id is null) then
    raise exception 'The contract is not one of this project''s contracts';
  end if;
  if exists(select 1 from public.books_revenue_policies where org_id = p_org_id and project_id = p_project_id and contract_id is not distinct from p_contract_id and status = 'proposed') then
    raise exception 'A proposed policy for this job is already waiting for review';
  end if;
  select id into v_prior from public.books_revenue_policies
    where org_id = p_org_id and project_id = p_project_id and contract_id is not distinct from p_contract_id and status = 'approved' and effective_from <= p_effective_from
    order by effective_from desc, reviewed_at desc, id desc limit 1;
  insert into public.books_revenue_policies(org_id, project_id, contract_id, method, billing_method, effective_from, rationale, supersedes_id, prepared_by)
  values (p_org_id, p_project_id, p_contract_id, p_method, p_billing_method, p_effective_from, trim(p_rationale), v_prior, p_actor_id)
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.propose_books_revenue_policy(uuid,uuid,uuid,text,text,date,text,uuid) from public, anon, authenticated;
grant execute on function public.propose_books_revenue_policy(uuid,uuid,uuid,text,text,date,text,uuid) to service_role;

create or replace function public.review_books_revenue_policy(p_org_id uuid, p_policy_id uuid, p_approve boolean, p_note text, p_actor_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_policy public.books_revenue_policies%rowtype;
begin
  select * into v_policy from public.books_revenue_policies where id = p_policy_id and org_id = p_org_id for update;
  if not found then raise exception 'Revenue policy not found'; end if;
  if v_policy.status <> 'proposed' then raise exception 'This revenue policy has already been reviewed'; end if;
  if p_actor_id is null or not exists(select 1 from public.app_users where id = p_actor_id) then raise exception 'A reviewer is required'; end if;
  if p_actor_id = v_policy.prepared_by then raise exception 'A revenue policy is approved by someone other than the person who proposed it'; end if;
  if not p_approve and length(trim(coalesce(p_note, ''))) < 10 then raise exception 'Say why the policy is rejected'; end if;
  update public.books_revenue_policies
    set status = case when p_approve then 'approved' else 'rejected' end, reviewed_by = p_actor_id, reviewed_at = clock_timestamp(), review_note = nullif(trim(coalesce(p_note, '')), '')
    where id = p_policy_id;
  return jsonb_build_object('policyId', p_policy_id, 'status', case when p_approve then 'approved' else 'rejected' end, 'projectId', v_policy.project_id);
end;
$$;
revoke all on function public.review_books_revenue_policy(uuid,uuid,boolean,text,uuid) from public, anon, authenticated;
grant execute on function public.review_books_revenue_policy(uuid,uuid,boolean,text,uuid) to service_role;

-- The inferred baselines for jobs that have none: one per project, or one per
-- contract when the project has several. Never replaces a recorded policy.
create or replace function public.record_books_inferred_revenue_policies(p_org_id uuid, p_policies jsonb)
returns integer language plpgsql security definer set search_path = public as $$
declare v_row jsonb; v_count integer := 0;
begin
  if jsonb_typeof(p_policies) is distinct from 'array' then raise exception 'Inferred policies must be an array'; end if;
  for v_row in select value from jsonb_array_elements(p_policies) loop
    if not exists(select 1 from public.projects where id = (v_row->>'project_id')::uuid and org_id = p_org_id) then raise exception 'Project is outside this organization'; end if;
    if v_row->>'contract_id' is not null and not exists(select 1 from public.contracts where id = (v_row->>'contract_id')::uuid and org_id = p_org_id and project_id = (v_row->>'project_id')::uuid) then
      raise exception 'Contract is outside this project';
    end if;
    if exists(select 1 from public.books_revenue_policies where org_id = p_org_id and project_id = (v_row->>'project_id')::uuid
      and contract_id is not distinct from nullif(v_row->>'contract_id','')::uuid and status in ('inferred','approved')) then continue; end if;
    insert into public.books_revenue_policies(org_id, project_id, contract_id, method, billing_method, effective_from, rationale, status)
    values (p_org_id, (v_row->>'project_id')::uuid, nullif(v_row->>'contract_id','')::uuid, v_row->>'method', v_row->>'billing_method', '1900-01-01',
      'Inferred by Arc from the billing settings when the job was first posted. Not yet reviewed.', 'inferred')
    on conflict do nothing;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;
revoke all on function public.record_books_inferred_revenue_policies(uuid,jsonb) from public, anon, authenticated;
grant execute on function public.record_books_inferred_revenue_policies(uuid,jsonb) to service_role;
