-- Schedule + Change Order + Draw Schedule Integration
-- Adds cost tracking to schedule items and links COs to schedule impacts

-- Add cost/budget fields to schedule_items
ALTER TABLE schedule_items
ADD COLUMN IF NOT EXISTS cost_code_id uuid REFERENCES cost_codes(id),
ADD COLUMN IF NOT EXISTS budget_cents integer,
ADD COLUMN IF NOT EXISTS actual_cost_cents integer;

-- Track CO impact on schedule items (which COs affected which schedule items)
CREATE TABLE IF NOT EXISTS schedule_item_change_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  schedule_item_id uuid NOT NULL REFERENCES schedule_items(id) ON DELETE CASCADE,
  change_order_id uuid NOT NULL REFERENCES change_orders(id) ON DELETE CASCADE,
  days_adjusted integer DEFAULT 0,
  notes text,
  applied_at timestamptz,
  created_at timestamptz DEFAULT now(),
  UNIQUE(schedule_item_id, change_order_id)
);

-- Enable RLS
ALTER TABLE schedule_item_change_orders ENABLE ROW LEVEL SECURITY;

-- RLS policies for schedule_item_change_orders
CREATE POLICY "Org members can view schedule CO impacts"
  ON schedule_item_change_orders FOR SELECT
  USING (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));

CREATE POLICY "Org members can insert schedule CO impacts"
  ON schedule_item_change_orders FOR INSERT
  WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));

CREATE POLICY "Org members can update schedule CO impacts"
  ON schedule_item_change_orders FOR UPDATE
  USING (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));

CREATE POLICY "Org members can delete schedule CO impacts"
  ON schedule_item_change_orders FOR DELETE
  USING (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));

-- Indexes for performance
CREATE INDEX IF NOT EXISTS schedule_items_cost_code_idx ON schedule_items(cost_code_id);
CREATE INDEX IF NOT EXISTS schedule_item_co_item_idx ON schedule_item_change_orders(schedule_item_id);
CREATE INDEX IF NOT EXISTS schedule_item_co_co_idx ON schedule_item_change_orders(change_order_id);
CREATE INDEX IF NOT EXISTS schedule_item_co_org_idx ON schedule_item_change_orders(org_id);

-- Ensure draw_schedules has milestone_id (may already exist)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'draw_schedules' AND column_name = 'milestone_id'
  ) THEN
    ALTER TABLE draw_schedules ADD COLUMN milestone_id uuid REFERENCES schedule_items(id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS draw_schedules_milestone_idx ON draw_schedules(milestone_id);

-- Comments for documentation
COMMENT ON TABLE schedule_item_change_orders IS 'Tracks which change orders impact which schedule items and by how many days';
COMMENT ON COLUMN schedule_items.cost_code_id IS 'Links schedule item to a cost code for budget tracking';
COMMENT ON COLUMN schedule_items.budget_cents IS 'Budgeted cost for this schedule item in cents';
COMMENT ON COLUMN schedule_items.actual_cost_cents IS 'Actual cost incurred for this schedule item in cents';
COMMENT ON COLUMN draw_schedules.milestone_id IS 'Links draw to a schedule milestone for milestone-based billing';
