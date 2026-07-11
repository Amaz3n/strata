-- Workstream 06 Phase 1: punch ball-in-court — assign punch items to subcontractor companies.

alter table public.punch_items
  add column if not exists assigned_company_id uuid references public.companies(id),
  add column if not exists dispatched_at timestamptz,
  add column if not exists sub_completed_at timestamptz,
  add column if not exists back_charge_flag boolean not null default false;

create index if not exists punch_items_assigned_company_idx
  on public.punch_items (assigned_company_id)
  where assigned_company_id is not null;

-- Sub portal capability: see + work the punch queue for the token's company.
alter table public.portal_access_tokens
  add column if not exists can_view_punch_items boolean not null default false;
