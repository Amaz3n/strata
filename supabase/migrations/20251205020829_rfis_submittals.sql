CREATE TABLE IF NOT EXISTS rfis (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  rfi_number INTEGER NOT NULL,
  subject TEXT NOT NULL,
  question TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('draft','open','answered','closed')),
  priority TEXT CHECK (priority IN ('low','normal','high','urgent')),
  submitted_by UUID REFERENCES app_users(id),
  submitted_by_company_id UUID REFERENCES companies(id),
  assigned_to UUID REFERENCES app_users(id),
  submitted_at TIMESTAMPTZ,
  due_date DATE,
  answered_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  cost_impact_cents INTEGER,
  schedule_impact_days INTEGER,
  drawing_reference TEXT,
  spec_reference TEXT,
  location TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, rfi_number)
);
CREATE INDEX IF NOT EXISTS rfis_project_idx ON rfis (project_id);
CREATE INDEX IF NOT EXISTS rfis_org_idx ON rfis (org_id);
DO $$ BEGIN
  IF to_regproc('public.tg_set_updated_at') IS NOT NULL THEN
    CREATE TRIGGER rfis_set_updated_at BEFORE UPDATE ON rfis
      FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
  END IF;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS rfi_responses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  rfi_id UUID NOT NULL REFERENCES rfis(id) ON DELETE CASCADE,
  response_type TEXT NOT NULL CHECK (response_type IN ('answer','clarification','comment')),
  body TEXT NOT NULL,
  responder_user_id UUID REFERENCES app_users(id),
  responder_contact_id UUID REFERENCES contacts(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rfi_responses_rfi_idx ON rfi_responses (rfi_id);

CREATE TABLE IF NOT EXISTS submittals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  submittal_number INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  spec_section TEXT,
  submittal_type TEXT CHECK (submittal_type IN ('product_data','shop_drawing','sample','mock_up','certificate','other')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('draft','pending','approved','approved_as_noted','revise_resubmit','rejected')),
  submitted_by_company_id UUID REFERENCES companies(id),
  submitted_by_contact_id UUID REFERENCES contacts(id),
  reviewed_by UUID REFERENCES app_users(id),
  submitted_at TIMESTAMPTZ,
  due_date DATE,
  reviewed_at TIMESTAMPTZ,
  review_notes TEXT,
  lead_time_days INTEGER,
  required_on_site DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, submittal_number)
);
CREATE INDEX IF NOT EXISTS submittals_project_idx ON submittals (project_id);
CREATE INDEX IF NOT EXISTS submittals_org_idx ON submittals (org_id);
DO $$ BEGIN
  IF to_regproc('public.tg_set_updated_at') IS NOT NULL THEN
    CREATE TRIGGER submittals_set_updated_at BEFORE UPDATE ON submittals
      FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
  END IF;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS submittal_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  submittal_id UUID NOT NULL REFERENCES submittals(id) ON DELETE CASCADE,
  item_number INTEGER NOT NULL,
  description TEXT NOT NULL,
  manufacturer TEXT,
  model_number TEXT,
  file_id UUID REFERENCES files(id) ON DELETE SET NULL,
  status TEXT CHECK (status IN ('pending','approved','rejected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (submittal_id, item_number)
);
CREATE INDEX IF NOT EXISTS submittal_items_submittal_idx ON submittal_items (submittal_id);

ALTER TABLE rfis ENABLE ROW LEVEL SECURITY;
ALTER TABLE rfi_responses ENABLE ROW LEVEL SECURITY;
ALTER TABLE submittals ENABLE ROW LEVEL SECURITY;
ALTER TABLE submittal_items ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY rfis_access ON rfis FOR ALL USING (auth.role() = 'service_role' OR is_org_member(org_id));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY rfi_responses_access ON rfi_responses FOR ALL USING (auth.role() = 'service_role' OR is_org_member(org_id));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY submittals_access ON submittals FOR ALL USING (auth.role() = 'service_role' OR is_org_member(org_id));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE POLICY submittal_items_access ON submittal_items FOR ALL USING (auth.role() = 'service_role' OR is_org_member(org_id));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE OR REPLACE FUNCTION next_rfi_number(p_project_id UUID)
RETURNS INTEGER AS $$
  SELECT COALESCE(MAX(rfi_number), 0) + 1 FROM rfis WHERE project_id = p_project_id;
$$ LANGUAGE SQL;

CREATE OR REPLACE FUNCTION next_submittal_number(p_project_id UUID)
RETURNS INTEGER AS $$
  SELECT COALESCE(MAX(submittal_number), 0) + 1 FROM submittals WHERE project_id = p_project_id;
$$ LANGUAGE SQL;;
