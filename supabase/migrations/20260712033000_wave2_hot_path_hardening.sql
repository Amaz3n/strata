-- Wave 2 post-implementation hardening: deterministic org-self subject and FK-hot indexes.

create unique index if not exists companies_org_self_subject_uidx
  on public.companies (org_id)
  where metadata ->> 'system_role' = 'org_self';

create index if not exists meeting_distribution_meeting_identity_idx
  on public.meeting_distribution_recipients (meeting_id, org_id, project_id);
create index if not exists meeting_distribution_contact_idx
  on public.meeting_distribution_recipients (contact_id) where contact_id is not null;
create index if not exists meeting_distribution_user_idx
  on public.meeting_distribution_recipients (user_id) where user_id is not null;
create index if not exists meeting_transcripts_meeting_identity_idx
  on public.meeting_transcripts (meeting_id, org_id, project_id);
create index if not exists meeting_transcripts_audio_identity_idx
  on public.meeting_transcripts (audio_file_id, org_id, project_id) where audio_file_id is not null;
create index if not exists meeting_transcripts_created_by_idx
  on public.meeting_transcripts (created_by) where created_by is not null;

create index if not exists wage_classifications_determination_identity_idx
  on public.wage_classifications (determination_id, org_id);
create index if not exists payroll_worker_profiles_default_classification_identity_idx
  on public.payroll_worker_profiles (default_classification_id, org_id) where default_classification_id is not null;
create index if not exists certified_payroll_lines_report_identity_idx
  on public.certified_payroll_lines (report_id, org_id);
create index if not exists certified_payroll_lines_worker_identity_idx
  on public.certified_payroll_lines (worker_profile_id, org_id);
create index if not exists certified_payroll_lines_classification_identity_idx
  on public.certified_payroll_lines (classification_id, org_id) where classification_id is not null;

create index if not exists subtier_requirements_project_identity_idx
  on public.subtier_waiver_requirements (project_id, org_id);
create index if not exists subtier_requirements_commitment_identity_idx
  on public.subtier_waiver_requirements (commitment_id, org_id);
create index if not exists subtier_requirements_company_identity_idx
  on public.subtier_waiver_requirements (through_company_id, org_id);
