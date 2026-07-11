-- Workstream 03: prime change-order lifecycle, cost/price separation, and hard links.
-- Additive and backward-compatible: the legacy status column remains in service.

alter table public.change_orders
  add column if not exists lifecycle text not null default 'draft',
  add column if not exists source_rfi_id uuid references public.rfis(id) on delete set null,
  add column if not exists proposed_at timestamptz,
  add column if not exists owner_response_due date,
  add column if not exists cost_total_cents integer,
  add column if not exists markup_mode text not null default 'percent';

alter table public.change_orders
  drop constraint if exists change_orders_lifecycle_check,
  add constraint change_orders_lifecycle_check
    check (lifecycle in ('draft', 'pricing', 'proposed', 'approved', 'rejected', 'void')),
  drop constraint if exists change_orders_markup_mode_check,
  add constraint change_orders_markup_mode_check
    check (markup_mode in ('percent', 'manual'));

update public.change_orders
set lifecycle = case
  when status = 'draft' then 'draft'
  when status = 'approved' then 'approved'
  when status = 'rejected' then 'rejected'
  else 'draft'
end
where lifecycle = 'draft';

alter table public.change_order_lines
  add column if not exists internal_cost_cents integer,
  add column if not exists commitment_change_order_id uuid
    references public.commitment_change_orders(id) on delete set null;

alter table public.commitment_change_orders
  add column if not exists prime_change_order_id uuid
    references public.change_orders(id) on delete set null;

-- Preserve the old metadata keys for read compatibility, but promote valid UUIDs
-- into first-class relationships. Invalid historical values are ignored.
update public.change_orders
set source_rfi_id = (metadata->>'source_rfi_id')::uuid
where source_rfi_id is null
  and coalesce(metadata->>'source_rfi_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  and exists (
    select 1 from public.rfis
    where rfis.id = (change_orders.metadata->>'source_rfi_id')::uuid
      and rfis.org_id = change_orders.org_id
  );

update public.commitment_change_orders
set prime_change_order_id = (metadata->>'source_change_order_id')::uuid
where prime_change_order_id is null
  and coalesce(metadata->>'source_change_order_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  and exists (
    select 1 from public.change_orders
    where change_orders.id = (commitment_change_orders.metadata->>'source_change_order_id')::uuid
      and change_orders.org_id = commitment_change_orders.org_id
  );

create index if not exists change_orders_org_project_lifecycle_idx
  on public.change_orders (org_id, project_id, lifecycle);
create index if not exists change_orders_source_rfi_idx
  on public.change_orders (org_id, source_rfi_id)
  where source_rfi_id is not null;
create index if not exists change_order_lines_commitment_co_idx
  on public.change_order_lines (org_id, commitment_change_order_id)
  where commitment_change_order_id is not null;
create index if not exists commitment_change_orders_prime_co_idx
  on public.commitment_change_orders (org_id, prime_change_order_id)
  where prime_change_order_id is not null;

comment on column public.change_orders.lifecycle is
  'Structured PCO-to-OCO lifecycle. Legacy status remains dual-written during migration.';
comment on column public.change_orders.cost_total_cents is
  'Internal GC cost exposure; never render on owner-facing surfaces.';
comment on column public.change_order_lines.unit_cost_cents is
  'Owner price basis per unit. Internal cost is stored separately in internal_cost_cents.';
