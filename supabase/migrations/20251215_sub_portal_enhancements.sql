-- Add company_id and portal_type to portal_access_tokens
ALTER TABLE portal_access_tokens
ADD COLUMN IF NOT EXISTS company_id uuid REFERENCES companies(id) ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS portal_type text NOT NULL DEFAULT 'client'
  CHECK (portal_type IN ('client', 'sub'));

CREATE INDEX IF NOT EXISTS portal_access_tokens_company_idx
  ON portal_access_tokens(company_id) WHERE company_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS portal_access_tokens_portal_type_idx
  ON portal_access_tokens(portal_type);

-- Add share_with_subs flag to files
ALTER TABLE files
ADD COLUMN IF NOT EXISTS share_with_subs boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS files_share_with_subs_idx
  ON files(project_id, share_with_subs) WHERE share_with_subs = true;

-- Add sub-specific permission columns to portal_access_tokens
ALTER TABLE portal_access_tokens
ADD COLUMN IF NOT EXISTS can_view_commitments boolean NOT NULL DEFAULT true,
ADD COLUMN IF NOT EXISTS can_view_bills boolean NOT NULL DEFAULT true,
ADD COLUMN IF NOT EXISTS can_submit_invoices boolean NOT NULL DEFAULT true;

-- Add assigned_company_id to rfis and submittals for filtering
ALTER TABLE rfis
ADD COLUMN IF NOT EXISTS assigned_company_id uuid REFERENCES companies(id) ON DELETE SET NULL;

ALTER TABLE submittals
ADD COLUMN IF NOT EXISTS assigned_company_id uuid REFERENCES companies(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS rfis_assigned_company_idx ON rfis(assigned_company_id);
CREATE INDEX IF NOT EXISTS submittals_assigned_company_idx ON submittals(assigned_company_id);



