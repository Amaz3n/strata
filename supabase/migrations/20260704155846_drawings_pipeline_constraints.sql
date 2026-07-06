-- Drawings pipeline hardening (Vercel-native fan-out):
-- 1. Enforce the "one in-flight draft revision per project" invariant that the
--    upload action previously checked non-atomically (two concurrent uploads
--    could both pass the check).
-- 2. One version per sheet per revision. The per-page fan-out relies on this
--    to detect two pages of the same upload resolving to the same sheet.
-- 3. Atomic page-progress increment so parallel page jobs can detect
--    completion without racing.

create unique index if not exists drawing_revisions_one_pending_draft_per_project
  on public.drawing_revisions (project_id)
  where status in ('processing', 'draft');

create unique index if not exists drawing_sheet_versions_sheet_revision_unique
  on public.drawing_sheet_versions (drawing_sheet_id, drawing_revision_id);

create or replace function public.increment_drawing_revision_progress(p_revision_id uuid)
returns table (processed integer, total integer)
language sql
security definer
set search_path = public, pg_catalog
as $$
  update drawing_revisions
  set processed_pages = coalesce(processed_pages, 0) + 1
  where id = p_revision_id
  returning processed_pages, total_pages;
$$;

revoke all on function public.increment_drawing_revision_progress(uuid) from public;
grant execute on function public.increment_drawing_revision_progress(uuid) to service_role;
