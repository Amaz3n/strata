# Q07 implementation handoff: bounded transport and truthful maintenance

Status: IN PROGRESS. Parent program: `014-qbo-integration-completion.md`, Q07. Planned against the captured dirty-workspace snapshot at commit `9f1549af84a6998eb2d851415ec6f119ab89a96f`, not bare HEAD. Use the existing isolated checkout `/private/tmp/arc-qbo-goal-01a109ed`. No production connection or environment files.

## Problem and outcome

OAuth token exchange/refresh/revoke and company/pattern GETs use unbounded fetch. The client already has 45-second request signals and an AsyncLocalStorage deadline, but 429 delays cap a provider-requested wait at 60 seconds and do not parse HTTP dates. CDC polls ten companies sequentially without an overall budget. Keepalive lookup errors become zero-success telemetry; failed refreshes are ignored by outbox HTTP status. New transport must bound the whole exchange including response consumption, retain retry ambiguity safeguards, allow subsequent tenant work, and visibly record maintenance failure.

## Scope

`lib/integrations/accounting/qbo/auth.ts`, `client.ts`, `connections.ts`; new small transport helper under that QBO directory if justified; `lib/services/accounting-connections.ts` and `lib/integrations/accounting/provider.ts` only for additive maintenance-result contract/budget integration; `app/api/accounting/process-changes/route.ts`, `process-outbox/route.ts`; new `tests/qbo-worker-reliability.test.js` and existing accounting tests only where accurate fixture contracts need evolving. Do not touch financial import/reconciliation, money RPCs, encryption format, settings/UI, deployments or shared-source code without review. Preserve the Q03 commit.

## Existing seams

- `accounting-delivery.ts` exports `accountingDeliveryDeadline`, `withAccountingDeadline`, and typed `AccountingDeliveryError(retryable, reason)`; reuse the earliest inherited deadline.
- `QBOClient.fetchEndpoint` attaches a signal. `request` retries GET network/5xx and 429; uncertain POSTs are not retried. Upload/PDF calls also use fetchEndpoint. Do not regress these call sites or break streams by cancelling a response before the caller consumes it.
- `refreshConnectionTokens` persists with previous encrypted refresh token CAS, retries persistence once, and avoids stale errors expiring newer credentials. A bounded request must retain this behavior. Budget exhaustion before a request begins must not count as failed authorization or expire the connection.
- CDC rotates `last_inbound_poll_at` before an attempted request to prevent a failing tenant monopolizing the oldest-first selection. Preserve this fairness, while leaving unstarted connections untouched. The provider cursor is distinct and must not be advanced by a worker timeout.
- Cron wrapper classifies non-200 results; existing partial failures use HTTP207. Continue outbox work after a safely classified keepalive failure, report separate counts, and do not swallow database errors.
- Node behavioral fixtures transpile actual TypeScript modules with explicit infrastructure stubs. Use `tests/qbo-webhook-contract.test.js` and `tests/accounting-inbound-closure.test.js` as patterns. Every real infrastructure import must be stubbed; no env file loading.

## Required behavior

1. Every OAuth/company/pattern request uses a finite policy (default 10 seconds is acceptable) and earlier inherited deadline. Cover response.json/text consumption, not only headers. No refresh/revoke/token-exchange network retry on an ambiguous timeout. Never start a request when the deadline is already exhausted. Use safe errors with operation, status and Intuit correlation ID; never include credentials or arbitrary provider response bodies. Preserve invalid_grant classification using typed/allowlisted OAuth error codes rather than raw body dumping.
2. CDC uses an 85-second overall budget and a finite per-connection slice (default 10 seconds) so one hung company cannot spend the whole invocation. Iterate only while time remains, rotate only attempted companies, count attempted/deferred separately, and expose failure/budget exhaustion truthfully. A failed error-write is visible. No arbitrary Promise.race that leaves an uncancelled provider write running in the background.
3. Keepalive uses a bounded sub-budget inside outbox (default 20 seconds), stops before starting later refreshes after exhaustion, and reports deferred/unstarted work separately if contract extension is needed. Lookup failure is explicit failure. Preserve CAS/rotation semantics and make each attempted connection failure independent. Unattempted credentials stay due. Existing callers accepting scanned/refreshed/failed remain compatible.
4. Both empty and nonempty outbox responses classify maintenance failure as207 or explicit500 for an unrecoverable initialization failure. Successful deliveries stay counted; no new remote requests after the main budget is gone; owned unstarted jobs are released through existing outbox persistence.
5. Retry-After accepts positive seconds and HTTP dates. Never shorten the provider wait to a cap then send early. If the wait cannot fit the remaining budget, return a typed retryable throttle/deadline outcome instead of sleeping away the invocation; retain remote uncertainty protection and correlation IDs. Do not add blind POST retries. Existing default read backoff remains bounded.
6. Fake-clock/abort-aware behavioral tests prove each of the five auth requests is abortable, an exhausted deadline makes zero fetches, body stalls abort, workers finish within their budgets, a failed tenant allows another, pending later tenants/credentials remain eligible, keepalive database errors cannot be green, and Retry-After seconds/date and insufficient-budget cases do not send early. Tests execute real module functions and route boundary responses. Old behavior should fail the relevant regression assertions. No real sleeps, network or credentials.

## Verification

Run scoped Node accounting/QBO tests, changed-file ESLint (without --fix), relevant Bun transport/auth tests, and full `COREPACK_ENABLE_AUTO_PIN=0 pnpm typecheck`. Full lint can be run if cheap. No local build/dev server because the ordinary environment points to production. Record exact commands, pass/fail/skip counts and logs. Scope audit with git diff. Commit only implementation scope in the isolated checkout, never push or commit the user branch. Root maintains advisor-plans.

## Stop conditions

If a solution requires a live provider, production migration, changing posted financial facts or a broad service authorization redesign, stop and report that boundary. If default policy cannot be implemented without a source cycle, propose the small helper seam before broad refactoring. Do not claim full Q07 acceptance from source-regex-only checks or reuse old baseline counts.
