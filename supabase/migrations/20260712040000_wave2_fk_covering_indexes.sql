-- Cover every Wave 2 foreign key used by delete checks, joins, and list workflows.

create index if not exists certified_payroll_reports_finalized_by_idx on public.certified_payroll_reports (finalized_by) where finalized_by is not null;
create index if not exists payroll_worker_profiles_user_idx on public.payroll_worker_profiles (user_id) where user_id is not null;

create index if not exists project_locations_project_idx on public.project_locations (project_id);
create index if not exists project_locations_parent_identity_idx on public.project_locations (parent_id, project_id, org_id) where parent_id is not null;

create index if not exists spec_uploads_project_idx on public.spec_uploads (project_id);
create index if not exists spec_uploads_created_by_idx on public.spec_uploads (created_by) where created_by is not null;
create index if not exists spec_revisions_project_idx on public.spec_revisions (project_id);
create index if not exists spec_revisions_created_by_idx on public.spec_revisions (created_by) where created_by is not null;

create index if not exists subtier_requirements_created_by_idx on public.subtier_waiver_requirements (created_by) where created_by is not null;

create index if not exists meeting_distribution_contact_identity_idx on public.meeting_distribution_recipients (contact_id, org_id) where contact_id is not null;
create index if not exists meeting_distribution_project_idx on public.meeting_distribution_recipients (project_id);
create index if not exists meeting_transcripts_project_idx on public.meeting_transcripts (project_id);

create index if not exists compliance_documents_company_identity_idx on public.compliance_documents (company_id, org_id);
create index if not exists compliance_documents_document_type_idx on public.compliance_documents (document_type_id);
create index if not exists compliance_documents_file_idx on public.compliance_documents (file_id) where file_id is not null;
create index if not exists compliance_documents_portal_token_idx on public.compliance_documents (portal_token_id) where portal_token_id is not null;
create index if not exists compliance_documents_project_idx on public.compliance_documents (project_id) where project_id is not null;
create index if not exists compliance_documents_project_identity_idx on public.compliance_documents (project_id, org_id) where project_id is not null;
create index if not exists compliance_documents_requirement_idx on public.compliance_documents (requirement_id) where requirement_id is not null;
create index if not exists compliance_documents_reviewed_by_idx on public.compliance_documents (reviewed_by) where reviewed_by is not null;

create index if not exists lien_waivers_claimant_requirement_identity_idx on public.lien_waivers (claimant_requirement_id, org_id) where claimant_requirement_id is not null;
create index if not exists lien_waivers_through_company_identity_idx on public.lien_waivers (through_company_id, org_id) where through_company_id is not null;
