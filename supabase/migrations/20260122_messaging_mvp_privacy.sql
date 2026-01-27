-- Messaging MVP: Privacy-correct conversations with per-company scoping
-- This migration adds:
-- 1. audience_company_id to conversations for per-subcontractor privacy
-- 2. audience_contact_id for optional contact-level scoping
-- 3. last_message_at for efficient conversation sorting
-- 4. Unique constraint to prevent duplicate conversations
-- 5. conversation_read_states for unread tracking
-- 6. Index on file_links for message attachments

-- Add audience columns to conversations
ALTER TABLE conversations
ADD COLUMN IF NOT EXISTS audience_company_id uuid REFERENCES companies(id) ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS audience_contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS last_message_at timestamptz;

-- Create indexes for the new columns
CREATE INDEX IF NOT EXISTS conversations_audience_company_idx ON conversations(audience_company_id) WHERE audience_company_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS conversations_last_message_idx ON conversations(last_message_at DESC NULLS LAST);

-- Deduplicate existing conversations before creating unique index
-- Keep the conversation with the most messages (or oldest if no messages)
DO $$
DECLARE
  deleted_count INTEGER;
BEGIN
  WITH conversation_stats AS (
    SELECT
      c.id,
      c.org_id,
      c.project_id,
      c.channel,
      c.audience_company_id,
      c.created_at,
      COUNT(m.id) as message_count
    FROM conversations c
    LEFT JOIN messages m ON m.conversation_id = c.id
    GROUP BY c.id, c.org_id, c.project_id, c.channel, c.audience_company_id, c.created_at
  ),
  duplicates AS (
    SELECT
      id,
      ROW_NUMBER() OVER (
        PARTITION BY org_id, project_id, channel, COALESCE(audience_company_id, '00000000-0000-0000-0000-000000000000'::uuid)
        ORDER BY message_count DESC, created_at ASC
      ) as rn
    FROM conversation_stats
  ),
  to_delete AS (
    SELECT id FROM duplicates WHERE rn > 1
  )
  DELETE FROM conversations WHERE id IN (SELECT id FROM to_delete);

  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RAISE NOTICE 'Deleted % duplicate conversations', deleted_count;
END $$;

-- Create unique index for conversation lookup pattern
-- This ensures only one conversation per (org, project, channel, audience_company) combination
-- For client conversations, audience_company_id will be the client's company
-- For sub conversations, audience_company_id will be the subcontractor company
CREATE UNIQUE INDEX IF NOT EXISTS conversations_unique_audience_idx
ON conversations(org_id, project_id, channel, COALESCE(audience_company_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- Create conversation_read_states table for unread tracking
CREATE TABLE IF NOT EXISTS conversation_read_states (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id uuid REFERENCES app_users(id) ON DELETE CASCADE,
  contact_id uuid REFERENCES contacts(id) ON DELETE CASCADE,
  last_read_at timestamptz NOT NULL DEFAULT now(),
  last_read_message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Either user_id or contact_id must be set (but not both)
  CONSTRAINT conversation_read_states_actor_check CHECK (
    (user_id IS NOT NULL AND contact_id IS NULL) OR
    (user_id IS NULL AND contact_id IS NOT NULL)
  )
);

-- Indexes for read state lookups
CREATE UNIQUE INDEX IF NOT EXISTS conversation_read_states_user_idx
ON conversation_read_states(conversation_id, user_id) WHERE user_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS conversation_read_states_contact_idx
ON conversation_read_states(conversation_id, contact_id) WHERE contact_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS conversation_read_states_org_idx ON conversation_read_states(org_id);

-- Trigger for updated_at
CREATE TRIGGER conversation_read_states_set_updated_at
  BEFORE UPDATE ON conversation_read_states
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

-- RLS for conversation_read_states
ALTER TABLE conversation_read_states ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY conversation_read_states_access ON conversation_read_states
    FOR ALL USING (
      auth.role() = 'service_role' OR
      is_org_member(org_id)
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Add index on file_links for message attachments lookups
CREATE INDEX IF NOT EXISTS file_links_message_attachments_idx
ON file_links(entity_type, entity_id) WHERE entity_type = 'message';

-- Function to update last_message_at on new message
CREATE OR REPLACE FUNCTION update_conversation_last_message_at()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE conversations
  SET last_message_at = NEW.sent_at
  WHERE id = NEW.conversation_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to auto-update last_message_at
DROP TRIGGER IF EXISTS messages_update_conversation_last_message ON messages;
CREATE TRIGGER messages_update_conversation_last_message
  AFTER INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION update_conversation_last_message_at();

-- Backfill last_message_at for existing conversations
UPDATE conversations c
SET last_message_at = (
  SELECT MAX(sent_at) FROM messages m WHERE m.conversation_id = c.id
)
WHERE c.last_message_at IS NULL;
