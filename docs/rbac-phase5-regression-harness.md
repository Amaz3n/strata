# RBAC Phase 5 Regression Harness

Date: February 12, 2026

## Purpose

Regression harness for project-scoped RLS after Phase 5 rollout.

Goal: validate user-role x project-membership x table access matrix for read/write behavior.

## Core Matrix

Use at least these test principals in the same org:

- org owner/admin with no project membership on target project
- project PM member on target project
- project field member on target project
- tenant member with no project membership on target project

Use at least two projects in the org:

- `project_a` (member project)
- `project_b` (non-member project)

## Tables In Scope

Wave 1 direct project tables:

- `tasks`, `schedule_items`, `schedule_dependencies`, `daily_logs`, `daily_log_entries`
- `photos`, `punch_items`, `rfis`, `submittals`
- `change_orders`, `commitments`, `vendor_bills`, `invoices`, `payments`, `conversations`

Wave 2 indirect tables:

- `task_assignments`, `messages`, `mentions`, `receipts`, `rfi_responses`
- line-child tables (`invoice_lines`, `change_order_lines`, `commitment_lines`, `vendor_bill_lines` where present)

Wave 3 modules:

- `drawing_sets`, `drawing_revisions`, `drawing_sheets`, `drawing_sheet_versions`, `drawing_markups`
- `files`, `file_links`, `file_versions`
- `closeout_items`, `selection_sheets`, `selection_choices`
- `warranty_items`, `warranty_claims`
- e-sign child tables from project-scoped envelopes/documents

## SQL Harness (Supabase SQL Editor)

1. For each test user, set auth context:

```sql
-- replace with test user id
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-000000000000';
```

2. Run membership sanity checks:

```sql
select m.user_id, m.org_id, r.key as org_role, m.status
from memberships m
join roles r on r.id = m.role_id
where m.user_id = auth.uid();

select pm.user_id, pm.project_id, r.key as project_role, pm.status
from project_members pm
join roles r on r.id = pm.role_id
where pm.user_id = auth.uid();
```

3. Run read matrix checks (project A vs project B):

```sql
select 'tasks' as table_name, count(*) from tasks where project_id = '<project_a>'
union all
select 'tasks', count(*) from tasks where project_id = '<project_b>'
union all
select 'commitments', count(*) from commitments where project_id = '<project_a>'
union all
select 'commitments', count(*) from commitments where project_id = '<project_b>'
union all
select 'vendor_bills', count(*) from vendor_bills where project_id = '<project_a>'
union all
select 'vendor_bills', count(*) from vendor_bills where project_id = '<project_b>'
union all
select 'drawings', count(*) from drawing_sheets where project_id = '<project_a>'
union all
select 'drawings', count(*) from drawing_sheets where project_id = '<project_b>';
```

4. Run write matrix checks (expect allow only where member/admin policy allows):

```sql
-- example write probe; rollback after each probe block
begin;
insert into tasks (org_id, project_id, title, status)
values ('<org_id>', '<project_b>', 'RLS probe', 'todo');
rollback;
```

Repeat probe pattern for representative tables in each wave.

## Expected Outcomes

1. Non-member user:
- No access to project-scoped rows in `project_b`.
- No writes to project-scoped rows in `project_b`.

2. Project member user:
- Access only to rows for member projects.
- Writes only where role + policy allow.

3. Org owner/admin:
- Cross-project visibility preserved per rollout requirement.

4. Service role:
- Backend jobs remain functional via service-role bypass.

## Evidence Capture

- Save SQL screenshots/query history for each principal.
- Export summary table with pass/fail per table and project.
- Attach evidence to release ticket with migration versions:
  - `20260212024648_phase5_rls_project_scope_wave1`
  - `20260212025001_phase5_rls_project_scope_wave2_indirect`
  - `20260212025305_phase5_rls_project_scope_wave3_modules`
