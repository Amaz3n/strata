-- Add cost tracking columns to schedule_items
ALTER TABLE schedule_items
ADD COLUMN IF NOT EXISTS cost_code_id uuid REFERENCES cost_codes(id) ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS budget_cents integer DEFAULT 0,
ADD COLUMN IF NOT EXISTS actual_cost_cents integer DEFAULT 0;

-- Add index for cost_code lookups
CREATE INDEX IF NOT EXISTS idx_schedule_items_cost_code_id ON schedule_items(cost_code_id);

COMMENT ON COLUMN schedule_items.cost_code_id IS 'Reference to cost code for budget tracking';
COMMENT ON COLUMN schedule_items.budget_cents IS 'Budgeted cost in cents';
COMMENT ON COLUMN schedule_items.actual_cost_cents IS 'Actual cost incurred in cents';;
