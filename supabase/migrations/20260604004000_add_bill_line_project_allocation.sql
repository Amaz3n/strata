-- Multi-project payables:
-- a single vendor bill can allocate its lines across multiple projects.
-- Each bill_line gains an optional project_id; the bill's own project_id stays
-- the primary/home project and the fallback when a line is untagged.

alter table public.bill_lines
  add column if not exists project_id uuid references public.projects(id) on delete set null;

-- Backfill existing lines to their parent bill's project so cost attribution
-- (which now reads line.project_id) is unchanged for single-project bills.
update public.bill_lines bl
set project_id = vb.project_id
from public.vendor_bills vb
where bl.bill_id = vb.id
  and bl.project_id is null;

create index if not exists bill_lines_org_project_idx
  on public.bill_lines (org_id, project_id)
  where project_id is not null;
