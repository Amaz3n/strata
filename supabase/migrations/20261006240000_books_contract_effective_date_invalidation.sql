-- A contract taking effect changes how its project's documents post, with no edit.
--
-- A project's revenue basis comes from the primary contracts in effect today
-- (resolveProjectRevenueBasis). Editing a contract touches the project's sources
-- (20261006175218), but a contract dated in the future changes the basis on the
-- morning its effective date arrives, and nothing moved the sources: they kept
-- reading "posted" under the old basis until the nightly pass. Each ordinary run
-- now touches the sources of projects whose primary contract took effect since
-- its previous read, so they re-post on that run.

create or replace function public.books_touch_sources_for_effective_contracts(p_org_id uuid, p_after date, p_through date)
returns integer language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  project uuid;
  touched integer := 0;
begin
  if p_after is null or p_through is null or p_after >= p_through then return 0; end if;
  for project in
    select distinct contract.project_id from public.contracts contract
    where contract.org_id = p_org_id and contract.parent_contract_id is null and contract.project_id is not null
      and contract.effective_date > p_after and contract.effective_date <= p_through
  loop
    perform public.books_touch_project_sources(p_org_id, project);
    touched := touched + 1;
  end loop;
  return touched;
end;
$$;
revoke all on function public.books_touch_sources_for_effective_contracts(uuid, date, date) from public, anon, authenticated;
grant execute on function public.books_touch_sources_for_effective_contracts(uuid, date, date) to service_role;
