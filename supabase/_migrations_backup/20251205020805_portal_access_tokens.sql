CREATE TABLE IF NOT EXISTS portal_access_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  company_id UUID REFERENCES companies(id) ON DELETE SET NULL,
  token TEXT NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(32), 'hex'),
  portal_type TEXT NOT NULL CHECK (portal_type IN ('client', 'sub')),
  can_view_schedule BOOLEAN NOT NULL DEFAULT true,
  can_view_photos BOOLEAN NOT NULL DEFAULT true,
  can_view_documents BOOLEAN NOT NULL DEFAULT true,
  can_view_daily_logs BOOLEAN NOT NULL DEFAULT false,
  can_view_budget BOOLEAN NOT NULL DEFAULT false,
  can_approve_change_orders BOOLEAN NOT NULL DEFAULT true,
  can_submit_selections BOOLEAN NOT NULL DEFAULT true,
  can_create_punch_items BOOLEAN NOT NULL DEFAULT false,
  can_message BOOLEAN NOT NULL DEFAULT true,
  created_by UUID REFERENCES app_users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,
  last_accessed_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  access_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS portal_access_tokens_token_idx ON portal_access_tokens (token) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS portal_access_tokens_project_idx ON portal_access_tokens (project_id);
CREATE INDEX IF NOT EXISTS portal_access_tokens_org_idx ON portal_access_tokens (org_id);

ALTER TABLE portal_access_tokens ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY portal_tokens_service_role ON portal_access_tokens
    FOR ALL USING (auth.role() = 'service_role');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;;
