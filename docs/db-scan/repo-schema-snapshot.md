# Repo Schema Snapshot

Source of truth for this snapshot:

- `supabase/schema.sql`
- `supabase/migrations/*`

This snapshot exists to support Stage 0 drift reconciliation in `docs/unified-mvp-gameplan.md`.

## What’s in the repo today

### `supabase/schema.sql`

`supabase/schema.sql` is a **foundation schema** (extensions, enums, and scaffolding) and does **not** appear to define the full Strata application schema described in `docs/database-overview.md`.

Notably missing (based on repo search + runtime code usage):

- `projects`, `tasks`, `daily_logs`, `schedule_items`
- `rfis`, `rfi_responses`
- `submittals`, `submittal_items`
- `invoices`, `payments`, `invoice_lines`, `invoice_views`, `receipts`
- `conversations`, `messages`, `notifications`
- and many more tables enumerated in `docs/database-overview.md`

### `supabase/migrations/*`

Current migration files (in repo):

- `20241206_qbo.sql`
- `20251215_add_files_metadata.sql`
- `20251215_sub_portal_enhancements.sql`
- `20251217_files_phase1.sql`
- `20251217_files_phase2_versioning.sql`
- `20251218_drawings_phase3.sql`
- `20251218_drawings_phase4_markups.sql`
- `20251219_files_share_with_clients.sql`

These migrations primarily cover:

- QuickBooks integration tables/workflows
- Files metadata + linking + versioning
- Drawings workflows (sets/sheets/revisions/markups/pins)
- Sub-portal enhancements (adds columns/indexes to existing `rfis`/`submittals`, implying those tables exist in production)

## High-confidence repo ↔ app mismatch

The application code under `lib/services/*` and routes under `app/**` assume the existence of many tables that are **not created** by the repo’s `supabase/schema.sql` + migrations.

This aligns with the “repo ↔ production drift” called out in `docs/unified-mvp-gameplan.md`.

## Next step

Once `docs/db-scan/live-schema-snapshot.md` is filled, produce `docs/db-scan/drift-report.md` with a concrete reconciliation strategy:

- Port missing production migrations into the repo (preferred), or
- Create a minimal reconciliation migration that brings a clean DB up to the production shape required for the MVP.

