# Q17 handoff: real PostgreSQL concurrency verification

Status: PARTIAL EVIDENCE; no additional original code clause is accepted by this document. Preserve all125 clauses in `014-qbo-completion-checklist.json`. This supplements Q03/Q04/Q05/Q17, and does not replace application, financial, authorization, UI, CI or rollout gates.

Source baseline: isolated `/private/tmp/arc-qbo-goal-01a109ed` HEAD `75e9810dad944ffefacbfd515edbcb182b00956a`, before Q05 integration. Q05 is being implemented by the single existing executor; do not start another source executor. Never load `.env.local`, use a production database URL, or apply these migrations remotely.

## Actual environment and independent parent evidence

No local PostgreSQL binaries were installed. Parent downloaded the official PostgreSQL17.6 release archive and verified SHA256 `e0630a3600aea27511715563259ec2111cd5f4353a4b040e0be827f94cd7a8b0` against the publisher checksum. [Official installation documentation](https://www.postgresql.org/docs/17/install-make.html) describes the configurable installation prefix. All compiled files are under `/private/tmp/arc-qbo-postgres-17.6`; no system package or service was installed.

Build/configuration evidence: `configure.log`, `build.log`, `install.log`, `initdb.log`, `server.log` in that temporary directory. Configure used `--prefix=/private/tmp/arc-qbo-postgres-17.6/runtime --without-readline --without-icu --without-zlib`. Actual `postgres --version` and `psql --version` report17.6.

The cluster uses UTF8/C locale, local trust only in a private0700 directory, rejected host authentication, **TCP disabled** (`listen_addresses=''`), Unix socket `/private/tmp/arc-qbo-postgres-17.6/socket`, port55437, max20 connections. Server PID32284 was independently verified running. Sandbox process/socket access is denied: a sandbox `pg_ctl status` misleadingly returned no server, but an escalated inspection confirmed the same live PID and connection. Do not restart based on that sandbox result. Revalidate the handle and connection before use.

The bootstrap was captured from the actual `tests/fixtures/qbo-cdc-database.js` setup and its install method, without replacing migration bodies. It contains24 statements and includes the exact Q02 authorization, Q03 receipt and Q04 recovery migrations plus their existing fixture table/function setup. It is saved as `fixture-bootstrap.sql`; the successful replay log is `fixture-bootstrap.log`. These are synthetic minimal fixture tables, **not the complete financial schema**. Database `qbo_review` contains only synthetic data.

Parent independently executed these simultaneous transactions with service_role and observed actual `pg_stat_activity.wait_event_type='Lock'`, `wait_event='transactionid'`, and `pg_blocking_pids` identifying the competing session:

1. Webhook receipt contention: two transactions intake the same canonical semantic event with different provider IDs. Exactly one semantic row remains; both IDs survive. The first transaction marks it reconciled before commit; the contender preserves the terminal state and processed timestamp, and returns no newly inserted semantic ID. Evidence: `receipt-concurrency-evidence.json` (PIDs38455/38457).
2. CDC overlapping claims: one transaction holds the connection lock after claiming; the contender waits and returns null after commit. Exactly one open run/owner survives. Evidence: `cdc-concurrency-evidence.json` (PIDs38826/38828).
3. CDC lease takeover versus stale progress: expire the old fixture lease, claim a replacement while holding the connection lock, and concurrently send progress with the old token. The contender waits then raises `Stale CDC progress fence`; neither its event nor receipt is persisted. Evidence in the same file (PIDs38837/38839).
4. Concurrent identical CDC completion: two transactions complete the same run with the same token/receipt/command. The second waits and replays exactly the first result. There is one completion version, one receipt and one fresh event; the cursor equals the validated run checkpoint; unrelated settings and an already terminal event survive. Evidence in the same file (PIDs38852/38854).

These probes prove these specific database cases. They do not prove actual overlapping provider facades, complete financial projectors, arbitrary lock-order freedom, browser journeys or CI coverage. No checklist count was increased. Temporary JSON and logs are leads/evidence; durable portable tests must be committed and rerun before their original broader criteria are accepted.

## Executor implementation scope and definitions of done

Add a portable PostgreSQL concurrency suite (for example `tests/qbo-postgresql-concurrency.test.js` and a narrow fixture/driver helper), reusing actual QBO SQL/bootstrap definitions. Keep PGlite coverage. Avoid checking in isolated Git hashes as executable dependencies. Do not require this temporary runtime or fixed PIDs/port in CI.

- An explicitly supplied disposable database is mandatory; no implicit process `.env`, production URL or remote project fallback. CI may provide its existing PostgreSQL service after the database-contract workflow is inspected.
- Give each fixture an isolated database/schema and lifecycle cleanup. PostgreSQL roles are cluster-wide; use the existing CI fixture pattern and avoid collisions across parallel suites. Do not weaken SQL roles to make tests pass.
- Execute exact additive migrations and relevant effective current triggers. No substitute receipt/lease implementation. Cover absent-RPC fail-closed behavior, forward replay and anon/authenticated denials separately.
- Add the four actual cases above as executable tests, with deterministic barriers and actual observed blocking sessions. `Promise.all` alone, elapsed timing alone, a mocked DB or serialized PGlite do not prove contention. Bound observations and set lock/statement timeouts; failed participants must roll back and release connections.
- Exercise Q04 actual poll facade overlap using a real database adapter plus synthetic pinned QBO responses; demonstrate only the owner persists/advances progress and that a stale owner cannot acknowledge missing work. Preserve timestamp ties, malformed/saturated response boundaries and fairness coverage.
- Exercise Q05 actual mutable apply against competing job-cost/billable/opening/fact writers, current source/children/revision triggers and delivery receipt completion. Verify old/new source moves, missing/deleted child references, stale provider revisions, transactional rollback and preserved posted facts. If legacy source/child lock ordering deadlocks, assert the aborted transaction fails closed and retry keeps work eligible; do not claim universal deadlock freedom.
- Preserve full Q17 financial/UI/auth/Node/Bun/type/lint/build/release obligations. A passing concurrency suite cannot substitute for them.

Run the focused PostgreSQL suite with zero failures/skips, then original targeted Node/Bun and the relevant source-revision/Books suites after any fixture/source changes. Independently rerun in a checkout without isolated Git objects or untracked dependencies. Record commands, exits, engine version, actual scope and limitations. Parent reviews all hunks and re-runs tests before hash-guarded integration; executor must not update authoritative plans or copy source without approval.

## Runtime access and cleanup

Use explicit local arguments, not environment-derived connection selection:

```sh
/private/tmp/arc-qbo-postgres-17.6/runtime/bin/pg_ctl -D /private/tmp/arc-qbo-postgres-17.6/data status
/private/tmp/arc-qbo-postgres-17.6/runtime/bin/psql -X -h /private/tmp/arc-qbo-postgres-17.6/socket -p55437 -d qbo_review -v ON_ERROR_STOP=1
```

In this environment these need the sandbox exception for the private socket/process/shared-memory access. Starting or querying this disposable server is authorized verification, not production permission. Keep provider responses synthetic and native fetch fail-closed. When no running test needs it, stop this exact cluster using `pg_ctl -D .../data -m fast -w stop`; preserve evidence/runtime for later goal turns and revalidate before restarting. Never stop an unrelated service or system PostgreSQL.

## Additional parent actual-facade overlap evidence

Parent independently executed current `ingestQboCdcChanges` and `recoverQboCdc` through the actual `tests/fixtures/qbo-cdc-runtime.js` database adapter, replacing only the PGlite query transport with explicit private-socket PostgreSQL `psql`. A synthetic pinned provider holds the first invocation at its actual CDC await. The second actual invocation sees the owned database lease and returns `deferred:true` before making any provider request. Releasing the first response yields `currentScanComplete:true`, exactly one provider request, one complete run/version1/receipt, a null released token and preserved unrelated connection settings. Native fetch throws; authority/provider factory/deadline collaborators remain explicit fixture boundaries. Evidence: `/private/tmp/arc-qbo-postgres-17.6/cdc-facade-overlap-evidence.json`.

This supplements the four actual simultaneous SQL cases. It does not replace a committed portable facade concurrency test, all partial/outage/role cases, full financial schema or CI evidence. No original clause count was increased. Add this exact actual-facade barrier case to the future durable suite alongside the transaction-blocking cases, without changing the public facade implementation to satisfy a test.
