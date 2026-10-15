-- EP07 review 3: gate completion for releases already in flight.
--
-- The gate-completion trigger (20261014192000) must not strand a release that was
-- legitimately under way before it:
--
-- 1. A gate definition activated after a package was queued reaches only open
--    and ready packages. A release judges the gate rows the package actually
--    has: a definition with no row blocks only the move out of open or ready
--    (the queue), never a retry from attention or the publication. Judging the
--    rows it has is the safer choice over fanning the new gate into a releasing
--    package: a gate row added mid-release could never be answered (gates are
--    frozen once a release begins), so it would block the very package it was
--    meant to protect.
-- 2. A package that was releasing or in attention when this migration ran carries
--    metadata.gate_rules_legacy. Its gate rows were written before a financing
--    gate for a cash buyer had to be proven, so the publication accepts a gate
--    marked not applicable or waived without the newer reason rule for it; only
--    a gate still pending blocks it. The marker is dropped when the package
--    leaves releasing for ready, open, cancelled or released, so a release that is
--    cancelled and queued again is judged by today's rules.

create or replace function public.assert_start_gates_complete(p_package public.start_packages,p_include_produced boolean,
  p_require_rows boolean,p_legacy boolean)
returns void language plpgsql set search_path=public,pg_catalog as $$
declare v_key text;
begin
  select d.key into v_key from public.start_gate_definitions d
    where d.org_id=p_package.org_id and d.is_active and (p_include_produced or d.key not in ('budget','po_set'))
      and (p_require_rows or exists(select 1 from public.start_package_gates g
        where g.org_id=d.org_id and g.start_package_id=p_package.id and g.gate_definition_id=d.id))
      and not exists(select 1 from public.start_package_gates g
        where g.org_id=d.org_id and g.start_package_id=p_package.id and g.gate_definition_id=d.id
          and (g.status='passed'
            or (g.status='waived' and (p_legacy or length(btrim(coalesce(g.waived_reason,'')))>=10))
            or (g.status='not_applicable' and (p_legacy or (d.applies_when in ('financed_only','purchasing_enabled') and (d.applies_when='purchasing_enabled' or not p_package.is_financed))))
            or (g.status='pending' and d.applies_when='financed_only' and not p_package.is_financed)))
    order by d.sort_order,d.key limit 1;
  if v_key is not null then
    raise exception 'Release completion is not proven for the % gate',v_key using errcode='40001'; end if;
end $$;
revoke all on function public.assert_start_gates_complete(public.start_packages,boolean,boolean,boolean) from public,anon,authenticated;
drop function public.assert_start_gates_complete(public.start_packages,boolean);

create or replace function public.guard_start_package_gate_completion() returns trigger
language plpgsql set search_path=public,pg_catalog as $$
declare v_legacy boolean:=coalesce((old.metadata->>'gate_rules_legacy')::boolean,false);
begin
  if new.status is distinct from old.status then
    if new.status in ('releasing','released') then
      perform public.assert_start_gates_complete(new,new.status='released',old.status in ('open','ready'),v_legacy and old.status in ('releasing','attention'));
    end if;
    if new.status<>'releasing' and new.status<>'attention' and new.metadata ? 'gate_rules_legacy' then
      new.metadata:=new.metadata-'gate_rules_legacy';
    end if;
  end if;
  return new;
end $$;

update public.start_packages set metadata=coalesce(metadata,'{}')||'{"gate_rules_legacy":true}'::jsonb
  where status in ('releasing','attention');
