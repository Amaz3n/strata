-- Add metadata column to files table for storing additional file information
ALTER TABLE files
ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Add index on metadata for common queries
CREATE INDEX IF NOT EXISTS files_metadata_idx ON files USING gin(metadata);



