-- Create schedule_item_change_orders, which tracks which change orders impact which
-- schedule items and by how many days. The table was defined in an old backup migration
-- (supabase/_migrations_backup/20251227_schedule_co_draw_integration.sql) that was never
-- pushed, so the app's /api/schedule/[id]/impacts route 500s on a missing table. The column
-- additions from that backup file already exist in the DB; only this table is missing.
--
-- RLS uses the is_org_member() helper (memberships table); the backup file's policies
-- referenced a nonexistent org_members table.

CREATE TABLE IF NOT EXISTS schedule_item_change_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  schedule_item_id uuid NOT NULL REFERENCES schedule_items(id) ON DELETE CASCADE,
  change_order_id uuid NOT NULL REFERENCES change_orders(id) ON DELETE CASCADE,
  days_adjusted integer DEFAULT 0,
  notes text,
  applied_at timestamptz,
  created_at timestamptz DEFAULT now(),
  UNIQUE (schedule_item_id, change_order_id)
);

ALTER TABLE schedule_item_change_orders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Org members can view schedule CO impacts"
  ON schedule_item_change_orders FOR SELECT
  USING (auth.role() = 'service_role' OR is_org_member(org_id));

CREATE POLICY "Org members can insert schedule CO impacts"
  ON schedule_item_change_orders FOR INSERT
  WITH CHECK (auth.role() = 'service_role' OR is_org_member(org_id));

CREATE POLICY "Org members can update schedule CO impacts"
  ON schedule_item_change_orders FOR UPDATE
  USING (auth.role() = 'service_role' OR is_org_member(org_id))
  WITH CHECK (auth.role() = 'service_role' OR is_org_member(org_id));

CREATE POLICY "Org members can delete schedule CO impacts"
  ON schedule_item_change_orders FOR DELETE
  USING (auth.role() = 'service_role' OR is_org_member(org_id));

CREATE INDEX IF NOT EXISTS schedule_item_co_item_idx ON schedule_item_change_orders(schedule_item_id);
CREATE INDEX IF NOT EXISTS schedule_item_co_co_idx ON schedule_item_change_orders(change_order_id);
CREATE INDEX IF NOT EXISTS schedule_item_co_org_idx ON schedule_item_change_orders(org_id);

COMMENT ON TABLE schedule_item_change_orders IS 'Tracks which change orders impact which schedule items and by how many days';
