-- One live document per requirement, enforced where it can actually hold.
--
-- `supersedePriorDocuments` runs as a separate statement after the insert, and
-- the cross-org share path in `compliance-portability.ts` does its own variant.
-- Two uploads that land together can therefore both finish un-superseded, and
-- `buildComplianceStatus` counts both as live — so a vendor can satisfy a
-- requirement twice, and revoking the one the reviewer is looking at leaves the
-- other silently holding the requirement open.
--
-- The index below is the invariant the supersede logic has always been trying
-- to maintain. Zero rows violate it today. It also makes the supersede write
-- self-checking: a concurrent second approval now raises 23505 instead of
-- quietly winning.
--
-- Scope is (company, type) rather than anything project-shaped on purpose:
-- documents are held at the company, and the project layer raises the terms a
-- document must MEET (project_compliance_requirements), never how many exist.

create unique index if not exists compliance_documents_live_per_requirement_uidx
  on public.compliance_documents (org_id, company_id, document_type_id)
  where status = 'approved'
    and revoked_at is null
    and superseded_by_id is null;

comment on index public.compliance_documents_live_per_requirement_uidx is
  'At most one approved, un-revoked, un-superseded document per company per document type — the invariant supersedePriorDocuments maintains in application code and could not guarantee under concurrency.';
