-- Which job develops which phase.
--
-- A development job is an ordinary project: its budget, commitments, bills and
-- Books inventory already exist. Nothing said which phase it was developing, so
-- a Books development allocation could spread its cost onto any acquired lot in
-- the organization, and no screen could reconcile a phase's budget, contracts
-- and actual cost to the lots it delivers.
--
-- community_phases.development_project_id is that link. One phase has at most
-- one development job; one job may serve several phases (shared site work). The
-- job sits in the organization and the division of the phase's community, and
-- is not itself a home on a lot.
--
-- A Books development allocation now needs the link: proposing or posting one
-- refuses a project that develops no phase, and any lot outside the phases it
-- develops.

set local lock_timeout = '3s';

alter table public.community_phases
  add column if not exists development_project_id uuid references public.projects(id) on delete restrict;

create index if not exists community_phases_development_project_idx
  on public.community_phases (org_id, development_project_id) where development_project_id is not null;
create index if not exists community_phases_development_project_fk_idx
  on public.community_phases (development_project_id) where development_project_id is not null;

comment on column public.community_phases.development_project_id is
  'The project that develops this phase''s land (budget, contracts, actual cost). Development cost reaches only the lots of the phases a job develops.';

create or replace function public.guard_community_phase_development_project()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_project_org uuid;
  v_project_division uuid;
  v_community_division uuid;
begin
  if new.development_project_id is null
     or (tg_op = 'UPDATE' and new.development_project_id is not distinct from old.development_project_id
         and new.community_id is not distinct from old.community_id) then
    return new;
  end if;
  select p.org_id, p.division_id into v_project_org, v_project_division
    from public.projects p
   where p.id = new.development_project_id;
  if v_project_org is distinct from new.org_id then
    raise exception 'The development job is not in this organization' using errcode = '23503';
  end if;
  select c.division_id into v_community_division
    from public.communities c
   where c.id = new.community_id and c.org_id = new.org_id;
  if v_project_division is distinct from v_community_division then
    raise exception 'The development job must be in the community''s division' using errcode = '23514';
  end if;
  if exists (select 1 from public.lots l where l.org_id = new.org_id and l.project_id = new.development_project_id) then
    raise exception 'A home on a lot cannot be a development job' using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_community_phase_development_project() from public, anon, authenticated;

drop trigger if exists community_phases_development_project on public.community_phases;
create trigger community_phases_development_project
  before insert or update of development_project_id, community_id on public.community_phases
  for each row execute function public.guard_community_phase_development_project();

-- Why a development allocation may not reach these lots from this job, or null.
create or replace function public.books_development_allocation_refusal(p_org_id uuid, p_project_id uuid, p_lot_ids uuid[])
returns text
language sql
stable
set search_path = ''
as $$
  select case
    when not exists (
      select 1 from public.community_phases ph
       where ph.org_id = p_org_id and ph.development_project_id = p_project_id
    ) then 'Link this development job to the phases it develops before allocating its cost'
    when exists (
      select 1
        from unnest(p_lot_ids) as lot(id)
        left join public.lots l on l.org_id = p_org_id and l.id = lot.id
        left join public.community_phases ph
          on ph.org_id = p_org_id and ph.id = l.community_phase_id and ph.development_project_id = p_project_id
       where ph.id is null
    ) then 'Development cost reaches only lots in the phases this job develops'
  end;
$$;

revoke all on function public.books_development_allocation_refusal(uuid, uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.books_development_allocation_refusal(uuid, uuid, uuid[]) to service_role;

create or replace function public.propose_books_development_allocation(
  p_org_id uuid, p_project_id uuid, p_date date, p_reference text, p_basis text, p_total_cents bigint, p_weights jsonb, p_evidence_url text, p_note text, p_actor_id uuid
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_row jsonb; v_shares jsonb; v_id uuid; v_refusal text;
begin
  if not exists(select 1 from public.project_financial_settings where org_id = p_org_id and project_id = p_project_id and books_inventory_enabled) then
    raise exception 'The source project must hold owned development inventory';
  end if;
  if p_actor_id is null or not exists(select 1 from public.app_users where id = p_actor_id) then raise exception 'A preparer is required'; end if;
  if jsonb_typeof(p_weights) is distinct from 'array' or jsonb_array_length(p_weights) = 0 then raise exception 'Give each receiving lot its share of the basis'; end if;
  if (select count(*) from jsonb_array_elements(p_weights)) <> (select count(distinct value->>'lot_id') from jsonb_array_elements(p_weights)) then raise exception 'Name each lot once'; end if;
  for v_row in select value from jsonb_array_elements(p_weights) loop
    if coalesce((v_row->>'weight')::numeric, 0) <= 0 then raise exception 'Each lot''s basis must be positive'; end if;
    if not exists(select 1 from public.lots where org_id = p_org_id and id = (v_row->>'lot_id')::uuid) then raise exception 'A receiving lot is outside this organization'; end if;
  end loop;
  v_refusal := public.books_development_allocation_refusal(p_org_id, p_project_id,
    array(select (value->>'lot_id')::uuid from jsonb_array_elements(p_weights)));
  if v_refusal is not null then raise exception '%', v_refusal; end if;
  select jsonb_agg(jsonb_build_object('lot_id', s->>'key', 'weight', s->'weight', 'amount_cents', s->'amount_cents') order by s->>'key') into v_shares
    from jsonb_array_elements(public.books_allocation_shares(p_total_cents,
      (select jsonb_agg(jsonb_build_object('key', w->>'lot_id', 'weight', w->'weight')) from jsonb_array_elements(p_weights) w))) s;
  if (select sum((value->>'amount_cents')::bigint) from jsonb_array_elements(v_shares)) <> p_total_cents then raise exception 'Allocation shares must add to the total'; end if;
  insert into public.books_development_allocations(org_id, project_id, allocation_date, reference, basis, total_cents, shares, evidence_url, note, prepared_by)
  values (p_org_id, p_project_id, p_date, btrim(p_reference), p_basis, p_total_cents, v_shares, p_evidence_url, trim(p_note), p_actor_id)
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.propose_books_development_allocation(uuid,uuid,date,text,text,bigint,jsonb,text,text,uuid) from public, anon, authenticated;
grant execute on function public.propose_books_development_allocation(uuid,uuid,date,text,text,bigint,jsonb,text,text,uuid) to service_role;

-- Posting re-checks the link: a phase may have been relinked since the proposal.
create or replace function public.review_books_development_allocation(p_org_id uuid, p_allocation_id uuid, p_approve boolean, p_note text, p_actor_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v public.books_development_allocations%rowtype; v_entry uuid; v_refusal text;
begin
  select * into v from public.books_development_allocations where id = p_allocation_id and org_id = p_org_id for update;
  if not found then raise exception 'Development allocation not found'; end if;
  if v.status <> 'proposed' then raise exception 'This allocation has already been reviewed'; end if;
  if p_actor_id is null or p_actor_id = v.prepared_by then raise exception 'A development allocation is approved by someone other than the person who proposed it'; end if;
  if not p_approve and length(trim(coalesce(p_note, ''))) < 10 then raise exception 'Say why the allocation is rejected'; end if;
  if p_approve then
    v_refusal := public.books_development_allocation_refusal(p_org_id, v.project_id,
      array(select (value->>'lot_id')::uuid from jsonb_array_elements(v.shares)));
    if v_refusal is not null then raise exception '%', v_refusal; end if;
    v_entry := public.allocate_books_development_cost(p_org_id, v.project_id, v.allocation_date,
      (select jsonb_agg(jsonb_build_object('lot_id', value->>'lot_id', 'amount_cents', (value->>'amount_cents')::bigint)) from jsonb_array_elements(v.shares)),
      v.reference, v.evidence_url, p_actor_id);
  end if;
  update public.books_development_allocations set status = case when p_approve then 'approved' else 'rejected' end,
    reviewed_by = p_actor_id, reviewed_at = clock_timestamp(), review_note = nullif(trim(coalesce(p_note, '')), ''), journal_entry_id = v_entry
    where id = v.id;
  return jsonb_build_object('allocationId', v.id, 'projectId', v.project_id, 'status', case when p_approve then 'approved' else 'rejected' end, 'journalEntryId', v_entry);
end;
$$;
revoke all on function public.review_books_development_allocation(uuid,uuid,boolean,text,uuid) from public, anon, authenticated;
grant execute on function public.review_books_development_allocation(uuid,uuid,boolean,text,uuid) to service_role;
