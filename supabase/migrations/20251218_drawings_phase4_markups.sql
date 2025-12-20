-- Phase 4: Drawings v2 - Markups + "Link Work to Drawings"
-- This migration adds markup annotations and entity pins to drawing sheets

-- ============================================================================
-- DRAWING MARKUPS
-- Stores vector annotations (arrows, circles, text, etc.) on drawing sheets
-- ============================================================================
CREATE TABLE IF NOT EXISTS drawing_markups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,

  -- Link to specific sheet version (annotations are version-specific)
  drawing_sheet_id uuid NOT NULL REFERENCES drawing_sheets(id) ON DELETE CASCADE,
  sheet_version_id uuid REFERENCES drawing_sheet_versions(id) ON DELETE SET NULL,

  -- Markup content (stores annotation type and vector data)
  -- Example structure for data:
  -- {
  --   "type": "arrow" | "circle" | "rectangle" | "text" | "freehand" | "callout" | "dimension",
  --   "points": [[x1, y1], [x2, y2], ...],  -- normalized 0-1 coordinates
  --   "color": "#FF0000",
  --   "strokeWidth": 2,
  --   "text": "Optional text content",
  --   "fontSize": 14,
  --   "style": { ... additional style properties }
  -- }
  data jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Optional label for searching/filtering
  label text,

  -- Visibility settings
  is_private boolean NOT NULL DEFAULT false, -- If true, only visible to creator
  share_with_clients boolean NOT NULL DEFAULT false,
  share_with_subs boolean NOT NULL DEFAULT false,

  -- Audit
  created_by uuid REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS drawing_markups_sheet_idx ON drawing_markups (org_id, drawing_sheet_id);
CREATE INDEX IF NOT EXISTS drawing_markups_version_idx ON drawing_markups (org_id, sheet_version_id);
CREATE INDEX IF NOT EXISTS drawing_markups_creator_idx ON drawing_markups (org_id, created_by);
CREATE INDEX IF NOT EXISTS drawing_markups_data_idx ON drawing_markups USING GIN (data);

-- RLS
ALTER TABLE drawing_markups ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Org members can view drawing markups"
  ON drawing_markups FOR SELECT
  USING (is_org_member(org_id));

CREATE POLICY "Org members can insert drawing markups"
  ON drawing_markups FOR INSERT
  WITH CHECK (is_org_member(org_id));

CREATE POLICY "Org members can update drawing markups"
  ON drawing_markups FOR UPDATE
  USING (is_org_member(org_id))
  WITH CHECK (is_org_member(org_id));

CREATE POLICY "Org members can delete drawing markups"
  ON drawing_markups FOR DELETE
  USING (is_org_member(org_id));

-- ============================================================================
-- DRAWING PINS
-- Links entities (tasks, RFIs, punch items, etc.) to specific locations on sheets
-- ============================================================================
CREATE TABLE IF NOT EXISTS drawing_pins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

  -- Link to sheet (pins can optionally be version-specific)
  drawing_sheet_id uuid NOT NULL REFERENCES drawing_sheets(id) ON DELETE CASCADE,
  sheet_version_id uuid REFERENCES drawing_sheet_versions(id) ON DELETE SET NULL,

  -- Location on the sheet (normalized 0-1 coordinates)
  -- This allows the pin to scale with different view sizes
  x_position numeric(10, 8) NOT NULL CHECK (x_position >= 0 AND x_position <= 1),
  y_position numeric(10, 8) NOT NULL CHECK (y_position >= 0 AND y_position <= 1),

  -- Linked entity (polymorphic reference)
  entity_type text NOT NULL CHECK (entity_type IN (
    'task',
    'rfi',
    'punch_list',
    'submittal',
    'daily_log',
    'observation',
    'issue'
  )),
  entity_id uuid NOT NULL,

  -- Optional label (can override entity title for display)
  label text,

  -- Pin styling
  -- Example: { "color": "#FF0000", "icon": "flag", "size": "medium" }
  style jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Status tracking (derived from entity, but cached for performance)
  status text, -- open, in_progress, closed, etc.

  -- Visibility settings
  share_with_clients boolean NOT NULL DEFAULT false,
  share_with_subs boolean NOT NULL DEFAULT false,

  -- Audit
  created_by uuid REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS drawing_pins_sheet_idx ON drawing_pins (org_id, drawing_sheet_id);
CREATE INDEX IF NOT EXISTS drawing_pins_project_idx ON drawing_pins (org_id, project_id);
CREATE INDEX IF NOT EXISTS drawing_pins_entity_idx ON drawing_pins (org_id, entity_type, entity_id);
CREATE INDEX IF NOT EXISTS drawing_pins_version_idx ON drawing_pins (org_id, sheet_version_id);
CREATE INDEX IF NOT EXISTS drawing_pins_status_idx ON drawing_pins (org_id, status);

-- Unique constraint to prevent duplicate pins for same entity on same sheet
CREATE UNIQUE INDEX IF NOT EXISTS drawing_pins_entity_sheet_unique
  ON drawing_pins (org_id, drawing_sheet_id, entity_type, entity_id);

-- RLS
ALTER TABLE drawing_pins ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Org members can view drawing pins"
  ON drawing_pins FOR SELECT
  USING (is_org_member(org_id));

CREATE POLICY "Org members can insert drawing pins"
  ON drawing_pins FOR INSERT
  WITH CHECK (is_org_member(org_id));

CREATE POLICY "Org members can update drawing pins"
  ON drawing_pins FOR UPDATE
  USING (is_org_member(org_id))
  WITH CHECK (is_org_member(org_id));

CREATE POLICY "Org members can delete drawing pins"
  ON drawing_pins FOR DELETE
  USING (is_org_member(org_id));

-- ============================================================================
-- TRIGGERS
-- ============================================================================

-- Update updated_at trigger for drawing_markups
CREATE OR REPLACE FUNCTION update_drawing_markups_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER drawing_markups_updated_at
  BEFORE UPDATE ON drawing_markups
  FOR EACH ROW
  EXECUTE FUNCTION update_drawing_markups_updated_at();

-- Update updated_at trigger for drawing_pins
CREATE OR REPLACE FUNCTION update_drawing_pins_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER drawing_pins_updated_at
  BEFORE UPDATE ON drawing_pins
  FOR EACH ROW
  EXECUTE FUNCTION update_drawing_pins_updated_at();

-- ============================================================================
-- COMMENTS
-- ============================================================================
COMMENT ON TABLE drawing_markups IS 'Vector annotations on drawing sheets (arrows, circles, text, etc.)';
COMMENT ON TABLE drawing_pins IS 'Links entities (tasks, RFIs, punch items) to specific locations on drawing sheets';

COMMENT ON COLUMN drawing_markups.data IS 'JSON object containing annotation type and vector data: type, points, color, strokeWidth, text, fontSize, style';
COMMENT ON COLUMN drawing_markups.is_private IS 'If true, only visible to the creator';

COMMENT ON COLUMN drawing_pins.x_position IS 'Normalized X coordinate (0-1) on the drawing sheet';
COMMENT ON COLUMN drawing_pins.y_position IS 'Normalized Y coordinate (0-1) on the drawing sheet';
COMMENT ON COLUMN drawing_pins.entity_type IS 'Type of linked entity: task, rfi, punch_list, submittal, daily_log, observation, issue';
COMMENT ON COLUMN drawing_pins.style IS 'JSON object for pin styling: color, icon, size';
COMMENT ON COLUMN drawing_pins.status IS 'Cached status from linked entity for quick filtering';
