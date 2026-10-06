# Q16 handoff: transaction modules and measured bounded work

Status: TODO; all thirteen original Q16 clauses remain false. Priority P1/P2, effort L, risk MED/HIGH because refactoring can silently change financial meaning or recovery guarantees. Planned October 5, 2026 against shared HEAD `9f1549af84a6998eb2d851415ec6f119ab89a96f` plus reviewed dirty source; isolated integrated baseline `75e9810dad944ffefacbfd515edbcb182b00956a`. Refresh source hashes after Q03–Q15 implementations. The one source executor remains on Q05; this is an execution handoff, not a new dispatch or code acceptance.

Preserve all 125 original goal clauses. Executor works only in its disposable checkout; root reviews immutable artifacts and updates advisor-plans only. No shared commits/merge/push, production environment files, live provider/money/remote SQL, destructive D2 cleanup, dependency installs or local application build/dev server. Explicit synthetic provider/auth/database fixtures and disposable SQL only. Production rollout and CI application-build acceptance remain Q17.

## Current code and independently measured evidence

Shared QBO adapter/import/reconcile/client are 2,429/3,987/1,473/1,348 lines respectively at the hashes below. The isolated Q05 draft already introduces cost-source/cost-lines/cost-comparison; use the accepted versions after review instead of creating a duplicate translator. Invoice import/reconcile still contain separate money/line translation and adapter contains its own cent/total rules. Refactoring must follow accepted financial golden behavior, especially invoice discounts/tax, signed cost credits, payment applications and refunds.

`client.ts:listTransactionsForImport` builds one array and a seen-ID set, fetches pages of 1000, then sorts/returns up to 25,000 records. Its comment still says default 5000. At the cap it logs truncation without returning a continuation/completeness result. `import.ts:listImportableQboRecords` loads requested physical families concurrently, materializes translated records, reads matching candidates and returns one whole records array. It does dedupe Purchase/JournalEntry virtual family fetches and uses bounded mapping reads; retain those strengths. `AccountingImportPreviewInput/Listing` and strict service preview schema have no pagination cursor. Import execution currently limits document workers to four, serializes payment phase and chains duplicate selections; do not replace those guarantees with an unbounded Promise.all.

Parent actual full client and actual QBO listImportableQboRecords measurements are persisted in `advisor-plans/014-qbo-efficiency-baseline.json`. Three separate GC-baselined processes per mode/cardinality, explicit lightweight one-line synthetic Bill rows, fake provider HTTP and empty read-only SQL/auth fixtures. Exact probe `/private/tmp/q16-parent-history-measure.js`, aggregate `/private/tmp/q16-parent-history-measurements.json`. Preview baseline was corrected to GC after loading actual modules; exploratory measurements including module initialization were discarded. Samples at request/serialization/method-return boundaries are OBSERVED heap peaks, not an exhaustive profiler maximum. No real provider latency, real financial database, provider-neutral conversion/action/UI or authorization acceptance is claimed.

| Actual method / rows | HTTP GETs | Returned JSON bytes | Max observed additional heap MiB |
|---|---:|---:|---:|
| marker / 1,000 | 2 | 402 | 2.10 |
| marker / 10,000 | 11 | 402 | 13.25 |
| marker / 25,000 | 26 | 402 | 28.50 |
| client import list / 1,000 | 2 | 401,792 | 2.57 |
| client import list / 10,000 | 11 | 4,037,794 | 13.41 |
| client import list / 25,000 | 25 | 10,127,794 | 34.54 |
| QBO preview function / 1,000 | 2 | 483,843 | 5.49 |
| QBO preview function / 10,000 | 11 | 4,857,845 | 24.12 |
| QBO preview function / 25,000 | 25 | 12,177,845 | 48.71 |

Preview uses six synthetic SELECTs at every measured cardinality. At 25,000 the cap prevents a terminal empty page; the returned list does not prove complete history. The lightweight observed heap is below 128 MiB already; do not call that a measured memory failure. The confirmed deficiencies are whole-response size, lack of resume and request concurrency. Wall time/runtimes/external buffers/RSS are in the evidence; synthetic execution time is not network latency.

Parent actual two same-realm QBOClient instances admitted ten simultaneous held getBillById HTTP requests, peak ten. `/private/tmp/q16-parent-limiter-characterization.test.js` passes 1/1 negative, log `/private/tmp/q16-parent-limiter-characterization.log`, evidence `/private/tmp/q16-parent-limiter-evidence.json`. Synthetic fetch barriers prove in-process dispatch behavior; they are not distributed-worker or rate-clock proof. Source search found refresh single-flight and429 backoff, but no shared request limiter. Q07 deadlines remain accepted independently.

Previously verified actual 100-line invoice adapter fixture issued 100 item lookup methods with peak100 and five DB reads before its deliberate pre-POST stop; evidence `/private/tmp/q13-parent-preflight-characterization-evidence.json`. Q13 owns the first in-flight Promise dedupe fix; Q16 must preserve and measure the actual public facade after modularization. Q15 owns supported request-ID retry improvement from26 historical GETs to0; Q16 retains historical resumability without weakening complete/unique identity recovery.

## Original thirteen definitions of done

1. Q16-01: break transaction families into cohesive modules, share canonical invoice/line/money translation and remove duplicate implementations.
2. Q16-02: Transport, domain mutations and UI DTOs remain separate.
3. Q16-03: No new any/as escapes or speculative generic framework.
4. Q16-04: Existing behavioral fixtures run unchanged against the public facade.
5. Q16-05: Reference lookup request count is proportional to distinct refs, not number of lines; a 100-line invoice using one item performs one item lookup per dispatch.
6. Q16-06: Import preview pages contain at most 200 rows and at most 1 MiB serialized JSON for the supported synthetic fixture.
7. Q16-07: Traversing a 25k-record history is resumable rather than a single unbounded action.
8. Q16-08: Peak additional heap for the 25k lightweight fixture stays below 128 MiB; measure baseline, rows and payload bytes at 1k/10k/25k.
9. Q16-09: Import execution concurrency defaults to at most four items and is bounded further by per-realm transport limits.
10. Q16-10: Concurrent requests are bounded per realm (default at most two in flight); the controllable-clock limiter fixture admits no more than eight starts per realm per second across cooperating workers.
11. Q16-11: Raising global concurrency alone is not a fix.
12. Q16-12: Record before/after calls, queries, wall time, fixture/runtime/sample sizes and peak memory where measurable.
13. Q16-13: Require no regression and a demonstrable request/query reduction in the named repeated-reference and recovery cases.

These are the original criteria, with spacing normalized for readability; none is reduced or replaced.

## Scope, dependency order and design conventions

Prerequisites: accepted Q03–Q15 actual financial/authorization/delivery/import/version/UI contracts and characterization suites. No sweeping extraction while their behavior is still changing. Scope: existing adapter/import/reconcile public facades, cohesive QBO transaction-family/translation modules, typed preview/progress DTO/service/action/UI compatibility, one narrowly approved private realm limiter/resume persistence contract if needed, fixtures/benchmarks and registrations. Do not alter canonical Books authority, permissions, source identities, posted-money rules, webhook/CDC acknowledgement or OAuth company ownership as a refactor side effect.

Use existing strict Zod action boundaries, ActionResult and AccountingDeliveryError conventions. Provider interfaces remain neutral; provider payload validation/transport belongs in qbo modules and canonical domain mutations in services/SQL. Dense token-only integration controls per docs/design.md; use current loading/error/partial/resume patterns. A thin facade delegates meaningful families, rather than several renamed giant files or a speculative plugin framework. Share accepted canonical invoice/discount/tax/money and complete cost translators; typed adapters translate provider DTOs once. Avoid circular imports and importing entire UI modules into service code.

## Ordered implementation and verification

### 1. Freeze behavior and extract cohesive typed families

Inventory exported facade signatures/capabilities and internal ownership. Identify invoice/credit/refund, purchase/cost-credit, payable/vendor-credit, payment/application/reversal, journals/deposits, attachments and metadata/setup families. Keep stable qboProvider and import/reconcile worker entry points; extract small cohesive translators and family commands behind them. Reuse accepted cost/invoice translation and domain services; do not widen support by a generic any payload. Unknown provider input is validated at the boundary, not cast to a successful shape. No new any/as bypass, no disable-lint suppression, no success fallback for missing fields. Existing historical tests remain intact; add behavior coverage rather than rewriting assertions to fit extraction.

**Gate:** `node --test tests/accounting-*.test.js tests/qbo-*.test.js` before/after same accepted fixture inputs and public entry points, zero failures; golden invoice/discount/tax/signed credits/payment allocation/refund/source-version/permission tests unchanged. `pnpm typecheck` and changed-file eslint exit0. Root checks every removed duplicate and module dependency direction, not just line counts. No financial capability accepted solely from registration/source regex.

### 2. Add bounded company-bound preview pages and resumable traversal

Propose exact cursor/resume schema before service/SQL expansion. Cursor binds org, connection, pinned realm/provider environment, authorized selected types/date/filter, stable run/version and per-physical-family progress; virtual families share one physical fetch. Validate signatures/server-owned opaque tokens and bounded IDs. Reject stale/foreign/tampered/filter-changed cursors before provider/SQL work. Current provider offsets are not a snapshot guarantee: insertions/deletions/reordering/overlapping pages must produce explicit uncertainty/restart or a certified dedupe/completeness protocol, never silently omit records. Root must review this protocol and exact SQL before coding. Reuse Q04 recovery candidate/progress concepts only where semantics actually match; do not overload a CDC run as an import receipt.

Return at most 200 translated preview rows and at most1,048,576 serialized JSON bytes INCLUDING envelope/cursor/errors/metadata for the supported fixture. Fetch/hydrate only the current bounded page; never load25k then slice200. Collect candidate refs/maps once per page/distinct scope, bounded batches; replace O(records×candidate-list) searches with typed indexes where identity rules permit. Keep cross-project/division visibility and imported counts correct before truncation; hidden records cannot leak through suggestions/counts. Clearly distinguish displayed-page count from complete scoped total and unknown total. Q10/Q11 own durable receipt/domain authorization; preserve those contracts.

If one record/line group exceeds byte bounds, return a bounded explicit unsupported/detail-review entry or separately authorized paged details. Do not truncate money/allocation proof and offer incomplete execution. Preserve complete selected record proof for Q05/Q06 actual import; provider fetch can revalidate exact selected record/version rather than accept narrowed preview as authority. Large descriptions/nested linked docs/many lines must not blow the envelope or hide an overflow error.

Every bounded call leaves durable/opaque progress usable after process restart, error/retry/deadline and UI close. Twenty-five thousand rows are traversed through repeated bounded calls; no single action or retained UI array owns the entire history. Page navigation/load more/search uses bounded state and stable selection keyed by immutable external/type identity. Selection across pages remains canonical and revalidated on execution. A historical marker scan can stop only at a persisted progress boundary without authorizing a new create; absence/uniqueness is certified only after complete stable scan. Persist exact seen-ID/match/ambiguity evidence in bounded private storage when needed, not a 25k in-memory Set hidden behind a cursor. Do not resume by transaction date alone or stop at the first marker match.

**Gate:** `node --test tests/qbo-import-preview-pages.test.js tests/qbo-history-resume.test.js` executes actual service/action/provider-client/page DTO and current permissions with1k/10k/25k fixtures. Each serialized page≤200 rows/1MiB; final traversal preserves every identity once; restart/different worker resumes; page invertions/overlap/same-date IDs/deletions/changed realm/filter/permissions/oversize failure are explicit and bounded. Named25k traversal requires multiple bounded calls and never reports absence/create permission before certified completion. Include a late duplicate marker after an early match. Full same-company golden import/failed-only receipt behavior remains passing.

### 3. Enforce realm request limits across cooperating workers

Before SQL send root exact admission/release/expiry/CAS contract, key semantics, lock order, maximum queue/cardinality, deadline/backoff policy, private grants, failure/cleanup and migration-first rollback. Default goal policy is two concurrent requests and eight starts per realm per second; these are this goal's conservative limits, not a claim about current Intuit quotas. Distinct connection objects/workers for the same provider environment/realm share admission. Separate realms do not unnecessarily block each other. Scope authorization to the owned connection while keeping any shared realm state private; no cross-org leakage. An instance-local semaphore alone cannot pass the cooperating-worker clause.

Reserve bounded admission immediately before actual HTTP, under inherited worker deadline. Every actual request/retry, including401/429/recovery/metadata and supported financial replay, passes admission. Waiting cannot consume the remaining platform budget indefinitely; deadline/abort/lease loss removes queued work and makes0 HTTP starts. No holding global DB transaction locks over HTTP. Current Q07 abort/keepalive and Q15 uncertain-write safety remain effective. Rate accounting must cover the tested rolling one-second windows, including boundary bursts, rather than a fixed bucket that admits16 starts straddling a boundary. Acquire/release operations are bounded and exact; count their DB overhead in measurements.

Permits are recoverable after process crash but cannot expire/reclaim while the old request is still eligible to run. Tie physical abort timeout to the permit lifetime, recheck ownership before dispatch and define safe late-result handling. Duplicate release/expired owner cannot release another request. Retry-after/backoff does not occupy an inflight slot while asleep; it still consumes a new start admission when sending again. Errors/parse failures/aborts release owned permits; financial uncertain outcomes remain unresolved evidence, not safe new operations. Missing limiter SQL fails closed for paths depending on it; do not silently fall back to unlimited traffic.

**Gate:** `node --test tests/qbo-realm-limiter.test.js tests/qbo-realm-limiter-db.test.js` runs actual transport with controllable clock/barriers across at least two clients and two cooperating worker contexts:≤2 held requests per realm,≤8 starts in every tested rolling1s interval, cross-boundary burst, separate realm progress,401/429/read retry, deadline while queued, exception/parse/abort release, late response/expired ownership, process restart and migration failure. Exact service-only privilege and real PostgreSQL two-session admission/contention fixtures are required separately from clock mocks. No skipped runtime counted as passed distributed proof. Parent ten-held-request negative must become bounded two without weakening assertion.

### 4. Preserve bounded import dependencies and distinct-reference reuse

Keep import document phase at most four items, then protected payment/application/reversal phases with current domain ordering and duplicate serialization. Four item workers do not authorize four HTTP requests in the same realm; transport admission bounds further. Q11 durable per-record outcomes survive a worker error/restart and retain ordered receipts, actual targets and completed-item non-reexecution. Do not start dependent payment until all required documents are durably available. No unbounded `Promise.all` over requested records, lines or families bypassing shared admission.

Preserve Q13 in-flight lookup Promise caching before await, keyed by company/settings/ref kind+ID per dispatch; rejected lookup dedupes too. Bounded batch queries resolve many distinct refs only when provider semantics support them.100 lines/one item uses one lookup;100 lines/two items uses two; same numeric IDs across realms never share proof. Current setup/source version changes invalidate stale cached proof. Keep display metadata separate from material identity. Failure before preflight makes0 financial POSTs; no unattended Account/Item creation as a fallback.

**Gate:** actual public100-line dispatch/full import fixtures record method+HTTP+DB counts,≤4 item workers and≤2 same-realm HTTP, exact dependencies/duplicate ordering, partial-failure receipts and different-company/failing refs. No test that stubs out the limiter or replaces actual adapter with a synthetic function can certify its interaction.

### 5. Measure, profile and deliver exact artifact

Add portable synthetic benchmark using accepted public entry points and explicit no-network fixture configuration. Record fixture schema/version/cardinality/rows/bytes, runtime/V8/architecture, GC/load/warmup/sample count, provider method/HTTP/DB queries, wall time, observed heap/RSS/buffers and profiler strategy. Measure baseline and after at 1k/10k/25k, at least three independent samples each. Do not compare before raw provider rows against after narrowed DTOs without reporting both sizes/scopes. Measure peak additional heap for the 25k lightweight COMPLETE resumable traversal below 128MiB, including retained cursor/selection/client state; use sufficiently fine profiling or allocation bound to establish peak, not only after-GC snapshots. Parent boundary samples are leads, not that final certification. Long nested/large-line fixtures exercise bounds separately from lightweight heap benchmark.

Named repeated-reference case must demonstrate100→1 actual item lookup without query regression; named supported response-lost recovery must preserve Q15's26→0 historical requests and1 remote document. Historical25k traversal remains complete and resumable with bounded peak/response; do not require fewer pages by increasing page size above its cap. Report new limiter/progress DB overhead honestly and improve repeated/redundant reads where possible. No faster fixture by skipping authorization/preflight/financial invariants, lowering rows or suppressing failed pages.

Run full accounting/QBO Node, six existing QBO/local-change Bun files with `bun test --preload ./scripts/bun-test-setup.js`, actual auth/financial/source/current Books regressions, types, changed-file lint, `git diff --check`, exact migration forward replay/roles and no-Git portable focused checkout. New critical suites zero failures/skips/cancellations. Q17 retains full suite/CI application build/browser/release evidence. Deliver isolated code-only immutable commit, before/after hashes, measurements/profiling evidence and rollout/rollback dependency inventory. Root independently reruns exact artifact before hash-guarded shared copy; no production rollout implied.

## Maintenance and stop conditions

Family extraction, canonical money/source DTOs, settings cache keys, provider entity registry, preview cursor version and private limiter/progress SQL evolve together. Keep request admission separate from durable financial operation identity and human import receipts; one cannot replace the other. A provider/list schema or supported family change requires versioned validation/golden/resume/size/limit fixtures. Report a concrete proposal if provider ordering cannot certify resume, a single record cannot be bounded without losing economic meaning, distributed permits can overlap after expiry, or extraction needs a broader domain change. Do not drop scope to a one-process limiter, paged rendering of a preloaded25k array or unverified memory claim.

## Planned shared source hashes

- `lib/integrations/accounting/qbo/adapter.ts`: `a8ce1660e7712f54f6ab46e5ad42b5b7b2fc5bca06c76fb3dc48c1cbdd627bb4`
- `lib/integrations/accounting/qbo/import.ts`: `8ecfa340a4c24fc44a90e259193ebd55bea7c5518512be008575aa3f1f4fc71c`
- `lib/integrations/accounting/qbo/reconcile.ts`: `1adcfcff30a85302530095478832a8f927d2afec610c12dee394c3081857430b`
- `lib/integrations/accounting/qbo/client.ts`: `3b1646581aae526f2db2fb08529090736272facd91981a16735745b8728301f4`
- `lib/integrations/accounting/import.ts`: `d552f37b03eaccef5b20888ac964730bb07bcc0668611c163e86daa3594965e6`
- `lib/services/accounting-import.ts`: `3b4eef547a7bb10581e0bd4bf49377c2ba1abc9cde348e13018fc25a6f820138`
- `components/integrations/qbo-import-sheet.tsx`: `83dac7fffd7b5f7ddf0db5928bb0d52febd784357a4b46039aee01fc0a367589`
