-- The photo list leaves out paperwork in production too.
--
-- 20260825120000_photo_records was applied to production before its view
-- learned to exclude financials, contracts and permits; the file was edited
-- afterwards, so production still lists a photographed receipt as a photo.
-- This is that definition, restated so production gets it at deploy.

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
