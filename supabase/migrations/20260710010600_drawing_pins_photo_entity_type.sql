-- Allow "photo" pins on drawings (Attach Photo in the drawing viewer).
-- The photos table already supports standalone project photos
-- (daily_log_id/task_id are nullable); only the pin entity_type CHECK
-- needs to admit the new type.

ALTER TABLE public.drawing_pins
  DROP CONSTRAINT IF EXISTS drawing_pins_entity_type_check;

ALTER TABLE public.drawing_pins
  ADD CONSTRAINT drawing_pins_entity_type_check
  CHECK (entity_type = ANY (ARRAY[
    'task'::text,
    'rfi'::text,
    'punch_list'::text,
    'submittal'::text,
    'daily_log'::text,
    'observation'::text,
    'issue'::text,
    'photo'::text
  ]));
