-- Stage 9 (Unified MVP Gameplan): Job costing lite + AP workflow indexes
-- Focus: project-scoped list/queue queries and budget version lookups.

create index if not exists budgets_org_project_version_idx on budgets (org_id, project_id, version desc);
create index if not exists budget_lines_org_budget_cost_code_idx on budget_lines (org_id, budget_id, cost_code_id);

create index if not exists commitments_org_project_status_idx on commitments (org_id, project_id, status);

create index if not exists vendor_bills_org_project_status_due_idx on vendor_bills (org_id, project_id, status, due_date);
create index if not exists vendor_bills_org_commitment_status_idx on vendor_bills (org_id, commitment_id, status);

