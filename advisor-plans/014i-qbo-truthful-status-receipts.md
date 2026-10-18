# Q09 handoff: truthful status, delivery clocks and import receipts

Status: TODO; this is a full Q09 handoff, not acceptance. PriorityP1, effortM, riskMED. Planned October5,2026 against shared commit `9f1549af84a6998eb2d851415ec6f119ab89a96f` plus reviewed dirty workspace. The full goal has125 original clauses; this handoff preserves all seven Q09 clauses. One isolated executor only; root owns status. Do not edit the shared branch, load `.env.local`, call QBO, apply production SQL or move customer money. Execution follows current Q04 review and prerequisite import outcome work; no second executor is authorized.

## Problem and current contracts

`components/integrations/accounting-sync-sheet.tsx:84` initializes items=[]/connected=true, and `load` catches failures only with a toast. Its header derives “In sync” from an empty array; the empty pane says “Everything is in sync.” Neither distinguishes an unread queue from a successfully empty queue. Refresh failure leaves previous data looking current. History has the same missing persistent error state. Current callbacks have only projectId dependencies; connectionId already exists in Props but is absent from queue/history requests. A late response after scope changes can display another company's results.

The same sheet derives lastSyncedAt from the first history entry whose status is not error, and history dots color every non-error green. `lib/services/accounting-sync-attempts.ts` defines the actual outcome union: synced,skipped,deferred,error,needs_review,conflict. Only synced proves successful delivery. File export badges elsewhere deliberately distinguish exported files from provider posting; preserve that vocabulary.

`app/(app)/integrations/accounting-sync-actions.ts` currently exposes `AccountingSyncHistoryItem.status:string`, `direction:string` and `syncedAt` for every attempt's created_at. Do not fabricate success by retaining `row.outcome ?? 'synced'`; null/unknown historical outcomes must be labeled unknown. Queue enrichment silently ignores invoice/expense/bill/payment query errors. All required reads must either yield a valid complete scoped result or fail visibly. Provider-neutral records, org/division/project permissions and expired/disconnected backlog retention remain mandatory.

`components/integrations/qbo-import-sheet.tsx:728` stores a summary only when result.imported>0. It constructs counts/items from every submitted record, including failed/skipped ones. Its links around941 use the context project despite item allocations into other projects. `lib/integrations/accounting/import.ts` currently returns aggregate imported/skipped/failed/errors/affectedProjectIds; it cannot prove a particular successful item's identity or destination. Do not reconstruct a success list by subtracting errors from submissions: duplicate source IDs, skips, partial fan-out and interrupted execution invalidate that inference. Q11 must establish durable per-record outcome receipts through the existing owned claim/persistence paths before Q09-06 can be verified.

## Scope and dependencies

Modify only the two integration sheets, accounting-sync-actions types/read error propagation, an optional focused pure presentation/state helper under `lib/integrations/accounting/`, and dedicated tests. Additive receipt DTO adoption is allowed only after the reviewed Q11 producer exists. Q10 owns query scoping/keyset/counts/company health; coordinate its resulting DTO instead of building a competing queue or passing ignored connection parameters. Q11 owns durable import receipt storage/producer/recovery. Q09 may land a reviewed status slice, but stays IN PROGRESS until every original criterion is fulfilled.

Never change provider dispatch, import financial creation, cash corrections, accounting authority mode, job leases, permission policy, global toast behavior or design primitives. Reuse existing CenteredState/ListSkeleton/Button and semantic success/warning/destructive/muted tokens from `docs/design.md`; preserve the existing sync/review/conflict actions.

## Steps and executable gates

1. Capture existing failures with actual component/action behavior using synthetic dependency doubles. Follow executable TypeScript module loading in `tests/accounting-inbound-closure.test.js`; imports must be explicit and native fetch fail closed. For rendered behavior use the actual React component and controllable deferred action results. `tests/browser/books-payroll-workspace.test.js` provides the repository's isolated browser-fixture pattern, with temporary artifacts and a synthetic local action bridge rather than a production Next server. Any new harness dependency/file scope must be reviewed first; no install/build/dev server. Gate: `node --test tests/accounting-status-presentation.test.js` must show the named old-behavior failures, not source-regex-only assertions.
2. Represent queue and history reads independently as unloaded/loading/loaded/error, retaining prior successful payload separately when refreshing. Persist sanitized error text and Retry. Mark retained payload stale and suppress healthy/empty-success claims while refresh is failed or pending. Disable bulk action based on unreliable scope/data. Close/scope changes invalidate prior requests with a generation or abort guard; one scope's late result cannot replace another scope's payload. Loading may show retained rows as refreshing, but must never assert freshness. Gate: actual component fixtures cover initial failure, success-empty, success-nonempty, refresh failure, Retry success, close/reopen and project/company response inversion.
3. Introduce an exhaustive outcome presentation map checked against `AccountingSyncAttemptOutcome`: synced=success; skipped=neutral with reason; deferred=waiting; needs_review/conflict=attention; error=failed. Unknown runtime outcome=unknown/neutral, never synced. Carry attempt time separately from successful delivery time. Compute inbound/outbound successful clocks independently and only from actual synced outcomes. If history pagination cannot contain the last true success, consume Q10's complete-scope clocks or label this as latest successful attempt on the displayed page; do not imply absence is “never synced.” Gate: every union outcome and unknown/null runtime outcome is rendered and clocks are asserted with a newer conflict/deferred/skipped preceding an older synced row in each direction.
4. Check and propagate every required action read's error before returning queue/history health. Preserve optional best-effort trace storage behavior: a failure to write an explanatory attempt is not itself a failed financial delivery. Gate: actual action fixtures fail each connection/project/enrichment/history query separately and return no false healthy DTO; permission failures still precede privileged reads.
5. Adopt the reviewed durable Q11 receipt. Render actual per-record created/adopted/already-complete/skipped/failed/interrupted outcomes, with failed-only receipts retained. Use receipt-persisted entity/project IDs for links, including multiple allocations; do not use context project or submitted project as destination evidence. Counts reconcile to actual item dispositions and linked children; one source record split across projects is not several successful source imports. Missing/ambiguous outcome remains incomplete, never green. Retain receipts across listing refresh and allow retry of eligible failed items through Q11's existing run semantics. Gate: actual mixed2success/1skip/1failure, failed-only, zero-new/adopted, partial fan-out, changed destination and interrupted/reloaded fixtures; links must match actual persisted projects.
6. Run complete package gates, prepare one immutable isolated commit and a file/hash manifest for root review. Root reviews every hunk and reruns the tests before shared source copy. No root-authored source changes; root owns checklist acceptance. Gate commands below all pass without skipped cases or accidental network.

## Required commands

From the disposable executor checkout, use `COREPACK_ENABLE_AUTO_PIN=0` for every pnpm invocation:

```sh
node --test tests/accounting-status-presentation.test.js tests/accounting-status-actions.test.js
node --test tests/accounting-*.test.js tests/qbo-*.test.js
COREPACK_ENABLE_AUTO_PIN=0 pnpm typecheck
COREPACK_ENABLE_AUTO_PIN=0 pnpm exec eslint components/integrations/accounting-sync-sheet.tsx components/integrations/qbo-import-sheet.tsx 'app/(app)/integrations/accounting-sync-actions.ts' tests/accounting-status-presentation.test.js tests/accounting-status-actions.test.js
git diff --check
```

Add actual new helper/harness paths to ESLint and explicit browser-fixture commands once reviewed. Relevant existing Bun QBO client/webhook/error-rules/sync-safety/account-utils suites must remain green. Do not run the broad `verify` script: it contains build and unrelated production-oriented gates outside this package's authority. Record runtime and test counts; no assertion count presented as scenario count.

## Original code definitions of done

- Q09-01: unloaded/loading/error/loaded are distinct in actual rendered queue/history fixtures.
- Q09-02: failed reads show a persistent retryable error; retained data is stale and empty data alone cannot be green.
- Q09-03: explicit map covers synced/skipped/deferred/needs_review/conflict/error, with unknown fallback never successful.
- Q09-04: only actual delivered/synced attempts advance success time.
- Q09-05: inbound and outbound success clocks are separately labeled and verified.
- Q09-06: partial/failed-only imports retain receipts; actual persisted per-item outcomes and destinations drive rows/counts/links. Depends on full Q11 producer verification, not a fabricated DTO stub alone.
- Q09-07: fixtures cover every outcome and named failure/refresh/scope race transition; targeted Node, relevant Bun, full types, changed lint and diff gates pass with zero skips.

## Stop conditions and maintenance

Report a missing durable per-item producer, ignored/unscoped connection parameter, new harness dependency, unknown provider outcome semantics, or changed source excerpts before expanding scope. Continue independent status tests while a dependency is being completed; do not call the package complete. Preserve authorization and financial ownership. Future outcome additions must fail exhaustive type checks until presentation is defined; future pagination must retain complete-scope success clocks and stale-request guards.
