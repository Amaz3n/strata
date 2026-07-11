alter table public.safety_incidents
  add column if not exists photo_file_id uuid references public.files(id) on delete set null;

create index if not exists safety_incidents_photo_file_idx
  on public.safety_incidents (photo_file_id)
  where photo_file_id is not null;
