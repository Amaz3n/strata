-- Master rule 18 project-list indexes for Wave 2 meeting tables.
create index if not exists meeting_distribution_org_project_idx
  on public.meeting_distribution_recipients (org_id, project_id, sent_at desc);
create index if not exists meeting_transcripts_org_project_idx
  on public.meeting_transcripts (org_id, project_id, created_at desc);
