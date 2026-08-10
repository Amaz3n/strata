-- Durable user-owned payables views and a transaction-safe bulk approval path.

create table if not exists public.saved_payable_views (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  user_id uuid not null references public.app_users(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  scope text not null check (scope in ('org', 'project')),
  project_id uuid references public.projects(id) on delete cascade,
  filters jsonb not null default '{}'::jsonb check (jsonb_typeof(filters) = 'object'),
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((scope = 'project' and project_id is not null) or (scope = 'org' and project_id is null)),
  unique nulls not distinct (org_id, user_id, scope, project_id, name)
);

create index if not exists saved_payable_views_user_idx
  on public.saved_payable_views (org_id, user_id, scope, project_id, updated_at desc);
create unique index if not exists saved_payable_views_one_default_idx
  on public.saved_payable_views (org_id, user_id, scope, coalesce(project_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where is_default;

alter table public.saved_payable_views enable row level security;
drop policy if exists saved_payable_views_owner_access on public.saved_payable_views;
create policy saved_payable_views_owner_access on public.saved_payable_views
  for all to authenticated
  using (
    user_id = (select auth.uid())
    and public.has_org_permission(org_id, 'bill.read')
  )
  with check (
    user_id = (select auth.uid())
    and public.has_org_permission(org_id, 'bill.read')
  );
grant select, insert, update, delete on public.saved_payable_views to authenticated;
grant all on public.saved_payable_views to service_role;
drop trigger if exists saved_payable_views_set_updated_at on public.saved_payable_views;
create trigger saved_payable_views_set_updated_at before update on public.saved_payable_views
  for each row execute function public.tg_set_updated_at();

create or replace function public.approve_vendor_bills_atomic(
  p_org_id uuid,
  p_actor_id uuid,
  p_items jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_requested integer;
  v_locked integer;
  v_now timestamptz := now();
  v_bill record;
begin
  if jsonb_typeof(p_items) <> 'array' then raise exception 'Approval items must be an array'; end if;
  v_requested := jsonb_array_length(p_items);
  if v_requested < 1 or v_requested > 500 then raise exception 'Bulk approval requires between 1 and 500 bills'; end if;
  if (select count(distinct item->>'id') from jsonb_array_elements(p_items) item) <> v_requested then
    raise exception 'Bulk approval contains duplicate bills';
  end if;

  -- Lock in a stable order. Any failed validation raises and rolls back every row.
  perform b.id
  from public.vendor_bills b
  join jsonb_array_elements(p_items) item on item->>'id' = b.id::text
  where b.org_id = p_org_id
  order by b.id
  for update;
  get diagnostics v_locked = row_count;
  if v_locked <> v_requested then raise exception 'One or more payables no longer exist'; end if;

  for v_bill in
    select b.*, item->>'expected_updated_at' as expected_updated_at
    from public.vendor_bills b
    join jsonb_array_elements(p_items) item on item->>'id' = b.id::text
    where b.org_id = p_org_id
    order by b.id
  loop
    if v_bill.status <> 'pending' then raise exception 'Payable % is no longer pending', coalesce(v_bill.bill_number, v_bill.id::text); end if;
    if v_bill.expected_updated_at is not null and v_bill.updated_at <> v_bill.expected_updated_at::timestamptz then
      raise exception 'Payable % changed since it was selected', coalesce(v_bill.bill_number, v_bill.id::text);
    end if;
    if coalesce(v_bill.metadata->>'source', '') = 'vendor_credit' then raise exception 'Vendor credits cannot be approved for payment'; end if;
    if not exists (select 1 from public.bill_lines l where l.org_id = p_org_id and l.bill_id = v_bill.id) then
      raise exception 'Payable % has no coding lines', coalesce(v_bill.bill_number, v_bill.id::text);
    end if;
    if exists (
      select 1 from public.bill_lines l
      left join public.project_financial_settings s on s.org_id = p_org_id and s.project_id = coalesce(l.project_id, v_bill.project_id)
      left join public.org_settings os on os.org_id = p_org_id
      where l.org_id = p_org_id and l.bill_id = v_bill.id
        and coalesce(s.cost_codes_enabled, nullif(os.settings->>'cost_codes_enabled', '')::boolean, true)
        and l.cost_code_id is null
    ) then raise exception 'Payable % is missing required cost-code coding', coalesce(v_bill.bill_number, v_bill.id::text); end if;
    if (select coalesce(sum(round(coalesce(l.quantity, 1) * coalesce(l.unit_cost_cents, 0))), 0) from public.bill_lines l where l.org_id = p_org_id and l.bill_id = v_bill.id) <> coalesce(v_bill.total_cents, 0) then
      raise exception 'Payable % coding does not equal its total', coalesce(v_bill.bill_number, v_bill.id::text);
    end if;
  end loop;

  update public.vendor_bills b
  set status = 'approved', approved_at = coalesce(b.approved_at, v_now), approved_by = p_actor_id,
      qbo_sync_status = case when b.qbo_sync_status = 'synced' then 'pending' else b.qbo_sync_status end,
      qbo_sync_error = case when b.qbo_sync_status = 'synced' then null else b.qbo_sync_error end
  from jsonb_array_elements(p_items) item
  where b.org_id = p_org_id and b.id::text = item->>'id';

  insert into public.audit_log (org_id, actor_user_id, action, entity_type, entity_id, before_data, after_data, source)
  select p_org_id, p_actor_id, 'update', 'vendor_bill', b.id,
    jsonb_build_object('status', 'pending'), jsonb_build_object('status', 'approved', 'bulk', true), 'bulk_payables_approval'
  from public.vendor_bills b join jsonb_array_elements(p_items) item on item->>'id' = b.id::text
  where b.org_id = p_org_id;

  insert into public.events (org_id, event_type, entity_type, entity_id, payload, channel)
  select p_org_id, 'vendor_bill_updated', 'vendor_bill', b.id,
    jsonb_build_object('status', 'approved', 'actor_id', p_actor_id, 'bulk', true), 'activity'
  from public.vendor_bills b join jsonb_array_elements(p_items) item on item->>'id' = b.id::text
  where b.org_id = p_org_id;

  -- Ledger/accounting projections are durable and idempotent. The web action also
  -- attempts them immediately, while this job guarantees a transient failure is retried.
  insert into public.outbox (org_id, job_type, payload, dedupe_key, priority)
  select p_org_id, 'project_vendor_bill_approval',
    jsonb_build_object('bill_id', b.id),
    'vendor-bill-approval:' || b.id::text,
    80
  from public.vendor_bills b join jsonb_array_elements(p_items) item on item->>'id' = b.id::text
  where b.org_id = p_org_id
  on conflict (org_id, dedupe_key) where status = 'pending' and dedupe_key is not null do update
    set status = 'pending', run_at = now(), last_error = null, updated_at = now(), priority = greatest(public.outbox.priority, excluded.priority);

  return jsonb_build_object('approved_count', v_requested, 'approved_at', v_now);
end;
$$;

revoke all on function public.approve_vendor_bills_atomic(uuid,uuid,jsonb) from public, anon, authenticated;
grant execute on function public.approve_vendor_bills_atomic(uuid,uuid,jsonb) to service_role;
