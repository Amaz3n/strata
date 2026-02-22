-- Remove legacy company-level compliance fields.
-- Compliance is now sourced from:
-- - orgs.compliance_rules
-- - orgs.default_compliance_requirements
-- - company_compliance_requirements
-- - compliance_documents
-- - compliance_document_types

alter table if exists public.companies
  drop column if exists license_expiry,
  drop column if exists license_verified,
  drop column if exists insurance_expiry,
  drop column if exists insurance_provider,
  drop column if exists insurance_document_id,
  drop column if exists w9_on_file,
  drop column if exists w9_file_id;
