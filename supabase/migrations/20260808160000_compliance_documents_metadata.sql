-- Compliance documents gain a metadata jsonb, mirroring vendor_bills.metadata.
--
-- This is where the certificate-of-insurance reading lives:
--   metadata.coi_extraction         the model's claim about the policy
--   metadata.coi_extraction_attempt the input key + status that stops an
--                                   unchanged file being read twice
--
-- The claim is advisory. `evaluateInsuranceCurrency` keeps the human-entered
-- expiry_date authoritative for blocking a payment and surfaces the reading as
-- evidence beside it, so an absent or malformed value here degrades the
-- insurance hold to exactly its pre-extraction behaviour. Nothing in the
-- application requires the key to be present, which is why this column is
-- backfill-free and defaults to an empty object.

alter table public.compliance_documents
  add column if not exists metadata jsonb not null default '{}'::jsonb;

-- The reading is looked up by the compliance document row the payment hold
-- already loaded, so no index is warranted on the jsonb itself. The lookup
-- from a file back to its documents is the one the extraction job makes.
create index if not exists compliance_documents_org_file_idx
  on public.compliance_documents (org_id, file_id)
  where file_id is not null;
