# Books reconciliation — 2026-10-08

Generated from the completion tracker and the all-scenario run. Status is the tracker's; coverage is this run's result for each scenario the item names.

| Item | Status | Scope | Title | Scenario coverage |
|---|---|---|---|---|
| B00.1 | LOCALLY_VERIFIED | first client | Reconcile requirements and workspace drift | — |
| B00.2 | LOCALLY_VERIFIED | first client | Accept fresh and upgrade schema paths | — |
| B00.3 | LOCALLY_VERIFIED | first client | Build the golden acceptance runner and durable evidence catalog | — |
| B01.1 | LOCALLY_VERIFIED | first client | Atomic or durably recoverable close orchestration | CLOSE-01: incomplete; open: quarter-end, all-supported-modules; RACE-01: incomplete; open: entity-pair; YEAR-01: passed |
| B01.2 | LOCALLY_VERIFIED | first client | Correct year-end closing and ordered reopen/reclose | CLOSE-01: incomplete; open: quarter-end, all-supported-modules; RACE-01: incomplete; open: entity-pair; YEAR-01: passed |
| B01.3 | LOCALLY_VERIFIED | first client | Complete close gates and cures | CLOSE-01: incomplete; open: quarter-end, all-supported-modules; RACE-01: incomplete; open: entity-pair; YEAR-01: passed |
| B02.1 | LOCALLY_VERIFIED | first client | One complete native invoice accounting contract | BILL-01: passed |
| B02.2 | LOCALLY_VERIFIED | first client | Credits, writeoffs, voids, returns and collections | BILL-01: passed |
| B03.1 | LOCALLY_VERIFIED | first client | Durable effective-dated source history | HIST-01: passed; MIG-01: not_built (B03.3, B15.1); RESTORE-01: passed |
| B03.2 | LOCALLY_VERIFIED | first client | Shared historical subledger engine | HIST-01: passed; MIG-01: not_built (B03.3, B15.1); RESTORE-01: passed |
| B03.3 | LOCALLY_VERIFIED | first client | Opening outstanding-item migration and reviewed legacy attribution | HIST-01: passed; MIG-01: not_built (B03.3, B15.1); RESTORE-01: passed |
| B04.1 | LOCALLY_VERIFIED | first client | Contract and performance-obligation ownership | LOSS-01: passed; WIP-01: passed |
| B04.2 | LOCALLY_VERIFIED | first client | Period evidence, estimates and late adjustments | LOSS-01: passed; WIP-01: passed |
| B04.3 | LOCALLY_VERIFIED | first client | Presentation, bonded WIP and operational review | LOSS-01: passed; WIP-01: passed |
| B05.1 | LOCALLY_VERIFIED | first client | Complete annual payment classification | TAX-01: passed |
| B05.2 | PARTIAL | first client | Filing-ready review and partner handoff | TAX-01: passed |
| B06.1 | PARTIAL | first client | Consistent streamed capture and archive jobs | CAP-01: failed; open: failed-source-retries, close-review-reads; RESTORE-01: passed; STORE-01: blocked (B06.4) |
| B06.2 | PARTIAL | first client | Self-contained recoverable dependency package | CAP-01: failed; open: failed-source-retries, close-review-reads; RESTORE-01: passed; STORE-01: blocked (B06.4) |
| B06.3 | PARTIAL | first client | Full populated recovery and post-restore continuity | CAP-01: failed; open: failed-source-retries, close-review-reads; RESTORE-01: passed; STORE-01: blocked (B06.4) |
| B06.4 | PARTIAL | first client | Live storage retention and recovery | CAP-01: failed; open: failed-source-retries, close-review-reads; RESTORE-01: passed; STORE-01: blocked (B06.4) |
| B07.1 | LOCALLY_VERIFIED | first client | Authoritative posted dimension contract | DIM-01: passed; ENTITY-01: passed |
| B07.2 | LOCALLY_VERIFIED | first client | Statements, comparative periods and source detail | DIM-01: passed; ENTITY-01: passed |
| B08.1 | LOCALLY_VERIFIED | first client | Imported outstanding items and real clearing | BANK-01: passed; RACE-01: incomplete; open: entity-pair |
| B08.2 | BLOCKED_EXTERNAL | first client | Concurrent statement lifecycle and feed/import resilience | BANK-01: passed; RACE-01: incomplete; open: entity-pair |
| B08.3 | LOCALLY_VERIFIED | first client | Funding account, card and reimbursement truth | BANK-01: passed; RACE-01: incomplete; open: entity-pair |
| B09.1 | LOCALLY_VERIFIED | first client | Complete economic dependency invalidation | CAP-01: failed; open: failed-source-retries, close-review-reads; RACE-01: incomplete; open: entity-pair; STATUS-01: passed |
| B09.2 | PARTIAL | first client | Bounded workers, captures and review reads | CAP-01: failed; open: failed-source-retries, close-review-reads; RACE-01: incomplete; open: entity-pair; STATUS-01: passed |
| B09.3 | LOCALLY_VERIFIED | first client | Complete shared operational status and health | CAP-01: failed; open: failed-source-retries, close-review-reads; RACE-01: incomplete; open: entity-pair; STATUS-01: passed |
| B10.1 | LOCALLY_VERIFIED | first client | Complete source/policy coverage | CASH-01: passed; RESTORE-01: passed; TAX-01: passed |
| B10.2 | LOCALLY_VERIFIED | first client | Inventory, prepaids, capitalization and depreciation bridge | CASH-01: passed; RESTORE-01: passed; TAX-01: passed |
| B10.3 | PARTIAL | first client | Full tax workpaper and report delivery journey | CASH-01: passed; RESTORE-01: passed; TAX-01: passed |
| B10.4 | LOCALLY_VERIFIED | first client | Independently specified cash reconciliation | CASH-01: passed; RESTORE-01: passed; TAX-01: passed |
| B11.1 | LOCALLY_VERIFIED | first client | Effective-dated policy and contract history | DIM-01: passed; HOME-01: passed; PAY-01: deferred (B13); REV-01: passed |
| B11.2 | LOCALLY_VERIFIED | first client | T&M, cost-plus and GMP recognition and protected billing | DIM-01: passed; HOME-01: passed; PAY-01: deferred (B13); REV-01: passed |
| B11.3 | LOCALLY_VERIFIED | first client | Home closing, land/lot/development/inventory and closeout | DIM-01: passed; HOME-01: passed; PAY-01: deferred (B13); REV-01: passed |
| B11.4 | LOCALLY_VERIFIED | first client | Complete construction cost allocation policies | DIM-01: passed; HOME-01: passed; PAY-01: deferred (B13); REV-01: passed |
| B12.1 | LOCALLY_VERIFIED | first client | Contract-specific forecast loss and provision lifecycle | CLOSE-01: incomplete; open: quarter-end, all-supported-modules; HOME-01: passed; LOSS-01: passed |
| B12.2 | LOCALLY_VERIFIED | first client | Impairment review before remaining loss provision | CLOSE-01: incomplete; open: quarter-end, all-supported-modules; HOME-01: passed; LOSS-01: passed |
| B13.1 | LOCALLY_VERIFIED | deferred | Finish saved attribution history, detail, separate review and withdrawal | CAP-01: failed; open: failed-source-retries, close-review-reads; PAY-01: deferred (B13); PAY-02: deferred (B13); RACE-01: incomplete; open: entity-pair; RESTORE-01: passed; STORE-01: blocked (B06.4) |
| B13.2 | PARTIAL | deferred | Supporting evidence intake and valid signed claim journeys | CAP-01: failed; open: failed-source-retries, close-review-reads; PAY-01: deferred (B13); PAY-02: deferred (B13); RACE-01: incomplete; open: entity-pair; RESTORE-01: passed; STORE-01: blocked (B06.4) |
| B13.3 | PARTIAL | deferred | Initial construction decisions and independently reviewed monetary proposal | CAP-01: failed; open: failed-source-retries, close-review-reads; PAY-01: deferred (B13); PAY-02: deferred (B13); RACE-01: incomplete; open: entity-pair; RESTORE-01: passed; STORE-01: blocked (B06.4) |
| B13.4 | PARTIAL | deferred | Actual initial posting and complete lifetime status | CAP-01: failed; open: failed-source-retries, close-review-reads; PAY-01: deferred (B13); PAY-02: deferred (B13); RACE-01: incomplete; open: entity-pair; RESTORE-01: passed; STORE-01: blocked (B06.4) |
| B13.5 | PARTIAL | deferred | Funding, liability settlement, provider fees and remittance | CAP-01: failed; open: failed-source-retries, close-review-reads; PAY-01: deferred (B13); PAY-02: deferred (B13); RACE-01: incomplete; open: entity-pair; RESTORE-01: passed; STORE-01: blocked (B06.4) |
| B13.6 | PARTIAL | deferred | Provider formats and run types | CAP-01: failed; open: failed-source-retries, close-review-reads; PAY-01: deferred (B13); PAY-02: deferred (B13); RACE-01: incomplete; open: entity-pair; RESTORE-01: passed; STORE-01: blocked (B06.4) |
| B13.7 | PARTIAL | deferred | Complete coordinated payroll corrections and recovery | CAP-01: failed; open: failed-source-retries, close-review-reads; PAY-01: deferred (B13); PAY-02: deferred (B13); RACE-01: incomplete; open: entity-pair; RESTORE-01: passed; STORE-01: blocked (B06.4) |
| B13.8 | PARTIAL | deferred | Integrate close, cash, entity and reporting | CAP-01: failed; open: failed-source-retries, close-review-reads; PAY-01: deferred (B13); PAY-02: deferred (B13); RACE-01: incomplete; open: entity-pair; RESTORE-01: passed; STORE-01: blocked (B06.4) |
| B14.1 | LOCALLY_VERIFIED | first client | Decide and enforce the native legal-entity boundary | CONSOL-01: not_built (B14.4); ENTITY-01: passed; INTERCO-01: not_built (B14.3); RESTORE-01: passed |
| B14.2 | LOCALLY_VERIFIED | first client | Entity-specific workflows, ledgers, periods and cutover | CONSOL-01: not_built (B14.4); ENTITY-01: passed; INTERCO-01: not_built (B14.3); RESTORE-01: passed |
| B14.3 | LOCALLY_VERIFIED | first client | Intercompany transactions and reconciliations | CONSOL-01: not_built (B14.4); ENTITY-01: passed; INTERCO-01: not_built (B14.3); RESTORE-01: passed |
| B14.4 | LOCALLY_VERIFIED | first client | Consolidated reporting and eliminations | CONSOL-01: not_built (B14.4); ENTITY-01: passed; INTERCO-01: not_built (B14.3); RESTORE-01: passed |
| B14.5 | LOCALLY_VERIFIED | first client | Multi-entity migration, export, recovery and permission proof | CONSOL-01: not_built (B14.4); ENTITY-01: passed; INTERCO-01: not_built (B14.3); RESTORE-01: passed |
| B15.1 | PARTIAL | first client | Two entry routes and first normal transaction | — |
| B15.2 | PARTIAL | first client | Golden twelve-period scenario matrix | — |
| B15.3 | PARTIAL | first client | Failure, concurrency, permission and transport acceptance | — |
| B15.4 | PARTIAL | first client | Recovery, rebuild and nightly continuity | — |
| B16.1 | PARTIAL | first client | One current accounting policy and capability matrix | — |
| B16.2 | PARTIAL | first client | Operator and recovery runbooks | — |
| B16.3 | PARTIAL | with first client | Independent CPA and real-builder parallel close | — |
| B16.5 | NOT_STARTED | unscoped | Migration deploy inventory: know exactly what production needs | — |
| B16.4 | PARTIAL | deferred | Controlled rollout and organization activation | — |

## Observed failures and owners

- CAP-01 failed-source-retries and close-review-reads: the scenario's own search-reindex jobs do not drain within the kit's 60 queue passes at CAP volume (668 s run) — **B09.2**
- CLOSE-01 quarter-end and all-supported-modules not implemented — **B01.2 / B15.2**
- RACE-01 entity-pair not implemented — **B14.3 (buildable now)**
- MIG-01, GREEN-01, INTERCO-01, CONSOL-01, AUTH-01 not built — **B03.3/B15.1, B15.1, B14.3, B14.4, B15.3**
- STORE-01 needs real R2 storage — **B06.4 (needs an authorized test bucket)**
- PAY-01, PAY-02 — **B13 (deferred: payroll not day one)**
- pnpm lint error in tests/esign-access-code.test.js — **another session's uncommitted work (not Books)**
- Acceptance dev server returned 'use cache ... Expected a WorkStore' after routes were added while running — **B16.2 runbook: restart the acceptance app after adding routes (not a product defect; passes after restart)**
- Plain `npx tsc --noEmit` runs out of memory — **Verification command uses NODE_OPTIONS=--max-old-space-size=12288**
- Production migration ledger lacks 199 repository migrations — **B16.5**

## First-client items not yet verified

- B05.2 Filing-ready review and partner handoff (PARTIAL)
- B06.1 Consistent streamed capture and archive jobs (PARTIAL)
- B06.2 Self-contained recoverable dependency package (PARTIAL)
- B06.3 Full populated recovery and post-restore continuity (PARTIAL)
- B06.4 Live storage retention and recovery (PARTIAL)
- B08.2 Concurrent statement lifecycle and feed/import resilience (BLOCKED_EXTERNAL)
- B09.2 Bounded workers, captures and review reads (PARTIAL)
- B10.3 Full tax workpaper and report delivery journey (PARTIAL)
- B15.1 Two entry routes and first normal transaction (PARTIAL)
- B15.2 Golden twelve-period scenario matrix (PARTIAL)
- B15.3 Failure, concurrency, permission and transport acceptance (PARTIAL)
- B15.4 Recovery, rebuild and nightly continuity (PARTIAL)
- B16.1 One current accounting policy and capability matrix (PARTIAL)
- B16.2 Operator and recovery runbooks (PARTIAL)
