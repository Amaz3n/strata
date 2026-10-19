-- A bid request names the drawing sheets a trade prices from and an optional
-- site walk.
-- Sheets are chosen by sheet, not by whole set file, so a bidder sees only the
-- pages that are theirs.

alter table public.bid_packages
  add column if not exists site_walk_at timestamptz;

create table if not exists public.bid_package_sheets (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  bid_package_id uuid not null references public.bid_packages(id) on delete cascade,
  drawing_sheet_id uuid not null references public.drawing_sheets(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  unique (bid_package_id, drawing_sheet_id)
);

create index if not exists bid_package_sheets_org_package_idx on public.bid_package_sheets (org_id, bid_package_id);
create index if not exists bid_package_sheets_sheet_idx on public.bid_package_sheets (drawing_sheet_id);

alter table public.bid_package_sheets enable row level security;

create policy bid_package_sheets_read on public.bid_package_sheets
  for select using (is_org_member(org_id));

create policy bid_package_sheets_insert on public.bid_package_sheets
  for insert with check (has_org_permission(org_id, 'bid.write') or has_org_permission(org_id, 'project.manage'));

create policy bid_package_sheets_delete on public.bid_package_sheets
  for delete using (has_org_permission(org_id, 'bid.write') or has_org_permission(org_id, 'project.manage'));

-- Same division fence as scope items: the row is visible only through a package the caller can see.
create policy bid_package_sheets_division_scope on public.bid_package_sheets
  as restrictive for all
  using (exists (select 1 from public.bid_packages p where p.id = bid_package_sheets.bid_package_id))
  with check (exists (select 1 from public.bid_packages p where p.id = bid_package_sheets.bid_package_id));
