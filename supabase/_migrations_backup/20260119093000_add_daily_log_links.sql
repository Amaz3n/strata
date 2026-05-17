ALTER TABLE public.daily_log_entries
  ADD COLUMN IF NOT EXISTS schedule_item_id uuid REFERENCES public.schedule_items(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS task_id uuid REFERENCES public.tasks(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS punch_item_id uuid REFERENCES public.punch_items(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cost_code_id uuid REFERENCES public.cost_codes(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS location text,
  ADD COLUMN IF NOT EXISTS trade text,
  ADD COLUMN IF NOT EXISTS labor_type text,
  ADD COLUMN IF NOT EXISTS inspection_result text,
  ADD COLUMN IF NOT EXISTS progress integer;

CREATE INDEX IF NOT EXISTS daily_log_entries_daily_log_id_idx ON public.daily_log_entries (daily_log_id);
CREATE INDEX IF NOT EXISTS daily_log_entries_schedule_item_id_idx ON public.daily_log_entries (schedule_item_id);
CREATE INDEX IF NOT EXISTS daily_log_entries_task_id_idx ON public.daily_log_entries (task_id);
CREATE INDEX IF NOT EXISTS daily_log_entries_punch_item_id_idx ON public.daily_log_entries (punch_item_id);

ALTER TABLE public.files
  ADD COLUMN IF NOT EXISTS daily_log_id uuid REFERENCES public.daily_logs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS schedule_item_id uuid REFERENCES public.schedule_items(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS files_daily_log_id_idx ON public.files (daily_log_id);
CREATE INDEX IF NOT EXISTS files_schedule_item_id_idx ON public.files (schedule_item_id);
