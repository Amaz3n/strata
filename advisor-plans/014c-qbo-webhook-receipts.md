# Q03 completion handoff: durable provider-event metadata

Status: CODE INTEGRATED — approved738bf7d exact five files in shared workspace; original eight Q03 code clauses verified. Full package/program acceptance retains the explicit two-session PostgreSQL contention check below. The existing signed webhook fix is integrated at isolated commit `d8b97bc`; 169 Node accounting/QBO tests and13 Bun parser tests passed before subsequent changes. Root-reviewed parser and HTTP errors must remain intact. This closes Q03-03; it does not replace CDC completeness work Q04.

## Problem

CloudEvents provider IDs are parsed and correlated in logs but discarded from durable queue records. An equivalent CDC/legacy row may already exist before the CloudEvent arrives. Simply adding a field to the insert fails on this replay because ignoreDuplicates protects the terminal row. Preserve provider IDs durably without resetting processing state, and keep acknowledgment conditional on durable metadata as well as durable work.

## Scope

One additive migration for `qbo_webhook_events` metadata and a narrow service-only intake RPC; webhook intake section of `lib/integrations/accounting/qbo/reconcile.ts`; signed HTTP/CDC fixtures and a new real PGlite receipt test. Existing facade/signature parser, processing/reconciliation and money mutations stay unchanged. Create migration using installed `supabase migration new` in isolated checkout only. Do not apply production SQL or alter previous migrations. Do not reuse generic payment webhook receipt status in a way that implies accounting reconciliation succeeded.

## Suggested design and invariants

Add an explicit provider-event-ID collection (text array or appropriate normalized metadata relation) to existing infrastructure queue storage. Preserve every distinct provider event ID; repeated delivery of the same ID is idempotent. A first legacy/CDC row starts with an empty collection. A later equivalent CloudEvent adds its ID without changing process_status, attempts, processed_at, process_error or identity. Multiple IDs for an equivalent semantic fact are retained without duplicate work. Never store raw signed bodies, credentials or full financial payloads as metadata.

Prefer a narrow atomic service-only intake function that inserts canonical entity events and merges metadata on conflicts, returning truthful newly inserted work count. A batch can reduce existing one-network-upsert-per-event overhead; do not optimize away durable acknowledgment or introduce snapshot races. SQL UPDATE must merge against the locked current row, not a stale read/replace of an array. If using plpgsql insert-on-conflict-do-nothing plus metadata update, verify concurrent visibility/replay semantics; do not depend blindly on undocumented MVCC system columns or a CTE updating the same row twice. Server TypeScript validates the complete delivery before invoking SQL. Nonempty malformed inputs still return400, invalid signature401, storage/receipt failure503, explicit empties200 without DB dispatch.

Only service_role executes the new function or mutates queue/metadata. Preserve existing realm routing uniqueness and processing indexes. No new QBO business-table columns. Migration must replay after both pre-D2 and post-D2 accounting security states. Record unapplied migration requirement; application rollout cannot call an unavailable RPC without an explicitly reviewed compatible transition.

## Behavioral acceptance

- Actual signed CloudEvents store provider ID durably; legacy and actual CDC followed by equivalent CloudEvent retain one work row plus ID metadata.
- Two distinct delivery IDs for the same semantic event are retained; replay of either leaves one semantic event and unchanged terminal state.
- Mixed realms normalize and persist correctly. Whole delivery validation precedes all persistence.
- Metadata persistence failure prevents successful HTTP acknowledgment; retry completes missing durable metadata without resetting work.
- Concurrent receipt updates cannot lose IDs. An isolated PostgreSQL/PGlite fixture must execute exact migration/RPC, SET ROLE privilege denial and terminal-state assertions; use proper engine concurrency support and report any missing concurrency evidence explicitly.
- Returned processed count means newly inserted work only, not repeated deliveries or merely successful upserts. Retain existing routes' response contract.
- Named old behavior fails durable provider ID regression. Standard Node suite contains the tests; zero network and real money.

## Verification

Scoped Node accounting/QBO suites; Bun webhook suite; changed-file ESLint; full COREPACK_ENABLE_AUTO_PIN=0 pnpm typecheck; real SQL role/receipt tests and source schema check if affected. Parent reviews every hunk and re-runs criteria before integration. Commit only isolated scope, no push or shared commit. Root maintains status/evidence. Do not claim full Q03 complete from logs or source regex.

## Concurrency review and remaining release evidence

Parent reviewed the proposed INSERT-DO-NOTHING followed by current-row UPDATE against PostgreSQL’s documented [Read Committed conflict visibility](https://www.postgresql.org/docs/current/transaction-iso.html) and [VOLATILE function snapshots](https://www.postgresql.org/docs/current/xfunc-volatility.html). The default volatile PL/pgSQL function’s next statement obtains a fresh snapshot; an UPDATE waiting on a concurrent writer reevaluates against its updated row. This supports the merge design by inference from the documented semantics. It does not replace an actual two-session contention test. PGlite serializes promises, so its replay assertions prove serial replay/rollback/privileges only. No available native PostgreSQL binary was found locally; a read-only Docker image inventory did not finish and was cancelled. True simultaneous insert/update contention and reversed-overlap batches remain explicit disposable-PostgreSQL/CI release evidence, with no production access needed.

Existing CI `.github/workflows/verify.yml` has a `database-contracts` job with `supabase db start` and `supabase test db --local`; use that disposable environment for a required, non-skipped two-session receipt contention check in Q17. Do not use browser-job secrets or production URLs for this fixture. Cover concurrent first inserts, distinct metadata merges on terminal rows and reversed overlap ordering, with both transaction completions and the final ID union asserted. This is planned evidence, not an executed CI result.

Parent acceptance:264/264 isolated and independently repeated shared Node,55/55 Bun across five QBO files, changed-file lint/fulltypecheck/diff0. Source and every destination were checked before copy; parent independently matched all five resulting bytes to the approved commit. Synthetic actual-SDK measurement80→1 requests with41 new semantic facts and40 retained delivery IDs agrees with the exact SQL/signed-route fixture. The embedded old receive function exactly matches b76 AST text. No SQL application or shared git commit.

When bundling with Q02, retain both dependencies: Q02 service-owned app paths precede restrictive grants, while Q03 RPC SQL precedes new intake. Q17 must verify staged app artifacts (Q02 services with previous webhook intake, ordered additive SQL, then RPC intake) or separately review selective migration-history handling. Temporarily unavailable Q02 count RPC fails closed. Neither all-SQL-first nor all-final-app-first satisfies both dependencies automatically. This is planning only.
