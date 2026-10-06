# Books acceptance runner

This is B00 infrastructure in Plan 013, not a completed release scenario suite.
`scripts/test-books-release-acceptance.cjs --list` registers all 25 golden
scenarios. They currently report `NOT_IMPLEMENTED` and fail if requested,
including `--scenario all`. Existing scoped unit/browser successes do not satisfy
these integrated scenarios.

`SCHEMA-01` runs every current `supabase/tests/*.sql` file using native PostgreSQL
and pgTAP. It verifies the isolated database marker and the complete installed
migration-version list before any test write, then enables pgTAP in that isolated
database. Each test receives the normal `public,extensions` search path. Missing,
duplicate, failed, skipped or TODO assertions fail the run. Source changes during
execution also fail. It preserves input hashes, runtime/database identity,
individual TAP logs and the result in a new private evidence directory.

This proves the current train's database contracts when actually executed. It
does not establish fresh replay, populated upgrade, authenticated product,
multiple-session contention, golden financial outcomes, capacity or recovery by
itself. Those require their own input/provenance and scenario artifacts.

Invocation:

```sh
node scripts/test-books-release-acceptance.cjs --list
node scripts/test-books-release-acceptance.cjs \
  --database-url-env BOOKS_ACCEPTANCE_DATABASE_URL \
  --scenario SCHEMA-01 \
  --evidence-dir /tmp/books-current-schema-unique-run
```

The caller supplies `BOOKS_ACCEPTANCE_DATABASE_URL` and
`BOOKS_ACCEPTANCE_INSTANCE_ID` in the environment. The runner never loads Arc's
`.env` files, places passwords in command arguments or writes a connection URL
to evidence. The database URL must explicitly identify a loopback PostgreSQL
database, with no option-bearing query string. Use native host `psql`, or set `BOOKS_ACCEPTANCE_CONTAINER` to the uniquely named isolated database container. The container route verifies the local Unix Docker context, project label, running state and published PostgreSQL port before using its native `psql`.
Every connection and SQL invocation is bounded; a timeout fails rather than
publishing incomplete acceptance. An existing evidence directory is refused.

Before use, create a disposable Supabase database under a unique project ID
matching `arc-books-acceptance-*`. Verify its actual container/project identity;
do not create the marker in an existing Arc/customer database. Disable
`cron.launch_active_jobs` before replay so isolated migrations cannot launch
background provider jobs. Preserve fresh-replay and populated-upgrade logs
separately. After successful replay and identity inspection, establish the
following marker in **that isolated database only**:

```sql
create schema books_acceptance;
create table books_acceptance.environment (
  singleton boolean primary key default true check (singleton),
  instance_id uuid not null,
  project_id text not null,
  isolated boolean not null check (isolated),
  migration_manifest_sha256 text not null check (
    migration_manifest_sha256 ~ '^[a-f0-9]{64}$'
  )
);
```

Insert exactly one row with a fresh version-four UUID, the verified isolated
project ID and the migration manifest hash returned by
`require('./scripts/books-acceptance/runtime.cjs').manifest(process.cwd())`.
The UUID must match `BOOKS_ACCEPTANCE_INSTANCE_ID`. Marker creation is an
attestation after inspecting the replay, not permission to relabel a customer
database as isolated. The runner additionally compares every installed migration
version with the current source inventory and rejects recovery replicas or live
cron workers. A stored marker alone does not prove an upgrade/recovery journey.

The fresh-database bootstrap is now implemented:

```sh
node scripts/bootstrap-books-acceptance.cjs \
  --workspace /tmp/books-isolated-unique-run --db-port 55480
node scripts/bootstrap-books-acceptance.cjs \
  --workspace /tmp/books-isolated-unique-run --run
```

Staging records the entire current source inventory in a new private directory;
it initially contains **no application SQL**. Execution verifies the local Docker
engine, uses CLI **2.117.0**, starts only the unique empty database, verifies its
project identity and absence of Arc schema, disables and verifies background
cron, then copies hashed SQL and replays the current train. After comparing every
installed migration version, it creates the isolated marker and independently
checks database identity. Failed/attempted workspaces are retained and refused on
subsequent execution; the bootstrap never resets an existing database. The installed
host CLI is currently 2.67.1, so its unpinned executable is not used for replay.

Before the CLI or container start, a read-only local-socket `/version` probe now
requires HTTP 200 **and nonempty JSON with real engine/API versions**. Its absolute
five-second deadline also bounds a request that never returns headers; oversized
or interrupted responses fail. The subsequent CLI info version must agree with
the probe. An empty HTTP 200 from a socket proxy cannot count as engine readiness.
Only allowlisted version fields are returned, and failed step logs/state are
retained. The October 4 runtime probe observed empty version JSON and stopped
before container creation or migration replay. This diagnoses the acceptance
blocker; it does not establish that Docker is healthy or permit a daemon restart.

A successful `REPLAYED` state is fresh-replay evidence only. Use the recorded
instance/container and loopback target for `SCHEMA-01`; populated upgrade and the
25 golden journeys still need separate implementations and acceptance artifacts.
Duplicate migration versions fail staging with all conflicting filenames, before
any Docker/database operation. Source drift fails rather than silently changing
replay inputs.

Eleven focused tests pass. These include explicit transport fixtures and an actual
child process that ignores SIGTERM, verifying SIGKILL timeout completion. A native
bootstrap attempt on October 4 reached the local Docker context but its engine
version read timed out after eight seconds. Evidence is retained at
`/tmp/books-full-schema-20261004-1700/bootstrap.json`; no container was created,
application SQL replayed, or native pgTAP executed. An earlier attempt exposed the
SIGTERM timeout bug; only its verified hung inspection child was terminated.
Neither attempt restarted the daemon or changed existing containers/application
data. This remains a runtime blocker for native acceptance, not a passing schema
result.

**Current status (October 5):** the fresh route works end to end. Replay of
the full current train (563 migrations) reached `REPLAYED`, and `SCHEMA-01`
passed all 68 pgTAP files (769 assertions) with no Books `plpgsql_check` errors; evidence is in
`docs/books-evidence/2026-10-05-schema-01/`. Two bootstrap defects had hidden
behind the earlier engine timeouts: the project ID is now `arc-books-acceptance-`
plus 12 hex digits, because Docker hostnames stop at 63 characters and the CLI
names containers `supabase_<service>_<project>`; and the cron fence runs as
`supabase_admin`, the only superuser on Supabase images. Populated upgrade from
the production baseline is still outstanding.

Next infrastructure work is actual fresh replay/pgTAP and populated upgrade,
then the 25 golden scenario journeys with independent expected entries. CI's
existing database job cannot substitute for retained upgrade/golden evidence or
G1–G7 completion. Native entity ownership follows
`docs/adr/2026-10-04-books-native-legal-entities.md` and still requires implementation
and upgrade acceptance.

A further October 4 retry after the user reported Docker running is retained at
`/tmp/books-full-schema-20261004-resume-02/bootstrap.json`. Authorized local socket
access succeeded, but the engine-version inspection still timed out after eight
seconds. Separate bounded reads of both `desktop-linux` and `default` contexts
also timed out. The earlier sandboxed attempt at `resume-01` was denied socket
access; it is distinct from the authorized engine timeout. No attempt reached
container creation or application migration replay, and no Docker daemon or
existing container was restarted. This evidence does not establish engine health
or native schema acceptance. The source train now also includes the pending
lossless export-row identity migration; a future native run must stage current
inputs afresh.

The schema 19 ownership-review checkpoint retried the native bootstrap in
`/tmp/books-full-schema-20261004-legacy-review`. The authorized engine inspection
again ended with `ETIMEDOUT` after eight seconds, before container creation or
SQL replay. Scoped fixtures verified actual pending proposal/review/capture SQL,
original-document streaming and recovery, but no current native schema or golden
scenario was accepted. Fresh staging now needs the current schema 19 source train.

The independent journal-review receipt checkpoint stages 530 migrations and 44
pgTAP files in `/tmp/books-full-schema-20261004-proposal-review`. Its native attempt
stopped at engine readiness because Docker's version endpoint returned empty or
invalid JSON. No container was created and no application migration replayed.
The prepared proposal-review pgTAP assertions remain unexecuted on native Postgres;
scoped PGlite journal and service tests do not satisfy full-schema acceptance.

The explicit journal preparation intent checkpoint stages 531 migrations and 45
pgTAP files in `/tmp/books-full-schema-20261004-preparation-intents`. Its native
attempt again stopped at engine readiness with an empty/invalid Docker version
JSON body. No container was created and no migration or native pgTAP file ran.
Preparation/review SQL and editor callbacks are scoped test evidence; native
full-schema, complete archive recovery and authenticated browser acceptance remain
required.
