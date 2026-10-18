-- EP07 final review: the legacy gate marker and the cutover marker.
--
-- 1. metadata.gate_rules_legacy marks a package that was releasing or in attention
--    when 20261014194000 ran. It is dropped on ANY status change whose old status
--    is not releasing or attention (so a privileged writer cannot carry it into a
--    fresh queue from open or ready), and whenever the package leaves releasing
--    and attention. The "waived without a reason" arm of the legacy rule is gone:
--    start_package_gate_waiver_reason already forbids that state. The not
--    applicable arm stays.
-- 2. starts_cutover_ready() also proves 20261014196000 (a reservation is released
--    only once it is two minutes old) and this migration (the strip). It stays
--    false unless every EP07 migration from 100000 shows its mark. When a later
--    EP07 migration is added, add its mark here, in a new file.

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
            or g.status='waived'
            or (g.status='not_applicable' and (p_legacy or (d.applies_when in ('financed_only','purchasing_enabled') and (d.applies_when='purchasing_enabled' or not p_package.is_financed))))
            or (g.status='pending' and d.applies_when='financed_only' and not p_package.is_financed)))
    order by d.sort_order,d.key limit 1;
  if v_key is not null then
    raise exception 'Release completion is not proven for the % gate',v_key using errcode='40001'; end if;
end $$;

create or replace function public.guard_start_package_gate_completion() returns trigger
language plpgsql set search_path=public,pg_catalog as $$
declare v_legacy boolean:=coalesce((old.metadata->>'gate_rules_legacy')::boolean,false) and old.status in ('releasing','attention');
  v_strip boolean;
begin
  if new.status is distinct from old.status then
    if new.status in ('releasing','released') then
      perform public.assert_start_gates_complete(new,new.status='released',old.status in ('open','ready'),v_legacy);
    end if;
    v_strip:=old.status not in ('releasing','attention') or new.status not in ('releasing','attention');
    if v_strip and new.metadata ? 'gate_rules_legacy' then
      new.metadata:=new.metadata-'gate_rules_legacy';
    end if;
  end if;
  return new;
end $$;

create or replace function public.starts_cutover_ready()
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce(
        to_regclass('public.release_throughput_targets') is not null            -- 100000
    and to_regclass('public.trade_notice_deliveries') is not null               -- 110000
    and to_regclass('public.trade_work_responses') is not null                  -- 120000
    and to_regprocedure('public.settle_release_step(uuid,bigint,uuid,text,jsonb,integer,uuid)') is not null -- 130000
    and to_regproc('public.guard_plan_drawing_copy_manifest_browser_writes') is not null -- 140000
    and exists (select 1 from pg_trigger where tgname = 'start_packages_financing_flip' and not tgisinternal) -- 150000
    and exists (select 1 from pg_trigger where tgname = 'schedule_assignments_consistency' and not tgisinternal) -- 160000
    and strpos(pg_get_functiondef(to_regprocedure('public.read_trade_lookahead_workspace(uuid,uuid,integer,uuid,uuid,text,integer,text,integer)')),
      'another home or organization') = 0                                       -- 165000 dropped this raise
    and to_regproc('public.guard_release_key_browser_writes') is not null       -- 170000
    and strpos(pg_get_functiondef(to_regproc('public.guard_plan_drawing_copy_manifest_browser_writes')),
      'new.metadata->''plan_instantiation'' is distinct') > 0                   -- 180000
    and strpos(pg_get_functiondef(to_regproc('public.tg_start_package_financing_flip')), 'v_reopened') > 0 -- 190000
    and strpos(pg_get_functiondef(to_regprocedure('public.apply_schedule_reschedule(uuid,uuid,jsonb,text,jsonb,uuid)')), 'starts_actor_reaches_division') > 0 -- 191000
    and to_regproc('public.stamp_release_versions') is not null
    and exists (select 1 from pg_trigger where tgname = 'start_packages_gate_completion_guard' and not tgisinternal) -- 192000
    and strpos(pg_get_functiondef(to_regprocedure('public.reserve_plan_drawing_copy(uuid,uuid,uuid,uuid,jsonb)')), 'plan_drawing_copy.source_changed') > 0 -- 193000
    and to_regprocedure('public.assert_start_gates_complete(public.start_packages,boolean,boolean,boolean)') is not null -- 194000 (the four-argument gate check)
    and strpos(pg_get_functiondef(to_regprocedure('public.reserve_plan_drawing_copy(uuid,uuid,uuid,uuid,jsonb)')), 'interval ''2 minutes''') > 0 -- 196000 (only a stale reservation is released)
    and strpos(pg_get_functiondef(to_regproc('public.guard_start_package_gate_completion')), 'v_strip') > 0, -- 197000 (the legacy marker never outlives its release)
    false)
$$;

revoke all on function public.starts_cutover_ready() from public, anon, authenticated;
grant execute on function public.starts_cutover_ready() to service_role;
