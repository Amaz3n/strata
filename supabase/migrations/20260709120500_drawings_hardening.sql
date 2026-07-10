-- Drawings hardening: outbox claim-path indexes + canonical sheet uniqueness.
--
-- 1) The outbox previously had only an org_id index; claim_jobs, pending-count
--    checks, and stale-job reclaim all seq-scanned a table shared by every
--    async job type. These partial indexes cover the hot predicates.
-- 2) drawing_sheets had no uniqueness on (project_id, sheet_number), so
--    parallel page jobs racing on findSheetByNumber/createDraftSheet could
--    create duplicate sheets. Dedupe existing rows (keep the oldest sheet id,
--    adopt the newest upload's set/revision pointers), then enforce uniqueness.

-- 1. Outbox claim path -------------------------------------------------------

create index if not exists outbox_pending_claim_idx
  on public.outbox (job_type, run_at)
  where status = 'pending';

create index if not exists outbox_processing_updated_idx
  on public.outbox (updated_at)
  where status = 'processing';

create index if not exists outbox_payload_gin_idx
  on public.outbox using gin (payload jsonb_path_ops);

-- 2. Dedupe duplicate sheets, then enforce uniqueness ------------------------

do $$
declare
  grp record;
  keeper_id uuid;
  newest record;
begin
  for grp in
    select project_id, sheet_number
    from public.drawing_sheets
    where sheet_number is not null
    group by project_id, sheet_number
    having count(*) > 1
  loop
    select id into keeper_id
    from public.drawing_sheets
    where project_id = grp.project_id and sheet_number = grp.sheet_number
    order by created_at asc
    limit 1;

    select id, drawing_set_id, current_revision_id, sheet_title, discipline
      into newest
    from public.drawing_sheets
    where project_id = grp.project_id and sheet_number = grp.sheet_number
    order by created_at desc
    limit 1;

    -- Move versions from duplicates onto the keeper unless the keeper already
    -- has a version for that revision (unique on sheet+revision).
    update public.drawing_sheet_versions v
    set drawing_sheet_id = keeper_id
    where v.drawing_sheet_id in (
        select s.id from public.drawing_sheets s
        where s.project_id = grp.project_id
          and s.sheet_number = grp.sheet_number
          and s.id <> keeper_id
      )
      and not exists (
        select 1 from public.drawing_sheet_versions k
        where k.drawing_sheet_id = keeper_id
          and k.drawing_revision_id = v.drawing_revision_id
      );

    -- Colliding leftovers (same revision on both sheets): keeper's copy wins.
    delete from public.drawing_sheet_versions v
    where v.drawing_sheet_id in (
      select s.id from public.drawing_sheets s
      where s.project_id = grp.project_id
        and s.sheet_number = grp.sheet_number
        and s.id <> keeper_id
    );

    -- Re-point markups; their sheet_version_id rows moved with the versions.
    update public.drawing_markups m
    set drawing_sheet_id = keeper_id
    where m.drawing_sheet_id in (
      select s.id from public.drawing_sheets s
      where s.project_id = grp.project_id
        and s.sheet_number = grp.sheet_number
        and s.id <> keeper_id
    );

    -- Re-point pins, respecting the (org, sheet, entity_type, entity_id)
    -- uniqueness: drop duplicate-entity pins rather than violating it.
    delete from public.drawing_pins p
    where p.drawing_sheet_id in (
        select s.id from public.drawing_sheets s
        where s.project_id = grp.project_id
          and s.sheet_number = grp.sheet_number
          and s.id <> keeper_id
      )
      and p.entity_id is not null
      and exists (
        select 1 from public.drawing_pins k
        where k.drawing_sheet_id = keeper_id
          and k.org_id = p.org_id
          and k.entity_type = p.entity_type
          and k.entity_id = p.entity_id
      );

    update public.drawing_pins p
    set drawing_sheet_id = keeper_id
    where p.drawing_sheet_id in (
      select s.id from public.drawing_sheets s
      where s.project_id = grp.project_id
        and s.sheet_number = grp.sheet_number
        and s.id <> keeper_id
    );

    -- The newest duplicate represents the latest upload: adopt its pointers.
    if newest.id <> keeper_id then
      update public.drawing_sheets
      set drawing_set_id = newest.drawing_set_id,
          current_revision_id = newest.current_revision_id,
          sheet_title = newest.sheet_title,
          discipline = newest.discipline,
          updated_at = now()
      where id = keeper_id;
    end if;

    delete from public.drawing_sheets s
    where s.project_id = grp.project_id
      and s.sheet_number = grp.sheet_number
      and s.id <> keeper_id;
  end loop;
end $$;

create unique index if not exists drawing_sheets_project_sheet_number_key
  on public.drawing_sheets (project_id, sheet_number)
  where sheet_number is not null;

-- Sheet rows may have moved; rebuild the denormalized list view.
select public.refresh_drawing_sheets_list();
