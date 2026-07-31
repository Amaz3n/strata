-- Procore parity P1: photo intelligence, quick-capture drafts, first-class
-- submittal revisions/register drafts, and project correspondence ingest.

create table public.photo_albums (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  name text not null,
  description text,
  created_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, name)
);

alter table public.photos
  add column if not exists album_id uuid references public.photo_albums(id) on delete set null,
  add column if not exists location_id uuid references public.project_locations(id) on delete set null,
  add column if not exists trade_company_id uuid references public.companies(id) on delete set null,
  add column if not exists latitude numeric(10,7),
  add column if not exists longitude numeric(10,7),
  add column if not exists ai_caption text,
  add column if not exists ai_tags text[] not null default '{}',
  add column if not exists visibility text not null default 'internal' check (visibility in ('internal','client')),
  add column if not exists ai_processed_at timestamptz,
  add column if not exists updated_at timestamptz not null default now(),
  add constraint photos_latitude_check check (latitude is null or latitude between -90 and 90),
  add constraint photos_longitude_check check (longitude is null or longitude between -180 and 180);

create index photo_albums_org_project_idx on public.photo_albums (org_id, project_id, name);
create index photos_project_taken_idx on public.photos (org_id, project_id, taken_at desc, id);
create index photos_album_idx on public.photos (org_id, album_id, taken_at desc) where album_id is not null;
create index photos_location_idx on public.photos (org_id, location_id, taken_at desc) where location_id is not null;
create index photos_client_feed_idx on public.photos (org_id, project_id, taken_at desc) where visibility = 'client';
create index photos_ai_tags_idx on public.photos using gin (ai_tags);

alter table public.photo_albums enable row level security;
create policy photo_albums_read on public.photo_albums for select to authenticated
  using (public.has_org_permission(org_id, 'docs.read'));
create policy photo_albums_write on public.photo_albums for all to authenticated
  using (public.has_org_permission(org_id, 'docs.upload'))
  with check (public.has_org_permission(org_id, 'docs.upload'));
grant select, insert, update, delete on public.photo_albums to authenticated;
grant all on public.photo_albums to service_role;
create trigger photo_albums_set_updated_at before update on public.photo_albums
  for each row execute function public.tg_set_updated_at();
create trigger photos_set_updated_at before update on public.photos
  for each row execute function public.tg_set_updated_at();

create or replace function public.photo_timeline_for_portal(p_project_id uuid, p_org_id uuid)
returns table(week_start timestamptz, week_end timestamptz, photos jsonb, summaries text[])
language sql stable security invoker set search_path = public, pg_catalog as $$
  select date_trunc('week', coalesce(p.taken_at, p.created_at)),
    date_trunc('week', coalesce(p.taken_at, p.created_at)) + interval '6 days',
    jsonb_agg(jsonb_build_object(
      'id', p.id, 'url', f.storage_path, 'taken_at', coalesce(p.taken_at, p.created_at),
      'tags', coalesce(p.ai_tags, p.tags, '{}'), 'caption', p.ai_caption,
      'latitude', p.latitude, 'longitude', p.longitude
    ) order by coalesce(p.taken_at, p.created_at)),
    array_agg(dl.summary) filter (where dl.summary is not null)
  from public.photos p
  join public.files f on f.id = p.file_id and f.org_id = p.org_id
  left join public.daily_logs dl on dl.id = p.daily_log_id and dl.org_id = p.org_id
  where p.project_id = p_project_id and p.org_id = p_org_id and p.visibility = 'client'
  group by date_trunc('week', coalesce(p.taken_at, p.created_at))
  order by 1 desc;
$$;

create table public.quick_capture_drafts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  lot_id uuid references public.lots(id) on delete set null,
  capture_kind text not null check (capture_kind in ('audio','photo','video','text')),
  target_type text check (target_type in ('punch_item','observation','daily_log_note','task','rfi_draft')),
  status text not null default 'queued' check (status in ('queued','processing','ready','committed','rejected','failed')),
  source_file_id uuid references public.files(id) on delete set null,
  attachment_file_ids uuid[] not null default '{}',
  transcript text,
  extracted_payload jsonb not null default '{}'::jsonb check (jsonb_typeof(extracted_payload) = 'object'),
  confidence numeric(5,4) check (confidence is null or confidence between 0 and 1),
  failure_reason text,
  created_by uuid not null references public.app_users(id) on delete cascade,
  committed_entity_type text,
  committed_entity_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index quick_capture_drafts_review_idx on public.quick_capture_drafts (org_id, created_by, status, created_at desc);
create index quick_capture_drafts_project_idx on public.quick_capture_drafts (org_id, project_id, created_at desc);
alter table public.quick_capture_drafts enable row level security;
create policy quick_capture_drafts_read on public.quick_capture_drafts for select to authenticated
  using (public.has_org_permission(org_id, 'project.read'));
create policy quick_capture_drafts_write on public.quick_capture_drafts for all to authenticated
  using (public.has_org_permission(org_id, 'quick_capture.create'))
  with check (public.has_org_permission(org_id, 'quick_capture.create'));
grant select, insert, update, delete on public.quick_capture_drafts to authenticated;
grant all on public.quick_capture_drafts to service_role;
create trigger quick_capture_drafts_set_updated_at before update on public.quick_capture_drafts
  for each row execute function public.tg_set_updated_at();

create table public.submittal_revisions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  submittal_id uuid not null references public.submittals(id) on delete cascade,
  revision_number integer not null check (revision_number >= 0),
  status text not null default 'draft' check (status in ('draft','pending','approved','approved_as_noted','revise_resubmit','rejected','superseded')),
  attachment_file_id uuid references public.files(id) on delete set null,
  stamped_file_id uuid references public.files(id) on delete set null,
  submitted_at timestamptz,
  submitted_by_user_id uuid references public.app_users(id) on delete set null,
  submitted_by_contact_id uuid references public.contacts(id) on delete set null,
  decision text check (decision in ('approved','approved_as_noted','revise_resubmit','rejected')),
  decision_notes text,
  decided_at timestamptz,
  superseded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (submittal_id, revision_number)
);

alter table public.submittals add column if not exists current_revision_id uuid references public.submittal_revisions(id) on delete set null;
alter table public.submittals
  add column if not exists needs_spec_rereview boolean not null default false,
  add column if not exists spec_rereview_reason text;
alter table public.submittal_review_steps add column if not exists submittal_revision_id uuid references public.submittal_revisions(id) on delete cascade;
alter table public.portal_access_tokens add column if not exists scoped_submittal_revision_id uuid references public.submittal_revisions(id) on delete cascade;

insert into public.submittal_revisions (
  org_id, project_id, submittal_id, revision_number, status, attachment_file_id,
  stamped_file_id, submitted_at, decision, decision_notes, decided_at, created_at, updated_at
)
select s.org_id, s.project_id, s.id, coalesce(s.revision, 0),
  case when s.status in ('draft','pending','approved','approved_as_noted','revise_resubmit','rejected') then s.status else 'draft' end,
  s.attachment_file_id, s.stamped_file_id, s.submitted_at, s.decision_status, s.decision_note,
  s.decision_at, s.created_at, s.updated_at
from public.submittals s
on conflict (submittal_id, revision_number) do nothing;

update public.submittals s set current_revision_id = r.id
from public.submittal_revisions r
where r.submittal_id = s.id and r.revision_number = coalesce(s.revision, 0) and s.current_revision_id is null;

create table public.submittal_register_drafts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  spec_section_id uuid references public.spec_sections(id) on delete cascade,
  spec_revision_id uuid references public.spec_revisions(id) on delete set null,
  section_reference text not null,
  requirement_type text not null check (requirement_type in ('product_data','shop_drawing','sample','mock_up','certificate','other')),
  title text not null,
  clause_text text not null,
  clause_page integer,
  suggested_company_id uuid references public.companies(id) on delete set null,
  suggested_lead_time_days integer check (suggested_lead_time_days is null or suggested_lead_time_days >= 0),
  confidence numeric(5,4) not null check (confidence between 0 and 1),
  status text not null default 'draft' check (status in ('draft','accepted','dismissed','needs_review')),
  accepted_submittal_id uuid references public.submittals(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index submittal_revisions_submittal_idx on public.submittal_revisions (org_id, submittal_id, revision_number desc);
create index submittal_revisions_project_idx on public.submittal_revisions (org_id, project_id, status);
create index submittal_register_drafts_review_idx on public.submittal_register_drafts (org_id, project_id, status, confidence desc);
create unique index submittal_register_drafts_source_idx on public.submittal_register_drafts
  (spec_revision_id, title, clause_page) nulls not distinct;
create index portal_access_tokens_submittal_revision_idx on public.portal_access_tokens (scoped_submittal_revision_id) where scoped_submittal_revision_id is not null;
alter table public.submittal_revisions enable row level security;
alter table public.submittal_register_drafts enable row level security;
create policy submittal_revisions_access on public.submittal_revisions for all to authenticated
  using (public.has_org_permission(org_id, 'submittal.read'))
  with check (public.has_org_permission(org_id, 'submittal.write'));
create policy submittal_register_drafts_access on public.submittal_register_drafts for all to authenticated
  using (public.has_org_permission(org_id, 'submittal.read'))
  with check (public.has_org_permission(org_id, 'submittal.write'));
grant select, insert, update, delete on public.submittal_revisions, public.submittal_register_drafts to authenticated;
grant all on public.submittal_revisions, public.submittal_register_drafts to service_role;
create trigger submittal_revisions_set_updated_at before update on public.submittal_revisions
  for each row execute function public.tg_set_updated_at();
create trigger submittal_register_drafts_set_updated_at before update on public.submittal_register_drafts
  for each row execute function public.tg_set_updated_at();

create table public.project_emails (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  direction text not null check (direction in ('inbound','outbound')),
  message_id text,
  provider_email_id text,
  thread_id text not null,
  from_address text not null,
  to_addresses text[] not null default '{}',
  cc_addresses text[] not null default '{}',
  subject text not null,
  body_file_id uuid references public.files(id) on delete set null,
  classification text not null default 'general'
    check (classification in ('correspondence','rfi_related','co_trigger','bill','submittal_related','general')),
  classified_by text not null default 'user' check (classified_by in ('ai','user')),
  classification_confidence numeric(5,4) check (classification_confidence is null or classification_confidence between 0 and 1),
  linked_entity_type text,
  linked_entity_id uuid,
  received_at timestamptz,
  sent_at timestamptz,
  created_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, message_id)
);

alter table public.projects add column if not exists correspondence_slug text;
create unique index projects_correspondence_slug_idx on public.projects (correspondence_slug) where correspondence_slug is not null;
create index project_emails_project_thread_idx on public.project_emails (org_id, project_id, thread_id, created_at);
create index project_emails_classification_idx on public.project_emails (org_id, project_id, classification, created_at desc);
alter table public.project_emails enable row level security;
create policy project_emails_read on public.project_emails for select to authenticated
  using (public.has_org_permission(org_id, 'correspondence.read'));
create policy project_emails_write on public.project_emails for all to authenticated
  using (public.has_org_permission(org_id, 'correspondence.write'))
  with check (public.has_org_permission(org_id, 'correspondence.write'));
grant select, insert, update, delete on public.project_emails to authenticated;
grant all on public.project_emails to service_role;
create trigger project_emails_set_updated_at before update on public.project_emails
  for each row execute function public.tg_set_updated_at();

insert into public.permissions (key, description) values
  ('quick_capture.create', 'Create and review field quick-capture drafts'),
  ('correspondence.read', 'Read project correspondence'),
  ('correspondence.write', 'Classify, link, and send project correspondence')
on conflict (key) do update set description = excluded.description;

insert into public.role_permissions (role_id, permission_key)
select distinct rp.role_id, 'quick_capture.create' from public.role_permissions rp
where rp.permission_key in ('daily_log.write','task.write','punch.write')
on conflict (role_id, permission_key) do nothing;

insert into public.role_permissions (role_id, permission_key)
select distinct rp.role_id,
  case rp.permission_key when 'docs.read' then 'correspondence.read' when 'docs.upload' then 'correspondence.write' end
from public.role_permissions rp where rp.permission_key in ('docs.read','docs.upload')
on conflict (role_id, permission_key) do nothing;
