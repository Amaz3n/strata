# Accounting integration and D2 operations

This describes the accounting code in the working tree. The September 8 closure migrations and application changes require a coordinated release; they have not been deployed by this accounting task. Production D2 remains gated. Arc Books' ledger-authority policy is unchanged.

## Provider boundary

`lib/integrations/accounting/provider.ts` defines the provider contract; the registry checks advertised capabilities against implemented operations. QBO owns its transport, OAuth refresh, settings validation, import translation, inbound processing, and error classification. Shared services own authorization, connection routing, durable delivery, canonical persistence, and operational receipts. File export uses the same accounting experience and sealed batch revisions. Adding a provider requires the capability certification tests, including a fake provider's settings/import/error paths; registering a key alone is insufficient.

QBO transaction IDs are meaningful only with organization, connection, and remote entity type. Canonical identity lives in `accounting_sync_records`; coding lives in `accounting_coding`; project dimensions and counterparties use their scoped maps and links. QBO business-table columns are compatibility data awaiting D2, never a runtime fallback.

## Outbound lifecycle

Human requests pass permission and project/division checks and enter the durable queue. Jobs pin the connection/provider. Delivery rechecks ledger authority, cutover freeze, current routing, existing remote ownership, transaction eligibility, and integration settings. Manual sync does not bypass freeze or historical ownership.

The shared delivery service owns a fenced lease for the transaction. A losing or expired owner cannot publish a result or release another owner's lease. External identity and version survive partial failures; successful no-ops, deferred work, review blocks, and delivered work have distinct outcomes. A local edit during remote delivery retains the discovered remote identity and queues another attempt with an immutable deferral receipt. Reversals use the same lifecycle. Worker deadlines propagate to transport; expired work is reclaimed and genuine deferral does not exhaust retries.

Remote creates carry an Arc marker. Recovery searches all remote history and stops on failed, incomplete, or ambiguous lookups. This prevents uncertain lookup results from authorizing another create. Large remote histories may exceed the worker deadline and need reviewed recovery. QBO also supports `requestid`; the current historical recovery contract does not yet depend on durable operation-scoped request IDs. Any adoption of that feature must distinguish retries from an explicitly authorized new operation. See [Intuit's request-id guidance](https://blogs.a.intuit.com/2018/09/10/quickbooks-online-api-best-practices/).

## Inbound and import

Webhook acknowledgement requires durable storage. Transient lookup/application errors remain retryable. Conflict resolution checks authorization and the current conflict, and take-remote does not stop at the unchanged-version shortcut.

Import claims are scoped by connection and remote entity type. Atomic RPCs persist documents, lines, links, and identity adoption with completeness checks; split imports retain source line identity and resume incomplete pieces. Existing rows are inspected rather than automatically considered complete. Cross-connection adoption and overwriting a different remote identity are rejected. Grouped payments and expenses compare the full allocation group. Changed posted money or unavailable remote payments remain visible conflicts until an authorized financial correction is chosen. A stale OAuth refresh failure cannot invalidate newer credentials.

## Release order and acceptance

1. Review the candidate, apply its additive migrations in dependency order, then deploy the compatible application through CI. Do not use a blanket push that includes pending destructive SQL. Keep the previous compatible build available.
2. Review and execute the per-record repairs or historical dispositions, preserving exact before-values, remote versions, and money totals. Execute the lossless finalizer from `supabase/pending-migrations/accounting_d2_lossless_finalizer.sql` only under the approved production scope. It archives populated legacy values and fills absent coding; unexplained disagreements abort it.
3. Start a service-only acceptance campaign tied to the deployed commit, schema fingerprint, checker version, expected QBO identity, and approved release evidence. Existing nightly reconciliation records measured, append-only samples. No campaign creates no samples.
4. Retain seven consecutive completed UTC dates with complete global evidence. Missing dates, failed samples, changed identity/schema, incomplete scans, unresolved decisions, stale workers, or actionable backlog block D2. A passing retry cannot erase a failed sample. Healthy work inside its delivery window is permitted.
5. Obtain a separate final drop approval and fresh passing evidence. The transactional pending drop checks the campaign, current health, exact archive, and all gates before removing 38 legacy columns. Rehearse the exact files in an isolated database first. After production drop, a rollback build must itself be neutral; an older legacy-reading build is no longer compatible.

The source release census must remain zero. The SQL census rejects references to every dropped column, with one exact-definition exception for the tested tax-readiness output cache; changing that definition invalidates the exception. The database tests execute financial routines with all legacy columns absent. Archive and audit history remain after cleanup.

## Verification

Run `pnpm accounting:d2:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and the database contracts against an explicitly isolated local database. The full Node suite includes financial, authorization, and mobile tests. Set `ARC_PGLITE_MODULE` to an installed PGlite module to exercise the optional SQL transaction suites. CI owns the application build and uses Supabase CLI 2.117.0 for database replay. Real QBO pushes and production acceptance smoke tests require their reviewed release scope.
