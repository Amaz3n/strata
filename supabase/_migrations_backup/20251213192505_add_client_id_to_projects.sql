ALTER TABLE projects ADD COLUMN IF NOT EXISTS client_id uuid REFERENCES contacts(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_projects_client_id ON projects(client_id);
COMMENT ON COLUMN projects.client_id IS 'Primary client contact for this project';;
