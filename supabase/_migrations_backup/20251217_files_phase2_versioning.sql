-- Phase 2: True Versioning (Replace Without Chaos)
-- This migration extends doc_versions to store per-version blob metadata

-- Add per-version storage fields to doc_versions
ALTER TABLE doc_versions ADD COLUMN IF NOT EXISTS storage_path text;
ALTER TABLE doc_versions ADD COLUMN IF NOT EXISTS mime_type text;
ALTER TABLE doc_versions ADD COLUMN IF NOT EXISTS size_bytes bigint;
ALTER TABLE doc_versions ADD COLUMN IF NOT EXISTS checksum text;
ALTER TABLE doc_versions ADD COLUMN IF NOT EXISTS file_name text;

-- Add index for efficient version lookups
CREATE INDEX IF NOT EXISTS doc_versions_file_version_idx ON doc_versions (org_id, file_id, version_number DESC);

-- Add a current_version_id to files to track the active version
ALTER TABLE files ADD COLUMN IF NOT EXISTS current_version_id uuid REFERENCES doc_versions(id);

-- Comment on columns
COMMENT ON COLUMN doc_versions.storage_path IS 'Storage path for this version''s blob';
COMMENT ON COLUMN doc_versions.mime_type IS 'MIME type of this version';
COMMENT ON COLUMN doc_versions.size_bytes IS 'File size in bytes for this version';
COMMENT ON COLUMN doc_versions.checksum IS 'Checksum/hash of this version''s file';
COMMENT ON COLUMN doc_versions.file_name IS 'Original filename for this version';
COMMENT ON COLUMN files.current_version_id IS 'Reference to the current active version in doc_versions';

-- Create a function to get the latest version number for a file
CREATE OR REPLACE FUNCTION get_next_version_number(p_file_id uuid)
RETURNS integer AS $$
DECLARE
  v_max_version integer;
BEGIN
  SELECT COALESCE(MAX(version_number), 0) + 1
  INTO v_max_version
  FROM doc_versions
  WHERE file_id = p_file_id;

  RETURN v_max_version;
END;
$$ LANGUAGE plpgsql;
