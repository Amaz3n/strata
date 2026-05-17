-- Phase 1: Make Documents Real Everywhere (Foundation)
-- This migration adds persisted metadata fields to the files table and indexes for file_links

-- Add category column with constraint for allowed values
ALTER TABLE files ADD COLUMN IF NOT EXISTS category text;

-- Add folder_path for virtual folder organization
ALTER TABLE files ADD COLUMN IF NOT EXISTS folder_path text;

-- Add description for file documentation
ALTER TABLE files ADD COLUMN IF NOT EXISTS description text;

-- Add tags array for flexible labeling
ALTER TABLE files ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT '{}'::text[];

-- Add archived_at for soft-archive functionality
ALTER TABLE files ADD COLUMN IF NOT EXISTS archived_at timestamptz;

-- Add source to track how the file was added
ALTER TABLE files ADD COLUMN IF NOT EXISTS source text;

-- Add constraint for category values matching the UI FileCategory type
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'files_category_check') THEN
    ALTER TABLE files ADD CONSTRAINT files_category_check
      CHECK (category IS NULL OR category IN ('plans', 'contracts', 'permits', 'submittals', 'photos', 'rfis', 'safety', 'financials', 'other'));
  END IF;
END$$;

-- Add constraint for source values
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'files_source_check') THEN
    ALTER TABLE files ADD CONSTRAINT files_source_check
      CHECK (source IS NULL OR source IN ('upload', 'portal', 'email', 'generated', 'import'));
  END IF;
END$$;

-- Add indexes for common query patterns
CREATE INDEX IF NOT EXISTS files_org_project_created_idx ON files (org_id, project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS files_org_project_category_idx ON files (org_id, project_id, category);
CREATE INDEX IF NOT EXISTS files_tags_idx ON files USING gin(tags);
CREATE INDEX IF NOT EXISTS files_folder_path_idx ON files (org_id, folder_path);
CREATE INDEX IF NOT EXISTS files_archived_idx ON files (org_id, archived_at) WHERE archived_at IS NOT NULL;

-- Add index on file_links for entity lookup (critical for attachments queries)
CREATE INDEX IF NOT EXISTS file_links_entity_idx ON file_links (org_id, entity_type, entity_id);

-- Add link_role column to file_links for structured attachment semantics
ALTER TABLE file_links ADD COLUMN IF NOT EXISTS link_role text;

-- Comment on columns for documentation
COMMENT ON COLUMN files.category IS 'File category: plans, contracts, permits, submittals, photos, rfis, safety, financials, other';
COMMENT ON COLUMN files.folder_path IS 'Virtual folder path for organization (e.g., /drawings/structural)';
COMMENT ON COLUMN files.description IS 'User-provided description of the file';
COMMENT ON COLUMN files.tags IS 'Array of tags for flexible labeling and search';
COMMENT ON COLUMN files.archived_at IS 'Timestamp when file was soft-archived, null if active';
COMMENT ON COLUMN files.source IS 'How the file was added: upload, portal, email, generated, import';
COMMENT ON COLUMN file_links.link_role IS 'Role of the attachment: rfi_question, rfi_response, submittal_package, co_supporting, task_evidence, invoice_backup';
