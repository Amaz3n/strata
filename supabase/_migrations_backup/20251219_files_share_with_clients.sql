-- Add share_with_clients flag to files for client portal sharing
ALTER TABLE files
ADD COLUMN IF NOT EXISTS share_with_clients boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS files_share_with_clients_idx
  ON files(project_id, share_with_clients)
  WHERE share_with_clients = true;
