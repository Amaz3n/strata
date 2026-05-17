ALTER TABLE approvals ADD COLUMN IF NOT EXISTS signature_data TEXT;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS signature_ip INET;
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS signed_at TIMESTAMPTZ;

ALTER TABLE change_orders ADD COLUMN IF NOT EXISTS client_visible BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE change_orders ADD COLUMN IF NOT EXISTS requires_signature BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE change_orders ADD COLUMN IF NOT EXISTS days_impact INTEGER;
ALTER TABLE change_orders ADD COLUMN IF NOT EXISTS summary TEXT;

ALTER TABLE punch_items ADD COLUMN IF NOT EXISTS created_via_portal BOOLEAN DEFAULT false;
ALTER TABLE punch_items ADD COLUMN IF NOT EXISTS portal_token_id UUID REFERENCES portal_access_tokens(id);;
