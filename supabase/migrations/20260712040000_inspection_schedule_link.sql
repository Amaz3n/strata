-- Link inspections to their scheduled slot on the Gantt.
-- A schedule item of type 'inspection' is the plan (date, dependencies,
-- lookahead); the inspection record is the execution (checklist, photos,
-- deficiencies). Completing the inspection checks off the schedule item.
alter table public.inspections
  add column if not exists schedule_item_id uuid references public.schedule_items(id) on delete set null;

create index if not exists inspections_schedule_item_idx
  on public.inspections (schedule_item_id)
  where schedule_item_id is not null;
