-- Defense in depth for direct Data API writes. Keep the pipeline readable to
-- organization members, but use the same project/manage boundary as the server.
-- The private helper must see a linked project even when project RLS hides it.
create schema if not exists arc_private;
revoke all on schema arc_private from public, anon;
grant usage on schema arc_private to authenticated, service_role;

create or replace function arc_private.can_write_deal(p_org_id uuid, p_prospect_id uuid)
returns boolean language plpgsql stable security definer set search_path = '' as $$
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
end $$;
revoke all on function arc_private.can_write_deal(uuid,uuid) from public, anon;
grant execute on function arc_private.can_write_deal(uuid,uuid) to authenticated, service_role;

drop policy if exists prospects_access on public.prospects;
create policy prospects_read on public.prospects for select to authenticated using (public.is_org_member(org_id));
create policy prospects_insert on public.prospects for insert to authenticated with check (arc_private.can_write_deal(org_id,id));
create policy prospects_update on public.prospects for update to authenticated
  using (arc_private.can_write_deal(org_id,id)) with check (arc_private.can_write_deal(org_id,id));
create policy prospects_delete on public.prospects for delete to authenticated using (arc_private.can_write_deal(org_id,id));

drop policy if exists prospect_contacts_access on public.prospect_contacts;
create policy prospect_contacts_read on public.prospect_contacts for select to authenticated using (public.is_org_member(org_id));
create policy prospect_contacts_insert on public.prospect_contacts for insert to authenticated with check (arc_private.can_write_deal(org_id,prospect_id));
create policy prospect_contacts_update on public.prospect_contacts for update to authenticated
  using (arc_private.can_write_deal(org_id,prospect_id)) with check (arc_private.can_write_deal(org_id,prospect_id));
create policy prospect_contacts_delete on public.prospect_contacts for delete to authenticated using (arc_private.can_write_deal(org_id,prospect_id));
revoke all on public.prospects, public.prospect_contacts from anon;

create or replace function arc_private.guard_deal_mutation()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  tenant uuid;
  prospect uuid;
  deal_status text;
  delivery boolean;
begin
  -- Server-only lifecycle transactions already authorize their actor. Do not
  -- block signature workers, conversion, contact promotion, or migrations.
  if current_setting('role',true) in ('service_role','none') then
    if tg_op='DELETE' then return old; else return new; end if;
  end if;
  tenant := case when tg_op='DELETE' then old.org_id else new.org_id end;
  if tg_op='UPDATE' and (new.org_id is distinct from old.org_id or new.id is distinct from old.id) then
    raise exception 'Deal identity cannot be changed';
  end if;
  if tg_table_name='prospect_contacts' then
    prospect := case when tg_op='DELETE' then old.prospect_id else new.prospect_id end;
    if tg_op='UPDATE' and new.prospect_id is distinct from old.prospect_id then raise exception 'Contact cannot be moved to another deal'; end if;
    select status::text into deal_status from public.prospects where id=prospect and org_id=tenant;
    if not found then
      -- The parent guard and RLS already authorized an ON DELETE CASCADE.
      if tg_op='DELETE' and pg_trigger_depth()>1 then return old; end if;
      raise exception 'Prospect not found';
    end if;
  else
    prospect := case when tg_op='DELETE' then old.id else new.id end;
    deal_status := case when tg_op='INSERT' then new.status::text else old.status::text end;
  end if;
  if not arc_private.can_write_deal(tenant,prospect) then raise exception 'Missing permission to edit this deal' using errcode='42501'; end if;
  select exists(select 1 from public.projects where org_id=tenant and prospect_id=prospect and phase='delivery') into delivery;
  if deal_status='won' or delivery then raise exception 'This deal is closed. Manage the active project instead.'; end if;
  if deal_status='lost' then
    if tg_table_name='prospects' and tg_op='UPDATE' then
      if new.status::text='contacted' and new.lost_reason is null
        and (to_jsonb(new)-array['status','lost_reason','lost_at','won_at','updated_at']) = (to_jsonb(old)-array['status','lost_reason','lost_at','won_at','updated_at']) then
        return new;
      end if;
    end if;
    raise exception 'Reopen this deal before editing it';
  end if;
  if tg_table_name='prospects' and tg_op<>'DELETE' then
    if new.owner_user_id is not null and (tg_op='INSERT' or new.owner_user_id is distinct from old.owner_user_id)
      and not exists(select 1 from public.memberships where org_id=tenant and user_id=new.owner_user_id and status='active') then
      raise exception 'Choose an active team member';
    end if;
  end if;
  if tg_op='DELETE' then return old; else return new; end if;
end $$;
revoke all on function arc_private.guard_deal_mutation() from public, anon, authenticated;
create trigger prospects_guard_mutation before insert or update or delete on public.prospects
  for each row execute function arc_private.guard_deal_mutation();
create trigger prospect_contacts_guard_mutation before insert or update or delete on public.prospect_contacts
  for each row execute function arc_private.guard_deal_mutation();
