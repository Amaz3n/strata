-- Workstream 07 Phase 1: controlled, zero-sum budget transfers.

alter table public.budget_revisions
  drop constraint if exists budget_revisions_revision_type_check;
alter table public.budget_revisions
  add constraint budget_revisions_revision_type_check
  check (revision_type in ('change_order', 'transfer', 'adjustment'));

create table if not exists public.budget_transfers (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  transfer_number integer not null,
  reason text not null,
  status text not null default 'draft'
    check (status in ('draft','pending_approval','approved','rejected','void')),
  requested_by uuid references public.app_users(id) on delete set null,
  approved_by uuid references public.app_users(id) on delete set null,
  approved_at timestamptz,
  budget_revision_id uuid references public.budget_revisions(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, transfer_number)
);

create table if not exists public.budget_transfer_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  transfer_id uuid not null references public.budget_transfers(id) on delete cascade,
  budget_line_id uuid not null references public.budget_lines(id) on delete restrict,
  amount_cents integer not null
);

create index if not exists budget_transfers_org_project_idx
  on public.budget_transfers (org_id, project_id, created_at desc);
create index if not exists budget_transfer_lines_org_transfer_idx
  on public.budget_transfer_lines (org_id, transfer_id);
create index if not exists budget_transfer_lines_budget_line_idx
  on public.budget_transfer_lines (budget_line_id);

drop trigger if exists budget_transfers_set_updated_at on public.budget_transfers;
create trigger budget_transfers_set_updated_at before update on public.budget_transfers
  for each row execute function public.tg_set_updated_at();

alter table public.budget_transfers enable row level security;
alter table public.budget_transfer_lines enable row level security;

drop policy if exists budget_transfers_org_access on public.budget_transfers;
create policy budget_transfers_org_access on public.budget_transfers for all to authenticated
  using (public.is_org_member(org_id)) with check (public.is_org_member(org_id));
drop policy if exists budget_transfer_lines_org_access on public.budget_transfer_lines;
create policy budget_transfer_lines_org_access on public.budget_transfer_lines for all to authenticated
  using (public.is_org_member(org_id)) with check (public.is_org_member(org_id));

create or replace function public.next_budget_transfer_number(p_project_id uuid)
returns integer language sql set search_path = public, pg_catalog as $$
  select coalesce(max(transfer_number), 0) + 1
  from public.budget_transfers where project_id = p_project_id;
$$;

create or replace function public.post_budget_transfer(p_transfer_id uuid, p_actor_id uuid)
returns uuid
language plpgsql
security invoker
set search_path = public, pg_catalog
as $$
declare
  v_transfer public.budget_transfers%rowtype;
  v_revision_id uuid;
  v_line_count integer;
  v_line_total bigint;
begin
  select * into v_transfer
  from public.budget_transfers
  where id = p_transfer_id
  for update;

  if not found then raise exception 'Budget transfer not found'; end if;
  if v_transfer.status <> 'pending_approval' then
    raise exception 'Only pending budget transfers can be approved';
  end if;

  select count(*), coalesce(sum(amount_cents), 0)
    into v_line_count, v_line_total
  from public.budget_transfer_lines
  where transfer_id = p_transfer_id and org_id = v_transfer.org_id;
  if v_line_count < 2 or v_line_total <> 0 then
    raise exception 'Budget transfer lines must contain at least two lines and net to zero';
  end if;

  insert into public.budget_revisions
    (org_id, project_id, revision_type, status, title, total_cents, posted_by, posted_at, metadata)
  values
    (v_transfer.org_id, v_transfer.project_id, 'transfer', 'posted',
     'Budget transfer #' || v_transfer.transfer_number || ': ' || v_transfer.reason,
     0, p_actor_id, now(), jsonb_build_object('budget_transfer_id', v_transfer.id))
  returning id into v_revision_id;

  insert into public.budget_revision_lines
    (org_id, budget_revision_id, cost_code_id, budget_line_id, description,
     amount_cents, sort_order, metadata)
  select
    v_transfer.org_id, v_revision_id, bl.cost_code_id, tl.budget_line_id,
    bl.description, tl.amount_cents,
    row_number() over (order by tl.id)::integer - 1,
    jsonb_build_object('budget_transfer_id', v_transfer.id)
  from public.budget_transfer_lines tl
  join public.budget_lines bl on bl.id = tl.budget_line_id and bl.org_id = v_transfer.org_id
  where tl.transfer_id = v_transfer.id and tl.org_id = v_transfer.org_id;

  update public.budget_transfers
  set status = 'approved', approved_by = p_actor_id, approved_at = now(),
      budget_revision_id = v_revision_id
  where id = v_transfer.id;

  return v_revision_id;
end;
$$;

grant all on table public.budget_transfers, public.budget_transfer_lines to authenticated, service_role;
grant execute on function public.next_budget_transfer_number(uuid) to authenticated, service_role;
revoke all on function public.post_budget_transfer(uuid, uuid) from public, anon;
grant execute on function public.post_budget_transfer(uuid, uuid) to authenticated, service_role;

insert into public.permissions (key, description) values
  ('budget.approve', 'Approve and post budget transfers')
on conflict (key) do update set description = excluded.description;

insert into public.role_permissions (role_id, permission_key)
select id, 'budget.approve' from public.roles
where key in ('org_owner', 'org_admin', 'org_office_admin', 'org_project_lead', 'pm')
on conflict (role_id, permission_key) do nothing;
