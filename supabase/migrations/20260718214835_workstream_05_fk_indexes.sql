-- Workstream 05 advisor-driven FK coverage. FK columns must be the leading
-- index column; the board/scope composite indexes serve different queries.

create index if not exists projects_superintendent_fk_idx
  on public.projects (superintendent_id)
  where superintendent_id is not null;

create index if not exists start_gate_definitions_attestation_permission_fk_idx
  on public.start_gate_definitions (requires_attestation_permission)
  where requires_attestation_permission is not null;

create index if not exists start_packages_community_fk_idx
  on public.start_packages (community_id);
