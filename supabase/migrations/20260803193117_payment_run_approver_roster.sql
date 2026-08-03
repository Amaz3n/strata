-- Designated payment-run approvers.
--
-- `payments.approve_run` says a person is *capable* of approving; this roster says
-- who an org has actually *designated*. An AP clerk who prepares a run should route
-- to a named superior, not to whoever happens to hold the permission.
--
-- Semantics (enforced in lib/services/payment-runs.ts, mirrored in the UI):
--   * roster empty  -> any user holding `payments.approve_run` may approve
--                      (preserves current behavior for orgs that never configure it)
--   * roster set    -> ONLY listed, still-permitted users may approve
-- The preparer can never approve their own run in either case; that rule lives in
-- decide_payment_run_atomic and is untouched here.

create table public.payment_run_approvers (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  user_id uuid not null references public.app_users(id) on delete cascade,
  -- Optional ceiling: this approver may only decide runs at or below this debit
  -- total. Null means no personal ceiling beyond the org's own run limits.
  approval_limit_cents bigint check (approval_limit_cents is null or approval_limit_cents > 0),
  created_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, user_id)
);

create index payment_run_approvers_org_idx on public.payment_run_approvers (org_id);
create index payment_run_approvers_org_user_idx on public.payment_run_approvers (org_id, user_id);

create trigger payment_run_approvers_set_updated_at before update on public.payment_run_approvers
  for each row execute function public.tg_set_updated_at();

alter table public.payment_run_approvers enable row level security;

grant select, insert, update, delete on public.payment_run_approvers to service_role;

-- Anyone who can see payment runs can see who approves them: knowing where your
-- submission is going is part of the workflow, not privileged information.
create policy payment_run_approvers_read on public.payment_run_approvers
  for select to authenticated
  using (public.has_org_permission(org_id, 'payment.release'));

-- Editing the roster is a payment control change, gated like the rest of the rail.
create policy payment_run_approvers_write on public.payment_run_approvers
  for all to authenticated
  using (public.has_org_permission(org_id, 'payments.manage_rail'))
  with check (public.has_org_permission(org_id, 'payments.manage_rail'));
