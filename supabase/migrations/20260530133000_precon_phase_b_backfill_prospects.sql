-- Phase B: backfill the new prospect model from the legacy precon surfaces.
--
-- This migration creates prospect rows from existing opportunities and
-- contact-backed CRM prospects, then links historical projects, estimates,
-- proposals, bid packages, files, documents, envelopes, and file links where a
-- deterministic prospect match exists.

ALTER TABLE public.prospects
  ADD COLUMN IF NOT EXISTS legacy_opportunity_id uuid REFERENCES public.opportunities(id) ON DELETE SET NULL;

ALTER TABLE public.prospects
  ADD COLUMN IF NOT EXISTS legacy_contact_id uuid REFERENCES public.contacts(id) ON DELETE SET NULL;

ALTER TABLE public.prospects
  ADD COLUMN IF NOT EXISTS legacy_source text;

ALTER TABLE public.proposals
  ADD COLUMN IF NOT EXISTS prospect_id uuid REFERENCES public.prospects(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS prospects_org_legacy_opportunity_uidx
  ON public.prospects (org_id, legacy_opportunity_id)
  WHERE legacy_opportunity_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS prospects_org_legacy_contact_uidx
  ON public.prospects (org_id, legacy_contact_id)
  WHERE legacy_contact_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS proposals_org_prospect_idx
  ON public.proposals (org_id, prospect_id);

WITH opportunity_backfill AS (
  SELECT
    o.id,
    o.org_id,
    o.name,
    CASE o.status::text
      WHEN 'estimating' THEN 'pricing'
      WHEN 'proposed' THEN 'estimate_sent'
      WHEN 'won' THEN 'won'
      WHEN 'lost' THEN 'lost'
      WHEN 'qualified' THEN 'qualified'
      WHEN 'contacted' THEN 'contacted'
      ELSE 'new'
    END::public.prospect_status AS prospect_status,
    o.owner_user_id,
    o.source,
    o.jobsite_location,
    o.project_type,
    o.budget_range,
    o.timeline_preference,
    COALESCE(o.tags, '{}'::text[]) AS tags,
    o.notes,
    o.created_at,
    o.updated_at
  FROM public.opportunities o
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.prospects p
    WHERE p.org_id = o.org_id
      AND p.legacy_opportunity_id = o.id
  )
)
INSERT INTO public.prospects (
  org_id,
  name,
  status,
  owner_user_id,
  source,
  jobsite_location,
  project_type,
  budget_range,
  timeline_preference,
  tags,
  notes,
  won_at,
  lost_at,
  created_by,
  created_at,
  updated_at,
  legacy_opportunity_id,
  legacy_source
)
SELECT
  org_id,
  name,
  prospect_status,
  owner_user_id,
  source,
  jobsite_location,
  project_type,
  budget_range,
  timeline_preference,
  tags,
  notes,
  CASE WHEN prospect_status = 'won' THEN COALESCE(updated_at, created_at, now()) END,
  CASE WHEN prospect_status = 'lost' THEN COALESCE(updated_at, created_at, now()) END,
  owner_user_id,
  created_at,
  COALESCE(updated_at, created_at, now()),
  id,
  'opportunity'
FROM opportunity_backfill;

INSERT INTO public.prospect_contacts (
  org_id,
  prospect_id,
  contact_id,
  full_name,
  email,
  phone,
  role,
  company_name,
  is_primary,
  promoted_contact_id,
  metadata,
  created_at,
  updated_at
)
SELECT
  p.org_id,
  p.id,
  c.id,
  c.full_name,
  c.email::text,
  c.phone,
  c.role,
  NULL,
  true,
  c.id,
  jsonb_build_object(
    'legacy_source', 'opportunity',
    'legacy_opportunity_id', o.id,
    'legacy_contact_id', c.id
  ),
  LEAST(o.created_at, c.created_at),
  now()
FROM public.prospects p
JOIN public.opportunities o
  ON o.org_id = p.org_id
  AND o.id = p.legacy_opportunity_id
JOIN public.contacts c
  ON c.org_id = o.org_id
  AND c.id = o.client_contact_id
WHERE NOT EXISTS (
  SELECT 1
  FROM public.prospect_contacts pc
  WHERE pc.org_id = p.org_id
    AND pc.prospect_id = p.id
    AND pc.is_primary
);

WITH eligible_contact_prospects AS (
  SELECT
    c.*,
    CASE
      WHEN COALESCE(c.metadata->>'lead_status', '') = 'estimating' THEN 'pricing'
      WHEN COALESCE(c.metadata->>'lead_status', '') = 'won' THEN 'won'
      WHEN COALESCE(c.metadata->>'lead_status', '') = 'lost' THEN 'lost'
      WHEN COALESCE(c.metadata->>'lead_status', '') = 'qualified' THEN 'qualified'
      WHEN COALESCE(c.metadata->>'lead_status', '') = 'contacted' THEN 'contacted'
      WHEN COALESCE(c.metadata->>'lead_status', '') = 'new' THEN 'new'
      WHEN EXISTS (
        SELECT 1
        FROM public.estimates e
        WHERE e.org_id = c.org_id
          AND e.recipient_contact_id = c.id
          AND e.opportunity_id IS NULL
      ) THEN 'pricing'
      ELSE 'new'
    END::public.prospect_status AS prospect_status
  FROM public.contacts c
  WHERE c.contact_type = 'client'
    AND (c.metadata->>'archived_at') IS NULL
    AND NOT EXISTS (
      SELECT 1
      FROM public.opportunities o
      WHERE o.org_id = c.org_id
        AND o.client_contact_id = c.id
    )
    AND NOT EXISTS (
      SELECT 1
      FROM public.prospects p
      WHERE p.org_id = c.org_id
        AND p.legacy_contact_id = c.id
    )
    AND (
      c.metadata ? 'lead_status'
      OR c.metadata ? 'lead_priority'
      OR c.metadata ? 'lead_owner_user_id'
      OR c.metadata ? 'lead_project_type'
      OR c.metadata ? 'lead_budget_range'
      OR c.metadata ? 'lead_timeline_preference'
      OR c.metadata ? 'lead_tags'
      OR c.metadata ? 'jobsite_location'
      OR c.metadata ? 'next_follow_up_at'
      OR c.metadata ? 'last_contacted_at'
      OR c.metadata ? 'lead_lost_reason'
      OR EXISTS (
        SELECT 1
        FROM public.estimates e
        WHERE e.org_id = c.org_id
          AND e.recipient_contact_id = c.id
          AND e.opportunity_id IS NULL
      )
    )
)
INSERT INTO public.prospects (
  org_id,
  name,
  status,
  owner_user_id,
  source,
  jobsite_location,
  project_type,
  budget_range,
  timeline_preference,
  tags,
  notes,
  lost_reason,
  won_at,
  lost_at,
  created_by,
  created_at,
  updated_at,
  legacy_contact_id,
  legacy_source
)
SELECT
  org_id,
  full_name,
  prospect_status,
  CASE
    WHEN COALESCE(metadata->>'lead_owner_user_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN (metadata->>'lead_owner_user_id')::uuid
    ELSE NULL
  END,
  crm_source,
  CASE
    WHEN jsonb_typeof(metadata->'jobsite_location') = 'object' THEN metadata->'jobsite_location'
    ELSE NULL
  END,
  NULLIF(metadata->>'lead_project_type', ''),
  NULLIF(metadata->>'lead_budget_range', ''),
  NULLIF(metadata->>'lead_timeline_preference', ''),
  CASE
    WHEN jsonb_typeof(metadata->'lead_tags') = 'array'
      THEN ARRAY(SELECT jsonb_array_elements_text(metadata->'lead_tags'))
    ELSE '{}'::text[]
  END,
  NULLIF(metadata->>'notes', ''),
  NULLIF(metadata->>'lead_lost_reason', ''),
  CASE WHEN prospect_status = 'won' THEN COALESCE(updated_at, created_at, now()) END,
  CASE WHEN prospect_status = 'lost' THEN COALESCE(updated_at, created_at, now()) END,
  CASE
    WHEN COALESCE(metadata->>'lead_owner_user_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN (metadata->>'lead_owner_user_id')::uuid
    ELSE NULL
  END,
  created_at,
  COALESCE(updated_at, created_at, now()),
  id,
  'contact'
FROM eligible_contact_prospects;

INSERT INTO public.prospect_contacts (
  org_id,
  prospect_id,
  contact_id,
  full_name,
  email,
  phone,
  role,
  company_name,
  is_primary,
  promoted_contact_id,
  metadata,
  created_at,
  updated_at
)
SELECT
  p.org_id,
  p.id,
  c.id,
  c.full_name,
  c.email::text,
  c.phone,
  c.role,
  NULL,
  true,
  c.id,
  jsonb_build_object(
    'legacy_source', 'contact',
    'legacy_contact_id', c.id
  ),
  c.created_at,
  now()
FROM public.prospects p
JOIN public.contacts c
  ON c.org_id = p.org_id
  AND c.id = p.legacy_contact_id
WHERE NOT EXISTS (
  SELECT 1
  FROM public.prospect_contacts pc
  WHERE pc.org_id = p.org_id
    AND pc.prospect_id = p.id
    AND pc.is_primary
);

WITH project_link_candidates AS (
  SELECT
    project_rows.id AS project_id,
    project_rows.org_id,
    project_rows.prospect_id,
    count(*) OVER (PARTITION BY project_rows.prospect_id) AS prospect_project_count
  FROM (
    SELECT
      p.id,
      p.org_id,
      pr.id AS prospect_id
    FROM public.projects p
    JOIN public.prospects pr
      ON pr.org_id = p.org_id
      AND pr.legacy_opportunity_id = p.opportunity_id
    WHERE p.opportunity_id IS NOT NULL
      AND p.prospect_id IS NULL
  ) project_rows
)
UPDATE public.projects p
SET
  prospect_id = c.prospect_id,
  updated_at = now()
FROM project_link_candidates c
WHERE p.org_id = c.org_id
  AND p.id = c.project_id
  AND c.prospect_project_count = 1;

UPDATE public.estimates e
SET
  prospect_id = p.id,
  updated_at = now()
FROM public.prospects p
WHERE e.org_id = p.org_id
  AND e.opportunity_id = p.legacy_opportunity_id
  AND e.opportunity_id IS NOT NULL
  AND e.prospect_id IS NULL;

WITH contact_prospect_matches AS (
  SELECT
    org_id,
    contact_id,
    (array_agg(prospect_id ORDER BY prospect_id::text))[1] AS prospect_id
  FROM (
    SELECT
      org_id,
      COALESCE(contact_id, promoted_contact_id) AS contact_id,
      prospect_id
    FROM public.prospect_contacts
    WHERE COALESCE(contact_id, promoted_contact_id) IS NOT NULL
  ) matches
  GROUP BY org_id, contact_id
  HAVING count(DISTINCT prospect_id) = 1
)
UPDATE public.estimates e
SET
  prospect_id = m.prospect_id,
  updated_at = now()
FROM contact_prospect_matches m
WHERE e.org_id = m.org_id
  AND e.recipient_contact_id = m.contact_id
  AND e.prospect_id IS NULL;

UPDATE public.proposals p
SET
  prospect_id = pr.id,
  updated_at = now()
FROM public.prospects pr
WHERE p.org_id = pr.org_id
  AND p.opportunity_id = pr.legacy_opportunity_id
  AND p.opportunity_id IS NOT NULL
  AND p.prospect_id IS NULL;

UPDATE public.proposals p
SET
  prospect_id = e.prospect_id,
  updated_at = now()
FROM public.estimates e
WHERE p.org_id = e.org_id
  AND p.estimate_id = e.id
  AND e.prospect_id IS NOT NULL
  AND p.prospect_id IS NULL;

UPDATE public.bid_packages bp
SET
  prospect_id = p.prospect_id,
  updated_at = now()
FROM public.projects p
WHERE bp.org_id = p.org_id
  AND bp.project_id = p.id
  AND p.prospect_id IS NOT NULL
  AND bp.prospect_id IS NULL;

UPDATE public.files f
SET
  prospect_id = p.prospect_id,
  updated_at = now()
FROM public.projects p
WHERE f.org_id = p.org_id
  AND f.project_id = p.id
  AND p.prospect_id IS NOT NULL
  AND f.prospect_id IS NULL;

UPDATE public.documents d
SET
  prospect_id = p.prospect_id,
  updated_at = now()
FROM public.projects p
WHERE d.org_id = p.org_id
  AND d.project_id = p.id
  AND p.prospect_id IS NOT NULL
  AND d.prospect_id IS NULL;

UPDATE public.envelopes e
SET
  prospect_id = p.prospect_id,
  updated_at = now()
FROM public.projects p
WHERE e.org_id = p.org_id
  AND e.project_id = p.id
  AND p.prospect_id IS NOT NULL
  AND e.prospect_id IS NULL;

UPDATE public.file_links fl
SET prospect_id = p.prospect_id
FROM public.projects p
WHERE fl.org_id = p.org_id
  AND fl.project_id = p.id
  AND p.prospect_id IS NOT NULL
  AND fl.prospect_id IS NULL;

COMMENT ON COLUMN public.prospects.legacy_opportunity_id IS
  'Transitional pointer used by the precon redesign backfill. Remove only after legacy opportunities are retired.';

COMMENT ON COLUMN public.prospects.legacy_contact_id IS
  'Transitional pointer used by the precon redesign backfill for old contact-backed CRM prospects.';

COMMENT ON COLUMN public.proposals.prospect_id IS
  'Historical link from legacy proposals to the prospect produced by the precon backfill.';
