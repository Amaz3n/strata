-- Fix migration: Deduplicate conversations before creating unique index
-- Run this if the previous migration failed on unique index creation

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

-- Drop the index if it exists (in case of partial creation)
DROP INDEX IF EXISTS conversations_unique_audience_idx;

-- Create unique index for conversation lookup pattern
CREATE UNIQUE INDEX conversations_unique_audience_idx
ON conversations(org_id, project_id, channel, COALESCE(audience_company_id, '00000000-0000-0000-0000-000000000000'::uuid));
