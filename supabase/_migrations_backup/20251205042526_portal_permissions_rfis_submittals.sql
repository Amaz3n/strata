-- Extend portal access permissions
alter table portal_access_tokens
  add column if not exists can_view_invoices boolean not null default true,
  add column if not exists can_pay_invoices boolean not null default false,
  add column if not exists can_view_rfis boolean not null default true,
  add column if not exists can_view_submittals boolean not null default true,
  add column if not exists can_respond_rfis boolean not null default true,
  add column if not exists can_submit_submittals boolean not null default true,
  add column if not exists can_download_files boolean not null default true,
  add column if not exists max_access_count integer;

-- RFI approvals + attachments
alter table rfis
  add column if not exists decision_status text check (decision_status in ('approved','revisions_requested','rejected')),
  add column if not exists decision_note text,
  add column if not exists decided_by_user_id uuid references app_users(id),
  add column if not exists decided_by_contact_id uuid references contacts(id),
  add column if not exists decided_at timestamptz,
  add column if not exists decided_via_portal boolean default false,
  add column if not exists decision_portal_token_id uuid references portal_access_tokens(id),
  add column if not exists last_response_at timestamptz,
  add column if not exists attachment_file_id uuid references files(id);

alter table rfi_responses
  add column if not exists file_id uuid references files(id) on delete set null,
  add column if not exists portal_token_id uuid references portal_access_tokens(id),
  add column if not exists created_via_portal boolean not null default false,
  add column if not exists actor_ip inet;

-- Submittal decisions + attachments
alter table submittals
  add column if not exists decision_status text check (decision_status in ('approved','approved_as_noted','revise_resubmit','rejected')),
  add column if not exists decision_note text,
  add column if not exists decision_by_user_id uuid references app_users(id),
  add column if not exists decision_by_contact_id uuid references contacts(id),
  add column if not exists decision_at timestamptz,
  add column if not exists decision_via_portal boolean default false,
  add column if not exists decision_portal_token_id uuid references portal_access_tokens(id),
  add column if not exists attachment_file_id uuid references files(id),
  add column if not exists last_item_submitted_at timestamptz;

alter table submittal_items
  add column if not exists notes text,
  add column if not exists portal_token_id uuid references portal_access_tokens(id),
  add column if not exists created_via_portal boolean not null default false,
  add column if not exists responder_user_id uuid references app_users(id),
  add column if not exists responder_contact_id uuid references contacts(id);
;
