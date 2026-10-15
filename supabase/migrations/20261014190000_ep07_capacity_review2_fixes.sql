-- EP07 review round 2 (gates and capacity).
--
-- Flipping is_financed on an open or ready package reopened its financing gate
-- (20261014150000) but left the package `ready`, so queue_start_release still
-- accepted it. The gate and the package now move together: a ready package whose
-- financing gate reopens drops back to `open` in the same statement, so the queue
-- refuses it as not ready and only a refresh that proves the financing makes it
-- ready again. The other order needs no more: a queued release has taken the
-- package lock and left `ready`, so the edit is refused as not editable.

create or replace function public.tg_start_package_financing_flip()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_reopened integer;
begin
  if new.is_financed is distinct from old.is_financed and new.status in ('open', 'ready') then
    update public.start_package_gates g set status = 'pending', passed_via = null
    from public.start_gate_definitions d
    where d.id = g.gate_definition_id and d.org_id = g.org_id and g.org_id = new.org_id and g.start_package_id = new.id
      and d.auto_source = 'agreement_milestones_clear' and g.status = 'passed';
    get diagnostics v_reopened = row_count;
    if v_reopened > 0 and new.status = 'ready' then
      update public.start_packages set status = 'open' where org_id = new.org_id and id = new.id and status = 'ready';
    end if;
  end if;
  return null;
end;
$$;

revoke all on function public.tg_start_package_financing_flip() from public, anon, authenticated;
