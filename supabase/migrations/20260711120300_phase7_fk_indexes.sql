-- Workstream 07 follow-up: standalone indexes for foreign-key maintenance paths.

create index if not exists budget_transfer_lines_transfer_idx
  on public.budget_transfer_lines (transfer_id);
create index if not exists budget_transfers_requested_by_idx
  on public.budget_transfers (requested_by) where requested_by is not null;
create index if not exists budget_transfers_approved_by_idx
  on public.budget_transfers (approved_by) where approved_by is not null;
create index if not exists budget_transfers_revision_idx
  on public.budget_transfers (budget_revision_id) where budget_revision_id is not null;

create index if not exists prequalifications_company_idx
  on public.prequalifications (company_id);
create index if not exists prequalifications_requested_by_idx
  on public.prequalifications (requested_by) where requested_by is not null;
create index if not exists prequalifications_reviewed_by_idx
  on public.prequalifications (reviewed_by) where reviewed_by is not null;
