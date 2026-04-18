-- Approval Workflow Updates

-- Add status and due_at to files
ALTER TABLE public.files 
ADD COLUMN IF NOT EXISTS status text DEFAULT 'draft',
ADD COLUMN IF NOT EXISTS due_at timestamp with time zone;

-- Index for status filtering
CREATE INDEX IF NOT EXISTS idx_files_status ON public.files(org_id, project_id, status);

-- Add comments for clarity
COMMENT ON COLUMN public.files.status IS 'Approval workflow status: draft, submitted, in_review, approved, rejected, resubmit_required';
