-- B11.3: shared development cost reaches lots only through a reviewed allocation.
-- A proposal states the basis (equal per lot, front footage, square footage,
-- sales value, or a custom schedule), each lot's weight and the total; the
-- database computes each lot's share in exact cents (largest remainder, ties by
-- lot), so the shares always add back to the total. A different person approves
-- it, and only then does it post. Proposals are never edited; a correction is a
-- new proposal.

create table public.books_development_allocations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  allocation_date date not null,
  reference text not null check (length(btrim(reference)) between 3 and 120),
  basis text not null check (basis in ('equal','front_footage','square_footage','sales_value','custom')),
  total_cents bigint not null check (total_cents > 0),
  shares jsonb not null check (jsonb_typeof(shares) = 'array' and jsonb_array_length(shares) between 1 and 250),
  evidence_url text not null check (evidence_url like 'https://%'),
  note text not null check (length(trim(note)) between 10 and 4000),
  status text not null default 'proposed' check (status in ('proposed','approved','rejected')),
  prepared_by uuid not null references public.app_users(id),
  prepared_at timestamptz not null default clock_timestamp(),
  reviewed_by uuid references public.app_users(id),
  reviewed_at timestamptz,
  review_note text,
  journal_entry_id uuid references public.journal_entries(id) on delete restrict,
  constraint books_development_allocations_review_check check ((status = 'proposed') = (reviewed_by is null)),
  constraint books_development_allocations_independent_check check (reviewed_by is null or reviewed_by <> prepared_by),
  unique (org_id, reference)
);
create index books_development_allocations_project_idx on public.books_development_allocations (org_id, project_id, prepared_at desc);
create index books_development_allocations_prepared_by_idx on public.books_development_allocations (prepared_by);
create index books_development_allocations_reviewed_by_idx on public.books_development_allocations (reviewed_by) where reviewed_by is not null;
create index books_development_allocations_entry_idx on public.books_development_allocations (journal_entry_id) where journal_entry_id is not null;
alter table public.books_development_allocations enable row level security;
create policy books_development_allocations_read on public.books_development_allocations
  for select to authenticated using (public.has_org_permission(org_id, 'books.read'));
grant select on public.books_development_allocations to authenticated;

create or replace function public.books_guard_development_allocation()
returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'DELETE' then raise exception 'Development allocations are kept; propose a correction instead'; end if;
  if old.status <> 'proposed' then raise exception 'A reviewed development allocation cannot change'; end if;
  if (new.org_id, new.project_id, new.allocation_date, new.reference, new.basis, new.total_cents, new.shares, new.evidence_url, new.note, new.prepared_by, new.prepared_at)
    is distinct from (old.org_id, old.project_id, old.allocation_date, old.reference, old.basis, old.total_cents, old.shares, old.evidence_url, old.note, old.prepared_by, old.prepared_at) then
    raise exception 'Only the review decision of a development allocation can be recorded';
  end if;
  return new;
end;
$$;
revoke all on function public.books_guard_development_allocation() from public, anon, authenticated;
create trigger books_development_allocations_guard before update or delete on public.books_development_allocations
  for each row execute function public.books_guard_development_allocation();

-- Exact shares by largest remainder: floor of each weighted share, then one more
-- cent to the largest remainders (ties by lot id) until the total is reached.
create or replace function public.books_allocation_shares(p_total bigint, p_weights jsonb)
returns jsonb language sql immutable set search_path = public as $$
  with w as (
    select value->>'lot_id' as lot_id, (value->>'weight')::numeric as weight from jsonb_array_elements(p_weights)
  ), t as (select sum(weight) as total_weight from w), raw as (
    select w.lot_id, w.weight, floor(p_total * w.weight / t.total_weight)::bigint as base, (p_total * w.weight / t.total_weight) - floor(p_total * w.weight / t.total_weight) as remainder from w, t
  ), ranked as (
    select raw.*, row_number() over (order by remainder desc, lot_id) as rank, p_total - sum(base) over () as leftover from raw
  )
  select coalesce(jsonb_agg(jsonb_build_object('lot_id', lot_id, 'weight', weight, 'amount_cents', base + case when rank <= leftover then 1 else 0 end) order by lot_id), '[]'::jsonb) from ranked;
$$;

create or replace function public.propose_books_development_allocation(
  p_org_id uuid, p_project_id uuid, p_date date, p_reference text, p_basis text, p_total_cents bigint, p_weights jsonb, p_evidence_url text, p_note text, p_actor_id uuid
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_row jsonb; v_shares jsonb; v_id uuid;
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
  v_shares := public.books_allocation_shares(p_total_cents, p_weights);
  if (select sum((value->>'amount_cents')::bigint) from jsonb_array_elements(v_shares)) <> p_total_cents then raise exception 'Allocation shares must add to the total'; end if;
  insert into public.books_development_allocations(org_id, project_id, allocation_date, reference, basis, total_cents, shares, evidence_url, note, prepared_by)
  values (p_org_id, p_project_id, p_date, btrim(p_reference), p_basis, p_total_cents, v_shares, p_evidence_url, trim(p_note), p_actor_id)
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.propose_books_development_allocation(uuid,uuid,date,text,text,bigint,jsonb,text,text,uuid) from public, anon, authenticated;
grant execute on function public.propose_books_development_allocation(uuid,uuid,date,text,text,bigint,jsonb,text,text,uuid) to service_role;

create or replace function public.review_books_development_allocation(p_org_id uuid, p_allocation_id uuid, p_approve boolean, p_note text, p_actor_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v public.books_development_allocations%rowtype; v_entry uuid;
begin
  select * into v from public.books_development_allocations where id = p_allocation_id and org_id = p_org_id for update;
  if not found then raise exception 'Development allocation not found'; end if;
  if v.status <> 'proposed' then raise exception 'This allocation has already been reviewed'; end if;
  if p_actor_id is null or p_actor_id = v.prepared_by then raise exception 'A development allocation is approved by someone other than the person who proposed it'; end if;
  if not p_approve and length(trim(coalesce(p_note, ''))) < 10 then raise exception 'Say why the allocation is rejected'; end if;
  if p_approve then
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
