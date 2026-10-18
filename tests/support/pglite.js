"use strict"

/**
 * The database tier: a PGlite Postgres with Arc's REAL schema.
 *
 * Every file in `supabase/migrations/` is applied whole, in filename order, on
 * top of a bootstrap that stands in for what the Supabase platform provides
 * (roles, the `auth` and `storage` schemas, extensions). The migrated database
 * is built once per migration set, cached as a data-dir image in the OS temp
 * dir, and every `createDatabase()` call gets its own isolated copy.
 *
 *   const { createDatabase, insert, rpc, seedMember, asRole } = require("./support/pglite")
 *
 *   test("a member cannot read another org's projects", async (t) => {
 *     const db = await createDatabase(t)                  // closed when the test ends
 *     const member = await seedMember(db)                 // auth user + org + membership
 *     const stranger = await seedMember(db)
 *     await insert(db, "projects", { org_id: stranger.orgId, name: "Lot 12" })
 *
 *     const { rows } = await asRole(db, { role: "authenticated", userId: member.userId }, (tx) =>
 *       tx.query("select id from projects"),
 *     )
 *     assert.deepEqual(rows, [])
 *   })
 *
 *   // Server-side SQL functions, called like supabase.rpc() (as service_role):
 *   const claimed = await rpc(db, "claim_drawing_jobs", { job_types: ["process_drawing_page"] })
 *
 * Outside `asRole` you are the `postgres` superuser: RLS and grants do not
 * apply, which is what fixture setup wants. Inside it you are exactly the role
 * PostgREST would use, with `auth.uid()` / `auth.jwt()` / `auth.role()`
 * answering for the given user. `setRequestHeaders` sets `request.headers`
 * for code that reads them (worker lease fences).
 *
 * The cached image lives in os.tmpdir()/arc-pglite, keyed by a hash of every
 * migration file, this file and the PGlite version; delete the directory to
 * force a rebuild.
 *
 * Nothing here ever connects to a real database. The only SQL this file
 * changes in a migration is the explicit PATCHES list below, each matched an
 * exact number of times so a migration edit cannot silently drift past it.
 */

const crypto = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const { PGlite } = require("@electric-sql/pglite")
const { citext } = require("@electric-sql/pglite/contrib/citext")
const { pg_trgm } = require("@electric-sql/pglite/contrib/pg_trgm")
const { pgcrypto } = require("@electric-sql/pglite/contrib/pgcrypto")
const { uuid_ossp } = require("@electric-sql/pglite/contrib/uuid_ossp")
const { pg_stat_statements } = require("@electric-sql/pglite/contrib/pg_stat_statements")
const { btree_gist } = require("@electric-sql/pglite/contrib/btree_gist")

const root = path.resolve(__dirname, "../..")
const migrationsDir = path.join(root, "supabase/migrations")
// Every extension a migration creates that PGlite ships a build of.
const extensions = { btree_gist, citext, pg_stat_statements, pg_trgm, pgcrypto, uuid_ossp }

// ---------------------------------------------------------------------------
// What the Supabase platform provides before the first migration runs.
// ---------------------------------------------------------------------------

/**
 * Supabase ships these as real extensions; PGlite has no build of them. Each is
 * installed as a SQL-only extension with the same name, so the migrations'
 * own `create extension` statements run unchanged. Only the surface Arc's
 * migrations call is provided.
 */
const STUB_EXTENSIONS = {
  // Vault encrypts secrets at rest. Here they are stored in plain text: tests
  // observe that a secret was written and replaced, never the ciphertext.
  supabase_vault: `
    create table vault.secrets (
      id uuid primary key default gen_random_uuid(),
      name text unique,
      description text not null default '',
      secret text not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create view vault.decrypted_secrets as
      select id, name, description, secret, secret as decrypted_secret, created_at, updated_at
      from vault.secrets;
    create function vault.create_secret(
      new_secret text, new_name text default null, new_description text default '', new_key_id uuid default null
    )
    returns uuid language sql as $$
      insert into vault.secrets (secret, name, description)
      values (new_secret, new_name, coalesce(new_description, ''))
      returning id
    $$;
    create function vault.update_secret(
      secret_id uuid, new_secret text default null, new_name text default null,
      new_description text default null, new_key_id uuid default null
    )
    returns void language sql as $$
      update vault.secrets
      set secret = coalesce(new_secret, secret),
          name = coalesce(new_name, name),
          description = coalesce(new_description, description),
          updated_at = now()
      where id = secret_id
    $$;
  `,
  // pg_cron schedules jobs. Here schedules are recorded and never run.
  pg_cron: `
    create schema cron;
    create table cron.job (
      jobid bigint generated always as identity primary key,
      schedule text not null,
      command text not null,
      jobname text unique,
      active boolean not null default true
    );
    create function cron.schedule(job_name text, schedule text, command text) returns bigint language sql as $$
      insert into cron.job (jobname, schedule, command) values (job_name, schedule, command)
      on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command
      returning jobid
    $$;
    create function cron.schedule(schedule text, command text) returns bigint language sql as $$
      insert into cron.job (schedule, command) values (schedule, command) returning jobid
    $$;
    create function cron.unschedule(job_name text) returns boolean language sql as $$
      with gone as (delete from cron.job where jobname = job_name returning 1) select exists (select 1 from gone)
    $$;
    create function cron.unschedule(job_id bigint) returns boolean language sql as $$
      with gone as (delete from cron.job where jobid = job_id returning 1) select exists (select 1 from gone)
    $$;
  `,
}

/** Supabase resolves unqualified extension functions (`digest`) through this. */
const SEARCH_PATH = '"$user", public, extensions'

/** Roles, schemas and `auth` / `storage` objects, shaped like Supabase's. */
const BOOTSTRAP = `
  alter database postgres set search_path = ${SEARCH_PATH};

  create role anon nologin noinherit;
  create role authenticated nologin noinherit;
  create role service_role nologin noinherit bypassrls;
  create role authenticator noinherit login;
  grant anon, authenticated, service_role to authenticator;
  create role supabase_admin superuser;
  create role supabase_auth_admin noinherit;
  create role supabase_storage_admin noinherit;
  create role dashboard_user;

  create schema extensions;
  create schema vault;
  create schema auth;
  create schema storage;
  create schema realtime;
  create publication supabase_realtime;
  grant usage on schema public, extensions, auth, storage to anon, authenticated, service_role;
  alter default privileges in schema extensions grant execute on functions to anon, authenticated, service_role;

  -- The request context PostgREST sets on every call (see asRole below).
  create function auth.jwt() returns jsonb language sql stable as $$
    select coalesce(
      nullif(current_setting('request.jwt.claim', true), ''),
      nullif(current_setting('request.jwt.claims', true), '')
    )::jsonb
  $$;
  create function auth.uid() returns uuid language sql stable as $$
    select coalesce(
      nullif(current_setting('request.jwt.claim.sub', true), ''),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    )::uuid
  $$;
  create function auth.role() returns text language sql stable as $$
    select coalesce(
      nullif(current_setting('request.jwt.claim.role', true), ''),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
    )::text
  $$;
  create function auth.email() returns text language sql stable as $$
    select coalesce(
      nullif(current_setting('request.jwt.claim.email', true), ''),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email')
    )::text
  $$;
  grant execute on all functions in schema auth to anon, authenticated, service_role;

  create table auth.users (
    instance_id uuid,
    id uuid primary key,
    aud varchar(255),
    role varchar(255),
    email varchar(255),
    encrypted_password varchar(255),
    email_confirmed_at timestamptz,
    last_sign_in_at timestamptz,
    raw_app_meta_data jsonb not null default '{}',
    raw_user_meta_data jsonb not null default '{}',
    is_super_admin boolean,
    phone text,
    banned_until timestamptz,
    is_anonymous boolean not null default false,
    deleted_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  );
  create table auth.sessions (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users (id) on delete cascade,
    created_at timestamptz default now(),
    updated_at timestamptz default now(),
    factor_id uuid,
    aal text,
    not_after timestamptz,
    refreshed_at timestamp,
    user_agent text,
    ip inet,
    tag text
  );
  create table auth.mfa_factors (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users (id) on delete cascade,
    friendly_name text,
    factor_type text not null default 'totp',
    status text not null default 'unverified',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  );

  create table storage.buckets (
    id text primary key,
    name text not null unique,
    owner uuid,
    public boolean default false,
    avif_autodetection boolean default false,
    file_size_limit bigint,
    allowed_mime_types text[],
    created_at timestamptz default now(),
    updated_at timestamptz default now()
  );
  create table storage.objects (
    id uuid primary key default gen_random_uuid(),
    bucket_id text references storage.buckets (id),
    name text,
    owner uuid,
    metadata jsonb,
    created_at timestamptz default now(),
    updated_at timestamptz default now(),
    last_accessed_at timestamptz default now()
  );
  alter table storage.objects enable row level security;
  create function storage.foldername(name text) returns text[] language sql immutable as $$
    select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1]
  $$;
  create function storage.filename(name text) returns text language sql immutable as $$
    select (string_to_array(name, '/'))[array_length(string_to_array(name, '/'), 1)]
  $$;
  grant all on all tables in schema storage to service_role;
  grant execute on all functions in schema storage to anon, authenticated, service_role;

  -- The migration ledger the Supabase CLI keeps (read by applied_migration_versions()).
  create schema supabase_migrations;
  create table supabase_migrations.schema_migrations (version text primary key, statements text[], name text);
`

// ---------------------------------------------------------------------------
// The only changes made to migration SQL. Each must match exactly `count`
// times; a mismatch fails the build rather than silently skipping new SQL.
// ---------------------------------------------------------------------------

const REMOTE_SCHEMA = "20260517092101_remote_schema.sql"

/** pgvector functions whose name and signature never mention a vector type. */
const PGVECTOR_BIT_FUNCTIONS = new Set([
  "hamming_distance",
  "jaccard_distance",
  "hnsw_bit_support",
  "ivfflat_bit_support",
  "hnswhandler",
  "ivfflathandler",
])

function isPgvectorFunction(grant) {
  const [, name, signature] = grant.match(/^GRANT ALL ON FUNCTION "public"\."([a-z0-9_]+)"\((.*)\) TO /)
  return PGVECTOR_BIT_FUNCTIONS.has(name) || /(^|[^a-z])(vector|halfvec|sparsevec)/.test(`${name}(${signature})`)
}

const PATCHES = [
  // pgvector has no PGlite build, and a SQL-only stand-in cannot define a base
  // type. Semantic search (`search_embeddings`, `match_search_embeddings`) is
  // the only consumer, so the extension and its dumped function grants are
  // left out and the one embedding column becomes a plain float array. The
  // search function itself is still created: the file sets
  // check_function_bodies = off, so its body is not resolved until called.
  {
    file: REMOTE_SCHEMA,
    reason: "pgvector: skip create extension vector",
    find: /^CREATE EXTENSION IF NOT EXISTS "vector" WITH SCHEMA "public";$/gm,
    replace: "-- [pglite harness] skipped: CREATE EXTENSION vector",
    count: 1,
  },
  {
    file: REMOTE_SCHEMA,
    reason: "pgvector: skip grants on the extension's own functions",
    find: /^GRANT ALL ON FUNCTION "public"\."[a-z0-9_]+"\(.*\) TO "[a-z_]+";$/gm,
    replace: (statement) =>
      isPgvectorFunction(statement) ? `-- [pglite harness] skipped pgvector grant: ${statement}` : statement,
    count: 472,
  },
  {
    file: REMOTE_SCHEMA,
    reason: "pgvector: the embedding column is stored as real[]",
    find: /"embedding" "public"\."vector"\(1536\) NOT NULL/g,
    replace: '"embedding" real[] NOT NULL',
    count: 1,
  },
  {
    file: REMOTE_SCHEMA,
    reason: "pgvector: skip the ivfflat index on the embedding column",
    find: /^CREATE INDEX "idx_search_embeddings_vector_cosine" .*;$/gm,
    replace: "-- [pglite harness] skipped: ivfflat index idx_search_embeddings_vector_cosine",
    count: 1,
  },
]

// ---------------------------------------------------------------------------
// Building and caching the migrated image.
// ---------------------------------------------------------------------------

function migrationFiles() {
  return fs
    .readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort()
}

function patchedSql(name) {
  let sql = fs.readFileSync(path.join(migrationsDir, name), "utf8")
  for (const patch of PATCHES.filter((p) => p.file === name)) {
    let changed = 0
    sql = sql.replace(patch.find, (statement) => {
      const replacement = typeof patch.replace === "function" ? patch.replace(statement) : patch.replace
      if (replacement !== statement) changed += 1
      return replacement
    })
    if (changed !== patch.count) {
      throw new Error(
        `pglite harness: patch "${patch.reason}" expected to change ${patch.count} statement(s) ` +
          `in ${name}, changed ${changed}`,
      )
    }
  }
  return sql
}

function imageKey(files) {
  const hash = crypto.createHash("sha256")
  hash.update(fs.readFileSync(__filename))
  hash.update(fs.readFileSync(path.join(path.dirname(require.resolve("@electric-sql/pglite")), "../package.json")))
  for (const name of files) {
    hash.update(name)
    hash.update(fs.readFileSync(path.join(migrationsDir, name)))
  }
  return hash.digest("hex").slice(0, 16)
}

function installStubExtensions(db) {
  const dir = "/pglite/share/postgresql/extension"
  for (const [name, sql] of Object.entries(STUB_EXTENSIONS)) {
    db.Module.FS.writeFile(`${dir}/${name}.control`, `default_version = '0.0'\nrelocatable = false\n`)
    db.Module.FS.writeFile(`${dir}/${name}--0.0.sql`, sql)
  }
}

async function openDatabase(options = {}) {
  const db = new PGlite({ extensions, ...options })
  await db.waitReady
  installStubExtensions(db)
  return db
}

/**
 * Shrink the data dir before it is imaged: every test database loads it, so
 * its size is the per-test cost. 574 migrations leave the catalogs full of
 * dead rows, and Postgres keeps recycled WAL segments it will never need here.
 */
async function compact(db) {
  await db.exec("select pg_stat_statements_reset()")
  await db.exec("vacuum full")
  await db.exec("checkpoint")
  const { rows } = await db.query(
    "select current_setting('data_directory') as dir, pg_walfile_name(pg_current_wal_lsn()) as current",
  )
  const wal = `${rows[0].dir}/pg_wal`
  for (const segment of db.Module.FS.readdir(wal)) {
    // Segments named after the current one are pre-allocated for reuse.
    if (/^[0-9A-F]{24}$/.test(segment) && segment > rows[0].current) db.Module.FS.unlink(`${wal}/${segment}`)
  }
}

/** Apply the bootstrap and every migration to a fresh database. */
async function buildImage() {
  const db = await openDatabase()
  await db.exec(BOOTSTRAP)
  for (const name of migrationFiles()) {
    try {
      // Each file starts from a clean session, as it does when the Supabase
      // CLI applies it: the dumped schema sets search_path = '' for itself.
      await db.exec(`reset all; reset role; set search_path = ${SEARCH_PATH}`)
      await db.exec(patchedSql(name))
    } catch (error) {
      error.message = `migration ${name} failed: ${error.message}`
      throw error
    }
  }
  await compact(db)
  const image = await db.dumpDataDir("none")
  await db.close()
  return Buffer.from(await image.arrayBuffer())
}

const cacheDir = path.join(os.tmpdir(), "arc-pglite")
const STALE_IMAGE_MS = 24 * 60 * 60_000

/** Images for other migration sets (other branches) unused for a day are deleted. */
function pruneImages(keep) {
  for (const name of fs.readdirSync(cacheDir)) {
    const file = path.join(cacheDir, name)
    if (!/^schema-[0-9a-f]+\.tar$/.test(name) || file === keep) continue
    const stats = fs.statSync(file, { throwIfNoEntry: false })
    if (stats && Date.now() - stats.mtimeMs > STALE_IMAGE_MS) fs.rmSync(file, { force: true })
  }
}

/**
 * The migrated image for the current migration set, from the cache when
 * another process already built it. Concurrent test processes share one build
 * through a lock file.
 */
async function loadImage() {
  const files = migrationFiles()
  const file = path.join(cacheDir, `schema-${imageKey(files)}.tar`)
  const lock = `${file}.lock`
  fs.mkdirSync(cacheDir, { recursive: true })

  for (;;) {
    if (fs.existsSync(file)) {
      const now = new Date()
      fs.utimesSync(file, now, now)
      return fs.readFileSync(file)
    }
    let fd
    try {
      fd = fs.openSync(lock, "wx")
    } catch (error) {
      if (error.code !== "EEXIST") throw error
      const age = Date.now() - fs.statSync(lock, { throwIfNoEntry: false })?.mtimeMs
      if (age > 5 * 60_000) fs.rmSync(lock, { force: true })
      await new Promise((resolve) => setTimeout(resolve, 250))
      continue
    }
    try {
      const image = await buildImage()
      const partial = `${file}.${process.pid}`
      fs.writeFileSync(partial, image)
      fs.renameSync(partial, file)
      pruneImages(file)
      return image
    } finally {
      fs.closeSync(fd)
      fs.rmSync(lock, { force: true })
    }
  }
}

let template

/**
 * A fresh, isolated database with every migration applied. Pass the test
 * context to have it closed when the test ends.
 */
async function createDatabase(t) {
  template ??= loadImage()
  const image = await template
  const db = await openDatabase({ loadDataDir: new Blob([image]) })
  // PGlite starts every session on search_path = public.
  await db.exec(`set search_path = ${SEARCH_PATH}`)
  t?.after(() => db.close())
  return db
}

// ---------------------------------------------------------------------------
// Acting as a Supabase caller.
// ---------------------------------------------------------------------------

/**
 * Run `fn(tx)` in a transaction as `role`, with the JWT claims PostgREST would
 * set for `userId`. `aal` is the session's assurance level ("aal1" after a
 * password, "aal2" after a two-factor code). The role and claims end with the
 * transaction; an error in `fn` rolls it back and is rethrown.
 */
async function asRole(db, { role, userId = null, aal = null }, fn) {
  const jwt = { role, ...(userId ? { sub: userId } : {}), ...(aal ? { aal } : {}) }
  return db.transaction(async (tx) => {
    await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(jwt)])
    await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [userId ?? ""])
    await tx.query("select set_config('request.jwt.claim.role', $1, true)", [role])
    await tx.exec(`set local role ${role}`)
    return fn(tx)
  })
}

/**
 * Call a SQL function the way `supabase.rpc(name, args)` does: named
 * arguments, as `service_role` unless another caller is given. Resolves to
 * the function's value, or to its rows when it returns a set or a table.
 */
async function rpc(db, name, args = {}, caller = { role: "service_role" }) {
  const names = Object.keys(args)
  const call = `public.${name}(${names.map((arg, i) => `${arg} => $${i + 1}`).join(", ")})`
  return asRole(db, caller, async (tx) => {
    const { rows } = await tx.query(
      "select bool_or(proretset) as returns_set from pg_proc where proname = $1 and pronamespace = 'public'::regnamespace",
      [name],
    )
    if (rows[0].returns_set) return (await tx.query(`select * from ${call}`, Object.values(args))).rows
    return (await tx.query(`select ${call} as value`, Object.values(args))).rows[0].value
  })
}

/**
 * Set the request headers PostgREST exposes to SQL as `request.headers` for
 * the rest of the session (pass `{}` to clear them).
 */
async function setRequestHeaders(db, headers) {
  await db.query("select set_config('request.headers', $1, false)", [JSON.stringify(headers)])
}

// ---------------------------------------------------------------------------
// Fixtures. Setup runs as the superuser, so RLS never gets in its way.
// ---------------------------------------------------------------------------

let sequence = 0

/** A deterministic, valid v4-shaped UUID that is unique within the process. */
function uuid() {
  sequence += 1
  return `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`
}

/**
 * Insert one row and return it as stored (defaults and triggers applied).
 * `db` may also be the `tx` handed to an `asRole` callback.
 */
async function insert(db, table, row) {
  const columns = Object.keys(row)
  const { rows } = await db.query(
    `insert into ${table} (${columns.join(", ")}) values (${columns.map((_, i) => `$${i + 1}`).join(", ")}) returning *`,
    Object.values(row),
  )
  return rows[0]
}

/**
 * A signed-up user who is an active member of an org, the shape every
 * authenticated request in Arc starts from. Creates the org unless `orgId`
 * names one that exists. `role` is a key from the seeded `roles` catalog.
 */
async function seedMember(db, { orgId = uuid(), userId = uuid(), role = "org_owner" } = {}) {
  const email = `user-${userId}@example.test`
  await insert(db, "auth.users", { id: userId, email, aud: "authenticated", role: "authenticated" })
  await insert(db, "app_users", { id: userId, email })
  await db.query("insert into orgs (id, name, created_by) values ($1, $2, $3) on conflict (id) do nothing", [
    orgId,
    `Org ${orgId.slice(-4)}`,
    userId,
  ])
  await db.query(
    "insert into memberships (org_id, user_id, role_id, status) select $1, $2, id, 'active' from roles where key = $3",
    [orgId, userId, role],
  )
  return { orgId, userId }
}

/** An org role holding exactly `permissions`, for exercising a guard that one key set reaches. */
async function seedRole(db, { key = `test_role_${uuid().slice(0, 8)}`, permissions }) {
  const { rows: [role] } = await db.query("insert into roles (key, label, scope) values ($1, $1, 'org') returning key", [key])
  for (const permission of permissions) {
    await db.query("insert into role_permissions (role_id, permission_key) select id, $2 from roles where key = $1", [key, permission])
  }
  return role.key
}

module.exports = { createDatabase, asRole, rpc, setRequestHeaders, insert, seedMember, seedRole, uuid }
