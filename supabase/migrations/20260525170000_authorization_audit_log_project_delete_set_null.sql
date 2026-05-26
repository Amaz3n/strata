ALTER TABLE public.authorization_audit_log
  DROP CONSTRAINT IF EXISTS authorization_audit_log_project_id_fkey;

ALTER TABLE public.authorization_audit_log
  ADD CONSTRAINT authorization_audit_log_project_id_fkey
  FOREIGN KEY (project_id)
  REFERENCES public.projects(id)
  ON DELETE SET NULL;
