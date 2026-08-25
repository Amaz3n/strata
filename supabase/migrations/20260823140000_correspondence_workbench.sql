-- Correspondence workbench.
--
-- The log shipped as a flat, read-only list of filed messages. This turns it
-- into the surface a PM actually works:
--
--   1. Real threading. `thread_id` was a hash of the normalized subject, so two
--      unrelated "Site update" chains merged and a subject edit forked one.
--      RFC 5322 `In-Reply-To` / `References` are stored so the ingest can join a
--      reply to the message it answers, and fall back to the subject hash only
--      when a message carries no threading headers at all.
--   2. Triage state. `classified_by` had two values, so a message nobody had
--      looked at was indistinguishable from one a person had ruled on — which
--      made "confirm the model's guess" unrepresentable. 'system' is the third
--      state: filed, not yet judged by model or human.
--   3. Links are a table, not two columns. An email that answers an RFI *and*
--      triggers a change is one message with two links; `linked_entity_type` /
--      `linked_entity_id` could only ever hold one, and only ever held
--      'change_event'.
--   4. A thread rollup view, so the list pages, filters, counts and searches in
--      the database. The 200-row cap with no way past it was the whole reason
--      older mail was unreachable.
--
-- `project_emails.linked_entity_type` / `linked_entity_id` are backfilled into
-- the link table and stop being read here. They are left in place for one
-- release and dropped by `supabase/pending-migrations/`.

-- ── 1. Message-level columns ───────────────────────────────────────────────

alter table public.project_emails
  add column if not exists in_reply_to text,
  add column if not exists reference_ids text[] not null default '{}',
  add column if not exists body_preview text,
  add column if not exists archived_at timestamptz,
  add column if not exists archived_by uuid references public.app_users(id) on delete set null;

comment on column public.project_emails.in_reply_to is
  'RFC 5322 In-Reply-To header of the message this one answers. The primary threading key; the subject hash is the fallback for mail that carries no headers.';
comment on column public.project_emails.reference_ids is
  'RFC 5322 References chain, oldest first. Lets a reply join a thread even when the message it directly answers was never filed.';
comment on column public.project_emails.body_preview is
  'Leading plain text of the message, denormalized out of storage so the log can be searched and can show a snippet without a per-row storage read.';
comment on column public.project_emails.archived_at is
  'Set when someone unfiles a message — spam to the public address, or mail filed against the wrong project. The row is kept: the log is evidentiary and deletion would be the wrong record.';

-- 'system' is the state a message is filed in: nobody, model or person, has
-- ruled on it yet. Without it the ingest default ('user') claimed every
-- untouched message had been confirmed by a human.
alter table public.project_emails drop constraint if exists project_emails_classified_by_check;
alter table public.project_emails
  add constraint project_emails_classified_by_check
  check (classified_by in ('ai', 'user', 'system'));

-- Exactly the ingest default: general, no confidence, stamped 'user' by a row
-- no person ever saw. Anything a human or the model actually touched carries a
-- non-general classification or a confidence, and is left alone.
update public.project_emails
set classified_by = 'system'
where classified_by = 'user'
  and classification = 'general'
  and classification_confidence is null;

-- ── 2. An email links to many records ──────────────────────────────────────

create table if not exists public.project_email_links (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  project_email_id uuid not null references public.project_emails(id) on delete cascade,
  entity_type text not null check (entity_type in ('change_event', 'rfi', 'submittal', 'vendor_bill')),
  entity_id uuid not null,
  created_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, project_email_id, entity_type, entity_id)
);

comment on table public.project_email_links is
  'What a filed message is about, in the records that already exist. Many per message: an answer that also prices a change is one email against an RFI and a change event.';

create index if not exists project_email_links_email_idx
  on public.project_email_links (org_id, project_email_id);
-- Reverse lookup: "what mail is attached to this RFI".
create index if not exists project_email_links_entity_idx
  on public.project_email_links (org_id, entity_type, entity_id);
create index if not exists project_email_links_project_idx
  on public.project_email_links (org_id, project_id);

alter table public.project_email_links enable row level security;

drop policy if exists project_email_links_read on public.project_email_links;
drop policy if exists project_email_links_insert on public.project_email_links;
drop policy if exists project_email_links_update on public.project_email_links;
drop policy if exists project_email_links_delete on public.project_email_links;
create policy project_email_links_read on public.project_email_links for select to authenticated
  using (public.has_org_permission(org_id, 'correspondence.read'));
create policy project_email_links_insert on public.project_email_links for insert to authenticated
  with check (public.has_org_permission(org_id, 'correspondence.write'));
create policy project_email_links_update on public.project_email_links for update to authenticated
  using (public.has_org_permission(org_id, 'correspondence.write'))
  with check (public.has_org_permission(org_id, 'correspondence.write'));
create policy project_email_links_delete on public.project_email_links for delete to authenticated
  using (public.has_org_permission(org_id, 'correspondence.write'));

grant select, insert, update, delete on public.project_email_links to authenticated;
grant all on public.project_email_links to service_role;

drop trigger if exists project_email_links_set_updated_at on public.project_email_links;
create trigger project_email_links_set_updated_at before update on public.project_email_links
  for each row execute function public.tg_set_updated_at();

insert into public.project_email_links (org_id, project_id, project_email_id, entity_type, entity_id)
select pe.org_id, pe.project_id, pe.id, pe.linked_entity_type, pe.linked_entity_id
from public.project_emails pe
where pe.linked_entity_id is not null
  and pe.linked_entity_type in ('change_event', 'rfi', 'submittal', 'vendor_bill')
on conflict do nothing;

-- ── 3. Indexes the workbench reads through ─────────────────────────────────

-- Attachment counts are read per message on every list render.
create index if not exists file_links_entity_idx
  on public.file_links (org_id, entity_type, entity_id);

-- The log's own ordering key, and the triage queue behind the nav badge.
create index if not exists project_emails_recent_idx
  on public.project_emails (org_id, project_id, received_at desc, created_at desc)
  where archived_at is null;
create index if not exists project_emails_review_idx
  on public.project_emails (org_id, project_id)
  where archived_at is null and classified_by <> 'user';
-- Reply arrives → find the message it answers.
create index if not exists project_emails_in_reply_to_idx
  on public.project_emails (org_id, in_reply_to)
  where in_reply_to is not null;

-- ── 4. One row per conversation ────────────────────────────────────────────
--
-- The list is a list of threads, so paging, filtering, ordering and counting
-- all have to happen over threads — in the database. Doing this in application
-- code is what capped the log at 200 messages with no way to reach older mail.
--
-- Archived messages are excluded: a thread whose every message has been unfiled
-- disappears from the log, and the archived view queries the messages directly.

create or replace view public.project_email_threads
with (security_invoker = true)
as
with messages as (
  select
    pe.org_id,
    pe.project_id,
    pe.thread_id,
    pe.id,
    pe.subject,
    pe.direction,
    pe.from_address,
    pe.classification,
    pe.classified_by,
    pe.body_preview,
    pe.contact_id,
    pe.company_id,
    coalesce(pe.sent_at, pe.received_at, pe.created_at) as occurred_at,
    -- The far side of the message from the builder: who an inbound came from,
    -- who an outbound went to.
    case when pe.direction = 'inbound' then pe.from_address
         else coalesce(pe.to_addresses[1], pe.from_address) end as counterparty_address,
    (select count(*) from public.file_links fl
      where fl.org_id = pe.org_id and fl.entity_type = 'project_email' and fl.entity_id = pe.id)
      as attachment_count,
    (select count(*) from public.project_email_links pl
      where pl.org_id = pe.org_id and pl.project_email_id = pe.id)
      as link_count,
    row_number() over (
      partition by pe.org_id, pe.project_id, pe.thread_id
      order by coalesce(pe.sent_at, pe.received_at, pe.created_at) desc, pe.id desc
    ) as recency
  from public.project_emails pe
  where pe.archived_at is null
), threads as (
select
  m.org_id,
  m.project_id,
  m.thread_id,
  -- Exactly one row per thread has recency = 1, so max() is picking that row's
  -- value rather than the largest of several.
  max(m.subject) filter (where m.recency = 1) as subject,
  max(m.direction) filter (where m.recency = 1) as last_direction,
  max(m.counterparty_address) filter (where m.recency = 1) as counterparty_address,
  -- There is no max(uuid) aggregate before PostgreSQL 18, and picking the
  -- newest row's value is what is meant anyway -- array_agg does that for the
  -- uuid columns without a cast through text.
  (array_agg(m.contact_id) filter (where m.recency = 1))[1] as counterparty_contact_id,
  (array_agg(m.company_id) filter (where m.recency = 1))[1] as counterparty_company_id,
  max(m.body_preview) filter (where m.recency = 1) as last_body_preview,
  count(*)::int as message_count,
  max(m.occurred_at) as last_message_at,
  sum(m.attachment_count)::int as attachment_count,
  sum(m.link_count)::int as link_count,
  -- The triage queue: anything no person has ruled on.
  count(*) filter (where m.classified_by <> 'user')::int as unreviewed_count,
  bool_or(m.direction = 'inbound') as has_inbound,
  bool_or(m.direction = 'outbound') as has_outbound,
  array_agg(distinct m.classification) as classifications,
  -- One lowercase haystack so a single ilike covers subject, both sides of every
  -- message, and the stored body preview. Body search was impossible while the
  -- text lived only in storage.
  lower(
    coalesce(max(m.subject) filter (where m.recency = 1), '') || ' ' ||
    coalesce(string_agg(distinct m.from_address, ' '), '') || ' ' ||
    coalesce(string_agg(distinct m.counterparty_address, ' '), '') || ' ' ||
    coalesce(string_agg(distinct m.body_preview, ' '), '')
  ) as search_text
from messages m
group by m.org_id, m.project_id, m.thread_id
)
select
  t.*,
  -- The directory party the thread is with, so the list shows a name rather
  -- than a raw address. Falls back to the address when nothing matched.
  coalesce(ct.full_name, co.name, t.counterparty_address) as counterparty_name,
  t.search_text || ' ' || lower(coalesce(ct.full_name, co.name, '')) as search_haystack
from threads t
left join public.contacts ct on ct.id = t.counterparty_contact_id and ct.org_id = t.org_id
left join public.companies co on co.id = t.counterparty_company_id and co.org_id = t.org_id;

comment on view public.project_email_threads is
  'One row per correspondence thread, aggregated over its non-archived messages. security_invoker so the correspondence.read policy on project_emails still applies to whoever selects from it.';

grant select on public.project_email_threads to authenticated;
grant select on public.project_email_threads to service_role;
