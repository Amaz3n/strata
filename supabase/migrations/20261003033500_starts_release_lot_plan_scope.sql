-- STAGED, UNAPPLIED. Plan posture is pinned on the lot, not the start package.
create function public.starts_release_plan_version(p_package public.start_packages) returns uuid
language plpgsql set search_path=public,pg_catalog as $$
declare v_plan uuid;
begin
 select house_plan_version_id into v_plan from public.lots where org_id=p_package.org_id and id=p_package.lot_id
   and community_id=p_package.community_id and project_id=p_package.project_id for share;
 if not found or v_plan is null then raise exception 'Starts lot has no matching pinned plan scope' using errcode='42501'; end if;
 return v_plan;
end $$;
revoke all on function public.starts_release_plan_version(public.start_packages) from public,anon,authenticated;
grant execute on function public.starts_release_plan_version(public.start_packages) to service_role;
