-- Phase 1: first-class envelopes model

create table if not exists envelopes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  document_id uuid not null references documents(id) on delete cascade,
  document_revision integer not null default 1 check (document_revision >= 1),
  source_entity_type text check (
    source_entity_type is null
    or source_entity_type in ('proposal', 'change_order', 'lien_waiver', 'selection', 'subcontract', 'closeout', 'other')
  ),
  source_entity_id uuid,
  status text not null default 'draft' check (status in ('draft', 'sent', 'partially_signed', 'executed', 'voided', 'expired')),
  subject text,
  message text,
  expires_at timestamptz,
  sent_at timestamptz,
  executed_at timestamptz,
  voided_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists envelopes_org_project_created_idx
  on envelopes (org_id, project_id, created_at desc);
create index if not exists envelopes_org_status_created_idx
  on envelopes (org_id, status, created_at desc);
create index if not exists envelopes_org_document_created_idx
  on envelopes (org_id, document_id, created_at desc);
create index if not exists envelopes_org_source_entity_created_idx
  on envelopes (org_id, source_entity_type, source_entity_id, created_at desc)
  where source_entity_type is not null and source_entity_id is not null;
create index if not exists envelopes_draft_document_idx
  on envelopes (org_id, document_id, created_at desc)
  where status = 'draft';

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'envelopes_set_updated_at') then
    create trigger envelopes_set_updated_at
      before update on envelopes
      for each row
      execute function public.tg_set_updated_at();
  end if;
end$$;

create table if not exists envelope_recipients (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  envelope_id uuid not null references envelopes(id) on delete cascade,
  recipient_type text not null default 'external_email' check (recipient_type in ('external_email', 'contact', 'internal_user')),
  contact_id uuid references contacts(id) on delete set null,
  user_id uuid references app_users(id) on delete set null,
  name text,
  email citext,
  role text not null default 'signer' check (role in ('signer', 'cc')),
  signer_role text,
  sequence integer not null default 1 check (sequence >= 1),
  required boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check ((recipient_type <> 'contact') or contact_id is not null),
  check ((recipient_type <> 'internal_user') or user_id is not null)
);

create index if not exists envelope_recipients_org_envelope_sequence_idx
  on envelope_recipients (org_id, envelope_id, sequence, created_at);
create index if not exists envelope_recipients_org_envelope_role_idx
  on envelope_recipients (org_id, envelope_id, role, sequence);
create index if not exists envelope_recipients_contact_idx
  on envelope_recipients (org_id, contact_id)
  where contact_id is not null;
create index if not exists envelope_recipients_user_idx
  on envelope_recipients (org_id, user_id)
  where user_id is not null;
create index if not exists envelope_recipients_email_idx
  on envelope_recipients (org_id, email)
  where email is not null;

create table if not exists envelope_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  envelope_id uuid not null references envelopes(id) on delete cascade,
  envelope_recipient_id uuid references envelope_recipients(id) on delete set null,
  event_type text not null,
  status_from text,
  status_to text,
  payload jsonb not null default '{}'::jsonb,
  created_by uuid references app_users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists envelope_events_org_envelope_created_idx
  on envelope_events (org_id, envelope_id, created_at desc);
create index if not exists envelope_events_org_event_created_idx
  on envelope_events (org_id, event_type, created_at desc);

alter table document_signing_requests
  add column if not exists envelope_id uuid references envelopes(id) on delete cascade,
  add column if not exists envelope_recipient_id uuid references envelope_recipients(id) on delete set null;

create index if not exists document_signing_requests_envelope_idx
  on document_signing_requests (org_id, envelope_id, sequence, created_at desc)
  where envelope_id is not null;
create index if not exists document_signing_requests_envelope_recipient_idx
  on document_signing_requests (envelope_recipient_id)
  where envelope_recipient_id is not null;

with grouped as (
  select
    coalesce(r.group_id, r.id) as envelope_id,
    r.org_id,
    d.project_id,
    r.document_id,
    max(r.revision) as document_revision,
    d.source_entity_type,
    d.source_entity_id,
    case
      when d.status = 'draft' then 'draft'
      when d.status = 'voided' then 'voided'
      when d.status = 'expired' then 'expired'
      when d.status = 'signed' then 'executed'
      when count(*) filter (where r.required is distinct from false and r.status = 'signed') > 0
        and count(*) filter (
          where r.required is distinct from false
            and r.status not in ('signed', 'voided', 'expired')
        ) > 0
        then 'partially_signed'
      else 'sent'
    end as envelope_status,
    max(r.expires_at) as expires_at,
    max(r.sent_at) as sent_at,
    case
      when bool_and(r.required = false or r.status = 'signed') then max(r.signed_at)
      else null
    end as executed_at,
    case
      when bool_or(r.status = 'voided') then max(r.created_at) filter (where r.status = 'voided')
      else null
    end as voided_at,
    (array_agg(r.created_by order by r.created_at asc) filter (where r.created_by is not null))[1] as created_by,
    min(r.created_at) as created_at
  from document_signing_requests r
  join documents d
    on d.id = r.document_id
   and d.org_id = r.org_id
  group by
    coalesce(r.group_id, r.id),
    r.org_id,
    d.project_id,
    r.document_id,
    d.source_entity_type,
    d.source_entity_id,
    d.status
)
insert into envelopes (
  id,
  org_id,
  project_id,
  document_id,
  document_revision,
  source_entity_type,
  source_entity_id,
  status,
  expires_at,
  sent_at,
  executed_at,
  voided_at,
  metadata,
  created_by,
  created_at,
  updated_at
)
select
  grouped.envelope_id,
  grouped.org_id,
  grouped.project_id,
  grouped.document_id,
  grouped.document_revision,
  grouped.source_entity_type,
  grouped.source_entity_id,
  grouped.envelope_status,
  grouped.expires_at,
  grouped.sent_at,
  grouped.executed_at,
  grouped.voided_at,
  jsonb_build_object(
    'migrated_from_group_id', grouped.envelope_id,
    'migration', 'phase1_envelopes'
  ),
  grouped.created_by,
  grouped.created_at,
  grouped.created_at
from grouped
on conflict (id) do nothing;

insert into envelope_recipients (
  id,
  org_id,
  envelope_id,
  recipient_type,
  contact_id,
  user_id,
  name,
  email,
  role,
  signer_role,
  sequence,
  required,
  metadata,
  created_at
)
select
  r.id,
  r.org_id,
  coalesce(r.group_id, r.id) as envelope_id,
  case
    when r.recipient_contact_id is not null then 'contact'
    else 'external_email'
  end as recipient_type,
  r.recipient_contact_id as contact_id,
  null::uuid as user_id,
  null::text as name,
  r.sent_to_email as email,
  'signer'::text as role,
  r.signer_role,
  coalesce(r.sequence, 1) as sequence,
  coalesce(r.required, true) as required,
  jsonb_build_object(
    'migrated_from_signing_request_id', r.id,
    'migration', 'phase1_envelopes'
  ) as metadata,
  r.created_at
from document_signing_requests r
on conflict (id) do nothing;

update document_signing_requests r
set envelope_id = coalesce(r.group_id, r.id),
    envelope_recipient_id = r.id
where r.envelope_id is null
   or r.envelope_recipient_id is null;

alter table envelopes enable row level security;
alter table envelope_recipients enable row level security;
alter table envelope_events enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'envelopes' and policyname = 'envelopes_access'
  ) then
    create policy envelopes_access on envelopes
      for all
      using (auth.role() = 'service_role' or is_org_member(org_id))
      with check (auth.role() = 'service_role' or is_org_member(org_id));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'envelope_recipients' and policyname = 'envelope_recipients_access'
  ) then
    create policy envelope_recipients_access on envelope_recipients
      for all
      using (auth.role() = 'service_role' or is_org_member(org_id))
      with check (auth.role() = 'service_role' or is_org_member(org_id));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'envelope_events' and policyname = 'envelope_events_access'
  ) then
    create policy envelope_events_access on envelope_events
      for all
      using (auth.role() = 'service_role' or is_org_member(org_id))
      with check (auth.role() = 'service_role' or is_org_member(org_id));
  end if;
end$$;
