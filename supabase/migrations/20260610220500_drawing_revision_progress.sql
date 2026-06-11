-- Draft processing progress is tracked on the revision (not the live set), so a
-- revision upload never flips the live register into a processing state.
ALTER TABLE public.drawing_revisions
  ADD COLUMN IF NOT EXISTS processing_stage text,
  ADD COLUMN IF NOT EXISTS processed_pages integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_pages integer,
  ADD COLUMN IF NOT EXISTS error_message text,
  ADD COLUMN IF NOT EXISTS source_file_id uuid;
