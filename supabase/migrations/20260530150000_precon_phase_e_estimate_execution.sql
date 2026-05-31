-- Phase E: make estimates the signable/executed commercial offer.

ALTER TABLE public.estimates
  ADD COLUMN IF NOT EXISTS client_signed_at timestamptz,
  ADD COLUMN IF NOT EXISTS builder_signed_at timestamptz,
  ADD COLUMN IF NOT EXISTS executed_at timestamptz,
  ADD COLUMN IF NOT EXISTS signature_document_id uuid REFERENCES public.documents(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS signature_envelope_id uuid REFERENCES public.envelopes(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS executed_file_id uuid REFERENCES public.files(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS signature_data jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS estimates_org_client_signed_idx
  ON public.estimates (org_id, client_signed_at)
  WHERE client_signed_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS estimates_org_executed_idx
  ON public.estimates (org_id, executed_at)
  WHERE executed_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS estimates_signature_document_id_idx
  ON public.estimates (signature_document_id)
  WHERE signature_document_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS estimates_executed_file_id_idx
  ON public.estimates (executed_file_id)
  WHERE executed_file_id IS NOT NULL;

COMMENT ON COLUMN public.estimates.client_signed_at IS
  'Timestamp when the client approved and signed the estimate through the estimate portal.';

COMMENT ON COLUMN public.estimates.builder_signed_at IS
  'Timestamp when the builder countersigned the client-signed estimate.';

COMMENT ON COLUMN public.estimates.executed_at IS
  'Timestamp when both client and builder signatures are complete and the estimate is executed.';

COMMENT ON COLUMN public.estimates.signature_data IS
  'Signature metadata for estimate execution, including client and builder signer identity, consent, IP, and source.';

COMMENT ON COLUMN public.estimates.signature_document_id IS
  'Optional document record for the executed estimate artifact.';

COMMENT ON COLUMN public.estimates.executed_file_id IS
  'Optional generated PDF file for the executed estimate.';
