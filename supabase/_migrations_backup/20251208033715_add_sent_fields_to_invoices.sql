ALTER TABLE invoices ADD COLUMN IF NOT EXISTS sent_at timestamptz; ALTER TABLE invoices ADD COLUMN IF NOT EXISTS sent_to_emails text[];;
