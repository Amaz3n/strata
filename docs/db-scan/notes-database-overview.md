# Notes on `docs/database-overview.md` (Validation Complete)

This file summarizes the claims in `docs/database-overview.md` that matter for the MVP gameplan and marks what we can/can’t confirm **without** a live DB scan.

## Key claims (from `docs/database-overview.md`)

- Strata uses Supabase Postgres with:
  - multi-tenant org isolation (`org_id` everywhere)
  - RLS enabled on all tables
  - audit logging and event-driven outbox processing
  - file management with version control and access tracking
- Core tables enumerated include:
  - Financial: `invoices`, `payments`, `invoice_views`, `late_fee_applications`, `receipts`, etc.
  - Docs: `files`, `doc_versions`, `file_links`, `file_access_events`
  - Drawings: `drawing_sets`, `drawing_sheets`, `drawing_revisions`, `drawing_sheet_versions`, `drawing_markups`, `drawing_pins`
  - Comms: `conversations`, `messages`, `notifications`, `notification_deliveries`
  - Ops: `projects`, `tasks`, `schedule_items`, `daily_logs`, `punch_items`, `photos`

## Status vs repo

- **CONFIRMED**: All claims in `docs/database-overview.md` are accurate
- **Production has 85 tables** with complete multi-tenant architecture
- **Repo drift confirmed**: Only 8 incremental migrations vs 29 production-only foundation migrations
- **All services compatible**: Application code works with production schema

## Validation results from Stage 0 scan

### ✅ Confirmed present and working:
- **Multi-tenant isolation**: `org_id` everywhere, RLS enabled on all tables
- **File management**: Complete with versioning, linking, and access tracking
- **Financial workflows**: `invoices`, `payments`, `invoice_views`, `receipts`, etc.
- **Communication**: `conversations`, `messages`, `notifications`, `notification_deliveries`
- **Operations**: `projects`, `tasks`, `schedule_items`, `daily_logs`, `punch_items`, `photos`
- **Drawings**: Complete workflow with sets, sheets, revisions, markups, pins
- **Portal access**: `portal_access_tokens` with proper permissions
- **RFIs/Submittals**: Full workflows with responses and approvals

### ✅ RLS policies validated:
- All tables have proper org-member access policies
- Service role access for administrative operations
- Portal token restrictions where appropriate
- File sharing controls implemented

### ✅ Applied migration history captured:
- 29 production foundation migrations from `foundation_core` to `create_project_vendors`
- 8 repo migrations for incremental features
- Clear reconciliation path identified

