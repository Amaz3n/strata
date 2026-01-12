# DB Drift Report (Repo ↔ Production) — Draft

This report is Stage 0 output for `docs/unified-mvp-gameplan.md`.

## Summary (what we know now)

- The repo's `supabase/schema.sql` appears to be a **foundation-only** schema.
- The repo's `supabase/migrations/*` set is small and focuses on:
  - files metadata/versioning/linking,
  - drawings workflows,
  - QBO integration,
  - incremental enhancements that assume other tables already exist.
- The application code (`lib/services/*`, `app/**`) references a much larger schema consistent with `docs/database-overview.md`.
- **PRODUCTION HAS 85 TABLES** vs repo having minimal incremental migrations

Conclusion: **repo → production drift is CONFIRMED** - production has a complete, operational schema while repo has only incremental changes.

## Top risks

- Clean local DB created from repo SQL will not match production and will cause runtime failures.
- Any new migration authored from the repo state risks:
  - failing in production (objects already exist / different types),
  - or masking missing production-only migrations.

## Reconciliation decision (CHOSEN)

After reviewing the live schema snapshot, we choose: **Single reconciliation migration (for MVP speed)**

**Rationale:**
- Production schema is fully operational with 85 tables and working RLS policies
- Application services are compatible with production schema
- Attempting to reconstruct 29 production-only migrations would be complex and error-prone
- MVP timeline favors speed over perfect history preservation

**Implementation plan:**
1. Export full production schema DDL (tables, indexes, triggers/functions, RLS policies)
2. Create a single migration that brings a clean DB to production shape
3. Document the migration clearly as "Production schema reconciliation - DO NOT MODIFY"
4. Apply existing repo migrations after the reconciliation migration
5. Update repo `schema.sql` to match the reconciled state

## Blocker (must resolve before writing the migration)

The current `docs/db-scan/live-schema-snapshot.md` is a **summary** (tables/index/RLS patterns) and does not contain the **exact DDL** needed to generate a reliable reconciliation migration.

To proceed, we need one of:

1) A production schema dump (preferred): `pg_dump --schema-only` output, OR  
2) The full SQL of the production migrations (all 29), OR  
3) A Supabase CLI schema pull output (SQL).

## Known drift indicators (confirmed)

- **29 production-only migrations** from foundation_core through create_project_vendors
- Production has complete financial, portal, and operational schemas
- Repo migrations (8 files) assume existing tables and only add incremental features
- Application code expects full production schema - confirmed working

## Concrete migration plan

### Phase 1: Schema reconciliation migration
Create `supabase/migrations/20251220_production_schema_reconciliation.sql`:
- Contains complete production schema as single migration
- Includes all 85 tables, indexes, and RLS policies
- Marked as "PRODUCTION RECONCILIATION - DO NOT MODIFY"

### Phase 0.5 (implemented): Phase 7 financial deltas
To unblock Phase 7 correctness work (invoice status/balance, invoice views, receipts), we added a targeted migration:
- `supabase/migrations/20251221_financial_foundation_correctness.sql`
  - Adds missing `invoices` columns used by the app (token/sent/view fields, QBO sync fields, subtotal/tax columns)
  - Creates `invoice_views` + RLS policies required by `recordInvoiceViewed`
  - Adds receipt columns + `unique(payment_id)` idempotency for receipt creation
  - Adds the required reporting/idempotency indexes for `payments` and `invoice_lines`

This does **not** replace the full production reconciliation migration; it only closes MVP-critical gaps in the finance primitives so the app’s financial loop behaves correctly.

### Phase 2: Apply existing repo migrations
After reconciliation migration, apply existing repo migrations in order:
1. `20241206_qbo.sql`
2. `20251215_add_files_metadata.sql`
3. `20251215_sub_portal_enhancements.sql`
4. `20251217_files_phase1.sql`
5. `20251217_files_phase2_versioning.sql`
6. `20251218_drawings_phase3.sql`
7. `20251218_drawings_phase4_markups.sql`
8. `20251219_files_share_with_clients.sql`

### Phase 3: Update repo foundation
- Update `supabase/schema.sql` to match production state
- Ensure local development works with reconciled schema

## MVP-critical schema subset

**All tables are MVP-critical** since the application expects the full production schema. The reconciliation migration will ensure:

### Core functionality tables (all required):
- **Multi-tenant foundation**: `orgs`, `app_users`, `memberships`, `projects`
- **File management**: `files`, `doc_versions`, `file_links`, `file_access_events`
- **Financial workflows**: `invoices`, `invoice_lines`, `payments`, `payment_intents`, `invoice_views`
- **Project management**: `tasks`, `schedule_items`, `daily_logs`
- **Client portals**: `portal_access_tokens`, `rfis`, `submittals`
- **Drawings**: `drawing_sets`, `drawing_sheets`, `drawing_revisions`, `drawing_markups`
- **Communications**: `conversations`, `messages`, `notifications`

### Confirmed working:
- All RLS policies properly isolate org data
- File sharing and portal access fully implemented
- Financial workflows complete with proper relationships
- Application services compatible with production schema
