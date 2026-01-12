-- Allow preconstruction estimates/proposals before a project exists
ALTER TABLE estimates ADD COLUMN IF NOT EXISTS recipient_contact_id UUID REFERENCES contacts(id);
ALTER TABLE estimates ADD COLUMN IF NOT EXISTS valid_until DATE;

ALTER TABLE proposals ALTER COLUMN project_id DROP NOT NULL;
ALTER TABLE proposals ALTER COLUMN estimate_id DROP NOT NULL;
