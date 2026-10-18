-- Schema marker: 20261014194000 joins the chain it proves.
--
-- starts_cutover_ready() (last written in 20261014193000) is true only when every
-- EP07 migration shows its mark; this adds the four-argument
-- assert_start_gates_complete that 20261014194000 introduced. When a later EP07
-- migration is added, add its mark here, in a new file.

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
    and to_regprocedure('public.assert_start_gates_complete(public.start_packages,boolean,boolean,boolean)') is not null, -- 194000 (the four-argument gate check)
    false)
$$;

revoke all on function public.starts_cutover_ready() from public, anon, authenticated;
grant execute on function public.starts_cutover_ready() to service_role;
