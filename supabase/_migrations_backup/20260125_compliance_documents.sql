-- Compliance Document Management
-- Allows subcontractors to upload/refresh compliance documents (W-9, COI, workers comp, license, etc.)
-- with admin review workflow

-- 1. Document Types Table (what types of compliance docs exist)
CREATE TABLE IF NOT EXISTS compliance_document_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name text NOT NULL,                    -- "Certificate of Insurance", "W-9"
  code text NOT NULL,                    -- "coi", "w9", "workers_comp", "license"
  description text,
  has_expiry boolean NOT NULL DEFAULT true,
  expiry_warning_days int NOT NULL DEFAULT 30,
  is_system boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(org_id, code)
);

CREATE INDEX IF NOT EXISTS compliance_doc_types_org_idx ON compliance_document_types(org_id);

-- 2. Company Requirements Table (what docs each company must provide)
CREATE TABLE IF NOT EXISTS company_compliance_requirements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  document_type_id uuid NOT NULL REFERENCES compliance_document_types(id) ON DELETE CASCADE,
  is_required boolean NOT NULL DEFAULT true,
  min_coverage_cents bigint,             -- For insurance minimums
  notes text,                            -- "Must list us as additional insured"
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  UNIQUE(company_id, document_type_id)
);

CREATE INDEX IF NOT EXISTS company_compliance_req_company_idx ON company_compliance_requirements(company_id);
CREATE INDEX IF NOT EXISTS company_compliance_req_org_idx ON company_compliance_requirements(org_id);

-- 3. Compliance Documents Table (actual submitted documents)
CREATE TABLE IF NOT EXISTS compliance_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  document_type_id uuid NOT NULL REFERENCES compliance_document_types(id) ON DELETE CASCADE,
  requirement_id uuid REFERENCES company_compliance_requirements(id) ON DELETE SET NULL,
  file_id uuid REFERENCES files(id) ON DELETE SET NULL,

  status text NOT NULL DEFAULT 'pending_review'
    CHECK (status IN ('pending_review', 'approved', 'rejected', 'expired')),
  effective_date date,
  expiry_date date,
  policy_number text,
  coverage_amount_cents bigint,
  carrier_name text,

  reviewed_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  review_notes text,
  rejection_reason text,

  submitted_via_portal boolean NOT NULL DEFAULT false,
  portal_token_id uuid REFERENCES portal_access_tokens(id) ON DELETE SET NULL,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS compliance_docs_company_idx ON compliance_documents(company_id);
CREATE INDEX IF NOT EXISTS compliance_docs_org_idx ON compliance_documents(org_id);
CREATE INDEX IF NOT EXISTS compliance_docs_status_idx ON compliance_documents(status);
CREATE INDEX IF NOT EXISTS compliance_docs_expiry_idx ON compliance_documents(expiry_date)
  WHERE status = 'approved';
CREATE INDEX IF NOT EXISTS compliance_docs_pending_idx ON compliance_documents(org_id, status)
  WHERE status = 'pending_review';

-- 4. Add portal permission for compliance uploads
ALTER TABLE portal_access_tokens
ADD COLUMN IF NOT EXISTS can_upload_compliance_docs boolean NOT NULL DEFAULT true;

-- 5. RLS Policies
ALTER TABLE compliance_document_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_compliance_requirements ENABLE ROW LEVEL SECURITY;
ALTER TABLE compliance_documents ENABLE ROW LEVEL SECURITY;

-- Compliance document types: org members can read/write
CREATE POLICY compliance_doc_types_org_access ON compliance_document_types
  FOR ALL
  USING (
    org_id IN (
      SELECT org_id FROM memberships
      WHERE user_id = auth.uid() AND status = 'active'
    )
  );

-- Company compliance requirements: org members can read/write
CREATE POLICY company_compliance_req_org_access ON company_compliance_requirements
  FOR ALL
  USING (
    org_id IN (
      SELECT org_id FROM memberships
      WHERE user_id = auth.uid() AND status = 'active'
    )
  );

-- Compliance documents: org members can read/write
CREATE POLICY compliance_docs_org_access ON compliance_documents
  FOR ALL
  USING (
    org_id IN (
      SELECT org_id FROM memberships
      WHERE user_id = auth.uid() AND status = 'active'
    )
  );

-- 6. Seed system document types for existing orgs
INSERT INTO compliance_document_types (org_id, name, code, description, has_expiry, is_system)
SELECT
  o.id,
  t.name,
  t.code,
  t.description,
  t.has_expiry,
  true
FROM orgs o
CROSS JOIN (VALUES
  ('W-9 Form', 'w9', 'IRS tax identification form', false),
  ('Certificate of Insurance (COI)', 'coi', 'General liability insurance certificate', true),
  ('Workers Compensation Certificate', 'workers_comp', 'Workers compensation insurance proof', true),
  ('Contractor License', 'license', 'State or local contractor license', true),
  ('Auto Insurance Certificate', 'auto_insurance', 'Commercial auto insurance certificate', true)
) AS t(name, code, description, has_expiry)
ON CONFLICT (org_id, code) DO NOTHING;

-- 7. Function to seed document types for new orgs
CREATE OR REPLACE FUNCTION seed_compliance_document_types()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO compliance_document_types (org_id, name, code, description, has_expiry, is_system)
  VALUES
    (NEW.id, 'W-9 Form', 'w9', 'IRS tax identification form', false, true),
    (NEW.id, 'Certificate of Insurance (COI)', 'coi', 'General liability insurance certificate', true, true),
    (NEW.id, 'Workers Compensation Certificate', 'workers_comp', 'Workers compensation insurance proof', true, true),
    (NEW.id, 'Contractor License', 'license', 'State or local contractor license', true, true),
    (NEW.id, 'Auto Insurance Certificate', 'auto_insurance', 'Commercial auto insurance certificate', true, true)
  ON CONFLICT (org_id, code) DO NOTHING;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create trigger to seed document types when org is created
DROP TRIGGER IF EXISTS seed_compliance_doc_types_on_org_create ON orgs;
CREATE TRIGGER seed_compliance_doc_types_on_org_create
  AFTER INSERT ON orgs
  FOR EACH ROW
  EXECUTE FUNCTION seed_compliance_document_types();
