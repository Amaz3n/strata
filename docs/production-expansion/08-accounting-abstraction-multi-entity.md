# 08 — Accounting Abstraction & Multi-Entity Connections

> **STATUS: PHASES A–C + D1 IMPLEMENTED; ADDITIVE DATABASE CUTOVER LIVE;
> APPLICATION DEPLOY AND SOAK-GATED CLEANUP PENDING (2026-07-19)**
>
> Platform workstream. Highest architectural risk in the production-expansion suite:
> real customer money flows through the QBO sync every day, and this doc rewires the
> layer it stands on. Read `00-MASTER-production-expansion.md` first (especially §5.7
> and §8), then `docs/commercial-expansion/00-MASTER-commercial-expansion.md` and
> `docs/commercial-expansion/09-platform-deferred-and-production.md` §A1, then the
> QBO sharp-edges notes in the repo `CLAUDE.md`. This doc is self-contained for a
> fresh executor, but those files are binding context.

### Progress and deployment boundary (2026-07-19)

The backward-compatible database cutover is live. The application code has not
been deployed. Compatibility views keep the currently deployed QBO code working;
the destructive B3/D2 files remain outside the active migration directory.

- [x] **Phase A repository work:** provider contract and registry, QBO adapter and
  file move, provider-neutral orchestration, target resolution rules, unconnected
  silent-no-op behavior, and adapter/resolution regression tests.
- [x] **Phase B repository + database work:** additive/cutover migration files B1–B3,
  provider-neutral connection and sync-ledger services, id-preserving copy,
  compatibility views/RPC, and direct consumers moved to the new names. B3 is a
  destructive follow-up and is held under `supabase/pending-migrations/` so it
  cannot be applied with B1/B2 accidentally. B1/B2 are live as migrations
  `20260719011735` and `20260719011822`; both compatibility views remain active.
- [x] **Phase C repository + database work:** multi-connection management UI, scoped entity
  maps and precedence, dimension pickers, stability guard and audited override,
  QBO import connection selection, RBAC/events migration, and connection-aware
  sync/health/vendor resolution. C1/C2 are live as `20260719011920` and
  `20260719012335`.
- [x] **Connection-scoped counterparties:** `accounting_counterparty_links`
  separates vendor/customer relationships from transaction sync state, so one
  Arc company can link to a different vendor in each book without overwriting
  another connection. Its 142-row live backfill is migration `20260719020641`.
- [x] **Unconnected/export work:** entity-scoped AP bills/payments, aggregated job
  cost, and balanced invoice revenue/cost journal exports with audit events.
- [x] **Phase D1 database work:** neutral coding/ledger backfill is live as
  `20260719012456`. D2
  destructive column/RPC cleanup are authored locally. D2 is held under
  `supabase/pending-migrations/` and is explicitly ineligible to apply before
  Gate C.
- [x] **Database security hardening:** Workstream RPC/trigger execute privileges
  are service-only and missing FK indexes are covered (`20260719014231`,
  `20260719014317`, `20260719021055`, `20260719021658`).
- [ ] **Phase A production gate:** application deploy plus 48-hour baseline/soak.
- [ ] **Phase B production gate:** application deploy, full QBO
  push/import/CDC/webhook QA, next-day B3 cleanup, and soak.
- [ ] **Phase C production gate:** two-connection sandbox proof and 14 consecutive
  days of zero legacy/map divergence.
- [ ] **Phase D application cleanup:** after Gate C, finish the source census that
  repoints remaining transaction/UI reads from denormalized business-table
  `qbo_*` columns to `accounting_sync_records`/`accounting_coding`, rerun the Gate
  D grep and manual QA, then—and only then—apply D2. The currently authored D2
  file is not production-safe while these reads remain.

Live verification: all 14 legacy connection rows and all 1,728 sync rows are
visible through both neutral tables and compatibility views. Patagonia
Development LLC's connection id and realm are unchanged, status is active,
refresh failures are zero, and `last_error` is null. Read-only gate queries are
saved in `docs/production-expansion/08-accounting-soak-queries.sql`.

Local verification: `pnpm lint`, TypeScript with `--noEmit`, the optimized Next.js
production build, and `pnpm test:financials` all pass (95/95 tests).

## 1. Mission

Make Arc's accounting integration **provider-agnostic and multi-entity**:

1. An `AccountingProvider` interface extracted from what `lib/services/qbo-sync.ts`
   actually does today — QBO becomes the first adapter, not the architecture.
2. **Many accounting connections per org** (`accounting_connections`), each labeled
   with the legal entity it represents, replacing today's hard
   one-active-QBO-connection-per-org constraint.
3. An **entity/dimension mapping layer** (`accounting_entity_map`) that routes each
   project (via division/community/project scope precedence) to a connection and to
   provider dimension values (QBO class/customer today; Intacct entity/location/
   department later) — replacing the denormalized `qbo_*` columns on `projects`.
4. A **migration of the QBO world** onto the new shape with zero downtime for live
   sync, and deletion of every obsoleted `qbo_*` column per leave-no-trash.
5. **Unconnected mode** hardened: Arc-native job cost plus journal/CSV exports per
   entity, so big builders on Sage Intacct/NetSuite go live without any adapter
   (master §8).
6. A **second-adapter spec** (Sage Intacct) that proves the interface — specced,
   explicitly NOT built (master §10).

**Why now.** Master §1's outer ring: large private production builders run
**divisions across states and multiple legal entities/accounting files**. "One org =
one set of books" is baked into today's schema (`qbo_connections_org_active_idx`
unique partial index) and into every push path (`getQBOAccessToken(orgId)`). Nothing
downstream — auto-PO (04), pay-on-PO bills, closings posting (06), warranty
backcharges (07) — can post money correctly for these builders until the routing
layer exists. That's why the master's execution order starts 08 in parallel with 01,
before 04/06 post a single dollar.

**Un-deferral notice.** Commercial doc `09-platform-deferred-and-production.md` §A1
("Accounting beyond QBO") deferred exactly this: *"QBO is hardcoded — `qbo_*`
columns denormalized onto financial tables, sync functions named `...ToQBO`, no
provider interface."* Its trigger was "3+ lost deals naming a specific ERP"; the
production segment supersedes that trigger — multi-entity is table stakes for the
outer ring, and §A1's own guidance ("new financial features must go through the
existing QBO service path rather than growing new `qbo_*` columns of their own",
standing rule since then) is the ramp this doc completes. This workstream formally
un-defers §A1's abstraction layer while keeping adapter #2 *implementation*
deferred.

## 2. Current-state audit (verified against repo + live schema, 2026-07-16)

### 2.1 The complete `qbo_*` column census

Everything below must be accounted for by this workstream — migrated into the new
layer or explicitly retained-and-justified, and the migrated ones **deleted**.

**Dedicated tables** (baseline `supabase/migrations/20260517092101_remote_schema.sql`
plus later migrations):

| Table | Columns / notes |
|---|---|
| `qbo_connections` | `id, org_id, realm_id, access_token, refresh_token, token_expires_at, refresh_token_expires_at, refresh_failure_count, company_name, connected_by, connected_at, disconnected_at, status ('active','expired','disconnected','error'), last_sync_at, last_error, settings jsonb, client_id` (added 20260529). **Unique partial index `qbo_connections_org_active_idx (org_id) WHERE status='active'` — the one-active-per-org constraint this doc removes.** Also `qbo_connections_expires_idx`, `qbo_connections_refresh_expiry_idx`. |
| `qbo_sync_records` | `org_id, connection_id → qbo_connections, entity_type` check (`invoice, payment, customer, item, vendor, project_expense, purchase, bill, bill_payment, purchase_order, vendor_credit, account`), `entity_id, qbo_id, qbo_sync_token, last_synced_at, sync_direction ('outbound','inbound','bidirectional'), status` (widened 20260715200001 to `synced, pending, processing, error, conflict, needs_review`), `error_message, metadata jsonb, pushable boolean` (20260605 — inbound-only "shadow" rows, e.g. JE-derived expenses, refuse outbound push). Unique `(org_id, entity_type, entity_id)`; index `(connection_id, qbo_id)`. RPC `qbo_claim_sync_create(org, connection, entity_type, entity_id, stale_after)` claims create-slots to prevent duplicate creates (20260715200001). |
| `qbo_webhook_events` | `event_id` unique, `payload_hash, realm_id, entity_name, entity_qbo_id, operation, last_updated, process_status, process_error, processed_at`, + `attempts, next_attempt_at` retry columns (20260715200002). Service-role-only RLS. |
| `qbo_invoice_reservations` | `org_id, reserved_number, reserved_by, reserved_at, expires_at (30 min), used_by_invoice_id, status ('reserved','used','expired','released')`. Unique active `(org_id, reserved_number)`. Used by `lib/services/invoice-numbers.ts` to reserve QBO DocNumbers ahead of invoice creation. |
| `qbo_import_cost_code_mappings` | `org_id, qbo_ref_type ('account','item'), qbo_ref_id, qbo_ref_name, cost_code_id` — remembered account/item→cost-code mapping for imports (20260703). |

**Denormalized columns on business tables:**

| Table | Columns | Origin migration |
|---|---|---|
| `invoices` | `qbo_id, qbo_synced_at, qbo_sync_status` (check: `pending, synced, error, skipped, needs_review` after 20260715200002) | baseline |
| `project_expenses` | `qbo_id, qbo_synced_at, qbo_sync_status, qbo_sync_error, qbo_transaction_type ('purchase','bill','journal_entry')`, `qbo_expense_account_id/_name, qbo_payment_account_id/_name, qbo_ap_account_id/_name, qbo_vendor_id/_name`, `qbo_class_id/_name` | baseline + 20260602 + 20260605 |
| `vendor_bills` | `qbo_id, qbo_synced_at, qbo_sync_status, qbo_sync_error, qbo_expense_account_id/_name, qbo_ap_account_id/_name, qbo_vendor_id/_name, qbo_class_id/_name` | baseline + 20260519 + 20260602 |
| `projects` | `qbo_class_id, qbo_class_name` (20260602), `qbo_customer_id, qbo_customer_name` (20260603) — **the entity-mapping columns master §5.7 names as the legacy shape** |
| `companies` | `qbo_vendor_id, qbo_vendor_name, qbo_vendor_synced_at, qbo_vendor_sync_status ('linked','created','needs_review','error')` (20260604) |
| `contacts` | none (verified — client links ride `invoices.metadata.qbo_customer_id` and `projects.qbo_customer_id`) |

**Buried in functions/RPCs:** `replace_invoice_lines_atomic` (20260715200002)
coalesces `qbo_id/qbo_sync_status/qbo_synced_at` in its jsonb update;
`update_qbo_cdc_cursor(connection_id, cursor)` (20260715200003) merges
`settings.qbo_cdc_last_synced_at` into `qbo_connections.settings`; an invoice-
reservation touch-up near line 577 of the baseline. All three must be revisited in
the column-cleanup phase.

**Connection `settings` jsonb keys** (from `QBOConnectionSettings` in
`lib/services/qbo-connection.ts`): `auto_sync, sync_payments, customer_sync_mode
('create_new'|'match_existing'), default_income_account_id,
default_expense_account_id, default_payment_account_id,
default_credit_card_account_id, default_ap_account_id, project_mapping_mode
('customer'|'sub_customer'), invoice_number_sync, invoice_number_pattern,
invoice_number_prefix, last_known_invoice_number`, plus the runtime-merged
`qbo_cdc_last_synced_at` cursor.

### 2.2 Operation map of `lib/services/qbo-sync.ts` (~2,270 lines)

**Outbound pushes** (one per money entity; JEs are inbound-only — there is no JE
push):

- `syncInvoiceToQBO(invoiceId, orgId, {allowRecreateDeleted})` + `forceSyncInvoiceToQBO` —
  invoice + lines → QBO Invoice; resolves customer via `getOrCreateProjectCustomer`
  (stamps `projects.qbo_customer_id`; honors `project_mapping_mode` sub-customer),
  per-line ClassRef via `resolveQBOClassRef(line.metadata, project)` falling back to
  `projects.qbo_class_id`; DocNumber sync + duplicate-DocNumber detection
  (`isDuplicateDocNumber`); PDF attachment via `syncInvoicePdfAttachmentToQBO`.
- `syncPaymentToQBO(paymentId, orgId)` — applied receivable payments → QBO Payment
  linked to the invoice's `qbo_id`.
- `syncProjectExpenseToQBO(expenseId, orgId)` — expense → QBO Purchase or Bill
  (`resolveProjectExpenseQBOTransactionType`), per-line cross-project class refs
  (expense split lines), receipt attachment sync, account coding from the
  `qbo_*_account_*` columns with connection-settings defaults.
- `syncVendorBillToQBO(billId, orgId)` — vendor bill + `bill_lines` → QBO Bill;
  vendor resolution (`companies.qbo_vendor_id` → `getOrCreateVendor`), per-line
  project class refs, `vendorBillHasQboExpenseCoding` gate, attachment sync.
- `syncBillPaymentToQBO(paymentId, orgId)` — QBO BillPayment (incl. applied-credit
  settlement rows from vendor-credit import).

**Push safety core** (the two helpers every adapter must preserve semantically):

- `resolveQBOSyncTarget({client, entityType, qboId, cachedSyncToken,
  allowRecreateDeleted})` → `{mode:'create'} | {mode:'update', id, syncToken}` —
  QBO optimistic concurrency needs the current SyncToken on every update; imported
  records have a `qbo_id` but no cached token, so it re-fetches the live entity to
  backfill; deleted-in-QBO records either throw `needs_review` or fall back to
  create when `allowRecreateDeleted`.
- `createOrUpdateQBOEntity({...payload, create, update})` — runs the resolve, then
  on stale-token failure (fault **5010**) re-fetches the token and retries the
  update exactly once.

**Bookkeeping:** `upsertSyncRecord`, `claimSyncCreate` (wraps the
`qbo_claim_sync_create` RPC — duplicate-create prevention when two workers race),
`markSyncRecordError/NeedsReview`, `markConnectionHealthy/Error/
ErrorIfConnectionLevel` (writes `qbo_connections.last_sync_at/last_error`),
`markProjectExpenseNeedsReview`, `markVendorBillNeedsReview`,
`isSyncPushBlocked` (blocks pushes for non-`pushable` sync records),
`isCostDrivenBillingModel`.

**Enqueue layer:** `enqueueInvoiceSync / enqueuePaymentSync /
enqueueProjectExpenseSync / enqueueVendorBillSync / enqueueBillPaymentSync` insert
outbox jobs — job types `qbo_sync_invoice, qbo_sync_payment,
qbo_sync_project_expense, qbo_sync_vendor_bill, qbo_sync_bill_payment` — with
payload-key dedupe (`outbox.dedupe_key`, unique while pending, 20260715200001).
`retryFailedQBOSyncJobs(orgId)` requeues failures.

### 2.3 Connection lifecycle (`lib/services/qbo-connection.ts`)

`getQBOAccessToken(orgId)` — **keyed by org, the single-connection assumption made
code** — refresh inside a 10-minute expiry window; `client_id` mismatch guard (a dev
box with different OAuth creds must never expire a live connection);
`refresh_failure_count` with expiry after 3 transient failures or `invalid_grant`;
optimistic-concurrency update guarded by `.eq("refresh_token", old)`;
`refreshQBOConnectionsDueForKeepalive` (30-day refresh-token horizon);
`upsertQBOConnection` **deactivates all existing org connections before insert**;
`disconnectQBO` revokes at Intuit; `getQBODiagnostics` aggregates connection +
outbox + failed-invoice health.

### 2.4 The three async pathways (all in `app/api/qbo/`, all in `proxy.ts`
`PUBLIC_API_ROUTES`, all GET-capable for Vercel Cron)

1. **Outbound outbox** — `process-outbox` cron (`*/10`): claims `qbo_sync_*` outbox
   jobs and calls the push functions.
2. **CDC poll** — `process-cdc` cron (`*/15`): per active connection,
   `QBOClient.changeDataCapture(["Invoice","Payment","Purchase","Bill","BillPayment"],
   changedSince)` from cursor `settings.qbo_cdc_last_synced_at` (advanced via the
   `update_qbo_cdc_cursor` RPC — jsonb-merge so it can't clobber concurrent settings
   writes), reconciles inbound edits/payments onto Arc rows
   (`replace_invoice_lines_atomic` for invoice line replacement).
3. **Webhooks** — `payment-webhook` verifies `intuit-signature` (HMAC verifier
   token), queues rows into `qbo_webhook_events`; `process-webhooks` cron
   (`5-59/15`) drains with `attempts/next_attempt_at` backoff. Queue-then-process
   split exists because webhook handlers must return fast and because of the proxy
   gotcha (any un-allowlisted `/api/qbo/*` route 307s to signin).

### 2.5 Inbound import (`lib/services/qbo-import.ts`, ~3,685 lines)

Entity types: `invoice, expense, expense_credit, bill, vendor_credit, payment,
bill_payment, journal_entry, client_deposit` (last two are JournalEntry-sourced;
JE-derived rows are `pushable:false` shadows). Org-wide import grid, per-line
project allocation persisting the customer→project link, cost-code memory via
`qbo_import_cost_code_mappings`. `qbo-project-link.ts` reads
`projects.qbo_customer_id/_name` for the project settings picker and import
routing.

### 2.6 `QBOClient` (`lib/integrations/accounting/qbo-api.ts`, ~1,090 lines)

`QBOClient.forOrg(orgId)` (again org-keyed); entity CRUD
(invoice/payment/purchase/bill/billpayment create+update, void invoice), reference
data (customers/vendors/classes/income+expense+payment+AP accounts, service items),
`changeDataCapture`, `listTransactionsForImport`, attachment upload, DocNumber
helpers. **Sharp edge encoded here:** Customer queries must use `SELECT *` —
explicit column lists containing complex columns (`BillAddr`, `PrimaryEmailAddr`)
400. `QBOError` carries `faultCode` for 5010/duplicate detection.

### 2.7 What the audit means

The provider seam is real but implicit: `qbo-sync.ts` already isolates Intuit calls
behind `QBOClient` and already funnels create/update through two helpers. What is
NOT abstracted: (a) org→connection resolution (everything keys on `orgId`), (b)
dimension resolution (class/customer read straight off denormalized project
columns), (c) sync bookkeeping tables named and check-constrained `qbo`, (d) the
UI. The abstraction below is an extraction, not an invention.

## 3. Target architecture

### 3.1 `AccountingProvider` interface — `lib/integrations/accounting/provider.ts`

Honest rule: **the interface exposes declared capabilities, not a QBO-shaped
lowest common denominator.** SyncToken optimistic concurrency, DocNumber
reservation, class/sub-customer dimensions are QBO facts; Intacct has entity/
location/department dimensions and no SyncToken. Callers branch on capabilities;
adapters never pretend.

```ts
// lib/integrations/accounting/provider.ts
export type AccountingProviderKey = "qbo" // | "sage_intacct" (speced §9, not built)

/** Dimension kinds a provider can stamp on transactions/lines. */
export type AccountingDimensionKind =
  | "class"       // QBO Class
  | "customer"    // QBO Customer / sub-customer (job)
  | "location"    // Intacct Location, QBO Location (unused today)
  | "department"  // Intacct Department
  | "entity"      // Intacct top-level entity (usually = the connection itself)

export interface AccountingCapabilities {
  supportsClasses: boolean
  supportsLocations: boolean
  supportsDepartments: boolean
  supportsSubCustomers: boolean          // QBO project_mapping_mode: 'sub_customer'
  supportsInvoiceNumberReservation: boolean // qbo_invoice_reservations flow
  supportsInvoiceDocNumberSync: boolean
  supportsCDC: boolean                   // change-data-capture pull
  supportsWebhooks: boolean
  supportsAttachments: boolean
  supportsJournalEntryPush: boolean      // false for QBO today (JEs inbound-only)
  supportsVendorCredits: boolean
  /** Optimistic-concurrency scheme for updates. 'sync_token' = QBO SyncToken
   *  (resolve-before-update + 5010 retry); 'none' = last-write-wins;
   *  'etag' = HTTP-style. Adapters own the retry mechanics internally, but the
   *  scheme is declared so orchestration can reason about conflict handling. */
  updateConcurrency: "sync_token" | "etag" | "none"
  /** Dimensions this provider accepts, in the order the entity-map editor
   *  should present them. */
  dimensions: AccountingDimensionKind[]
}

/** Resolved routing for one Arc project: which books, which dimension values. */
export interface AccountingTarget {
  connection: AccountingConnection             // §3.2 DTO
  /** Values keyed by dimension kind, provider-native ids + display names.
   *  e.g. { class: { id: "5000000000000112233", name: "Community A" },
   *         customer: { id: "42", name: "Lot 17 — Smith" } } */
  dimensions: Partial<Record<AccountingDimensionKind, { id: string; name: string | null }>>
  /** Which scope row won (audit/debug + stability enforcement). */
  resolvedFrom: "project" | "community" | "division" | "org_default"
}

export interface PushResult {
  externalId: string
  externalVersion?: string | null   // SyncToken analogue, provider-defined
  docNumber?: string | null
  raw?: unknown                     // provider payload for sync-record metadata
}

export interface PullChange {
  entityName: string                // provider-native, e.g. "Invoice"
  externalId: string
  operation: "create" | "update" | "delete" | "void"
  payload: unknown
  updatedAt: string
}

export interface AccountingProvider {
  readonly key: AccountingProviderKey
  readonly capabilities: AccountingCapabilities

  // ---- lifecycle / health ----
  /** Validate + refresh credentials; update connection health fields. */
  ensureHealthy(connectionId: string): Promise<{ ok: boolean; error?: string }>
  disconnect(connectionId: string): Promise<void>

  // ---- outbound pushes (entity ids are Arc row ids; adapter loads, maps,
  //      resolves target via resolveAccountingTarget, writes sync record) ----
  pushInvoice(input: { orgId: string; invoiceId: string; allowRecreateDeleted?: boolean }): Promise<PushResult>
  pushPayment(input: { orgId: string; paymentId: string }): Promise<PushResult>
  pushExpense(input: { orgId: string; expenseId: string }): Promise<PushResult>
  pushVendorBill(input: { orgId: string; billId: string }): Promise<PushResult>   // negative totals = vendor credit
  pushBillPayment(input: { orgId: string; paymentId: string }): Promise<PushResult>
  /** Only if capabilities.supportsJournalEntryPush. */
  pushJournalEntry?(input: { orgId: string; journalId: string }): Promise<PushResult>

  // ---- inbound ----
  /** CDC-style pull since cursor (opaque string owned by the adapter, persisted
   *  on the connection row). Only if supportsCDC. */
  pullChanges?(input: { connectionId: string; cursor: string | null }):
    Promise<{ changes: PullChange[]; nextCursor: string }>
  /** Verify a raw webhook request; return normalized events or null if invalid.
   *  Only if supportsWebhooks. Route stays provider-specific (§6.4). */
  verifyWebhook?(input: { rawBody: string; headers: Record<string, string | null> }):
    Promise<PullChange[] | null>

  // ---- reference data (feeds settings UI, entity-map editor, import coding) ----
  listDimensionValues(input: { connectionId: string; kind: AccountingDimensionKind }):
    Promise<Array<{ id: string; name: string }>>
  listAccounts(input: { connectionId: string;
    kind: "income" | "expense" | "payment" | "ap" }):
    Promise<Array<{ id: string; name: string }>>
  /** Find-or-create the provider-side counterparty for an Arc company/contact,
   *  recording it as a connection-scoped accounting_counterparty_links row. */
  resolveCounterparty(input: { connectionId: string; role: "customer" | "vendor";
    companyId?: string; displayName: string; projectId?: string }):
    Promise<{ id: string; name: string }>

  // ---- invoice numbering (only if supportsInvoiceNumberReservation) ----
  reserveInvoiceNumber?(input: { connectionId: string; orgId: string }):
    Promise<{ reservedNumber: string; expiresAt: string }>
}
```

Notes on honesty:

- **SyncToken never leaks above the adapter.** `resolveQBOSyncTarget` /
  `createOrUpdateQBOEntity` move INTO the QBO adapter unchanged; `externalVersion`
  on `PushResult`/sync records is the only surfaced trace.
- **`SELECT *` for QBO Customer queries** stays a private QBOClient rule; the
  interface returns mapped `{id, name}` shapes only.
- **Import is not on the interface (yet).** `qbo-import.ts`'s nine entity types are
  deeply QBO-shaped (Purchase-as-credit, JE fan-out, client deposits). Phase 1
  keeps import provider-specific behind the adapter boundary
  (`lib/integrations/accounting/qbo/` owns it); a `listImportableTransactions`
  interface method is an open question (§13), not a blocker.
- Push methods take `orgId + rowId`, not connection ids: **the adapter calls
  `resolveAccountingTarget` itself** so no caller can route a transaction to the
  wrong books.

### 3.2 `accounting_connections`

```sql
create table public.accounting_connections (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  provider text not null default 'qbo' check (provider in ('qbo')),  -- widen per adapter
  -- Display label = the LEGAL ENTITY these books belong to ("Arc Homes of Texas, LLC").
  label text not null,
  -- Provider-side account identifier (QBO realm_id; Intacct company+entity id).
  external_account_id text not null,
  external_account_name text,               -- QBO company_name
  credentials jsonb not null default '{}',  -- encrypted tokens + client_id (same
                                            -- encryptToken envelope as today)
  settings jsonb not null default '{}',     -- provider settings incl. cursor keys
  status text not null default 'active'
    check (status in ('active','expired','disconnected','error')),
  connected_by uuid references public.app_users(id),
  connected_at timestamptz not null default now(),
  disconnected_at timestamptz,
  last_sync_at timestamptz,
  last_error text,
  token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  refresh_failure_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- MANY active per org — the whole point. Uniqueness is per books, not per org:
create unique index accounting_connections_provider_account_active_idx
  on public.accounting_connections (org_id, provider, external_account_id)
  where status = 'active';
create index accounting_connections_org_idx on public.accounting_connections (org_id, status);
create index accounting_connections_expires_idx
  on public.accounting_connections (token_expires_at) where status = 'active';
create index accounting_connections_refresh_expiry_idx
  on public.accounting_connections (status, refresh_token_expires_at) where status = 'active';
-- RLS mirrors qbo_connections_access (service_role or is_org_member), with
-- (SELECT auth.uid()) initplan pattern per the DB performance pass.
```

Design choices: token columns stay first-class (not folded into `credentials`)
because the refresh machinery's guarded updates
(`.eq("refresh_token", old)`, partial indexes on expiry) depend on them; only the
encrypted secrets + `client_id` live in `credentials`. `realm_id` generalizes to
`external_account_id`. `label` is required — with multiple connections, an
unlabeled connection is meaningless UI.

### 3.3 `accounting_entity_map`

```sql
create table public.accounting_entity_map (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  connection_id uuid not null references public.accounting_connections(id) on delete restrict,
  -- Scope: exactly one of the three, or none = org default.
  division_id uuid references public.divisions(id) on delete cascade,     -- ws 01
  community_id uuid references public.communities(id) on delete cascade,  -- ws 01
  project_id uuid references public.projects(id) on delete cascade,
  scope text generated always as (
    case when project_id is not null then 'project'
         when community_id is not null then 'community'
         when division_id is not null then 'division'
         else 'org_default' end) stored,
  constraint accounting_entity_map_one_scope check (
    (project_id is not null)::int + (community_id is not null)::int
      + (division_id is not null)::int <= 1),
  -- Provider dimension values, keyed by AccountingDimensionKind:
  -- { "class": {"id":"...","name":"..."}, "customer": {"id":"...","name":"..."} }
  dimensions jsonb not null default '{}',
  created_by uuid references public.app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index accounting_entity_map_project_idx
  on public.accounting_entity_map (org_id, project_id) where project_id is not null;
create unique index accounting_entity_map_community_idx
  on public.accounting_entity_map (org_id, community_id) where community_id is not null;
create unique index accounting_entity_map_division_idx
  on public.accounting_entity_map (org_id, division_id) where division_id is not null;
create unique index accounting_entity_map_org_default_idx
  on public.accounting_entity_map (org_id)
  where project_id is null and community_id is null and division_id is null;
-- RLS: service_role or is_org_member(org_id).
```

Workstream 01 dependency is soft: until `divisions`/`communities` land, only
`project_id` and org-default rows exist — which is exactly the migrated QBO world.
The FKs are added when 01's tables exist (this doc's migration plan sequences it).

### 3.4 `resolveAccountingTarget` — `lib/services/accounting-target.ts`

```
resolveAccountingTarget({ orgId, projectId }): Promise<AccountingTarget | null>

1. Load the project's (division_id, community_id) — null-safe pre-ws-01.
2. Fetch candidate map rows in ONE query:
     where org_id = :org and (project_id = :p
       or community_id = :c or division_id = :d
       or (project_id is null and community_id is null and division_id is null))
3. Precedence: project > community > division > org_default. First hit wins.
4. Dimension INHERITANCE MERGE: dimensions merge shallowly from org_default up
   to the winning row (more specific keys override). A community row that sets
   only {class} still inherits {customer} behavior configured at project level —
   in practice: project rows carry customer, community/division rows carry
   class/location, org_default carries nothing or a catch-all class.
5. Load the connection; if status != 'active', return the target with a
   health flag — callers surface "connection unhealthy" needs_review rather
   than silently skipping (matches today's markConnectionError behavior).
6. Return { connection, dimensions, resolvedFrom }.
Null (no map rows at all) = unconnected mode (§8): every push path treats null
as "skip sync, stay Arc-native", exactly like today's missing-connection path.
```

Org-scoped, cached per request (follow `authorize()` caching pattern). **Every
push path calls this and only this** — `getOrCreateProjectCustomer`'s stamp target
and `resolveQBOClassRef`'s fallback both re-point here.

**Connection-stability guardrail.** A project's resolved connection must not
change once transactions exist under it — moving books mid-project silently forks
the ledger. Enforcement (all three layers):

1. **Service check (authoritative):** mutations to `accounting_entity_map` rows,
   and to `projects.division_id`/`community_id` when they would change the
   resolved connection for a project, run
   `countSyncedTransactionsForProject(projectId, currentConnectionId)` (exists a
   row in `accounting_sync_records` for this project's invoices/expenses/bills/
   payments with a non-empty external id on that connection). If > 0 → reject with
   a typed error naming the connection and count. Override path: an explicit
   `acknowledge_resync: true` flag permitted only to `financials.manage` +
   org admin, recorded to `audit_log` — for real re-orgs (entity sale, books
   migration), with the UI spelling out that history does NOT move.
2. **Adapter check (belt):** the adapter compares `resolveAccountingTarget`'s
   connection against the existing sync record's `connection_id` before any
   update push; mismatch → `needs_review` sync record, never a cross-books write.
3. **Trigger (suspenders):** BEFORE UPDATE trigger on `accounting_entity_map`
   raising when `connection_id` changes on a row whose scope has synced
   transactions and the audit override marker is absent from a
   `set_config`-provided flag. (Simple version acceptable: trigger only guards
   project-scope rows; broader scopes rely on the service check, since computing
   "all projects under a division" in a trigger is disproportionate.)

### 3.5 `accounting_sync_records` (renamed `qbo_sync_records`)

Decision: **physical rename + temporary compatibility view**, not a parallel
table. Justification in §5 (cutover safety). Shape changes:

- `+ provider text not null default 'qbo'` (check mirrors connections).
- `qbo_id` → `external_id`, `qbo_sync_token` → `external_version` (view aliases
  old names during cutover).
- `connection_id` re-pointed to `accounting_connections(id)`.
- Unique key remains `(org_id, entity_type, entity_id)` for transaction records;
  the stability guardrail (§3.4) keeps a transaction on one set of books.
  Reusable vendor/customer relationships live in `accounting_counterparty_links`,
  whose unique key includes `connection_id`, so the same Arc company can be a
  different vendor in several books. `(connection_id, external_id)` index kept.
- `qbo_claim_sync_create` RPC → `accounting_claim_sync_create` (same body, new
  table; old name kept as a delegating wrapper until code cutover completes, then
  dropped).
- `entity_type` check unchanged (values are provider-neutral enough).

`qbo_webhook_events` and `qbo_invoice_reservations` **keep their names** — they are
provider-specific infrastructure (Intuit webhook queue, QBO DocNumber
reservations), exactly the kind of thing that legitimately stays `qbo_*`. Same for
`qbo_import_cost_code_mappings` (QBO account/item refs), until a second adapter
motivates a generalization. The master's rule is "no NEW qbo_* columns", not
"pretend Intuit isn't Intuit."

### 3.6 Transaction-level columns: what stays, what dies

| Today | Decision |
|---|---|
| `invoices/project_expenses/vendor_bills . qbo_id, qbo_synced_at, qbo_sync_status, qbo_sync_error` | **DELETE** (final phase). `accounting_sync_records` is already the source of truth (`external_id`, `status`, `error_message`, `last_synced_at`); the columns are a denormalized read cache. Reads (list badges, `getQBODiagnostics` failed-count, partial indexes) re-point to sync-record joins; the two hot partial indexes (`*_qbo_sync_idx`) are replaced by `accounting_sync_records (org_id, entity_type, status)`. `replace_invoice_lines_atomic` updated in the same phase. |
| `project_expenses/vendor_bills . qbo_expense_account_id/_name, qbo_payment_account_id/_name, qbo_ap_account_id/_name` | **MIGRATE to `accounting_coding jsonb`** (one new neutral column on each table): `{ "expense_account": {"id","name"}, "payment_account": {...}, "ap_account": {...} }`. This is user-chosen per-transaction coding, provider-account-shaped but neutral in structure; Intacct GL accounts fit the same keys. Old columns dropped after backfill. |
| `project_expenses/vendor_bills . qbo_vendor_id/_name` | **DELETE**; counterparty ref lives on the sync path via `companies.qbo_vendor_*` migration below + `resolveCounterparty`. Rows without a company keep a `{"vendor": {...}}` key inside `accounting_coding`. |
| `project_expenses/vendor_bills . qbo_class_id/_name` (per-row overrides) | **MIGRATE** into the same `accounting_coding` jsonb (`"class"` key) — these are per-transaction dimension overrides, distinct from the project-level map. |
| `project_expenses.qbo_transaction_type` | **KEEP, renamed conceptually only** — it records which QBO entity shape the row round-trips as ('purchase','bill','journal_entry'). It is provider metadata → moves to `accounting_sync_records.metadata.transaction_shape` during backfill; column dropped. |
| `projects.qbo_class_id/_name, qbo_customer_id/_name` | **MIGRATE to `accounting_entity_map` project-scope rows** (`dimensions.class`, `dimensions.customer`), then **DELETE** — this is the §5.7 flagship. `qbo-project-link.ts` reimplemented over the map (same DTO), then inlined/deleted. |
| `companies.qbo_vendor_id/_name/_synced_at/_sync_status` | **MIGRATE to `accounting_counterparty_links`** rows (`role='vendor'`, `entity_type='company'`, keyed by connection), then **DELETE**. A transitional sync-ledger relationship row is dual-written until D2. Directory UI reads via `getCompanyAccountingLinks(companyIds)`; a company can be a vendor in several books without collisions. |
| `invoices.metadata.qbo_customer_id` (composer override) | **MIGRATE key name** to `metadata.accounting_customer_ref` during the same phase; write path updated first, one-time backfill for rows still carrying the old key. |

### 3.7 Capability matrix (initial)

| Capability | QBO | Sage Intacct (spec §9) | Unconnected |
|---|---|---|---|
| dimensions | class, customer | entity, location, department | — |
| supportsSubCustomers | yes | no (jobs are dimensions) | — |
| invoice # reservation / DocNumber sync | yes | no (Intacct auto-numbers) | Arc-native numbering |
| CDC | yes (15-min poll) | yes (audit-trail query) | — |
| webhooks | yes (Intuit signature) | no (poll only) | — |
| attachments | yes | yes (supporting docs) | — |
| JE push | no (inbound-only today) | yes (closing entries) | CSV/journal export |
| vendor credits | yes (negative bill) | yes (AP adjustment) | native negative bill |
| updateConcurrency | sync_token | none (Intacct upserts by key) | — |

## 4. Directory layout after refactor

```
lib/integrations/accounting/
  provider.ts            # interface + capability types (§3.1)
  registry.ts            # getProvider(key) → AccountingProvider; getProviderForConnection(id)
  qbo/
    adapter.ts           # implements AccountingProvider (extracted qbo-sync.ts push cores)
    client.ts            # QBOClient (moved from qbo-api.ts, unchanged semantics)
    auth.ts              # qbo-auth.ts (moved)
    config.ts, webhook.ts# moved
    import.ts            # qbo-import.ts moved (provider-specific, §3.1 note)
lib/services/
  accounting-connections.ts  # connection CRUD/health (generalizes qbo-connection.ts)
  accounting-target.ts       # resolveAccountingTarget + stability guardrail
  accounting-sync.ts         # orchestration: enqueue*, retry, diagnostics, sync-record
                             # bookkeeping (provider-neutral parts of qbo-sync.ts)
  accounting-export.ts       # §8 unconnected-mode journal/CSV exports
```

Leave-no-trash: `qbo-sync.ts`, `qbo-connection.ts`, `qbo-api.ts`, `qbo-import.ts`,
`qbo-project-link.ts` are DELETED at the end of their phase (contents moved, not
copied; imports repointed). `qbo-logger.ts` generalizes to an `accounting-logger`
with a provider field.

## 5. Strangler-fig migration plan

Ironclad rule: **live QBO sync never breaks mid-migration.** Real customer invoices,
bills, and payments flow through the three async pathways daily. Every phase is
independently shippable, independently revertible, and gated.

### Phase A — Interface + resolution layer (behavior identical)

Code only, no schema. Define `provider.ts`; carve `qbo-sync.ts` push functions into
`qbo/adapter.ts` implementing the interface (mechanical move —
`resolveQBOSyncTarget`/`createOrUpdateQBOEntity` and all sharp-edge handling move
verbatim); create `accounting-sync.ts` orchestration that the outbox processor and
actions call; add `resolveAccountingTarget` implemented AGAINST THE OLD SCHEMA
(reads `qbo_connections` active row + `projects.qbo_class_id/qbo_customer_id`,
synthesizing the `AccountingTarget` shape). Outbox job types unchanged. `QBOClient`
moves file location only.

**Gate A:** `pnpm lint` + `pnpm test:financials` clean; new adapter-level fixture
tests (§12) green; then a 48-hour production soak: `qbo_sync_records` error rate,
outbox failure counts, and CDC cursor progression compared before/after deploy
(query recipes in §12.4). Any regression → revert is a pure code revert.

### Phase B — New tables, single-connection behavior

Migrations B1–B3 (§11). Create `accounting_connections` + `accounting_entity_map`.
**Data cutover for connections, in one migration transaction:** insert one
`accounting_connections` row per `qbo_connections` row (all statuses, preserving
ids so `connection_id` FKs can re-point) with `label` = `company_name` fallback
"QuickBooks", `external_account_id` = `realm_id`, `credentials` =
`{access_token, refresh_token, client_id}` (values are already-encrypted text —
copied verbatim, no re-encryption). Then **rename** `qbo_sync_records` →
`accounting_sync_records` (+`provider`, column renames) and create updatable
compatibility view `qbo_sync_records` aliasing old column names; wrapper RPC
`qbo_claim_sync_create` delegates to the new one.

Why rename+view instead of parallel tables/dual-write: the sync-record table has
one writer path (the service layer) but three async readers; dual-write risks
divergence in exactly the table whose uniqueness invariants (claim RPC, entity
unique key) prevent double-pushes. The updatable view keeps any in-flight server
instance from the previous deploy working during the deploy window (simple
single-table views are auto-updatable in Postgres; the claim RPC wrapper covers the
one non-view write path). Same technique for `qbo_connections` → view over
`accounting_connections` (filtered `provider='qbo'`, aliasing
`realm_id`/`company_name`; token refresh's guarded UPDATE works through it).

Code in the same deploy: `accounting-connections.ts` replaces `qbo-connection.ts`
(reads/writes new table directly); `resolveAccountingTarget` still synthesizes
dimensions from project columns but reads the connection from the new table;
`update_qbo_cdc_cursor` re-pointed. OAuth callback writes new table.
**Single-connection behavior is preserved by policy, not constraint:** connect UI
still replaces the existing connection (the `upsertQBOConnection` deactivate-first
behavior) until Phase C flips it.

**In-flight safety checklist for the B deploy window:** outbox jobs reference Arc
row ids + org — unaffected; CDC cursor lives in connection `settings` — copied in
the same transaction, cron reads new table on next tick; webhook queue rows carry
`realm_id` — the processor's realm→connection lookup switches to
`accounting_connections.external_account_id`; `qbo_invoice_reservations` untouched.
Deploy sequence: apply migration (old code keeps working through views) → deploy
code → **drop views + wrapper RPC in migration B3 only after the deploy is
verified** (next day, not same transaction).

**Gate B:** same soak as Gate A, plus: one full end-to-end manual QA in production
on the team's own org — push invoice, payment, expense, bill, bill payment; import
one of each; CDC tick observed advancing; webhook event processed. Verify
`qbo_connections_org_active_idx` semantics still hold (policy layer). Reservation
flow exercised.

### Phase C — Multi-connection + entity map live

Enable many connections: connect flow gains "add another connection" (no
deactivate-first), label editing, per-connection settings/health. Backfill
migration C1: for every project with `qbo_class_id` or `qbo_customer_id`, insert a
project-scope `accounting_entity_map` row (`connection_id` = the org's single
active connection, `dimensions` from the columns); insert one org-default row per
org with an active connection. `resolveAccountingTarget` switches to the map
(**dual-read verification window:** for two weeks it also computes the legacy
answer from project columns and logs any divergence via `logQBO` — divergence
count must be zero before Phase D). Stability guardrail (service check + trigger)
ships here. `getOrCreateProjectCustomer` writes its stamp to the map row, and —
transitional — mirrors to the legacy columns until Phase D drops them, so a Phase C
revert loses nothing.

**Gate C:** dual-read divergence = 0 over 14 days; soak metrics flat; a second
sandbox QBO connection attached to a test org with two projects mapped to
different connections — pushes land in the correct realm (fixture-verified realm
ids in sync records); guardrail rejection + audited override both exercised.

### Phase D — Column deletion (leave-no-trash)

Migrations D1–D2: backfill `accounting_coding` jsonb + sync-record
`metadata.transaction_shape` + companies→sync-records (§3.6); repoint every read
(grep census: `qbo_class_id|qbo_customer_id|qbo_vendor_id|qbo_sync_status|qbo_id`
across `lib/`, `app/`, `components/`); update `replace_invoice_lines_atomic` to
stop touching dropped columns (writes sync-record fields instead); replace partial
indexes; THEN drop all §3.6 delete-column sets, the legacy mirror-writes, and the
dual-read shim. `qbo-project-link.ts` deleted. Old service files deleted.

**Gate D:** `pnpm lint` proves no dangling references (type-aware);
`pnpm test:financials`; full manual QA round again; `grep -rn "qbo_class_id\|qbo_customer_id\|qbo_vendor_id"` returns only migration files and docs.

Phases are also the acceptance-criteria checkpoints (§10 folds them together with
UI work).

## 6. Service layer changes

### 6.1 Push paths (call-site sweep)

Every caller of `enqueue*Sync`/`sync*ToQBO` — invoice actions, payment recording,
expense approval, vendor-bill approval/settlement, QBO sync sheet retry buttons,
draw/CO-linked invoice flows — switches to `accounting-sync.ts` orchestration:
`enqueueAccountingPush({orgId, entityType, entityId})`. Outbox job types: keep the
existing `qbo_sync_*` names as aliases during A–C (in-flight jobs must drain), add
provider-neutral `accounting_push_*` names at C, migrate the processor to accept
both, drop the old names at D (after `select distinct job_type from outbox where
status in ('pending','processing')` shows none).

### 6.2 Orchestration vs adapter split

`accounting-sync.ts` owns: outbox claim/retry, sync-record bookkeeping
(`upsertSyncRecord`, claim RPC, needs_review marking), connection health writes,
`isSyncPushBlocked` (pushable), diagnostics. The adapter owns: payload mapping,
provider API calls, SyncToken mechanics, attachments, DocNumber logic. The line:
anything that would read `QBOError.faultCode` belongs to the adapter.

### 6.3 Import

`qbo/import.ts` gains a required `connectionId` parameter end-to-end (grid is
per-connection; §7). Cost-code memory stays keyed by org + provider refs
(unchanged table). Customer→project link persistence writes `accounting_entity_map`
dimensions instead of project columns (Phase C+).

### 6.4 Routes

`app/api/qbo/*` **stay** — provider-specific webhook/callback/cron endpoints are
legitimate (Intuit signs webhooks; OAuth callbacks are per-provider). Handlers
become thin: verify/queue via `provider.verifyWebhook`, process via orchestration.
`process-cdc` and `process-outbox` iterate **all active connections** (already
per-connection for CDC; outbox becomes connection-aware via
`resolveAccountingTarget` inside the adapter). No new public paths in A–D, so
`PUBLIC_API_ROUTES` in `proxy.ts` is unchanged; **any future provider adds its own
`/api/accounting/<provider>/…` routes and MUST be allowlisted there and mirrored in
`vercel.json` + `CRON_JOBS`** (cron-GET rule applies).

## 7. Admin UI spec (`settings/integrations`)

Follow existing integration-sheet patterns (`components/integrations/
qbo-sync-sheet.tsx`); dense, token-colored, no heroes.

- **Connections list** replaces the single QBO card: table of connections — Label
  (legal entity, inline-editable), Provider, Company (external name), Status
  (color = state), Last sync, Failures. Row actions: settings, refresh token,
  disconnect, health detail (per-connection `getAccountingDiagnostics`). "Connect
  QuickBooks" button always available (adds another). Empty state: today's
  connect CTA plus an "Export-only (no connection)" explainer linking §8 exports.
- **Entity map editor** — two surfaces, one mutation home each:
  - Org-level (integrations page): the org-default row and division/community
    rows in one table — Scope, Connection, then one column per dimension the
    connection's provider declares (`capabilities.dimensions`), values picked via
    `listDimensionValues`. Divisions/communities appear only when ws-01 tables
    have rows (orgs without them never see the concept).
  - Project-level (project settings sheet, replacing today's QBO customer picker):
    the project's resolved target shown read-only ("Books: Arc Homes TX — via
    community Oakwood") with an override control creating/editing the
    project-scope row. Guardrail errors surface here with the transaction count
    and the admin-only acknowledge path.
- **Import tab** gains a connection switcher when >1 active connection.
- All views: empty/loading/error states, dark mode, pagination on the import grid
  (already capped).

## 8. Unconnected mode + exports

**Verify-and-harden (today's behavior audit is part of Phase A):** with no active
connection, `getQBOAccessToken` returns null and push paths mark records
skipped/error — sweep every `enqueue*` caller so absence of a connection is a
**silent no-op** (no outbox job, no error-status stamping, no sync badges in UI),
and the integrations/import surfaces render the unconnected empty state rather
than degrade. Arc-native job cost (budgets, actuals from expenses/bills, invoices,
payments) already works connection-free — regression-test that claim in the §12
suite rather than assuming it.

**Exports (`lib/services/accounting-export.ts` + a per-entity Export panel on the
integrations page):** the bridge for Sage Intacct/NetSuite customers pre-adapter
(master §8). All org-scoped, permission `financials.export` (new RBAC entry, §10),
each scoped to an entity-map scope (division/community/project set) so multi-entity
builders export per legal entity even unconnected:

1. **AP export** — approved vendor bills + payments in a period: CSV with vendor,
   bill no, date, due, GL account (from `accounting_coding`/cost-code mapping),
   amount_cents, project/community/division refs.
2. **Job-cost export** — actuals by project × cost code × period.
3. **Journal export (closing entries)** — balanced Dr/Cr rows for revenue
   (invoices/closings) and cost recognition per period, generic
   account/dimension/debit/credit/memo columns importable by Intacct/NetSuite CSV
   journal imports.

Every export records an `accounting_export` event + audit row. Formats are plain
CSV first; Intacct-native column headers are a fast follow inside the same
service.

## 9. Second adapter spec — Sage Intacct (SPEC ONLY; implementation deferred per master §10)

Named target because: dimensions (entity/location/department) map 1:1 onto
`accounting_entity_map.dimensions`; modern REST API (plus legacy XML gateway);
it's the accounting system most common at 100–500-closings/yr private builders —
exactly the outer ring.

Capability declaration (from §3.7): `dimensions: ["entity","location","department"]`,
`supportsSubCustomers: false`, `supportsInvoiceNumberReservation: false`,
`supportsCDC: true` (audit-trail/`whenmodified` queries), `supportsWebhooks: false`
(poll-only), `supportsJournalEntryPush: true`, `updateConcurrency: "none"`
(key-based upserts).

The adapter must implement: OAuth/credential handling into
`accounting_connections.credentials` (company id + entity + client creds);
`pushInvoice` → AR Invoice with dimension stamps; `pushVendorBill`/`pushBillPayment`
→ AP Bill/Payment; `pushExpense` → AP adjustment or GL entry per coding;
`pushJournalEntry` (its differentiator — closings + WIP entries from workstream 06
post natively); `pullChanges` via modified-since queries with the cursor as an ISO
watermark in `settings`; `listDimensionValues` for entity/location/department;
`resolveCounterparty` against Intacct vendors/customers. No SyncToken machinery,
no DocNumber reservation, no webhook route. New public routes (OAuth callback)
follow §6.4's allowlist rule. **Build trigger stays master §10's: a real
customer.**

## 10. RBAC, events, phases & acceptance criteria

**RBAC (catalog-as-code seed migration):** reuse existing integration-management
permission for connection CRUD; add `accounting.entity_map.manage` (org admin +
bookkeeper assignable role) and `financials.export`. Guardrail override requires
org admin.

**Events** (`recordEvent` + audit on every mutation): `accounting_connected` /
`accounting_disconnected` (with provider + label; supersede `qbo_connected`/
`qbo_disconnected` — emit both during C, old names dropped at D),
`accounting_entity_map_updated`, `accounting_connection_reassigned` (the audited
override), `accounting_export`. None join `EMAIL_NOTIFICATION_TYPES`.

**Phase acceptance (supersets of §5 gates):**

- **A:** interface + adapter extraction shipped; behavior byte-identical (gate A
  soak); unconnected-mode audit complete with silent-no-op fixes.
- **B:** new tables live, views bridging, single-connection UX unchanged; gate B
  manual QA matrix passed; views dropped.
- **C:** multi-connection UI + entity-map editor + resolution + guardrail live;
  dual-read divergence zero for 14 days; two-connection test-org proof.
- **D:** all §3.6 columns dropped; grep census clean; exports shipped
  (E can land any time after A — it has no schema dependency beyond
  `accounting_coding`, so schedule it with C); docs + memory updated.

## 11. Migration files plan (`supabase/migrations/`, additive-then-cleanup)

| # | File (date-ordered) | Contents | Phase |
|---|---|---|---|
| B1 | `…_accounting_connections.sql` | table + indexes + RLS + data copy from `qbo_connections` (id-preserving) + `qbo_connections` dropped-and-viewed + `update_qbo_cdc_cursor` re-point | B |
| B2 | `…_accounting_sync_records.sql` | rename + `provider` + column renames + compat view + `accounting_claim_sync_create` + delegating wrapper | B |
| B3 | `supabase/pending-migrations/…_accounting_drop_compat_views.sql` | drop both views + wrapper RPC (promote into `supabase/migrations/` with a fresh timestamp only after B deploy is verified) | B+1 |
| C1 | `…_accounting_entity_map.sql` | table + indexes + RLS + backfill from `projects.qbo_*` + org-default rows + stability trigger | C |
| C2 | `…_accounting_rbac_and_events.sql` | RBAC catalog seed entries | C |
| D1 | `…_accounting_coding_backfill.sql` | `accounting_coding` jsonb on `project_expenses`/`vendor_bills` + backfill + companies→sync-records backfill + `metadata.transaction_shape` + invoice `metadata` key rename | D |
| C3 | `…_accounting_counterparty_links.sql` | connection-scoped vendor/customer link table + RLS + validation + backfill from transitional ledger relationships | C |
| H1 | `…_accounting_security_hardening.sql`, `…_accounting_trigger_function_privileges.sql`, `…_accounting_fk_indexes_and_qbo_trigger_lockdown.sql` | service-only RPC/trigger privileges + FK indexes | A–D |
| D2 | `supabase/pending-migrations/…_drop_qbo_columns.sql` | drop every §3.6 delete set + legacy partial indexes + new sync-status index + `replace_invoice_lines_atomic` rewrite; promote with a fresh timestamp only after Gate C and the source census | D |

Rules: applied via `apply_migration` with repo copies; every backfill idempotent
(`on conflict do nothing` / `where not exists`); B1/B2 in single transactions;
destructive files (B3, D2) remain outside the active migrations directory until
their gates pass, then are promoted with a fresh timestamp as separate later
migrations. Divisions/communities FKs on the entity map are added by ws-01's own
migrations if 01 lands first, else C1 creates the columns FK-less and 01 adds the
constraints — coordinate via the master's execution order.

## 12. Test plan

QBO sync currently has NO test harness — this workstream builds one; it is the
regression strategy, not a nicety.

1. **Fixture-backed adapter tests** (`lib/integrations/accounting/qbo/
   adapter.test.ts`, vitest, joins `pnpm test:financials`): a `FakeQBOTransport`
   replacing `fetch` inside `QBOClient`, seeded with recorded sandbox JSON
   fixtures (`fixtures/qbo/*.json`) for: invoice create/update, 5010 stale-token
   (assert exactly-one refetch+retry), missing-SyncToken backfill (imported
   record), deleted-entity → needs_review vs recreate, duplicate DocNumber,
   Customer `SELECT *` quirk (assert query string never lists complex columns),
   purchase/bill/billpayment round-trips, CDC payload parse, webhook signature
   verify (valid/invalid).
2. **Resolution tests** (`lib/services/accounting-target.test.ts`): precedence
   (project > community > division > org-default), dimension inheritance merge,
   null = unconnected, unhealthy-connection flag, guardrail rejection + override.
3. **Orchestration tests:** claim RPC race (two concurrent claims → one create),
   pushable=false refusal, outbox dedupe-key behavior, connection-mismatch →
   needs_review.
4. **Production soak queries** (run at every gate; save as a scratchpad SQL file,
   read-only): error-rate on `accounting_sync_records` by day; outbox
   failed/pending counts by job_type; CDC cursor age per connection
   (`settings->>'qbo_cdc_last_synced_at'` vs now); webhook queue depth + max
   attempts. Baseline captured before Phase A deploy.
5. **Manual QA matrix** (gates B and D, production, team org + QBO sandbox org):
   push each of the five entity types; edit-in-QBO then re-push (5010 path);
   import one of each of the nine import types; reservation flow; disconnect/
   reconnect; two-connection routing (gate C).
6. **Unconnected-mode suite:** all financial flows green with zero connections;
   each §8 export golden-filed.

## 13. Open questions

1. **Import on the interface?** Should `listImportableTransactions` +
   `importRecords` join `AccountingProvider` now, or stay provider-private until
   Intacct forces the shape? Leaning private-until-second-adapter (avoid
   speculative abstraction), but ws-09's importer work may want the seam earlier.
2. **`qbo_import_cost_code_mappings` scope:** per-org today; with multiple
   connections, should mappings be per-connection (same account id can differ
   across realms)? Likely yes — fold `connection_id` into its unique key during
   Phase C; confirm no org has colliding refs first (read-only query).
3. **Payments spanning connections:** a receivable payment applied across invoices
   from two projects mapped to different books is representable in Arc but not in
   either ledger. Proposal: block at apply-time when invoice targets differ
   (validation in payments service) — confirm with real data whether any existing
   org would trip this.
4. **Historical re-homing tooling:** the audited override changes future routing
   only. Do we ever build "migrate synced history to another connection"
   (void-and-repush)? Default: no — out of scope, note in the override UI copy.
5. **Credential encryption key rotation:** `credentials` copies today's
   `encryptToken` envelope; multi-provider may motivate per-provider key ids.
   Defer unless security review says otherwise.
6. **Division/community FK timing** (§11) — confirm ws-01 sequencing at execution
   time.
