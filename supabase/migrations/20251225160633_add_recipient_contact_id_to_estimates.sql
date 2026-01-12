ALTER TABLE estimates ADD COLUMN IF NOT EXISTS recipient_contact_id UUID REFERENCES contacts(id);;
