-- Measured quantities on drawing markups.
--
-- Until now the only measuring markup was `dimension`, and its value was never
-- stored — the viewer recomputed it at render time and the number existed
-- nowhere else. That is fine for an annotation and useless for a takeoff: you
-- cannot sum, price, or diff a label. These columns make the measurement a
-- first-class, queryable property of the markup.
--
-- `quantity` is written SERVER-SIDE on create/update from the geometry, the
-- rendered image dimensions, and the sheet version's calibration
-- (lib/drawings/measure.ts is the single source of that math), and is
-- recomputed in bulk whenever the calibration changes. It is null for
-- non-measuring markups and for length/area geometry on an uncalibrated sheet.

alter table public.drawing_markups
  add column if not exists quantity numeric,
  add column if not exists uom text,
  add column if not exists condition_id uuid references public.takeoff_conditions(id) on delete set null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'drawing_markups_uom_check'
  ) then
    alter table public.drawing_markups
      add constraint drawing_markups_uom_check
      check (uom is null or uom in ('lf', 'sf', 'ea'));
  end if;
end $$;

-- Rollup path: every condition's members, in one index-only scan.
create index if not exists drawing_markups_condition_idx
  on public.drawing_markups (org_id, condition_id)
  where condition_id is not null;

-- "Which sheets carry measurements" — drives the takeoff panel's per-sheet
-- breakdown and the phase-8 re-anchor queue.
create index if not exists drawing_markups_measured_version_idx
  on public.drawing_markups (org_id, sheet_version_id)
  where quantity is not null;

comment on column public.drawing_markups.quantity is
  'Real-world measured value (feet, square feet, or each). Computed server-side from geometry x calibration; null when not a measuring markup or the sheet is uncalibrated.';
comment on column public.drawing_markups.uom is
  'Unit the quantity is expressed in: lf | sf | ea. Mirrors the markup type via lib/drawings/measure.ts MEASURING_TYPE_UOM.';
comment on column public.drawing_markups.condition_id is
  'Takeoff condition this measurement rolls into. Null = a loose measurement that counts toward nothing.';
