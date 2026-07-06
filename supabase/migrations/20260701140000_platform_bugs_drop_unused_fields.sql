-- Drop platform bug fields that added cognitive load to the reporting UI without
-- being used: freeform area, linked page URL, labels, reporter name/email, and
-- reproduction steps. Bug reporting now relies on title, description, the
-- status/priority/severity/assignee pills, plus optional org/project context.
alter table public.platform_bugs
  drop column if exists area,
  drop column if exists url,
  drop column if exists labels,
  drop column if exists reporter_name,
  drop column if exists reporter_email,
  drop column if exists reproduction_steps;
