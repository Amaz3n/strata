-- Add invite_token column to memberships for custom invite flow
ALTER TABLE memberships
ADD COLUMN IF NOT EXISTS invite_token TEXT UNIQUE,
ADD COLUMN IF NOT EXISTS invite_token_expires_at TIMESTAMPTZ;

-- Index for fast token lookups
CREATE INDEX IF NOT EXISTS idx_memberships_invite_token ON memberships(invite_token) WHERE invite_token IS NOT NULL;

COMMENT ON COLUMN memberships.invite_token IS 'Unique token for invite acceptance flow';
COMMENT ON COLUMN memberships.invite_token_expires_at IS 'Expiration time for the invite token';
