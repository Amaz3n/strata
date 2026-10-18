-- STAGED, UNAPPLIED. Organization security controls for EP02-02 / EP02-03.
--
--  1. org_security_policies: the org-wide "require two-factor" switch. Members
--     can READ their org's policy (the proxy asks with the member's own session
--     to decide whether to force enrollment); only the service role writes, so
--     the member-wide `orgs_access` policy can never be used to switch it off.
--  2. revoke_user_sessions: ends every Supabase session (and, by cascade, its
--     refresh tokens) for one user. Called when a member is suspended so a
--     departed person's open browser or phone stops refreshing immediately.
set lock_timeout = '5s';
set statement_timeout = '60s';

create table public.org_security_policies (
  org_id uuid primary key references public.orgs(id) on delete cascade,
  require_mfa boolean not null default false,
  updated_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index org_security_policies_updated_by_idx
  on public.org_security_policies (updated_by)
  where updated_by is not null;

create trigger org_security_policies_updated_at
  before update on public.org_security_policies
  for each row execute function public.tg_set_updated_at();

alter table public.org_security_policies enable row level security;

create policy org_security_policies_member_read
  on public.org_security_policies
  for select to authenticated
  using (public.is_org_member(org_id));

create policy org_security_policies_service_access
  on public.org_security_policies
  for all to service_role
  using ((select auth.role()) = 'service_role')
  with check ((select auth.role()) = 'service_role');

revoke all on public.org_security_policies from public, anon, authenticated;
grant select on public.org_security_policies to authenticated;
grant select, insert, update, delete on public.org_security_policies to service_role;

create or replace function public.revoke_user_sessions(p_user_id uuid)
returns integer
language plpgsql
security definer
set search_path = auth, public, pg_temp
as $$
declare
  v_deleted integer;
begin
  -- auth.refresh_tokens.session_id cascades, so the refresh tokens go with it.
  delete from auth.sessions where user_id = p_user_id;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function public.revoke_user_sessions(uuid) from public, anon, authenticated;
grant execute on function public.revoke_user_sessions(uuid) to service_role;
