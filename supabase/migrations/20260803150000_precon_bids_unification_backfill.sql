-- Precon bids unification: retire the prospect-scoped bids surface.
--
-- Every open prospect with homeless precon artifacts (bid packages or
-- estimates carrying prospect_id but no project_id) gets its precon-phase
-- project, and the artifacts are stamped onto it. After this backfill no
-- artifact is project-less, so the legacy /pipeline/prospects/*/bids pages
-- become pure redirects and the project-side OR-branch that tolerated
-- null-project packages is deleted from code.

with candidates as (
  select
    p.id as prospect_id,
    p.org_id,
    p.name,
    p.notes,
    p.jobsite_location,
    case
      when p.project_type in ('new_construction', 'remodel', 'addition', 'renovation', 'repair')
        then p.project_type
      else null
    end as project_type,
    p.created_by
  from public.prospects p
  where p.status not in ('won', 'lost')
    and not exists (select 1 from public.projects pr where pr.prospect_id = p.id)
    and (
      exists (select 1 from public.bid_packages bp where bp.prospect_id = p.id and bp.project_id is null)
      or exists (select 1 from public.estimates e where e.prospect_id = p.id and e.project_id is null)
    )
)
insert into public.projects (org_id, name, status, phase, location, project_type, description, prospect_id, created_by)
select org_id, name, 'planning', 'precon', jobsite_location, project_type, notes, prospect_id, created_by
from candidates;

-- Stamp homeless artifacts onto their prospect's project (whatever its phase:
-- precon workspaces just created, or delivery projects from past conversions
-- whose re-parenting missed rows).
update public.bid_packages bp
set project_id = pr.id, updated_at = now()
from public.projects pr
where pr.prospect_id = bp.prospect_id
  and bp.project_id is null;

update public.estimates e
set project_id = pr.id, updated_at = now()
from public.projects pr
where pr.prospect_id = e.prospect_id
  and e.project_id is null;
