-- EP07 review round 2: release safety.
--
-- 1. Gate completion is a database rule, not only a service check. A package
--    cannot enter `releasing` unless every active gate the coordinator answers
--    for is passed, waived with a reason, or does not apply to it, and cannot
--    become `released` unless every active gate (the two the release produces
--    included) is. The check is a trigger on the package's status, so it holds
--    for queue_start_release, retry_start_release and publish_start_release
--    whatever a later function body says, in the transaction that moves the
--    package. A gate that does not apply is accepted as such only when its own
--    rule says so: a financing gate for a cash buyer, a purchasing gate (the
--    desk marks those from the community's price book).
-- 2. Release keys written before generated rows carried a plan version
--    (release_key but no release_version) are stamped with the version the
--    home's lot is pinned to. The stamp is explicit and one-time, so resume stays
--    strict: a keyed row of any other version, or none, is never adopted. The
--    function stays as the repair for any home found in that state.
-- No new permission key and no new table.

create function public.assert_start_gates_complete(p_package public.start_packages,p_include_produced boolean)
returns void language plpgsql set search_path=public,pg_catalog as $$
declare v_key text;
begin
  select d.key into v_key from public.start_gate_definitions d
    where d.org_id=p_package.org_id and d.is_active and (p_include_produced or d.key not in ('budget','po_set'))
      and not exists(select 1 from public.start_package_gates g
        where g.org_id=d.org_id and g.start_package_id=p_package.id and g.gate_definition_id=d.id
          and (g.status='passed'
            or (g.status='waived' and length(btrim(coalesce(g.waived_reason,'')))>=10)
            or (g.status='not_applicable' and d.applies_when in ('financed_only','purchasing_enabled') and (d.applies_when='purchasing_enabled' or not p_package.is_financed))
            or (g.status='pending' and d.applies_when='financed_only' and not p_package.is_financed)))
    order by d.sort_order,d.key limit 1;
  if v_key is not null then
    raise exception 'Release completion is not proven for the % gate',v_key using errcode='40001'; end if;
end $$;
revoke all on function public.assert_start_gates_complete(public.start_packages,boolean) from public,anon,authenticated;

create function public.guard_start_package_gate_completion() returns trigger
language plpgsql set search_path=public,pg_catalog as $$
begin
  if new.status is distinct from old.status and new.status in ('releasing','released') then
    perform public.assert_start_gates_complete(new,new.status='released');
  end if;
  return new;
end $$;
revoke all on function public.guard_start_package_gate_completion() from public,anon,authenticated;
create trigger start_packages_gate_completion_guard before update of status on public.start_packages
  for each row execute function public.guard_start_package_gate_completion();

create function public.stamp_release_versions(p_org_id uuid default null)
returns jsonb language plpgsql set search_path=public,pg_catalog as $$
declare v_budgets integer; v_items integer; v_inspections integer;
begin
  if current_user in ('anon','authenticated') then raise exception 'Release versions are stamped by the server' using errcode='42501'; end if;
  update public.budgets b set metadata=b.metadata||jsonb_build_object('release_version',l.house_plan_version_id)
    from public.lots l where l.project_id=b.project_id and l.org_id=b.org_id and l.house_plan_version_id is not null
      and b.metadata ? 'release_key' and not (b.metadata ? 'release_version') and (p_org_id is null or b.org_id=p_org_id);
  get diagnostics v_budgets=row_count;
  update public.schedule_items s set metadata=s.metadata||jsonb_build_object('release_version',l.house_plan_version_id)
    from public.lots l where l.project_id=s.project_id and l.org_id=s.org_id and l.house_plan_version_id is not null
      and s.metadata ? 'release_key' and not (s.metadata ? 'release_version') and (p_org_id is null or s.org_id=p_org_id);
  get diagnostics v_items=row_count;
  update public.inspections i set metadata=i.metadata||jsonb_build_object('release_version',l.house_plan_version_id)
    from public.lots l where l.project_id=i.project_id and l.org_id=i.org_id and l.house_plan_version_id is not null
      and i.metadata ? 'release_key' and not (i.metadata ? 'release_version') and (p_org_id is null or i.org_id=p_org_id);
  get diagnostics v_inspections=row_count;
  return jsonb_build_object('budgets',v_budgets,'schedule_items',v_items,'inspections',v_inspections);
end $$;
revoke all on function public.stamp_release_versions(uuid) from public,anon,authenticated;
grant execute on function public.stamp_release_versions(uuid) to service_role;

select public.stamp_release_versions();
