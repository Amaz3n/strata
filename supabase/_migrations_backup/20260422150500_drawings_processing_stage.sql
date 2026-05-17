ALTER TABLE public.drawing_sets
ADD COLUMN IF NOT EXISTS processing_stage text;

UPDATE public.drawing_sets
SET processing_stage = CASE
  WHEN status = 'ready' THEN 'ready'
  WHEN status = 'failed' THEN 'failed'
  ELSE 'queued'
END
WHERE processing_stage IS NULL;
