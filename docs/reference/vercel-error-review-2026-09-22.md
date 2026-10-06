# Vercel error review — September 22, 2026

Project: `arc` (`prj_XrpEzZsu7TSoFxWUuSVfvi7sQ8U3`), team `team_qP2zOoCxvZ2VYfBwpKAscLVz`.
Production deployment reviewed: `dpl_2eZYwELKUBge9nuErjH8JfPM7FAV`, commit `d863ce02bb6f8d910670cae2a72f4caa44045306`.

## Coverage

The seven-day grouped-error query returned 34 clusters. Cluster first-seen dates extend before the requested window; these are not 34 distinct current bugs. The separate 24-hour query returned two clusters: two rejected reminder emails at 13:00 UTC and one cookie mutation failure at 16:43 UTC on September 22. Raw deployment logs for 17:29–17:59 UTC returned no matching errors. Seven-day aggregation and 24-hour raw log retrieval timed out, so this is not an exhaustive event export.

Hourly monitoring is active in this task as `monitor-arc-vercel-errors`. Compare last-seen dates and deployment IDs, deduplicate historical clusters, and report meaningful changes only. Polling is subject to Vercel retention and API availability; it cannot guarantee capture of every event.

## Fixes in this checkout

| Failure | Change |
| --- | --- |
| Cookie writes while resolving organization membership | Removed writes from the shared render-time membership helper. Login and organization-switch actions still persist selection. Both regular-member and platform-admin paths have behavioral regression tests. |
| Permission checks start database work during prerender | Both route permission guards await request time before resolving auth or permissions. Suspension is not converted into an unauthorized redirect. |
| Stripe account updates fail retrieving recipient information | Resolve the local AP recipient first. Unrelated platform/receivables accounts do not trigger vendor bank-detail retrieval. Database and real provider failures still propagate for retry. |
| Payment reconciliation queries nonexistent `created_at` | Select `opened_at` under the existing DTO alias and sort by `opened_at`. Live database schema confirmed. |
| Warranty desk joins requests directly to lots | Nest lots beneath projects, matching live foreign keys. Update community filtering and DTO extraction accordingly. |
| Platform organization switch produces `NEXT_REDIRECT` error | Rethrow Next.js control-flow exceptions before converting application errors into action results. |
| Reminder delivery rejects example addresses | Detect reserved placeholder domains before invoking Resend. Return false with an actionable warning; do not mark undelivered or partially delivered batches successful. Real recipient addresses still need correction in source records. |
| Build validation lacks new preconstruction route inputs | Add the section parameter and optional search parameters to the inherited instant-navigation sample. |
| Help route overrides the inherited Sentry header samples | Include absent `sentry-trace` and `baggage` headers in its catch-all sample. |
| Project API logs a canceled prerender as a server error | Await request time and preserve framework exceptions in the route handler. |

## Historical groups and remaining verification

- Broad membership/default-org prerender errors last appeared September 16; existing app-chrome request boundaries already address those entry points. Permission-specific clusters last appeared September 17 and receive the guard fix above. Monitor after deployment for uncovered entry points.
- `DOMMatrix` errors last appeared September 16. The current file viewer already uses a browser-only dynamic import with SSR disabled.
- Drawing snapshot fallback and metadata job failures last appeared September 17. Job `9037` is still a historical failed row; its referenced sheet version no longer exists, so replaying it cannot repair a current sheet. Current metadata code preserves provisional results and uses bounded retries. Do not label missing AI output a successful verification.
- Two 300-second timeouts last appeared September 16. No current trace identifies a remaining timeout source; monitor for a reproducible recurrence rather than increasing limits blindly.
- Team-security lookup last failed September 16. The current MFA RPC exists and a read-only empty-input query succeeds. No evidence justifies weakening the security check.
- Stripe fixes are locally tested; production account permissions and webhook recovery still require post-deployment verification.

## Validation

- 72 focused tests passed, including six new behavioral regressions plus existing authorization, warranty, and navigation tests.
- TypeScript check and focused ESLint passed.
- Corrected incident query, warranty relationship query, and community-filter query each returned HTTP 200 from the live Supabase Data API with zero-row limits.
- Production Webpack build passed, including TypeScript and generation of all 418 pages. Initial Turbopack attempts encountered environment restrictions (font network access, then local port binding). Webpack emits an existing libheif dynamic-require warning; synthetic anonymous build samples also produce auth-denial logs.

These changes are local. Production resolution is not verified until a deployment containing them receives traffic and the relevant error groups stop recurring.

## Monitor checkpoint — September 22, 18:59 UTC

Grouped runtime errors since 17:29 UTC: none. No new deployments since that checkpoint. Production error/fatal logs from 18:28–18:59 UTC: no matches. Production remains on the previously reviewed deployment; local fixes remain unverified in production. No new code changes or repeated tests were warranted.

## Monitor checkpoint — September 22, 21:00 UTC

New occurrence at 20:11 UTC: subscription persistence failed with SQL 23502 because `current_period_start` was null. The stored `customer.subscription.updated` webhook uses API 2025-11-17.clover and contains valid item-level periods; top-level periods are absent. The webhook was nevertheless marked processed. No new production deployment was observed.

Local fix: support legacy subscription-level dates and current primary-item dates, validate the period before writing, and propagate persistence errors so the webhook returns failure and can retry. Six behavioral tests cover insert/update, legacy dates, missing periods, and database failures. Focused lint passes.

Production recovery remains pending deployment: reconcile subscription `sub_1TZzACFZq01YONhtX4rM4DRy` against current Stripe state. Event `evt_1UIa1zFZq01YONhtfUAIgt2f` was already acknowledged and marked processed, so an ordinary redelivery is skipped by existing idempotency logic. Do not replay an old snapshot blindly or assume automatic retries will repair this occurrence.

## Monitor checkpoint — September 22, 22:00 UTC

Two failures at 21:11–21:12 UTC for `evt_3UIaykFZq01YONht1ifeCbXE`: the receivables mapper accepted a payment intent with empty metadata and selected `amazon_pay` from its enabled-method list. The invoice payment validator rejected that value. No new production deployment was observed.

Local fix: successful/processing intents with neither Arc invoice nor organization attribution return no receivables event. The webhook's existing ignored-event path acknowledges these unrelated payments. Partial attribution remains on the existing error path, and vendor-payment isolation is preserved. Eight regression tests and focused lint pass. Fix not deployed; the stored webhook is still failed pending recovery after deployment.
