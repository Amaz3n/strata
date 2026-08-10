-- Precon-phase projects (Option B of the precon overhaul).
--
-- A prospect that enters pricing gets a real project in phase 'precon' so
-- drawings, takeoff, bids, and estimates attach natively. Precon projects are
-- excluded from every project-enumerating surface by default; winning the job
-- flips the phase to 'delivery' instead of creating + re-parenting a project.

alter table public.projects
  add column if not exists phase text not null default 'delivery';

alter table public.projects
  add constraint projects_phase_chk check (phase in ('precon', 'delivery'));

-- Lists exclude precon rows by default; keep that predicate cheap per org.
create index if not exists projects_org_phase_precon_idx
  on public.projects (org_id)
  where phase = 'precon';
