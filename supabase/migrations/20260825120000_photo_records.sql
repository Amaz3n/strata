-- Photo records: make `photos` the record every project image and video has.
--
-- `photos` shipped with albums, curated visibility, AI captions, capture time and
-- GPS, and then never received a single row: the table is empty in production.
-- Everything downstream of it was dead as a result — the album filter had nothing
-- to filter, the caption search box searched columns that were always null, and
-- the client portal's photo feed (photo_timeline_for_portal, which reads
-- visibility = 'client') could never return anything.
--
-- The reason it stayed empty is that a photo enters Arc as a `files` row, from a
-- dozen different code paths — the photos workbench, a daily log, the mobile app,
-- a punch item, an inspection. Asking each of those to remember to write a second
-- row is how it got here. So the invariant is enforced by the database instead:
-- every non-archived image/video file that belongs to a project gets a `photos`
-- row, written by a trigger, and the listing reads a view over the join.
--
-- `taken_at` becomes the timeline's sort key and stops being nullable. Its meaning
-- is "when this photo was captured, as well as we know" — EXIF DateTimeOriginal
-- when the file carries one, upload time otherwise, which is the same fallback
-- every photo library uses. Grouping the timeline on upload time was wrong for the
-- ordinary case of a super emptying Friday's camera roll on Monday.

set lock_timeout = '5s';
set statement_timeout = '120s';

-- ---------------------------------------------------------------------------
-- 1. One photo record per file
-- ---------------------------------------------------------------------------

-- Nothing has ever written a second row for a file, and the backfill below is
-- guarded by `not exists`, so this is a constraint on an invariant that already
-- holds rather than a cleanup. It is created before the backfill on purpose: if
-- duplicates somehow exist, the migration should stop here and say so rather than
-- silently pick a winner and delete field data.
create unique index if not exists photos_org_file_key
  on public.photos (org_id, file_id);

-- ---------------------------------------------------------------------------
-- 2. Backfill: every project image/video file that predates this migration
-- ---------------------------------------------------------------------------

insert into public.photos (org_id, project_id, file_id, daily_log_id, captured_by, taken_at, created_at)
select
  f.org_id,
  f.project_id,
  f.id,
  f.daily_log_id,
  f.uploaded_by,
  f.created_at,
  f.created_at
from public.files f
where f.project_id is not null
  and f.archived_at is null
  and f.mime_type is not null
  and (f.mime_type like 'image/%' or f.mime_type like 'video/%')
  and not exists (select 1 from public.photos p where p.org_id = f.org_id and p.file_id = f.id)
on conflict (org_id, file_id) do nothing;

-- ---------------------------------------------------------------------------
-- 3. taken_at is the sort key, so it may not be null
-- ---------------------------------------------------------------------------

update public.photos set taken_at = created_at where taken_at is null;

alter table public.photos alter column taken_at set default now();
alter table public.photos alter column taken_at set not null;

-- The timeline's only ordering: newest capture first, file id breaking ties so
-- the keyset cursor is total. Every page of every project photo list uses it.
create index if not exists photos_project_taken_at_idx
  on public.photos (org_id, project_id, taken_at desc, file_id desc);

-- Filter columns. Partial where the column is usually null, so the index stays
-- small on orgs that never curate.
create index if not exists photos_album_idx
  on public.photos (org_id, album_id) where album_id is not null;
create index if not exists photos_location_idx
  on public.photos (org_id, location_id) where location_id is not null;
create index if not exists photos_trade_company_idx
  on public.photos (org_id, trade_company_id) where trade_company_id is not null;
-- The client portal feed reads exactly this predicate.
create index if not exists photos_client_feed_idx
  on public.photos (org_id, project_id, taken_at desc) where visibility = 'client';
-- The captioning backlog sweep.
create index if not exists photos_uncaptioned_idx
  on public.photos (org_id, created_at) where ai_processed_at is null;

create index if not exists photo_albums_project_idx
  on public.photo_albums (org_id, project_id);

-- ---------------------------------------------------------------------------
-- 4. The trigger that keeps it true
-- ---------------------------------------------------------------------------

-- SECURITY DEFINER, and that is load-bearing rather than convenience. The two
-- policies are not the same shape:
--
--   files_access   INSERT: is_org_member(org_id)
--   photos_access  INSERT: is_org_member(org_id)
--                          AND (project_id IS NULL
--                               OR is_project_member(project_id)
--                               OR is_org_admin_member(org_id))
--
-- So an org member who is neither a member of that project nor an org admin can
-- legally insert the file and would be refused on the photos row — and because
-- this fires inside their statement, the refusal would take their upload down
-- with it. Running as the definer keeps the invariant from turning into an
-- upload outage. It widens nothing: the function takes no arguments, reads
-- nothing from the caller, and writes one row derived entirely from the `files`
-- row that was just written.
--
-- Revoking EXECUTE below does not stop the trigger firing — books_reject_mutation
-- and the rest of the books guards have run this way since the SECURITY DEFINER
-- lockdown (20260824115218) with ten live triggers between them.
create or replace function public.tg_files_ensure_photo_record()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  if new.project_id is null
     or new.archived_at is not null
     or new.mime_type is null
     or (new.mime_type not like 'image/%' and new.mime_type not like 'video/%')
  then
    return null;
  end if;

  insert into public.photos (org_id, project_id, file_id, daily_log_id, captured_by, taken_at, created_at)
  values (
    new.org_id,
    new.project_id,
    new.id,
    new.daily_log_id,
    new.uploaded_by,
    coalesce(new.created_at, now()),
    coalesce(new.created_at, now())
  )
  on conflict (org_id, file_id) do nothing;

  return null;
end;
$$;

comment on function public.tg_files_ensure_photo_record() is
  'Gives every project image/video file its photos row. AFTER INSERT so the row sees the file''s defaults; SECURITY DEFINER so an uploader who is not a project member does not fail RLS on the photos insert and lose the file with it.';

-- Not reachable as an RPC, and never was meant to be.
revoke all on function public.tg_files_ensure_photo_record() from public;
revoke all on function public.tg_files_ensure_photo_record() from anon;
revoke all on function public.tg_files_ensure_photo_record() from authenticated;

drop trigger if exists files_ensure_photo_record on public.files;
create trigger files_ensure_photo_record
  after insert on public.files
  for each row execute function public.tg_files_ensure_photo_record();

-- ---------------------------------------------------------------------------
-- 5. The list the workbench reads
-- ---------------------------------------------------------------------------

-- Everything the photo list filters, sorts, searches and pages by lives here so
-- all of it happens in the database. The service used to pull batches of 96 file
-- rows and drop the ones that did not match in JavaScript, which meant a search
-- for a rare term walked — and signed a URL for — every photo in the project.
--
-- security_invoker so the org RLS on files and photos still applies to whoever
-- selects from it. Without it the view would run as its owner and read across
-- every tenant.
create or replace view public.project_photo_entries
with (security_invoker = true)
as
select
  f.id                                   as file_id,
  p.id                                   as photo_id,
  f.org_id,
  f.project_id,
  f.daily_log_id,
  -- The photo record can point at a different daily log than the file does, and
  -- at a task the file never referenced. Both are sources the workbench lists.
  p.daily_log_id                         as photo_daily_log_id,
  p.task_id                              as photo_task_id,
  f.file_name,
  f.storage_path,
  f.visibility                           as file_visibility,
  f.mime_type,
  f.size_bytes,
  f.uploaded_by,
  f.created_at                           as uploaded_at,
  p.taken_at,
  p.album_id,
  p.location_id,
  p.trade_company_id,
  p.latitude,
  p.longitude,
  p.ai_caption,
  p.ai_tags,
  p.ai_processed_at,
  p.visibility                           as curated_visibility,
  case when f.mime_type like 'video/%' then 'video' else 'image' end as media_kind,
  -- The preview ladder generate_file_preview writes. The grid renders from this
  -- rather than the original: a phone photo is several megabytes and a page of
  -- thirty of them was downloading the full-resolution originals.
  nullif(f.metadata #>> '{preview,status}', '')    as preview_status,
  nullif(f.metadata #>> '{preview,thumbhash}', '') as preview_thumbhash,
  (f.metadata #>> '{preview,width}')::int          as preview_width,
  (f.metadata #>> '{preview,height}')::int         as preview_height,
  (
    jsonb_typeof(f.metadata #> '{preview,sizes}') = 'array'
    and jsonb_array_length(f.metadata #> '{preview,sizes}') > 0
  ) as has_preview_ladder,
  -- Just the rung widths. The grid builds a srcset from them and lets the
  -- browser pick; the storage paths behind each rung are the preview route's
  -- business and would be dead weight on every row.
  case
    when jsonb_typeof(f.metadata #> '{preview,sizes}') = 'array'
      then (
        select array_agg(distinct (entry ->> 'width')::int)
        from jsonb_array_elements(f.metadata #> '{preview,sizes}') as entry
        where (entry ->> 'width') ~ '^[0-9]+$'
      )
    else null
  end as preview_widths,
  -- One lowercase haystack so a single ilike covers the file name, the caption
  -- the model wrote, and every tag on it.
  lower(
    f.file_name || ' ' ||
    coalesce(p.ai_caption, '') || ' ' ||
    array_to_string(p.ai_tags, ' ')
  ) as search_text
from public.photos p
join public.files f on f.id = p.file_id and f.org_id = p.org_id
where f.archived_at is null
  -- Paperwork is not a project photo. A receipt snapped on a phone, a scanned
  -- contract and a photographed permit card are all image/jpeg, and the old list
  -- showed every one of them because its only test was the mime type.
  --
  -- The category is the uploading path's own statement of intent, not a guess:
  -- uploadCostPlusFile, the payables inbox and the payables workspace all set
  -- `financials` explicitly, which is what makes this a reliable test rather than
  -- a heuristic. The list is kept in step with NON_PHOTO_FILE_CATEGORIES in
  -- lib/media/photo-media.ts, where the reasoning for its narrowness lives.
  --
  -- Filtered here rather than in the trigger on purpose. The record stays for
  -- every image — it costs one row, the file may be recategorised later, and the
  -- trigger fires before `file_links` exists, so it could never classify anyway.
  -- The workbench decides what it shows; the invariant stays simple.
  --
  -- Deliberately NOT also excluding by file_links to money records: `file_links`
  -- has no index on file_id, so a correlated NOT EXISTS would sequentially scan
  -- it once per candidate row, and against real data that predicate catches
  -- nothing this one misses.
  and (f.category is null or f.category not in ('financials', 'contracts', 'permits'));

comment on view public.project_photo_entries is
  'One row per project photo: its photos record joined to the file it describes. Carries the capture time the timeline sorts on, the curated metadata it filters on, the preview-ladder facts the grid renders from, and a search haystack. security_invoker so the org RLS on files and photos still applies to whoever selects from it.';

grant select on public.project_photo_entries to authenticated;
grant select on public.project_photo_entries to service_role;

-- ---------------------------------------------------------------------------
-- 6. The client portal feed could never render what it returned
-- ---------------------------------------------------------------------------

-- The old function returned `f.storage_path` as `url`, and the portal put it
-- straight into an <img src>. A storage key is not a URL: it resolved relative to
-- the portal origin and 404'd, so every photo a builder published to a client was
-- a broken image. It returns the file id now and the portal builds a URL against
-- its own token-scoped file route.
create or replace function public.photo_timeline_for_portal(p_project_id uuid, p_org_id uuid)
returns table(week_start timestamp with time zone, week_end timestamp with time zone, photos jsonb, summaries text[])
language sql
stable
set search_path to 'public', 'pg_catalog'
as $function$
  select date_trunc('week', p.taken_at),
    date_trunc('week', p.taken_at) + interval '6 days',
    jsonb_agg(jsonb_build_object(
      'id', p.id, 'file_id', p.file_id, 'taken_at', p.taken_at,
      'tags', coalesce(p.ai_tags, p.tags, '{}'), 'caption', p.ai_caption,
      'latitude', p.latitude, 'longitude', p.longitude
    ) order by p.taken_at desc),
    array_agg(dl.summary) filter (where dl.summary is not null)
  from public.photos p
  join public.files f on f.id = p.file_id and f.org_id = p.org_id
  left join public.daily_logs dl on dl.id = p.daily_log_id and dl.org_id = p.org_id
  where p.project_id = p_project_id
    and p.org_id = p_org_id
    and p.visibility = 'client'
    and f.archived_at is null
  group by date_trunc('week', p.taken_at)
  order by 1 desc;
$function$;

comment on function public.photo_timeline_for_portal(uuid, uuid) is
  'Client-portal photo feed, grouped by week of capture. Returns file ids; the caller builds token-scoped URLs from them.';
