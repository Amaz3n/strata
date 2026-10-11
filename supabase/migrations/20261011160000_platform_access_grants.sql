-- STAGED, UNAPPLIED. Break-glass support access for EP02-08.
--
-- Arc staff used to hold standing owner-level access to every organization:
-- being a platform operator was enough, and the only trace was an optional,
-- best-effort audit row. Access to a customer's organization is now a grant:
--
--  1. platform_access_grants: one operator's access to one organization, with
--     a stated reason and a hard end no more than eight hours after it starts.
--     The application honours a grant only while it is open and unexpired, and
--     re-reads it on every request. The customer's administrators can READ
--     their organization's grants (so they see when Arc support was inside);
--     only the service role writes.
--  2. open_platform_access_grant: opens a grant and writes its audit row in one
--     transaction, so access that was granted is always access that was logged.
--     Times come from the database clock, so the eight-hour bound is the
--     server's, not the caller's.
--  3. active_platform_access_grants: the open, unexpired grants of one
--     operator (optionally in one organization), evaluated against now().
set lock_timeout = '5s';
set statement_timeout = '60s';

create table public.platform_access_grants (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  -- No foreign key: the record of who was inside an organization must outlive
  -- the staff account. The email is copied for the same reason, and because the
  -- customer's administrators cannot read Arc staff profiles.
  operator_user_id uuid not null,
  operator_email text not null,
  reason text not null check (char_length(btrim(reason)) >= 10),
  impersonation_session_id uuid references public.impersonation_sessions(id) on delete set null,
  granted_at timestamptz not null default now(),
  expires_at timestamptz not null,
  ended_at timestamptz,
  ended_by uuid references public.app_users(id) on delete set null,
  constraint platform_access_grants_window
    check (expires_at > granted_at and expires_at <= granted_at + interval '8 hours')
);

create index platform_access_grants_org_operator_expires_idx
  on public.platform_access_grants (org_id, operator_user_id, expires_at);

create index platform_access_grants_org_granted_idx
  on public.platform_access_grants (org_id, granted_at desc);

create index platform_access_grants_open_operator_idx
  on public.platform_access_grants (operator_user_id, expires_at)
  where ended_at is null;

create index platform_access_grants_impersonation_idx
  on public.platform_access_grants (impersonation_session_id)
  where impersonation_session_id is not null;

create index platform_access_grants_ended_by_idx
  on public.platform_access_grants (ended_by)
  where ended_by is not null;

alter table public.platform_access_grants enable row level security;

create policy platform_access_grants_admin_read
  on public.platform_access_grants
  for select to authenticated
  using (
    public.has_org_permission(org_id, 'members.manage')
    or public.is_org_admin_member(org_id)
  );

create policy platform_access_grants_service_access
  on public.platform_access_grants
  for all to service_role
  using ((select auth.role()) = 'service_role')
  with check ((select auth.role()) = 'service_role');

revoke all on public.platform_access_grants from public, anon, authenticated;
grant select on public.platform_access_grants to authenticated;
grant select, insert, update, delete on public.platform_access_grants to service_role;

create or replace function public.open_platform_access_grant(
  p_org_id uuid,
  p_operator_user_id uuid,
  p_operator_email text,
  p_reason text,
  p_minutes integer,
  p_impersonation_session_id uuid default null
)
returns public.platform_access_grants
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_grant public.platform_access_grants;
begin
  if p_minutes is null or p_minutes < 5 or p_minutes > 480 then
    raise exception 'Support access lasts between 5 minutes and 8 hours.' using errcode = '22023';
  end if;

  -- Entering again replaces the operator's open grant rather than stacking a
  -- second one beside it.
  update public.platform_access_grants
     set ended_at = now(),
         ended_by = p_operator_user_id
   where org_id = p_org_id
     and operator_user_id = p_operator_user_id
     and ended_at is null
     and expires_at > now();

  insert into public.platform_access_grants (
    org_id,
    operator_user_id,
    operator_email,
    reason,
    impersonation_session_id,
    expires_at
  ) values (
    p_org_id,
    p_operator_user_id,
    p_operator_email,
    btrim(p_reason),
    p_impersonation_session_id,
    now() + make_interval(mins => p_minutes)
  )
  returning * into v_grant;

  insert into public.authorization_audit_log (
    actor_user_id,
    org_id,
    action_key,
    resource_type,
    resource_id,
    decision,
    reason_code,
    impersonation_session_id,
    context
  ) values (
    p_operator_user_id,
    p_org_id,
    'platform.org.access',
    'platform_access_grant',
    v_grant.id::text,
    'allow',
    'grant_opened',
    p_impersonation_session_id,
    jsonb_build_object(
      'reason', v_grant.reason,
      'granted_at', v_grant.granted_at,
      'expires_at', v_grant.expires_at
    )
  );

  return v_grant;
end;
$$;

create or replace function public.active_platform_access_grants(
  p_operator_user_id uuid,
  p_org_id uuid default null
)
returns setof public.platform_access_grants
language sql
stable
security invoker
set search_path = ''
as $$
  select g.*
    from public.platform_access_grants g
   where g.operator_user_id = p_operator_user_id
     and (p_org_id is null or g.org_id = p_org_id)
     and g.ended_at is null
     and g.expires_at > now()
   order by g.expires_at desc;
$$;

revoke all on function public.open_platform_access_grant(uuid, uuid, text, text, integer, uuid)
  from public, anon, authenticated;
grant execute on function public.open_platform_access_grant(uuid, uuid, text, text, integer, uuid)
  to service_role;

revoke all on function public.active_platform_access_grants(uuid, uuid) from public, anon, authenticated;
grant execute on function public.active_platform_access_grants(uuid, uuid) to service_role;
