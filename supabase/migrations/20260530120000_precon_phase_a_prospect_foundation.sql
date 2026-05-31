-- Phase A: precon prospect foundation.
--
-- This migration is intentionally additive. It introduces a first-class
-- prospect/job file for pre-project work and lets bids, documents, signatures,
-- files, estimates, and projects reference that prospect context without
-- removing the legacy contact/opportunity model yet.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'prospect_status') THEN
    CREATE TYPE public.prospect_status AS ENUM (
      'new',
      'contacted',
      'qualified',
      'pricing',
      'estimate_sent',
      'changes_requested',
      'client_approved',
      'executed',
      'won',
      'lost'
    );
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS public.prospects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.orgs(id) ON DELETE CASCADE,
  name text NOT NULL,
  status public.prospect_status NOT NULL DEFAULT 'new',
  owner_user_id uuid REFERENCES public.app_users(id) ON DELETE SET NULL,
  source text,
  jobsite_location jsonb,
  project_type text,
  budget_range text,
  timeline_preference text,
  tags text[] NOT NULL DEFAULT '{}'::text[],
  notes text,
  lost_reason text,
  won_at timestamptz,
  lost_at timestamptz,
  created_by uuid REFERENCES public.app_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT prospects_name_nonempty_chk CHECK (length(btrim(name)) > 0),
  CONSTRAINT prospects_terminal_dates_chk CHECK (
    (status = 'won' AND won_at IS NOT NULL AND lost_at IS NULL)
    OR (status = 'lost' AND lost_at IS NOT NULL AND won_at IS NULL)
    OR (status NOT IN ('won', 'lost'))
  )
);

CREATE TABLE IF NOT EXISTS public.prospect_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.orgs(id) ON DELETE CASCADE,
  prospect_id uuid NOT NULL REFERENCES public.prospects(id) ON DELETE CASCADE,
  contact_id uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
  full_name text NOT NULL,
  email text,
  phone text,
  role text,
  company_name text,
  is_primary boolean NOT NULL DEFAULT false,
  promoted_contact_id uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT prospect_contacts_name_nonempty_chk CHECK (length(btrim(full_name)) > 0)
);

ALTER TABLE public.estimates
  ADD COLUMN IF NOT EXISTS prospect_id uuid REFERENCES public.prospects(id);

ALTER TABLE public.bid_packages
  ADD COLUMN IF NOT EXISTS prospect_id uuid REFERENCES public.prospects(id);

ALTER TABLE public.files
  ADD COLUMN IF NOT EXISTS prospect_id uuid REFERENCES public.prospects(id);

ALTER TABLE public.documents
  ADD COLUMN IF NOT EXISTS prospect_id uuid REFERENCES public.prospects(id);

ALTER TABLE public.envelopes
  ADD COLUMN IF NOT EXISTS prospect_id uuid REFERENCES public.prospects(id);

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS prospect_id uuid REFERENCES public.prospects(id) ON DELETE SET NULL;

ALTER TABLE public.file_links
  ADD COLUMN IF NOT EXISTS prospect_id uuid REFERENCES public.prospects(id);

ALTER TABLE public.bid_packages
  ALTER COLUMN project_id DROP NOT NULL;

ALTER TABLE public.documents
  ALTER COLUMN project_id DROP NOT NULL;

ALTER TABLE public.envelopes
  ALTER COLUMN project_id DROP NOT NULL;

ALTER TABLE public.documents
  DROP CONSTRAINT IF EXISTS documents_document_type_check;

ALTER TABLE public.documents
  ADD CONSTRAINT documents_document_type_check CHECK (
    document_type = ANY (
      ARRAY[
        'estimate'::text,
        'proposal'::text,
        'contract'::text,
        'change_order'::text,
        'other'::text
      ]
    )
  );

ALTER TABLE public.documents
  DROP CONSTRAINT IF EXISTS documents_source_entity_type_chk;

ALTER TABLE public.documents
  ADD CONSTRAINT documents_source_entity_type_chk CHECK (
    source_entity_type IS NULL
    OR source_entity_type = ANY (
      ARRAY[
        'estimate'::text,
        'proposal'::text,
        'change_order'::text,
        'lien_waiver'::text,
        'selection'::text,
        'subcontract'::text,
        'closeout'::text,
        'other'::text
      ]
    )
  );

ALTER TABLE public.envelopes
  DROP CONSTRAINT IF EXISTS envelopes_source_entity_type_check;

ALTER TABLE public.envelopes
  ADD CONSTRAINT envelopes_source_entity_type_check CHECK (
    source_entity_type IS NULL
    OR source_entity_type = ANY (
      ARRAY[
        'estimate'::text,
        'proposal'::text,
        'change_order'::text,
        'lien_waiver'::text,
        'selection'::text,
        'subcontract'::text,
        'closeout'::text,
        'other'::text
      ]
    )
  );

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.bid_packages'::regclass
      AND conname = 'bid_packages_precon_context_chk'
  ) THEN
    ALTER TABLE public.bid_packages
      ADD CONSTRAINT bid_packages_precon_context_chk CHECK (
        project_id IS NOT NULL
        OR prospect_id IS NOT NULL
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.documents'::regclass
      AND conname = 'documents_precon_context_chk'
  ) THEN
    ALTER TABLE public.documents
      ADD CONSTRAINT documents_precon_context_chk CHECK (
        project_id IS NOT NULL
        OR prospect_id IS NOT NULL
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.envelopes'::regclass
      AND conname = 'envelopes_precon_context_chk'
  ) THEN
    ALTER TABLE public.envelopes
      ADD CONSTRAINT envelopes_precon_context_chk CHECK (
        project_id IS NOT NULL
        OR prospect_id IS NOT NULL
      );
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS prospects_org_status_idx
  ON public.prospects (org_id, status);

CREATE INDEX IF NOT EXISTS prospects_org_owner_idx
  ON public.prospects (org_id, owner_user_id);

CREATE INDEX IF NOT EXISTS prospects_org_created_idx
  ON public.prospects (org_id, created_at DESC);

CREATE INDEX IF NOT EXISTS prospect_contacts_org_prospect_idx
  ON public.prospect_contacts (org_id, prospect_id);

CREATE UNIQUE INDEX IF NOT EXISTS prospect_contacts_one_primary_uidx
  ON public.prospect_contacts (prospect_id)
  WHERE is_primary;

CREATE INDEX IF NOT EXISTS estimates_org_prospect_idx
  ON public.estimates (org_id, prospect_id);

CREATE INDEX IF NOT EXISTS bid_packages_org_prospect_idx
  ON public.bid_packages (org_id, prospect_id);

CREATE INDEX IF NOT EXISTS files_org_prospect_idx
  ON public.files (org_id, prospect_id);

CREATE INDEX IF NOT EXISTS documents_org_prospect_idx
  ON public.documents (org_id, prospect_id);

CREATE INDEX IF NOT EXISTS envelopes_org_prospect_idx
  ON public.envelopes (org_id, prospect_id);

CREATE INDEX IF NOT EXISTS file_links_org_prospect_idx
  ON public.file_links (org_id, prospect_id);

CREATE UNIQUE INDEX IF NOT EXISTS projects_prospect_id_uidx
  ON public.projects (prospect_id)
  WHERE prospect_id IS NOT NULL;

ALTER TABLE public.prospects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.prospect_contacts ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'prospects'
      AND policyname = 'prospects_access'
  ) THEN
    CREATE POLICY prospects_access ON public.prospects
      USING (
        auth.role() = 'service_role'
        OR public.is_org_member(org_id)
      )
      WITH CHECK (
        auth.role() = 'service_role'
        OR public.is_org_member(org_id)
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'prospect_contacts'
      AND policyname = 'prospect_contacts_access'
  ) THEN
    CREATE POLICY prospect_contacts_access ON public.prospect_contacts
      USING (
        auth.role() = 'service_role'
        OR public.is_org_member(org_id)
      )
      WITH CHECK (
        auth.role() = 'service_role'
        OR public.is_org_member(org_id)
      );
  END IF;
END
$$;

COMMENT ON TABLE public.prospects IS
  'First-class preconstruction job file. Replaces contact-backed prospects and opportunity-backed pre-project work over time.';

COMMENT ON TABLE public.prospect_contacts IS
  'Pre-sale people associated to a prospect. Rows can later be promoted into directory contacts after the job is won/executed.';

COMMENT ON COLUMN public.bid_packages.prospect_id IS
  'Prospect-scoped bid context used before a project exists.';

COMMENT ON COLUMN public.projects.prospect_id IS
  'Prospect that produced this project after estimate execution and project creation.';
