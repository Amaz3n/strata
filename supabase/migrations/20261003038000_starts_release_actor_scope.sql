-- STAGED, UNAPPLIED. Authorization at each locked generated-write scope.
-- Core/package transition authorization and non-header interactive RPC callers
-- remain separate work; this does not activate the claim consumers.
create function public.assert_starts_release_actor(p_job public.outbox,p_package public.start_packages)
returns void language plpgsql security definer set search_path=public,pg_catalog as $$
declare v_actor uuid; v_members uuid[]; v_roles uuid[]; v_base text[]; v_grants text[]; v_denies text[]; v_effective text[];
 v_assigned boolean; v_division uuid; v_lot_community uuid; v_lot_project uuid; v_divisions uuid[];
begin
 if p_job.org_id is distinct from p_package.org_id or p_job.job_type<>'start_release' then raise exception 'Starts actor scope mismatch' using errcode='42501'; end if;
 v_actor:=(p_job.payload->>'actor_id')::uuid;
 if v_actor is null then raise exception 'Starts actor missing' using errcode='42501'; end if;
 perform 1 from public.permissions where key='start.release' for share;
 if not found then raise exception 'Starts release permission is not registered' using errcode='42501'; end if;
 -- Parent UPDATE locks also block FK-backed insertion of a new override while
 -- permission facts are being used. Existing override/role rows are share locked.
 perform 1 from public.memberships where org_id=p_job.org_id and user_id=v_actor and status='active' order by id for update;
 select array_agg(id order by id),array_agg(distinct role_id),bool_or(division_scope='assigned') into v_members,v_roles,v_assigned
   from public.memberships where org_id=p_job.org_id and user_id=v_actor and status='active';
 if v_members is null then raise exception 'Starts actor is no longer an active organization member' using errcode='42501'; end if;
 perform 1 from public.role_permissions where role_id=any(v_roles) order by role_id,permission_key for share;
 perform 1 from public.membership_permission_overrides where membership_id=any(v_members) order by membership_id,permission_key for share;
 select coalesce(array_agg(distinct permission_key),'{}') into v_base from public.role_permissions where role_id=any(v_roles);
 select coalesce(array_agg(permission_key) filter(where effect='grant'),'{}'),coalesce(array_agg(permission_key) filter(where effect='deny'),'{}') into v_grants,v_denies
   from public.membership_permission_overrides where membership_id=any(v_members);
 select coalesce(array_agg(distinct x),'{}') into v_effective from unnest(v_base||v_grants) x where not(x=any(v_denies));
 if 'start.release'=any(v_denies) or not('start.release'=any(v_effective) or '*'=any(v_effective)) then raise exception 'Starts actor no longer has release permission' using errcode='42501'; end if;
 -- Mirrors fetchOrgPermissions division scope: a base org.admin role bypasses
 -- assignment scope; grants/denies still govern the requested release permission.
 v_assigned:=v_assigned and not('org.admin'=any(v_base));
 if v_assigned then
   perform 1 from public.membership_divisions where membership_id=any(v_members) order by membership_id,division_id for share;
   select coalesce(array_agg(distinct division_id),'{}') into v_divisions from public.membership_divisions where membership_id=any(v_members);
 end if;
 select division_id into v_division from public.communities where org_id=p_job.org_id and id=p_package.community_id for share;
 if not found then raise exception 'Starts community not found in organization' using errcode='42501'; end if;
 if v_assigned and (v_division is null or not(v_division=any(v_divisions))) then raise exception 'Starts community is outside actor division access' using errcode='42501'; end if;
 select division_id,community_id,project_id into v_division,v_lot_community,v_lot_project from public.lots where org_id=p_job.org_id and id=p_package.lot_id for share;
 if not found or v_lot_community is distinct from p_package.community_id then raise exception 'Starts lot ancestry differs from package' using errcode='42501'; end if;
 if v_assigned and (v_division is null or not(v_division=any(v_divisions))) then raise exception 'Starts lot is outside actor division access' using errcode='42501'; end if;
 if p_package.project_id is not null then
   if v_lot_project is distinct from p_package.project_id then raise exception 'Starts lot home ancestry differs from package' using errcode='42501'; end if;
   select division_id into v_division from public.projects where org_id=p_job.org_id and id=p_package.project_id for share;
   if not found then raise exception 'Starts home not found in organization' using errcode='42501'; end if;
   if v_assigned and (v_division is null or not(v_division=any(v_divisions))) then raise exception 'Starts home is outside actor division access' using errcode='42501'; end if;
 end if;
end $$;
revoke all on function public.assert_starts_release_actor(public.outbox,public.start_packages) from public,anon,authenticated;
grant execute on function public.assert_starts_release_actor(public.outbox,public.start_packages) to service_role;

create or replace function public.lock_starts_release_write_scope(p_org_id uuid) returns public.start_packages
language plpgsql set search_path=public,pg_catalog as $$
declare v_headers jsonb; v_job public.outbox%rowtype; v_pkg public.start_packages%rowtype;
begin
  v_headers:=coalesce(nullif(current_setting('request.headers',true),''),'{}')::jsonb;
  if v_headers->>'x-starts-job-id' is null and v_headers->>'x-starts-claim-token' is null then return null; end if;
  if current_user in ('anon','authenticated') then raise exception 'Browser cannot use starts worker headers' using errcode='42501'; end if;
  if coalesce(v_headers->>'x-starts-job-id','') !~ '^[1-9][0-9]{0,18}$'
    or coalesce(v_headers->>'x-starts-claim-token','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then raise exception 'Invalid starts worker context' using errcode='40001'; end if;
  select * into v_job from public.outbox where id=(v_headers->>'x-starts-job-id')::bigint
    and start_claim_token=(v_headers->>'x-starts-claim-token')::uuid and status='processing'
    and start_job_lease_expires_at>clock_timestamp() for update;
  if not found or v_job.job_type<>'start_release' then raise exception 'Starts worker lease lost' using errcode='40001'; end if;
  if p_org_id is distinct from v_job.org_id then raise exception 'Starts worker organization mismatch' using errcode='42501'; end if;
  select * into v_pkg from public.start_packages where org_id=v_job.org_id
    and id=(v_job.payload->>'start_package_id')::uuid for update;
  if not found or v_pkg.status<>'releasing' then raise exception 'Start package no longer releasing' using errcode='40001'; end if;
  if v_pkg.metadata->>'release_lease_token' is distinct from v_job.start_claim_token::text
    or v_pkg.metadata->>'release_lease_at' is null
    or (v_pkg.metadata->>'release_lease_at')::timestamptz<=clock_timestamp()-interval '5 minutes'
    then raise exception 'Start package lease lost' using errcode='40001'; end if;
  perform public.assert_starts_release_actor(v_job,v_pkg);
  return v_pkg;
end $$;
