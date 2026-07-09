-- Operational features upgrade: submittal revisions, client-facing decisions,
-- warranty dispatch, and overdue reminder markers.

-- Submittals: revision cycle. A resubmission is a new row with the same
-- submittal_number and revision + 1; the old row points forward via
-- superseded_by_id so "current" rows are simply superseded_by_id IS NULL.
alter table public.submittals add column if not exists revision integer not null default 0;
alter table public.submittals add column if not exists supersedes_submittal_id uuid references public.submittals(id);
alter table public.submittals add column if not exists superseded_by_id uuid references public.submittals(id);
alter table public.submittals add column if not exists overdue_notified_at timestamptz;

alter table public.submittals drop constraint if exists submittals_project_id_submittal_number_key;
alter table public.submittals drop constraint if exists submittals_project_id_number_revision_key;
alter table public.submittals add constraint submittals_project_id_number_revision_key
  unique (project_id, submittal_number, revision);

-- Decisions: client-facing approval with selectable options.
alter table public.decisions add column if not exists options jsonb not null default '[]'::jsonb;
alter table public.decisions add column if not exists selected_option_id text;
alter table public.decisions add column if not exists decision_note text;
alter table public.decisions add column if not exists notify_contact_id uuid references public.contacts(id);
alter table public.decisions add column if not exists requested_at timestamptz;
alter table public.decisions add column if not exists decided_by_contact_id uuid references public.contacts(id);
alter table public.decisions add column if not exists decided_via_portal boolean not null default false;
alter table public.decisions add column if not exists decision_portal_token_id uuid references public.portal_access_tokens(id);
alter table public.decisions add column if not exists overdue_notified_at timestamptz;

-- Warranty: dispatch to the responsible sub and close the loop.
alter table public.warranty_requests add column if not exists assigned_company_id uuid references public.companies(id);
alter table public.warranty_requests add column if not exists scheduled_date date;
alter table public.warranty_requests add column if not exists resolution_note text;
alter table public.warranty_requests add column if not exists dispatched_at timestamptz;
alter table public.warranty_requests add column if not exists updated_at timestamptz not null default now();

-- RFIs: one-shot overdue reminder marker.
alter table public.rfis add column if not exists overdue_notified_at timestamptz;
