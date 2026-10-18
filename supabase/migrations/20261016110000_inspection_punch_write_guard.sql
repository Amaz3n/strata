-- EP09-04 fix: corrective punch work linked to a failed inspection item is what gates a reinspection,
-- so a member's own data-API write can no longer close it without the authority and evidence the
-- punch service requires. Service-role and definer paths (portal completion, the raise function) pass.
create function public.punch_item_inspection_linked(p_id uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.inspection_items where punch_item_id=p_id);
$$;
revoke all on function public.punch_item_inspection_linked(uuid) from public,anon;
grant execute on function public.punch_item_inspection_linked(uuid) to authenticated;

-- Invoker function: current_user is the role that issued the statement.
create function public.guard_inspection_punch_writes() returns trigger language plpgsql set search_path='' as $$
declare closing boolean:=new.status in('closed','resolved') and old.status not in('closed','resolved');
begin
 if current_user not in('anon','authenticated') or not public.punch_item_inspection_linked(old.id) then return new; end if;
 if (new.org_id,new.project_id) is distinct from (old.org_id,old.project_id) or new.created_from_inspection is distinct from old.created_from_inspection then
  raise exception 'Corrective punch work cannot move or lose its inspection origin' using errcode='42501';
 end if;
 if (new.status,new.resolved_at,new.resolved_by,new.verified_at,new.verified_by,new.verification_required) is not distinct from (old.status,old.resolved_at,old.resolved_by,old.verified_at,old.verified_by,old.verification_required) then return new; end if;
 if not public.has_org_permission(old.org_id,'punch.write') then raise exception 'Missing permission: punch.write' using errcode='42501'; end if;
 if old.verification_required and not new.verification_required then raise exception 'Corrective punch work keeps its verification requirement' using errcode='42501'; end if;
 if closing then
  if new.resolved_by is distinct from (select auth.uid()) or new.resolved_at is null then raise exception 'Corrective punch work is resolved by the member closing it' using errcode='42501'; end if;
  if old.verification_required and old.verified_at is null and (
    new.verified_by is distinct from (select auth.uid()) or new.verified_at is null
    or not exists(select 1 from public.file_links f where f.org_id=old.org_id and f.entity_type='punch_item' and f.entity_id=old.id and f.link_role='after')) then
   raise exception 'Add verification evidence before closing this item.' using errcode='42501';
  end if;
 end if;
 return new;
end $$;
create trigger punch_item_inspection_writes before update on public.punch_items for each row execute function public.guard_inspection_punch_writes();
