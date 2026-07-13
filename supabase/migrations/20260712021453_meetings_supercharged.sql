-- Wave 2 WS-G: linked/aging meeting items, tracked minutes distribution,
-- durable transcripts, and human-reviewed AI draft proposals.

alter table public.meeting_items
  add column linked_entity_type text,
  add column linked_entity_id uuid;

alter table public.meeting_items
  add constraint meeting_items_linked_entity_shape_check check (
    (linked_entity_type is null and linked_entity_id is null)
    or (linked_entity_type in ('rfi', 'submittal', 'change_order', 'task') and linked_entity_id is not null)
  );

alter table public.meetings
  add column minutes_distributed_at timestamptz,
  add column minutes_distributed_by uuid references public.app_users(id);

create table public.meeting_distribution_recipients (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  project_id uuid not null references public.projects(id),
  meeting_id uuid not null references public.meetings(id) on delete cascade,
  contact_id uuid references public.contacts(id),
  user_id uuid references public.app_users(id),
  email text not null check (length(btrim(email)) > 3),
  display_name text not null,
  company_name text,
  share_link_id uuid references public.file_share_links(id),
  first_viewed_at timestamptz,
  first_downloaded_at timestamptz,
  sent_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (meeting_id, email)
);

create table public.meeting_transcripts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  project_id uuid not null references public.projects(id),
  meeting_id uuid not null references public.meetings(id) on delete cascade,
  source text not null check (source in ('recorded', 'audio_upload', 'pasted')),
  status text not null default 'pending' check (status in ('pending', 'transcribing', 'ready', 'failed')),
  transcript_text text,
  audio_file_id uuid references public.files(id) on delete set null,
  error text,
  draft_proposals jsonb,
  transcribed_at timestamptz,
  audio_deleted_at timestamptz,
  created_by uuid references public.app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint meeting_transcripts_source_shape_check check (
    (source = 'pasted' and transcript_text is not null and audio_file_id is null)
    or (source in ('recorded', 'audio_upload') and (audio_file_id is not null or audio_deleted_at is not null))
  )
);

create unique index if not exists meetings_id_org_project_uidx on public.meetings (id, org_id, project_id);
create unique index if not exists files_id_org_project_uidx on public.files (id, org_id, project_id);
create unique index if not exists contacts_id_org_uidx on public.contacts (id, org_id);

alter table public.meeting_distribution_recipients
  add constraint meeting_distribution_meeting_org_project_fkey foreign key (meeting_id, org_id, project_id) references public.meetings(id, org_id, project_id),
  add constraint meeting_distribution_contact_org_fkey foreign key (contact_id, org_id) references public.contacts(id, org_id);
alter table public.meeting_transcripts
  add constraint meeting_transcripts_meeting_org_project_fkey foreign key (meeting_id, org_id, project_id) references public.meetings(id, org_id, project_id),
  add constraint meeting_transcripts_audio_org_project_fkey foreign key (audio_file_id, org_id, project_id) references public.files(id, org_id, project_id);

create index meeting_items_linked_entity_idx on public.meeting_items (org_id, linked_entity_type, linked_entity_id)
  where linked_entity_id is not null;
create index meeting_distribution_recipients_meeting_idx on public.meeting_distribution_recipients (org_id, meeting_id, sent_at);
create index meeting_distribution_recipients_share_link_idx on public.meeting_distribution_recipients (share_link_id)
  where share_link_id is not null;
create index meeting_transcripts_meeting_idx on public.meeting_transcripts (org_id, meeting_id, created_at desc);
create index meeting_transcripts_audio_cleanup_idx on public.meeting_transcripts (transcribed_at, audio_file_id)
  where status = 'ready' and audio_file_id is not null and audio_deleted_at is null;

create trigger meeting_transcripts_set_updated_at before update on public.meeting_transcripts
  for each row execute function public.tg_set_updated_at();

alter table public.meeting_distribution_recipients enable row level security;
alter table public.meeting_transcripts enable row level security;

create policy meeting_distribution_recipients_read on public.meeting_distribution_recipients for select to authenticated
  using (exists (select 1 from public.memberships membership where membership.org_id = meeting_distribution_recipients.org_id and membership.user_id = (select auth.uid()) and membership.status = 'active'));
create policy meeting_distribution_recipients_insert on public.meeting_distribution_recipients for insert to authenticated
  with check (public.has_org_permission(org_id, 'meeting.write'));
create policy meeting_distribution_recipients_update on public.meeting_distribution_recipients for update to authenticated
  using (public.has_org_permission(org_id, 'meeting.write')) with check (public.has_org_permission(org_id, 'meeting.write'));
create policy meeting_distribution_recipients_delete on public.meeting_distribution_recipients for delete to authenticated
  using (public.has_org_permission(org_id, 'meeting.write'));
create policy meeting_transcripts_read on public.meeting_transcripts for select to authenticated
  using (exists (select 1 from public.memberships membership where membership.org_id = meeting_transcripts.org_id and membership.user_id = (select auth.uid()) and membership.status = 'active'));
create policy meeting_transcripts_insert on public.meeting_transcripts for insert to authenticated
  with check (public.has_org_permission(org_id, 'meeting.write'));
create policy meeting_transcripts_update on public.meeting_transcripts for update to authenticated
  using (public.has_org_permission(org_id, 'meeting.write')) with check (public.has_org_permission(org_id, 'meeting.write'));
create policy meeting_transcripts_delete on public.meeting_transcripts for delete to authenticated
  using (public.has_org_permission(org_id, 'meeting.write'));

grant select, insert, update, delete on public.meeting_distribution_recipients, public.meeting_transcripts to authenticated;
grant all on public.meeting_distribution_recipients, public.meeting_transcripts to service_role;
