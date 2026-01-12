CREATE TABLE project_vendors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  company_id uuid REFERENCES companies(id) ON DELETE CASCADE,
  contact_id uuid REFERENCES contacts(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'subcontractor', -- 'subcontractor', 'supplier', 'consultant', 'architect', 'engineer', 'client'
  scope text, -- e.g., 'Electrical', 'Plumbing', 'Structural'
  status text NOT NULL DEFAULT 'active', -- 'active', 'invited', 'inactive'
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT check_has_entity CHECK (company_id IS NOT NULL OR contact_id IS NOT NULL),
  UNIQUE (project_id, company_id),
  UNIQUE (project_id, contact_id)
);

CREATE INDEX idx_project_vendors_project ON project_vendors(project_id);
CREATE INDEX idx_project_vendors_company ON project_vendors(company_id);
CREATE INDEX idx_project_vendors_contact ON project_vendors(contact_id);

-- RLS policies
ALTER TABLE project_vendors ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view project vendors in their org"
  ON project_vendors FOR SELECT
  USING (org_id IN (SELECT org_id FROM memberships WHERE user_id = auth.uid() AND status = 'active'));

CREATE POLICY "Users can manage project vendors in their org"
  ON project_vendors FOR ALL
  USING (org_id IN (SELECT org_id FROM memberships WHERE user_id = auth.uid() AND status = 'active'));;
