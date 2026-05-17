-- RBAC Phase 1 foundation
-- - expands permission catalog
-- - seeds project-role and platform-role mappings
-- - introduces platform auth and authorization audit tables

begin;

-- 1) Permission key convention guardrail.
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'permissions_key_format_chk'
      and conrelid = 'public.permissions'::regclass
  ) then
    alter table public.permissions
      add constraint permissions_key_format_chk
      check (key ~ '^[a-z_]+(\.[a-z_]+)+$');
  end if;
end
$$;

-- 2) Expand permission catalog.
insert into public.permissions (key, description)
values
  ('org.settings.read', 'View organization settings'),
  ('org.settings.update', 'Update organization settings'),
  ('team.invite', 'Invite organization members'),
  ('team.remove', 'Remove organization members'),
  ('team.role.assign', 'Assign org or project roles'),
  ('team.mfa.reset', 'Reset member MFA factors'),
  ('project.create', 'Create projects'),
  ('project.archive', 'Archive or unarchive projects'),
  ('project.settings.read', 'View project settings'),
  ('project.settings.update', 'Update project settings'),
  ('docs.read', 'View project documents'),
  ('docs.upload', 'Upload project documents'),
  ('docs.download', 'Download project documents'),
  ('docs.share', 'Manage sharing on project documents'),
  ('docs.delete', 'Delete or archive project documents'),
  ('schedule.read', 'View project schedule'),
  ('schedule.edit', 'Edit project schedule'),
  ('schedule.publish', 'Publish schedule updates'),
  ('schedule.baseline.manage', 'Manage schedule baselines'),
  ('daily_log.read', 'View daily logs'),
  ('daily_log.write', 'Create and edit daily logs'),
  ('daily_log.approve', 'Approve daily logs'),
  ('rfi.read', 'View RFIs'),
  ('rfi.write', 'Create and edit RFIs'),
  ('rfi.respond', 'Respond to RFIs'),
  ('rfi.close', 'Close RFIs'),
  ('submittal.read', 'View submittals'),
  ('submittal.write', 'Create and edit submittals'),
  ('submittal.review', 'Review submittals'),
  ('submittal.approve', 'Approve submittals'),
  ('change_order.read', 'View change orders'),
  ('change_order.write', 'Create and edit change orders'),
  ('change_order.approve', 'Approve change orders'),
  ('commitment.read', 'View commitments'),
  ('commitment.write', 'Create and edit commitments'),
  ('commitment.approve', 'Approve commitments'),
  ('budget.read', 'View project budgets'),
  ('budget.write', 'Create and edit project budgets'),
  ('budget.lock', 'Lock budget versions'),
  ('invoice.read', 'View invoices'),
  ('invoice.write', 'Create and edit invoices'),
  ('invoice.approve', 'Approve invoices'),
  ('invoice.send', 'Send invoices to recipients'),
  ('bill.read', 'View vendor bills'),
  ('bill.write', 'Create and edit vendor bills'),
  ('bill.approve', 'Approve vendor bills'),
  ('payment.read', 'View payment records'),
  ('payment.release', 'Release payments'),
  ('draw.read', 'View draw schedules and requests'),
  ('draw.approve', 'Approve draw requests'),
  ('retainage.manage', 'Manage retainage configuration and release'),
  ('report.read', 'View reports'),
  ('audit.export', 'Export audit logs'),
  ('portal.access.manage', 'Manage portal access and tokens'),
  ('authz.policy.manage', 'Manage authorization policies and overrides'),
  ('platform.org.read', 'View tenant organizations from platform context'),
  ('platform.org.access', 'Enter tenant org context from platform console'),
  ('platform.billing.manage', 'Manage billing across organizations from platform context'),
  ('platform.support.read', 'Read support diagnostics across organizations'),
  ('platform.support.write', 'Run support write operations across organizations'),
  ('platform.feature_flags.manage', 'Manage feature flags from platform context'),
  ('impersonation.start', 'Start user impersonation sessions'),
  ('impersonation.end', 'End or revoke impersonation sessions')
on conflict (key) do update
set description = excluded.description;

-- 3) Seed platform roles.
insert into public.roles (key, label, scope, description)
values
  ('platform_super_admin', 'Platform Super Admin', 'platform', 'Break-glass platform administrator'),
  ('platform_admin', 'Platform Admin', 'platform', 'Platform operations and support administrator'),
  ('platform_billing_ops', 'Platform Billing Ops', 'platform', 'Platform billing operations'),
  ('platform_support_readonly', 'Platform Support Readonly', 'platform', 'Read-only platform support role'),
  ('platform_security_auditor', 'Platform Security Auditor', 'platform', 'Platform security and audit role')
on conflict (key) do update
set label = excluded.label,
    scope = excluded.scope,
    description = excluded.description;

-- 4) Ensure project roles have permissions.
insert into public.role_permissions (role_id, permission_key)
select r.id, p.permission_key
from public.roles r
join lateral (
  select unnest(
    case r.key
      when 'pm' then array[
        'project.read',
        'project.manage',
        'project.settings.read',
        'project.settings.update',
        'docs.read',
        'docs.upload',
        'docs.download',
        'docs.share',
        'schedule.read',
        'schedule.edit',
        'schedule.publish',
        'schedule.baseline.manage',
        'daily_log.read',
        'daily_log.write',
        'rfi.read',
        'rfi.write',
        'rfi.respond',
        'rfi.close',
        'submittal.read',
        'submittal.write',
        'submittal.review',
        'change_order.read',
        'change_order.write',
        'commitment.read',
        'commitment.write',
        'budget.read',
        'budget.write',
        'invoice.read',
        'invoice.write',
        'invoice.send',
        'bill.read',
        'bill.write',
        'payment.read',
        'draw.read',
        'report.read',
        'portal.access.manage'
      ]::text[]
      when 'field' then array[
        'project.read',
        'docs.read',
        'docs.upload',
        'docs.download',
        'schedule.read',
        'schedule.edit',
        'daily_log.read',
        'daily_log.write',
        'rfi.read',
        'rfi.write',
        'rfi.respond',
        'submittal.read',
        'submittal.write',
        'report.read'
      ]::text[]
      when 'client' then array[
        'project.read',
        'docs.read',
        'docs.download',
        'schedule.read',
        'daily_log.read',
        'rfi.read',
        'submittal.read',
        'change_order.read',
        'invoice.read',
        'draw.read',
        'report.read'
      ]::text[]
      else array[]::text[]
    end
  ) as permission_key
) p on true
where r.scope = 'project'
on conflict do nothing;

-- 5) Platform role mappings.
insert into public.role_permissions (role_id, permission_key)
select r.id, p.permission_key
from public.roles r
join lateral (
  select unnest(
    case r.key
      when 'platform_super_admin' then array[
        'platform.org.read',
        'platform.org.access',
        'platform.billing.manage',
        'platform.support.read',
        'platform.support.write',
        'platform.feature_flags.manage',
        'impersonation.start',
        'impersonation.end',
        'audit.read',
        'audit.export',
        'authz.policy.manage'
      ]::text[]
      when 'platform_admin' then array[
        'platform.org.read',
        'platform.org.access',
        'platform.support.read',
        'platform.support.write',
        'platform.feature_flags.manage',
        'impersonation.start',
        'impersonation.end',
        'audit.read'
      ]::text[]
      when 'platform_billing_ops' then array[
        'platform.org.read',
        'platform.billing.manage',
        'platform.support.read',
        'audit.read'
      ]::text[]
      when 'platform_support_readonly' then array[
        'platform.org.read',
        'platform.support.read',
        'audit.read'
      ]::text[]
      when 'platform_security_auditor' then array[
        'platform.org.read',
        'platform.support.read',
        'audit.read',
        'audit.export'
      ]::text[]
      else array[]::text[]
    end
  ) as permission_key
) p on true
where r.scope = 'platform'
on conflict do nothing;

-- 6) Platform memberships table.
create table if not exists public.platform_memberships (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_users(id) on delete cascade,
  role_id uuid not null references public.roles(id),
  status public.membership_status not null default 'active',
  granted_by uuid references public.app_users(id),
  reason text,
  expires_at timestamp with time zone,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  unique (user_id, role_id)
);

create index if not exists idx_platform_memberships_user_status
  on public.platform_memberships (user_id, status);

create index if not exists idx_platform_memberships_role_status
  on public.platform_memberships (role_id, status);

-- Enforce that role_id belongs to scope='platform'.
create or replace function public.enforce_platform_membership_role_scope()
returns trigger
language plpgsql
as $$
begin
  if not exists (
    select 1
    from public.roles r
    where r.id = new.role_id
      and r.scope = 'platform'
  ) then
    raise exception 'platform_memberships.role_id must reference a platform-scoped role';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_platform_memberships_role_scope on public.platform_memberships;
create trigger trg_platform_memberships_role_scope
before insert or update on public.platform_memberships
for each row
execute function public.enforce_platform_membership_role_scope();

alter table public.platform_memberships enable row level security;

drop policy if exists platform_memberships_service_role_access on public.platform_memberships;
create policy platform_memberships_service_role_access
on public.platform_memberships
for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');

-- 7) Impersonation session ledger.
create table if not exists public.impersonation_sessions (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid not null references public.app_users(id),
  target_user_id uuid not null references public.app_users(id),
  org_id uuid references public.orgs(id),
  status text not null default 'active' check (status in ('active', 'ended', 'revoked', 'expired')),
  reason text not null,
  started_at timestamp with time zone not null default now(),
  ended_at timestamp with time zone,
  expires_at timestamp with time zone not null default (now() + interval '1 hour'),
  approved_by uuid references public.app_users(id),
  metadata jsonb not null default '{}'::jsonb,
  check (actor_user_id <> target_user_id)
);

create index if not exists idx_impersonation_sessions_actor_started_at
  on public.impersonation_sessions (actor_user_id, started_at desc);

create index if not exists idx_impersonation_sessions_target_started_at
  on public.impersonation_sessions (target_user_id, started_at desc);

create index if not exists idx_impersonation_sessions_org_started_at
  on public.impersonation_sessions (org_id, started_at desc);

alter table public.impersonation_sessions enable row level security;

drop policy if exists impersonation_sessions_service_role_access on public.impersonation_sessions;
create policy impersonation_sessions_service_role_access
on public.impersonation_sessions
for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');

-- 8) Authorization decision log.
create table if not exists public.authorization_audit_log (
  id uuid primary key default gen_random_uuid(),
  occurred_at timestamp with time zone not null default now(),
  actor_user_id uuid references public.app_users(id),
  org_id uuid references public.orgs(id),
  project_id uuid references public.projects(id),
  action_key text not null,
  resource_type text,
  resource_id text,
  decision text not null check (decision in ('allow', 'deny')),
  reason_code text,
  policy_version text,
  context jsonb not null default '{}'::jsonb,
  impersonation_session_id uuid references public.impersonation_sessions(id),
  request_id text,
  ip inet,
  user_agent text
);

create index if not exists idx_authorization_audit_log_occurred_at
  on public.authorization_audit_log (occurred_at desc);

create index if not exists idx_authorization_audit_log_actor_occurred_at
  on public.authorization_audit_log (actor_user_id, occurred_at desc);

create index if not exists idx_authorization_audit_log_org_occurred_at
  on public.authorization_audit_log (org_id, occurred_at desc);

create index if not exists idx_authorization_audit_log_action_occurred_at
  on public.authorization_audit_log (action_key, occurred_at desc);

alter table public.authorization_audit_log enable row level security;

drop policy if exists authorization_audit_log_service_role_access on public.authorization_audit_log;
create policy authorization_audit_log_service_role_access
on public.authorization_audit_log
for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');

-- 9) Updated-at trigger for platform memberships.
do $$
begin
  if exists (
    select 1
    from pg_proc
    where proname = 'tg_set_updated_at'
      and pronamespace = 'public'::regnamespace
  ) then
    drop trigger if exists platform_memberships_set_updated_at on public.platform_memberships;

    create trigger platform_memberships_set_updated_at
    before update on public.platform_memberships
    for each row
    execute function public.tg_set_updated_at();
  end if;
end
$$;

commit;
