-- Option A: public drawings-images bucket + canonical paths
insert into storage.buckets (id, name, public)
values ('drawings-images', 'drawings-images', true)
on conflict (id) do update set public = true;

alter table public.drawing_sheet_versions
  add column if not exists thumb_path text,
  add column if not exists medium_path text,
  add column if not exists full_path text,
  add column if not exists tile_manifest_path text,
  add column if not exists tiles_base_path text;

create index if not exists idx_drawing_sheet_versions_thumb_path
  on public.drawing_sheet_versions (drawing_sheet_id)
  where thumb_path is not null;
;
