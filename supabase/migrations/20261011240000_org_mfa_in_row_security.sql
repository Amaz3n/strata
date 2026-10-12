-- STAGED, UNAPPLIED. EP02-02: an organization's two-factor requirement holds in
-- row security, not only in the proxy.
--
-- org_security_policies.require_mfa was enforced by the Next.js proxy alone. A
-- member's password is enough to get an aal1 JWT from Supabase Auth with the
-- public anon key, and that JWT read and wrote the org's rows straight through
-- PostgREST without ever meeting the proxy.
--
-- Every membership-based RLS helper now counts a membership in an org that
-- requires two-factor only for an aal2 session. Policies that inline a
-- subquery over memberships follow without being touched, because that
-- subquery runs under memberships_select, which asks is_org_member().
--
-- Deliberately unchanged:
--  * membership_is_org_admin(membership, role) is a fact about a role, read only
--    inside helpers that have already filtered the membership.
--  * member_foreign_division_*_ids() return ids a policy EXCLUDES. They read
--    member_reachable_division_ids(), which now shrinks for an aal1 session, so
--    the foreign set can only grow; shrinking it would widen access.
--  * member_reachable_community_ids() / member_reachable_lot_ids() derive from
--    member_reachable_division_ids() and narrow with it.
--
-- org_security_policies itself stays readable at aal1: the proxy asks, with the
-- member's own session, whether an org requires two-factor so it can send them
-- to enrollment. Gating that read on two-factor would answer "no" and wave the
-- session through to an app that shows nothing.
--
-- Definer RPCs that members call directly and that authorize from memberships
-- themselves get the same check: void_pay_application,
-- project_structural_option_cents, the inspection lifecycle RPCs (through
-- assert_inspection_lifecycle_actor), the trade lookahead (through
-- trade_workspace_readable_homes) and deal writes (arc_private.can_write_deal).
-- create or replace keeps every function's owner and grants.
set lock_timeout = '5s';
set statement_timeout = '60s';

-- True when this session may act on the org's rows: it is aal2, or the org
-- does not require two-factor. Read inside policies, so anon can execute it.
create or replace function public.session_meets_org_mfa(p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select auth.jwt()) ->> 'aal', '') = 'aal2'
    or not exists (
      select 1
      from public.org_security_policies p
      where p.org_id = p_org
        and p.require_mfa
    );
$$;

revoke all on function public.session_meets_org_mfa(uuid) from public;
grant execute on function public.session_meets_org_mfa(uuid) to authenticated, anon, service_role;

-- Membership whatever the session's assurance level. Only for reading what the
-- session owes before it may act (org_security_policies); never for org data.
create or replace function public.is_org_member_at_any_assurance(check_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.memberships m
    where m.org_id = check_org_id
      and m.user_id = (select auth.uid())
      and m.status = 'active'
  );
$$;

revoke all on function public.is_org_member_at_any_assurance(uuid) from public;
grant execute on function public.is_org_member_at_any_assurance(uuid) to authenticated, service_role;

drop policy org_security_policies_member_read on public.org_security_policies;
create policy org_security_policies_member_read
  on public.org_security_policies
  for select to authenticated
  using (public.is_org_member_at_any_assurance(org_id));

create or replace function public.is_org_member(check_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.memberships m
    where m.org_id = check_org_id
      and m.user_id = (select auth.uid())
      and m.status = 'active'
  )
  and public.session_meets_org_mfa(check_org_id);
$$;

create or replace function public.has_org_permission(check_org_id uuid, check_permission text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select
    exists (
      select 1
      from public.memberships m
      left join public.role_permissions rp
        on rp.role_id = m.role_id and rp.permission_key = check_permission
      left join public.membership_permission_overrides mpo
        on mpo.membership_id = m.id
       and mpo.permission_key = check_permission
       and mpo.effect = 'grant'
      where m.org_id = check_org_id
        and m.user_id = (select auth.uid())
        and m.status = 'active'
        and (rp.permission_key is not null or mpo.permission_key is not null)
    )
    and not exists (
      select 1
      from public.memberships m
      join public.membership_permission_overrides mpo
        on mpo.membership_id = m.id
       and mpo.permission_key = check_permission
       and mpo.effect = 'deny'
      where m.org_id = check_org_id
        and m.user_id = (select auth.uid())
        and m.status = 'active'
    )
    and public.session_meets_org_mfa(check_org_id);
$$;

create or replace function public.is_org_admin_member(check_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.memberships m
    join public.roles r on r.id = m.role_id
    where m.org_id = check_org_id
      and m.user_id = (select auth.uid())
      and m.status = 'active'
      and r.scope = 'org'
      and r.key in ('org_owner', 'org_admin', 'org_office_admin')
  )
  and public.session_meets_org_mfa(check_org_id);
$$;

create or replace function public.can_manage_members(check_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.memberships m
    join public.role_permissions rp on rp.role_id = m.role_id
    where m.org_id = check_org_id
      and m.user_id = (select auth.uid())
      and m.status = 'active'
      and rp.permission_key = 'members.manage'
  )
  and public.session_meets_org_mfa(check_org_id);
$$;

create or replace function public.is_project_member(check_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.project_members pm
    join public.projects p on p.id = pm.project_id
    where pm.project_id = check_project_id
      and pm.user_id = (select auth.uid())
      and pm.status = 'active'
      and pm.org_id = p.org_id
      and public.session_meets_org_mfa(pm.org_id)
  );
$$;

create or replace function public.shares_org_with_current_user(target_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.memberships ms
    join public.memberships mo on mo.org_id = ms.org_id
    where ms.user_id = (select auth.uid())
      and ms.status = 'active'
      and mo.user_id = target_user_id
      and public.session_meets_org_mfa(ms.org_id)
  );
$$;

create or replace function public.member_can_reach_project(check_org_id uuid, check_project_id uuid, check_division_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.memberships m
    where m.org_id = check_org_id
      and m.user_id = (select auth.uid())
      and m.status = 'active'
      and public.session_meets_org_mfa(m.org_id)
      and (
        public.membership_is_org_admin(m.id, m.role_id)
        or (
          (
            m.division_scope = 'all'
            or exists (
              select 1 from public.membership_divisions md
              where md.membership_id = m.id and md.division_id = check_division_id
            )
          )
          and (
            m.project_scope = 'all'
            or exists (
              select 1 from public.project_members pm
              where pm.project_id = check_project_id
                and pm.user_id = m.user_id
                and pm.org_id = check_org_id
                and pm.status = 'active'
            )
          )
        )
      )
  );
$$;

create or replace function public.member_unscoped_org_ids()
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(m.org_id), '{}'::uuid[])
  from public.memberships m
  where m.user_id = (select auth.uid())
    and m.status = 'active'
    and public.session_meets_org_mfa(m.org_id)
    and (
      (m.division_scope = 'all' and m.project_scope = 'all')
      or public.membership_is_org_admin(m.id, m.role_id)
    );
$$;

create or replace function public.member_division_unscoped_org_ids()
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(m.org_id), '{}'::uuid[])
  from public.memberships m
  where m.user_id = (select auth.uid())
    and m.status = 'active'
    and public.session_meets_org_mfa(m.org_id)
    and (m.division_scope = 'all' or public.membership_is_org_admin(m.id, m.role_id));
$$;

create or replace function public.member_reachable_project_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select p.id
  from public.memberships m
  join public.projects p on p.org_id = m.org_id
  where m.user_id = (select auth.uid())
    and m.status = 'active'
    and public.session_meets_org_mfa(m.org_id)
    and not public.membership_is_org_admin(m.id, m.role_id)
    and (
      m.division_scope = 'all'
      or p.division_id in (select md.division_id from public.membership_divisions md where md.membership_id = m.id)
    )
    and (
      m.project_scope = 'all'
      or exists (
        select 1 from public.project_members pm
        where pm.project_id = p.id
          and pm.user_id = m.user_id
          and pm.org_id = m.org_id
          and pm.status = 'active'
      )
    );
$$;

create or replace function public.member_reachable_division_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select md.division_id
  from public.memberships m
  join public.membership_divisions md on md.membership_id = m.id
  join public.divisions d on d.id = md.division_id and d.org_id = m.org_id
  where m.user_id = (select auth.uid())
    and m.status = 'active'
    and public.session_meets_org_mfa(m.org_id);
$$;

-- Unchanged apart from the two-factor condition on the membership it reads.
create or replace function public.project_structural_option_cents(p_project_id uuid)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select sum(ps.price_cents_snapshot)::bigint
  from public.projects p
  join public.project_selections ps on ps.org_id = p.org_id and ps.project_id = p.id
  join public.selection_options so on so.id = ps.selected_option_id and so.org_id = ps.org_id
  where p.id = p_project_id
    and (
      (select auth.role()) = 'service_role'
      -- Division scope is the enforcement layer: a member reaches the total only for a home in a
      -- division they work in. Project assignment is deliberately not required, so everyone who
      -- can sell in a division sees the same asking price.
      or exists (
        select 1
        from public.memberships m
        where m.org_id = p.org_id
          and m.user_id = (select auth.uid())
          and m.status = 'active'
          and public.session_meets_org_mfa(m.org_id)
          and (
            public.membership_is_org_admin(m.id, m.role_id)
            or m.division_scope = 'all'
            or exists (
              select 1 from public.membership_divisions md
              where md.membership_id = m.id and md.division_id = p.division_id
            )
          )
      )
    )
    and ps.status in ('confirmed', 'ordered', 'received')
    and so.option_scope = 'structural';
$$;

-- The four definitions below are unchanged apart from refusing an aal1 session
-- in an org that requires two-factor.
create or replace function public.void_pay_application(p_org_id uuid, p_pay_application_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_app record;
  v_newer integer;
  v_invoice_status text;
  v_release_remaining integer;
  v_release_take integer;
  v_line record;
begin
  perform 1 from public.contracts where id = (select contract_id from public.pay_applications where id=p_pay_application_id and org_id=p_org_id) and org_id=p_org_id for update;
  select * into v_app
  from public.pay_applications
  where id = p_pay_application_id and org_id = p_org_id
  for update;

  if not found then
    raise exception 'Pay application not found';
  end if;

  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role'
    and not exists (
      select 1
      from public.memberships m
      where m.org_id = p_org_id
        and m.user_id = (select auth.uid())
        and m.status = 'active'
        and public.session_meets_org_mfa(m.org_id)
        and (
          exists (
            select 1 from public.membership_permission_overrides mpo
            where mpo.membership_id = m.id
              and mpo.permission_key = 'payapp.write'
              and mpo.effect = 'grant'
          )
          or exists (
            select 1 from public.role_permissions rp
            where rp.role_id = m.role_id
              and rp.permission_key = 'payapp.write'
          )
        )
        and not exists (
          select 1 from public.membership_permission_overrides mpo
          where mpo.membership_id = m.id
            and mpo.permission_key = 'payapp.write'
            and mpo.effect = 'deny'
        )
        and (
          coalesce(m.project_scope::text, 'all') <> 'assigned'
          or exists (
            select 1 from public.project_members pm
            where pm.org_id = p_org_id
              and pm.project_id = v_app.project_id
              and pm.user_id = (select auth.uid())
              and pm.status = 'active'
          )
        )
    ) then
    raise exception 'Missing permission: payapp.write' using errcode = '42501';
  end if;
  if v_app.status = 'void' then
    return jsonb_build_object('pay_application_id', p_pay_application_id, 'already_void', true);
  end if;
  if v_app.status not in ('submitted', 'approved', 'invoiced') then
    raise exception 'Only submitted pay applications can be voided; delete drafts instead';
  end if;

  select count(*) into v_newer
  from public.pay_applications
  where org_id = p_org_id
    and contract_id = v_app.contract_id
    and application_number > v_app.application_number
    and status not in ('void','draft');
  if v_newer > 0 then
    raise exception 'Only the latest pay application can be voided';
  end if;

  if v_app.invoice_id is not null then
    select status into v_invoice_status
    from public.invoices
    where id = v_app.invoice_id and org_id = p_org_id;
    if v_invoice_status in ('paid', 'partial') then
      raise exception 'The pay application invoice has payments and cannot be voided';
    end if;
  end if;

  if coalesce(v_app.metadata ->> 'type', '') = 'retainage_release' then
    v_release_remaining := coalesce((v_app.metadata ->> 'release_amount_cents')::integer, 0);
    if v_release_remaining <= 0 then
      raise exception 'Retainage release application is missing its release amount';
    end if;

    -- Releases allocate oldest SOV lines first. Because only the latest
    -- application may be voided, reversing newest allocations first restores
    -- the exact cumulative state that preceded this release.
    for v_line in
      select id, retainage_released_cents
      from public.prime_sov_lines
      where org_id = p_org_id
        and contract_id = v_app.contract_id
        and retainage_released_cents > 0
      order by line_number desc
      for update
    loop
      exit when v_release_remaining <= 0;
      v_release_take := least(v_release_remaining, v_line.retainage_released_cents);
      update public.prime_sov_lines
      set retainage_released_cents = retainage_released_cents - v_release_take
      where id = v_line.id and org_id = p_org_id;
      v_release_remaining := v_release_remaining - v_release_take;
    end loop;

    if v_release_remaining <> 0 then
      raise exception 'Retainage release allocation is inconsistent (% cents missing)', v_release_remaining;
    end if;
  else
    update public.prime_sov_lines s
    set previous_billed_cents = s.previous_billed_cents - l.this_period_cents,
        stored_materials_cents = coalesce((l.metadata->>'previous_stored_materials_cents')::integer, s.stored_materials_cents),
        retainage_held_cents = s.retainage_held_cents - l.retainage_cents
    from public.pay_application_lines l
    where l.pay_application_id = p_pay_application_id
      and l.org_id = p_org_id
      and s.id = l.prime_sov_line_id
      and s.org_id = p_org_id;
  end if;

  update public.pay_applications
  set status = 'void'
  where id = p_pay_application_id and org_id = p_org_id;

  perform public.rebase_pay_application_drafts(p_org_id, v_app.contract_id);
  return jsonb_build_object(
    'pay_application_id', p_pay_application_id,
    'invoice_id', v_app.invoice_id,
    'retainage_release_reversed', coalesce(v_app.metadata ->> 'type', '') = 'retainage_release'
  );
end;
$function$;

create or replace function public.assert_inspection_lifecycle_actor(p_org_id uuid, p_project_id uuid, p_actor_id uuid, p_permission text)
returns void
language plpgsql
security definer
set search_path = 'public', 'pg_catalog'
as $function$
declare
 members uuid[]; org_roles uuid[]; project_roles uuid[]; platform_roles uuid[]; all_roles uuid[];
 base_permissions text[]; org_permissions text[]; project_permissions text[]; platform_permissions text[];
 grants text[]; denies text[]; effective text[]; org_effective text[];
 assigned_only boolean; division_assigned boolean; project_member boolean; home_division uuid; divisions uuid[];
begin
 if auth.uid() is distinct from p_actor_id and (auth.uid() is not null or current_setting('role',true)<>'service_role') then raise exception 'Inspection actor identity differs from authenticated session' using errcode='42501';end if;
 if auth.uid() is not null and not public.session_meets_org_mfa(p_org_id) then raise exception 'Your organization requires two-factor authentication' using errcode='42501';end if;
 if p_permission not in('inspection.write','inspection.review','project.read','closing.manage') then raise exception 'Invalid inspection operation permission';end if;
 if p_org_id is null or p_project_id is null or p_actor_id is null then raise exception 'Inspection lifecycle authorization identity is required' using errcode='42501'; end if;
 -- Parent locks also fence FK-backed new memberships, project grants and role
 -- permission/override inserts. Validate actual FK/lock order in full-schema QA.
 perform 1 from public.app_users where id=p_actor_id for update;
 if not found then raise exception 'Inspection lifecycle actor not found' using errcode='42501'; end if;
 perform 1 from public.permissions where key=p_permission for share;
 if not found then raise exception 'Inspection lifecycle write permission is not registered' using errcode='42501'; end if;
 select division_id into home_division from public.projects where id=p_project_id and org_id=p_org_id for update;
 if not found then raise exception 'Inspection lifecycle authorization home belongs to another organization or is unavailable' using errcode='42501'; end if;
 perform 1 from public.memberships where org_id=p_org_id and user_id=p_actor_id order by id for update;
 perform 1 from public.project_members where org_id=p_org_id and project_id=p_project_id and user_id=p_actor_id order by id for update;
 perform 1 from public.platform_memberships where user_id=p_actor_id order by id for update;
 select coalesce(array_agg(id),'{}'),coalesce(array_agg(distinct role_id),'{}'),coalesce(bool_or(project_scope='assigned'),false),coalesce(bool_or(division_scope='assigned'),false)
 into members,org_roles,assigned_only,division_assigned from public.memberships where org_id=p_org_id and user_id=p_actor_id and status='active';
 select coalesce(array_agg(distinct role_id),'{}'),count(*)>0 into project_roles,project_member from public.project_members where org_id=p_org_id and project_id=p_project_id and user_id=p_actor_id and status='active';
 select coalesce(array_agg(distinct role_id),'{}') into platform_roles from public.platform_memberships where user_id=p_actor_id and status='active';
 all_roles:=org_roles||project_roles||platform_roles;
 -- Permission removals are fenced by their existing-row SHARE locks. Adding
 -- another role grant cannot revoke an already-proven allow; SHARE here avoids
 -- serializing all signing work for every actor using the same role.
 perform 1 from public.roles where id=any(all_roles) order by id for share;
 perform 1 from public.role_permissions where role_id=any(all_roles) order by role_id,permission_key for share;
 perform 1 from public.membership_permission_overrides where membership_id=any(members) order by membership_id,permission_key for share;
 select coalesce(array_agg(distinct permission_key),'{}') into base_permissions from public.role_permissions where role_id=any(org_roles);
 select coalesce(array_agg(distinct permission_key),'{}') into project_permissions from public.role_permissions where role_id=any(project_roles);
 -- Evaluate expiry after waits for all locked permission facts.
 select coalesce(array_agg(distinct rp.permission_key),'{}') into platform_permissions from public.platform_memberships pm join public.role_permissions rp on rp.role_id=pm.role_id
 where pm.user_id=p_actor_id and pm.status='active' and (pm.expires_at is null or pm.expires_at>clock_timestamp());
 if '*'=any(platform_permissions) or 'platform.org.access'=any(platform_permissions) then return; end if;
 if cardinality(members)=0 then raise exception 'Inspection actor has no active organization membership' using errcode='42501';end if;
 select coalesce(array_agg(permission_key) filter(where effect='grant'),'{}'),coalesce(array_agg(permission_key) filter(where effect='deny'),'{}') into grants,denies
 from public.membership_permission_overrides where membership_id=any(members);
 org_permissions:=base_permissions||grants;
 select coalesce(array_agg(distinct x),'{}') into org_effective from unnest(org_permissions||platform_permissions) x where not(x=any(denies));
 if p_permission=any(denies) or (p_permission<>'project.read' and not(p_permission=any(org_effective) or '*'=any(org_effective))) then raise exception 'Inspection lifecycle actor lacks organization write permission' using errcode='42501'; end if;
 if not project_member and not('*'=any(org_permissions) or 'org.admin'=any(org_permissions) or (not assigned_only and ('project.read'=any(org_permissions) or 'project.manage'=any(org_permissions)))) then
  raise exception 'Inspection lifecycle home is outside actor assigned project access' using errcode='42501';
 end if;
 select coalesce(array_agg(distinct x),'{}') into effective from unnest(org_permissions||project_permissions||platform_permissions) x where not(x=any(denies));
 if not(p_permission=any(effective) or '*'=any(effective)) then raise exception 'Inspection lifecycle actor lacks home write permission' using errcode='42501'; end if;
 if division_assigned and not('org.admin'=any(effective)) then
  perform 1 from public.membership_divisions where membership_id=any(members) order by membership_id,division_id for share;
  select coalesce(array_agg(distinct division_id),'{}') into divisions from public.membership_divisions where membership_id=any(members);
  if home_division is null or not(home_division=any(divisions)) then raise exception 'Inspection lifecycle home is outside actor division access' using errcode='42501'; end if;
 end if;
end $function$;

create or replace function public.trade_workspace_readable_homes(p_org uuid, p_actor uuid, p_division uuid, p_community uuid)
returns table(project_id uuid)
language plpgsql
stable security definer
set search_path = ''
as $function$
declare members uuid[];base text[];grants text[];denies text[];platform text[];effective text[];
 assigned boolean;division_assigned boolean;divisions uuid[];all_homes boolean;bypass boolean;
begin
 if p_actor is null or p_org is null or not exists(select 1 from public.app_users where id=p_actor) then raise exception 'Trade workspace actor is unavailable' using errcode='42501';end if;
 if auth.uid() is not null and not public.session_meets_org_mfa(p_org) then raise exception 'Your organization requires two-factor authentication' using errcode='42501';end if;
 if not exists(select 1 from public.permissions where key='start.read') then raise exception 'Trade workspace permission is not registered' using errcode='42501';end if;
 select coalesce(array_agg(m.id),'{}'),coalesce(bool_or(m.project_scope='assigned'),false),coalesce(bool_or(m.division_scope='assigned'),false)
 into members,assigned,division_assigned from public.memberships m join public.roles r on r.id=m.role_id where m.org_id=p_org and m.user_id=p_actor and m.status='active';
 select coalesce(array_agg(distinct rp.permission_key),'{}') into base from public.memberships m join public.role_permissions rp on rp.role_id=m.role_id where m.id=any(members);
 select coalesce(array_agg(permission_key) filter(where effect='grant'),'{}'),coalesce(array_agg(permission_key) filter(where effect='deny'),'{}') into grants,denies from public.membership_permission_overrides where membership_id=any(members);
 select coalesce(array_agg(distinct rp.permission_key),'{}') into platform from public.platform_memberships m join public.roles r on r.id=m.role_id join public.role_permissions rp on rp.role_id=r.id where m.user_id=p_actor and m.status='active' and (m.expires_at is null or m.expires_at>statement_timestamp());
 bypass:='*'=any(platform) or 'platform.org.access'=any(platform);
 select coalesce(array_agg(distinct x),'{}') into effective from unnest(base||grants||platform) x where not(x=any(denies));
 if not bypass and (cardinality(members)=0 or 'start.read'=any(denies) or not('start.read'=any(effective) or '*'=any(effective))) then raise exception 'Trade workspace read permission denied' using errcode='42501';end if;
 all_homes:=bypass or '*'=any(base||grants) or 'org.admin'=any(base||grants) or (not assigned and ('project.read'=any(base||grants) or 'project.manage'=any(base||grants)));
 division_assigned:=not bypass and division_assigned and not('org.admin'=any(effective));
 select coalesce(array_agg(distinct division_id),'{}') into divisions from public.membership_divisions where membership_id=any(members);
 return query select p.id from public.projects p where p.org_id=p_org and p.property_type='production' and p.status='active'
 and (p_division is null or p.division_id=p_division) and (not division_assigned or p.division_id=any(divisions))
 and (all_homes or exists(select 1 from public.project_members pm join public.roles r on r.id=pm.role_id where pm.org_id=p_org and pm.project_id=p.id and pm.user_id=p_actor and pm.status='active'))
 and (bypass or not('project.read'=any(denies)) and ('project.read'=any(effective) or '*'=any(effective) or exists(select 1 from public.project_members pm join public.role_permissions rp on rp.role_id=pm.role_id where pm.org_id=p_org and pm.project_id=p.id and pm.user_id=p_actor and pm.status='active' and rp.permission_key in('project.read','*'))))
 and (p_community is null or exists(select 1 from public.lots l join public.communities c on c.id=l.community_id and c.org_id=l.org_id where l.project_id=p.id and l.org_id=p_org and c.id=p_community));
end $function$;

create or replace function arc_private.can_write_deal(p_org_id uuid, p_prospect_id uuid)
returns boolean
language plpgsql
stable security definer
set search_path = ''
as $function$
declare
  actor uuid := auth.uid();
  linked_project_id uuid;
  org_permissions text[];
  denied text[];
  project_permissions text[];
  assigned_only boolean;
  project_member boolean;
begin
  if actor is null then return false; end if;
  if not public.session_meets_org_mfa(p_org_id) then return false; end if;
  if not exists (select 1 from public.memberships where org_id=p_org_id and user_id=actor and status='active') then
    return false;
  end if;
  select coalesce(array_agg(distinct permission_key), '{}') into org_permissions from (
    select rp.permission_key from public.memberships m join public.role_permissions rp on rp.role_id=m.role_id
      where m.org_id=p_org_id and m.user_id=actor and m.status='active'
    union
    select o.permission_key from public.memberships m join public.membership_permission_overrides o on o.membership_id=m.id
      where m.org_id=p_org_id and m.user_id=actor and m.status='active' and o.effect='grant'
  ) grants;
  select coalesce(array_agg(distinct o.permission_key), '{}') into denied
    from public.memberships m join public.membership_permission_overrides o on o.membership_id=m.id
    where m.org_id=p_org_id and m.user_id=actor and m.status='active' and o.effect='deny';
  if 'org.member'=any(denied) or not ('org.member'=any(org_permissions) or ('*'=any(org_permissions) and not '*'=any(denied))) then return false; end if;
  select id into linked_project_id from public.projects where org_id=p_org_id and prospect_id=p_prospect_id;
  if linked_project_id is null then return true; end if;
  if 'project.manage'=any(denied) then return false; end if;
  select coalesce(bool_or(project_scope='assigned'),false) into assigned_only
    from public.memberships where org_id=p_org_id and user_id=actor and status='active';
  select exists(select 1 from public.project_members pm where pm.org_id=p_org_id and pm.project_id=linked_project_id and pm.user_id=actor and pm.status='active') into project_member;
  if not project_member and not (
    '*'=any(org_permissions) or 'org.admin'=any(org_permissions)
    or (not assigned_only and ('project.read'=any(org_permissions) or 'project.manage'=any(org_permissions)))
  ) then return false; end if;
  select coalesce(array_agg(distinct rp.permission_key), '{}') into project_permissions
    from public.project_members pm join public.role_permissions rp on rp.role_id=pm.role_id
    where pm.org_id=p_org_id and pm.project_id=linked_project_id and pm.user_id=actor and pm.status='active';
  return 'project.manage'=any(org_permissions || project_permissions)
    or ('*'=any(org_permissions || project_permissions) and not '*'=any(denied));
end $function$;
