-- Workstream 04 (Phase 2): multi-step submittal review routing + ball-in-court.
-- Ordered review steps (GC review -> architect -> consultants) as a state
-- machine; submittals/rfis carry a denormalized ball_in_court display label.
-- Submittals with zero steps keep the existing single-decision path untouched.

create table if not exists public.submittal_review_steps (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  submittal_id uuid not null references public.submittals(id) on delete cascade,
  step_order integer not null,
  reviewer_kind text not null check (reviewer_kind in ('internal', 'external')),
  reviewer_user_id uuid references public.app_users(id),      -- internal
  reviewer_contact_id uuid references public.contacts(id),    -- external (reviewer seat)
  reviewer_company_id uuid references public.companies(id),
  role_label text,                                            -- 'GC Review', 'Architect', 'MEP Engineer'
  status text not null default 'pending'
    check (status in ('pending', 'in_review', 'returned', 'skipped')),
  decision text
    check (decision in ('approved', 'approved_as_noted', 'revise_resubmit', 'rejected')),
  notes text,
  decided_at timestamptz,
  due_date date,
  markup_file_id uuid references public.files(id),
  portal_token_id uuid references public.portal_access_tokens(id),
  created_at timestamptz not null default now(),
  unique (submittal_id, step_order)
);

create index if not exists submittal_review_steps_org_submittal_idx
  on public.submittal_review_steps (org_id, submittal_id);
create index if not exists submittal_review_steps_reviewer_contact_idx
  on public.submittal_review_steps (org_id, reviewer_contact_id)
  where reviewer_contact_id is not null;
create index if not exists submittal_review_steps_reviewer_user_idx
  on public.submittal_review_steps (org_id, reviewer_user_id)
  where reviewer_user_id is not null;

alter table public.submittal_review_steps enable row level security;

drop policy if exists submittal_review_steps_org_access on public.submittal_review_steps;
create policy submittal_review_steps_org_access
  on public.submittal_review_steps
  for all
  to authenticated
  using (public.is_org_member(org_id))
  with check (
    public.is_org_member(org_id)
    and exists (
      select 1
      from public.submittals
      where submittals.id = submittal_review_steps.submittal_id
        and submittals.org_id = submittal_review_steps.org_id
    )
  );

grant all on table public.submittal_review_steps to authenticated, service_role;

alter table public.submittals
  add column if not exists current_review_step_id uuid references public.submittal_review_steps(id),
  add column if not exists ball_in_court text,
  add column if not exists stamped_file_id uuid references public.files(id);

comment on column public.submittals.stamped_file_id is
  'File whose current version carries the review stamp imprint (the record copy returned to the sub). The original upload survives as version 1.';

alter table public.rfis
  add column if not exists ball_in_court text;

comment on column public.submittals.ball_in_court is
  'Denormalized display label of the party that currently owes action; service-maintained on every workflow transition.';
comment on column public.rfis.ball_in_court is
  'Denormalized display label of the party that currently owes action; service-maintained on RFI transitions.';

-- Permission key for editing submittal review workflows and deciding internal
-- steps. Extends the RBAC catalog seed (20260708120500 is the source of truth;
-- keep its desired-state list in sync if it is ever re-run).
insert into public.permissions (key, description) values
  ('submittal.route', 'Edit submittal review workflows and decide internal review steps')
on conflict (key) do update set description = excluded.description;

insert into public.role_permissions (role_id, permission_key)
select id, 'submittal.route' from public.roles
where key in ('org_owner', 'org_admin', 'org_office_admin', 'org_project_lead', 'pm')
on conflict (role_id, permission_key) do nothing;
