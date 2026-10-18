# Unified reporting workspace

Reports is the home for operational reporting and Arc Books financial statements. `/books/statements` redirects to the statements collection. Books remains the accounting workspace; reporting is accessed through Reports.

## Terms

A report is a live query and its saved presentation settings. A snapshot preserves evaluated numbers and presentation at a particular time. Legacy packets are ordered documents containing multiple saved reports. Packet creation and dedicated navigation have been retired.

## Product behavior

- Financial statements require Arc Books to be enabled and the statement's Books permission. Arc does not fetch financial reports from QuickBooks or other accounting providers.
- Project and operational reports remain available independently of Books. Existing report-specific financial and project permissions still apply.
- Build a report opens a searchable starting-report chooser with a report name, then opens its live customization workspace. Save report persists the resulting configuration. The library keeps navigation and search outside the scrolling report list.
- Column headings toggle ascending/descending sorting. Sorting is part of the saved layout and exports. Financial sections and totals stay in place while their detail rows sort.
- A/R aging defaults to one row per client and columns for Current, 1–30, 31–60, 61–90, 90+, No due date, and Total. Project summary and open-invoice detail views are available; summary rows expand to source invoices. Client IDs prevent different clients with the same name from being merged when identity is available.
- The library includes templates, private saved reports, favorites, and preserved snapshots. Existing saved packets remain available under My reports (and Favorites when marked), with their direct links and historical snapshots preserved. Team visibility never bypasses report or project authorization.
- The live workspace supports date presets/custom ranges, saved organizational scope, report-specific filters, column visibility/order/labels, sorting, two-level grouping, zero suppression, computed sums/differences/ratios, charts, multiple transaction filters, and undo/redo. Report controls use shadcn Select and calendar popovers. Commentary, section-note, and manual page-break controls are omitted.
- P&L supports monthly columns, prior-period/prior-year comparison, account and operational dimensions, project expansion, and full account transaction reports. Account labels and current, monthly, and comparison amounts open a transaction report carrying the clicked dates and project scope. The transaction report supports date changes, added columns (including memo, entry kind, and account balance), numeric/text filters, grouping, calculations, source-record links, and CSV export. Returning to the statement retains its working configuration. Monthly account columns are limited to 24 months. Each monthly drilldown uses its own date window. Operating P&L activity excludes closing entries and their reversals.
- Accounting statement categories and authoritative totals are protected. Users can rename rows and arrange presentation groups within existing categories, and hide zero accounts, but cannot arbitrarily filter away nonzero statement accounts or change the underlying accounting calculations.
- Legacy report packets contain up to 12 saved reports in a chosen order. Members retain their own date/scope/layout and source labels. Packets cannot contain packets.
- PDF, CSV, and JSON use the same customized result as the preview. PDF supports charts, notes, section breaks, and horizontal panels for wide monthly tables. CSV protects textual cells against spreadsheet formula injection.
- A snapshot freezes evaluated values and presentation. The server re-evaluates and compares a preview fingerprint before capture; changed source data requires refreshing the preview. Historical snapshots disable live account drilldowns. Opening a live version carries the captured report settings forward.

The library starts with search and creation actions. Report navigation uses app-header breadcrumbs. The workspace has one control toolbar and a document heading with the report name, period, and basis. KPI strips and the Runs control are omitted. The customization panel animates with reduced-motion support and becomes a side drawer on smaller screens.

## Data and authorization

`lib/services/report-workspace.ts` is the shared authorization/evaluation boundary. UI previews, saved configurations, exports, packets, and scheduled runs use it. Only columns explicitly marked additive can be aggregated; ratios are recomputed from aggregated inputs.

Saved configurations use the existing `saved_report_configs.params` JSON. `_layout` holds the versioned presentation definition; `_division` and `_community` preserve scope; `_visibility` controls private/team discoverability; `_favorite` records the saved report preference; `_packet` stores ordered member IDs. Favorites on shared configurations are owned by the configuration owner, not individualized for each viewer.

Snapshots include source dependencies. Reading a packet snapshot rechecks access to every constituent report, including its project and Books requirements. Official/preview labels reflect Books ledger authority rather than treating Books activation alone as official accounting.

The browser cannot directly read or mutate report tables after the reporting migration. Server services use the service client only after checking the current user's report/project permissions and configuration ownership. This prevents a broad `report.read` database policy from exposing Books or margin snapshots.

## Scheduled delivery

Sharing, team publication, report links, and scheduled delivery controls are currently omitted from the product UI. Existing backend scheduling infrastructure is retained; this UI cleanup does not alter existing saved configurations or schedules.

Workers claim a due occurrence with a ten-minute lease. The occurrence keeps its original due timestamp until delivery succeeds. A snapshot and exact email payload are retained for retries; the email idempotency key includes the schedule ID and occurrence timestamp. Concurrent claims cannot deliver the same occurrence. Failed deliveries retain the due occurrence and expose the last error; retry becomes available after lease expiry. Successful delivery clears the cached payload and advances the schedule.

## Deployment

Deploy `supabase/migrations/20260919235924_unified_reporting_access.sql` together with this server change. It revokes direct authenticated/anonymous report-table access and adds `delivery_claimed_until`, `last_error`, and `delivery_payload` to `report_schedules`. Deploying only the database privilege changes would break older clients that access these tables directly. Scheduled delivery requires the new columns.

The migration is included in the repository but was not permanently applied during this implementation. Local database tests require a running Supabase Docker environment. `supabase/tests/report_workspace_access.test.sql` verifies the report-table privilege boundary after migration.

## Verification

Focused tests cover customization math, structured statements, authorization, scope/date validation, packet dependencies, snapshot access, and delivery concurrency/retries. Browser verification exercised a saved monthly P&L, matching monthly account activity, and preserved snapshot creation. A wide monthly PDF was rendered and visually checked for readable values and pagination. No email delivery or accounting transaction was performed during verification.
