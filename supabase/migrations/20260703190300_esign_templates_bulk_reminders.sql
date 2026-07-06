alter table public.documents
  drop constraint if exists documents_document_type_check;

alter table public.documents
  add constraint documents_document_type_check check (
    document_type in ('estimate', 'proposal', 'contract', 'change_order', 'other')
  );

alter table public.envelopes
  drop constraint if exists envelopes_source_entity_type_check;

alter table public.envelopes
  add constraint envelopes_source_entity_type_check check (
    source_entity_type is null
    or source_entity_type in ('estimate', 'proposal', 'change_order', 'lien_waiver', 'selection', 'subcontract', 'closeout', 'other')
  );

create table if not exists public.esign_templates (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  name text not null,
  description text,
  document_type text not null default 'other' check (
    document_type in ('estimate', 'proposal', 'contract', 'change_order', 'other')
  ),
  source_file_id uuid not null references public.files(id) on delete restrict,
  source_document_id uuid references public.documents(id) on delete set null,
  fields jsonb not null default '[]'::jsonb,
  recipients jsonb not null default '[]'::jsonb,
  reminder_settings jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint esign_templates_name_present check (length(btrim(name)) > 0),
  constraint esign_templates_fields_array check (jsonb_typeof(fields) = 'array'),
  constraint esign_templates_recipients_array check (jsonb_typeof(recipients) = 'array')
);

create index if not exists esign_templates_org_project_created_idx
  on public.esign_templates (org_id, project_id, created_at desc);

create index if not exists esign_templates_org_type_created_idx
  on public.esign_templates (org_id, document_type, created_at desc);

create unique index if not exists esign_templates_org_project_name_idx
  on public.esign_templates (org_id, coalesce(project_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));

drop trigger if exists esign_templates_set_updated_at on public.esign_templates;
create trigger esign_templates_set_updated_at
  before update on public.esign_templates
  for each row
  execute function public.tg_set_updated_at();

alter table public.esign_templates enable row level security;

drop policy if exists esign_templates_access on public.esign_templates;
create policy esign_templates_access
  on public.esign_templates
  for all
  using (
    auth.role() = 'service_role'
    or (
      public.is_org_member(org_id)
      and (
        project_id is null
        or public.is_project_member(project_id)
        or public.is_org_admin_member(org_id)
      )
    )
  )
  with check (
    auth.role() = 'service_role'
    or (
      public.is_org_member(org_id)
      and (
        project_id is null
        or public.is_project_member(project_id)
        or public.is_org_admin_member(org_id)
      )
    )
  );

grant all on table public.esign_templates to authenticated, service_role;

create table if not exists public.esign_reminder_deliveries (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  envelope_id uuid not null references public.envelopes(id) on delete cascade,
  signing_request_id uuid references public.document_signing_requests(id) on delete cascade,
  recipient_email citext,
  delivery_type text not null default 'automatic' check (delivery_type in ('automatic', 'manual')),
  status text not null default 'sent' check (status in ('sent', 'failed')),
  error_message text,
  sent_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists esign_reminder_deliveries_request_sent_idx
  on public.esign_reminder_deliveries (org_id, signing_request_id, sent_at desc)
  where signing_request_id is not null;

create index if not exists esign_reminder_deliveries_envelope_sent_idx
  on public.esign_reminder_deliveries (org_id, envelope_id, sent_at desc);

alter table public.esign_reminder_deliveries enable row level security;

drop policy if exists esign_reminder_deliveries_access on public.esign_reminder_deliveries;
create policy esign_reminder_deliveries_access
  on public.esign_reminder_deliveries
  for all
  using (auth.role() = 'service_role' or public.is_org_member(org_id))
  with check (auth.role() = 'service_role' or public.is_org_member(org_id));

grant all on table public.esign_reminder_deliveries to authenticated, service_role;
