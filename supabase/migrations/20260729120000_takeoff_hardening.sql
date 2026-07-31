-- Takeoff hardening: real provenance for bid scope lines, uniqueness on synced
-- lines, indexed provenance lookups, set-based repaint/detach, and a
-- non-blocking sheets-list refresh.
--
-- Why each piece exists:
--   * bid_scope_items had no metadata column, so takeoff sync provenance was
--     smuggled into the sub-facing `details` text as a magic string any edit
--     could corrupt. Provenance now lives in metadata like every other surface.
--   * Nothing prevented two concurrent syncs from inserting duplicate lines
--     for the same condition; the unique indexes below make the race lose
--     cleanly (the service recovers 23505 into an update).
--   * loadSyncStates/markSyncedLinesDetached filter on
--     metadata->'takeoff'->>'condition_id' with no index — a full scan of the
--     tenant's estimate lines per takeoff panel load.
--   * repaint/detach were one round trip per row from the service.
--   * refresh_drawing_sheets_list took an ACCESS EXCLUSIVE lock on a view
--     shared by every org (and was executable by anon).

-- ---------------------------------------------------------------------------
-- 1. Bid scope provenance gets a real home
-- ---------------------------------------------------------------------------

alter table public.bid_scope_items
  add column if not exists metadata jsonb not null default '{}'::jsonb;

comment on column public.bid_scope_items.metadata is
  'Structured provenance (e.g. metadata.takeoff for lines synced from takeoff conditions). Sub-facing text stays in details.';

-- ---------------------------------------------------------------------------
-- 2. De-duplicate before the unique indexes can land
--    Keep the newest line per (target, condition); older duplicates lose their
--    takeoff link (the line itself — the money — is untouched).
-- ---------------------------------------------------------------------------

with ranked as (
  select id,
         row_number() over (
           partition by estimate_id, metadata->'takeoff'->>'condition_id'
           order by created_at desc, id desc
         ) as rn
  from public.estimate_items
  where metadata->'takeoff'->>'condition_id' is not null
)
update public.estimate_items e
set metadata = (e.metadata - 'takeoff')
from ranked
where e.id = ranked.id and ranked.rn > 1;

with ranked as (
  select id,
         row_number() over (
           partition by house_plan_version_id, metadata->'takeoff'->>'condition_id'
           order by created_at desc, id desc
         ) as rn
  from public.house_plan_takeoff_lines
  where metadata->'takeoff'->>'condition_id' is not null
)
update public.house_plan_takeoff_lines l
set metadata = (l.metadata - 'takeoff')
from ranked
where l.id = ranked.id and ranked.rn > 1;

-- ---------------------------------------------------------------------------
-- 3. Uniqueness + provenance lookup indexes
-- ---------------------------------------------------------------------------

create unique index if not exists estimate_items_takeoff_condition_uniq
  on public.estimate_items (estimate_id, (metadata->'takeoff'->>'condition_id'))
  where metadata->'takeoff'->>'condition_id' is not null;

create unique index if not exists house_plan_takeoff_lines_takeoff_condition_uniq
  on public.house_plan_takeoff_lines (house_plan_version_id, (metadata->'takeoff'->>'condition_id'))
  where metadata->'takeoff'->>'condition_id' is not null;

create unique index if not exists bid_scope_items_takeoff_condition_uniq
  on public.bid_scope_items (bid_package_id, (metadata->'takeoff'->>'condition_id'))
  where metadata->'takeoff'->>'condition_id' is not null;

-- Org-wide provenance lookups (takeoff panel sync states, detach on delete).
create index if not exists estimate_items_takeoff_condition_idx
  on public.estimate_items (org_id, (metadata->'takeoff'->>'condition_id'))
  where metadata->'takeoff'->>'condition_id' is not null;

create index if not exists house_plan_takeoff_lines_takeoff_condition_idx
  on public.house_plan_takeoff_lines (org_id, (metadata->'takeoff'->>'condition_id'))
  where metadata->'takeoff'->>'condition_id' is not null;

create index if not exists bid_scope_items_takeoff_condition_idx
  on public.bid_scope_items (org_id, (metadata->'takeoff'->>'condition_id'))
  where metadata->'takeoff'->>'condition_id' is not null;

-- ---------------------------------------------------------------------------
-- 4. Set-based repaint: one UPDATE instead of one round trip per markup.
--    SECURITY INVOKER — RLS on drawing_markups still applies to the caller.
-- ---------------------------------------------------------------------------

create or replace function public.repaint_condition_markups(
  p_org_id uuid,
  p_condition_id uuid,
  p_color text
) returns integer
language plpgsql
security invoker
set search_path to 'public', 'pg_catalog'
as $$
declare
  v_count integer;
begin
  update public.drawing_markups
  set data = jsonb_set(coalesce(data, '{}'::jsonb), '{color}', to_jsonb(p_color))
  where org_id = p_org_id
    and condition_id = p_condition_id
    and coalesce(data->>'color', '') is distinct from p_color;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.repaint_condition_markups(uuid, uuid, text) from public, anon;
grant execute on function public.repaint_condition_markups(uuid, uuid, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. Set-based detach across EVERY destination a condition synced to.
--    Previously only estimate lines were detached; bid scope and plan takeoff
--    lines kept claiming a live link to a deleted condition.
-- ---------------------------------------------------------------------------

create or replace function public.detach_takeoff_condition_lines(
  p_org_id uuid,
  p_condition_id uuid
) returns integer
language plpgsql
security invoker
set search_path to 'public', 'pg_catalog'
as $$
declare
  v_total integer := 0;
  v_count integer;
begin
  update public.estimate_items
  set metadata = jsonb_set(metadata, '{takeoff,detached}', 'true'::jsonb)
  where org_id = p_org_id
    and metadata->'takeoff'->>'condition_id' = p_condition_id::text;
  get diagnostics v_count = row_count;
  v_total := v_total + v_count;

  update public.house_plan_takeoff_lines
  set metadata = jsonb_set(metadata, '{takeoff,detached}', 'true'::jsonb)
  where org_id = p_org_id
    and metadata->'takeoff'->>'condition_id' = p_condition_id::text;
  get diagnostics v_count = row_count;
  v_total := v_total + v_count;

  update public.bid_scope_items
  set metadata = jsonb_set(metadata, '{takeoff,detached}', 'true'::jsonb)
  where org_id = p_org_id
    and metadata->'takeoff'->>'condition_id' = p_condition_id::text;
  get diagnostics v_count = row_count;
  v_total := v_total + v_count;

  return v_total;
end;
$$;

revoke all on function public.detach_takeoff_condition_lines(uuid, uuid) from public, anon;
grant execute on function public.detach_takeoff_condition_lines(uuid, uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. Non-blocking sheets-list refresh + tighter grants
--    CONCURRENTLY is safe: idx_drawing_sheets_list_id (unique on id) exists.
--    The old definition took an ACCESS EXCLUSIVE lock on a view every org
--    reads, and carried a GRANT to anon.
-- ---------------------------------------------------------------------------

create or replace function public.refresh_drawing_sheets_list()
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_catalog'
as $$
begin
  if auth.role() not in ('authenticated', 'service_role') then
    raise exception 'unauthorized';
  end if;

  refresh materialized view concurrently public.drawing_sheets_list_mv;
end;
$$;

revoke all on function public.refresh_drawing_sheets_list() from public, anon;
grant execute on function public.refresh_drawing_sheets_list() to authenticated, service_role;
