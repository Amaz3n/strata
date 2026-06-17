-- Mature drawing revision packages into construction-friendly issuances.
ALTER TABLE public.drawing_revisions
  ADD COLUMN IF NOT EXISTS issuance_type text NOT NULL DEFAULT 'revision',
  ADD COLUMN IF NOT EXISTS issued_by text,
  ADD COLUMN IF NOT EXISTS received_from text;

ALTER TABLE public.drawing_revisions
  DROP CONSTRAINT IF EXISTS drawing_revisions_issuance_type_check;
ALTER TABLE public.drawing_revisions
  ADD CONSTRAINT drawing_revisions_issuance_type_check
  CHECK (
    issuance_type IN (
      'permit_set',
      'ifc_set',
      'bid_set',
      'addendum',
      'asi',
      'bulletin',
      'revision',
      'sketch',
      'record_set',
      'other'
    )
  );

COMMENT ON COLUMN public.drawing_revisions.issuance_type IS
  'Construction package type: permit set, IFC, addendum, ASI, bulletin, revision, etc.';
COMMENT ON COLUMN public.drawing_revisions.issued_by IS
  'Party who issued the drawing package, such as architect, engineer, owner, or GC.';
COMMENT ON COLUMN public.drawing_revisions.received_from IS
  'Party/source the package was received from.';

CREATE INDEX IF NOT EXISTS drawing_revisions_project_published_idx
  ON public.drawing_revisions (org_id, project_id, status, published_at DESC, created_at DESC);
