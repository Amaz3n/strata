-- Phase 3: Drawings v1 - Plan Set Ingestion + Sheet Register
-- This migration creates the drawing management tables for construction plans

-- ============================================================================
-- DRAWING SETS
-- A drawing set represents an uploaded multi-page plan PDF
-- ============================================================================
CREATE TABLE IF NOT EXISTS drawing_sets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

  -- Set metadata
  title text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'ready', 'failed')),

  -- Source file reference
  source_file_id uuid REFERENCES files(id) ON DELETE SET NULL,

  -- Processing info
  total_pages int,
  processed_pages int DEFAULT 0,
  error_message text,

  -- Audit
  created_by uuid REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS drawing_sets_org_project_idx ON drawing_sets (org_id, project_id);
CREATE INDEX IF NOT EXISTS drawing_sets_status_idx ON drawing_sets (org_id, status);
CREATE INDEX IF NOT EXISTS drawing_sets_created_at_idx ON drawing_sets (org_id, created_at DESC);

-- RLS
ALTER TABLE drawing_sets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Org members can view drawing sets"
  ON drawing_sets FOR SELECT
  USING (is_org_member(org_id));

CREATE POLICY "Org members can insert drawing sets"
  ON drawing_sets FOR INSERT
  WITH CHECK (is_org_member(org_id));

CREATE POLICY "Org members can update drawing sets"
  ON drawing_sets FOR UPDATE
  USING (is_org_member(org_id))
  WITH CHECK (is_org_member(org_id));

CREATE POLICY "Org members can delete drawing sets"
  ON drawing_sets FOR DELETE
  USING (is_org_member(org_id));

-- ============================================================================
-- DRAWING REVISIONS
-- A revision represents a specific issuance of drawings (e.g., "Rev A", "For Construction")
-- ============================================================================
CREATE TABLE IF NOT EXISTS drawing_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  drawing_set_id uuid REFERENCES drawing_sets(id) ON DELETE SET NULL,

  -- Revision metadata
  revision_label text NOT NULL, -- e.g., "A", "B", "1", "For Construction"
  issued_date date,
  notes text,

  -- Audit
  created_by uuid REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS drawing_revisions_set_idx ON drawing_revisions (org_id, drawing_set_id);
CREATE INDEX IF NOT EXISTS drawing_revisions_project_idx ON drawing_revisions (org_id, project_id);

-- RLS
ALTER TABLE drawing_revisions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Org members can view drawing revisions"
  ON drawing_revisions FOR SELECT
  USING (is_org_member(org_id));

CREATE POLICY "Org members can insert drawing revisions"
  ON drawing_revisions FOR INSERT
  WITH CHECK (is_org_member(org_id));

CREATE POLICY "Org members can update drawing revisions"
  ON drawing_revisions FOR UPDATE
  USING (is_org_member(org_id))
  WITH CHECK (is_org_member(org_id));

CREATE POLICY "Org members can delete drawing revisions"
  ON drawing_revisions FOR DELETE
  USING (is_org_member(org_id));

-- ============================================================================
-- DRAWING SHEETS
-- Individual sheets/pages within a drawing set (e.g., "A1.01 Floor Plan")
-- ============================================================================
CREATE TABLE IF NOT EXISTS drawing_sheets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  drawing_set_id uuid NOT NULL REFERENCES drawing_sets(id) ON DELETE CASCADE,

  -- Sheet identification
  sheet_number text NOT NULL, -- e.g., "A1.01", "E2.03"
  sheet_title text, -- e.g., "First Floor Plan", "Electrical Details"

  -- Classification
  discipline text CHECK (discipline IN (
    'A',  -- Architectural
    'S',  -- Structural
    'M',  -- Mechanical
    'E',  -- Electrical
    'P',  -- Plumbing
    'C',  -- Civil
    'L',  -- Landscape
    'I',  -- Interior
    'FP', -- Fire Protection
    'G',  -- General/Cover
    'T',  -- Title/Cover
    'SP', -- Specifications
    'D',  -- Details
    'X'   -- Other/Unknown
  )),

  -- Current revision tracking
  current_revision_id uuid REFERENCES drawing_revisions(id),

  -- Ordering
  sort_order int DEFAULT 0,

  -- Portal sharing
  share_with_clients boolean NOT NULL DEFAULT false,
  share_with_subs boolean NOT NULL DEFAULT false,

  -- Audit
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS drawing_sheets_set_idx ON drawing_sheets (org_id, drawing_set_id);
CREATE INDEX IF NOT EXISTS drawing_sheets_project_idx ON drawing_sheets (org_id, project_id);
CREATE INDEX IF NOT EXISTS drawing_sheets_number_idx ON drawing_sheets (org_id, project_id, sheet_number);
CREATE INDEX IF NOT EXISTS drawing_sheets_discipline_idx ON drawing_sheets (org_id, project_id, discipline);

-- RLS
ALTER TABLE drawing_sheets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Org members can view drawing sheets"
  ON drawing_sheets FOR SELECT
  USING (is_org_member(org_id));

CREATE POLICY "Org members can insert drawing sheets"
  ON drawing_sheets FOR INSERT
  WITH CHECK (is_org_member(org_id));

CREATE POLICY "Org members can update drawing sheets"
  ON drawing_sheets FOR UPDATE
  USING (is_org_member(org_id))
  WITH CHECK (is_org_member(org_id));

CREATE POLICY "Org members can delete drawing sheets"
  ON drawing_sheets FOR DELETE
  USING (is_org_member(org_id));

-- ============================================================================
-- DRAWING SHEET VERSIONS
-- Links a sheet to a specific revision with its file
-- ============================================================================
CREATE TABLE IF NOT EXISTS drawing_sheet_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  drawing_sheet_id uuid NOT NULL REFERENCES drawing_sheets(id) ON DELETE CASCADE,
  drawing_revision_id uuid NOT NULL REFERENCES drawing_revisions(id) ON DELETE CASCADE,

  -- File references
  file_id uuid REFERENCES files(id) ON DELETE SET NULL, -- The actual PDF page
  thumbnail_file_id uuid REFERENCES files(id) ON DELETE SET NULL, -- Optional thumbnail

  -- Source tracking
  page_index int, -- Original page number in the source PDF

  -- Metadata extracted during processing
  extracted_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Audit
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS drawing_sheet_versions_sheet_idx ON drawing_sheet_versions (org_id, drawing_sheet_id);
CREATE INDEX IF NOT EXISTS drawing_sheet_versions_revision_idx ON drawing_sheet_versions (org_id, drawing_revision_id);

-- RLS
ALTER TABLE drawing_sheet_versions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Org members can view drawing sheet versions"
  ON drawing_sheet_versions FOR SELECT
  USING (is_org_member(org_id));

CREATE POLICY "Org members can insert drawing sheet versions"
  ON drawing_sheet_versions FOR INSERT
  WITH CHECK (is_org_member(org_id));

CREATE POLICY "Org members can update drawing sheet versions"
  ON drawing_sheet_versions FOR UPDATE
  USING (is_org_member(org_id))
  WITH CHECK (is_org_member(org_id));

CREATE POLICY "Org members can delete drawing sheet versions"
  ON drawing_sheet_versions FOR DELETE
  USING (is_org_member(org_id));

-- ============================================================================
-- FILE ACCESS EVENTS (for audit logging)
-- Tracks downloads/views for dispute-proofing and compliance
-- ============================================================================
CREATE TABLE IF NOT EXISTS file_access_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  file_id uuid NOT NULL REFERENCES files(id) ON DELETE CASCADE,

  -- Actor (one of these should be set)
  actor_user_id uuid REFERENCES app_users(id),
  portal_token_id uuid, -- References portal_access_tokens if accessed via portal

  -- Access details
  action text NOT NULL CHECK (action IN ('view', 'download', 'share', 'unshare', 'print')),
  ip_address inet,
  user_agent text,

  -- Additional context
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Timestamp
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS file_access_events_file_idx ON file_access_events (org_id, file_id, created_at DESC);
CREATE INDEX IF NOT EXISTS file_access_events_user_idx ON file_access_events (org_id, actor_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS file_access_events_created_idx ON file_access_events (org_id, created_at DESC);

-- RLS
ALTER TABLE file_access_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Org members can view file access events"
  ON file_access_events FOR SELECT
  USING (is_org_member(org_id));

CREATE POLICY "Org members can insert file access events"
  ON file_access_events FOR INSERT
  WITH CHECK (is_org_member(org_id));

-- ============================================================================
-- TRIGGERS
-- ============================================================================

-- Update updated_at trigger for drawing_sets
CREATE OR REPLACE FUNCTION update_drawing_sets_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER drawing_sets_updated_at
  BEFORE UPDATE ON drawing_sets
  FOR EACH ROW
  EXECUTE FUNCTION update_drawing_sets_updated_at();

-- Update updated_at trigger for drawing_sheets
CREATE OR REPLACE FUNCTION update_drawing_sheets_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER drawing_sheets_updated_at
  BEFORE UPDATE ON drawing_sheets
  FOR EACH ROW
  EXECUTE FUNCTION update_drawing_sheets_updated_at();

-- ============================================================================
-- COMMENTS
-- ============================================================================
COMMENT ON TABLE drawing_sets IS 'Uploaded plan set PDFs that get processed into individual sheets';
COMMENT ON TABLE drawing_revisions IS 'Revision/issuance labels for tracking drawing versions';
COMMENT ON TABLE drawing_sheets IS 'Individual sheets extracted from a drawing set';
COMMENT ON TABLE drawing_sheet_versions IS 'Links sheets to revisions with their actual file';
COMMENT ON TABLE file_access_events IS 'Audit log for file downloads and views';

COMMENT ON COLUMN drawing_sheets.discipline IS 'Drawing discipline code: A=Arch, S=Struct, M=Mech, E=Elec, P=Plumb, C=Civil, L=Landscape, I=Interior, FP=Fire, G=General, T=Title, SP=Specs, D=Details, X=Other';
COMMENT ON COLUMN drawing_sheet_versions.extracted_metadata IS 'Metadata extracted during processing (OCR text, detected elements, etc.)';
