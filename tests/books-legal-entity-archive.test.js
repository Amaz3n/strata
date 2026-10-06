require("../scripts/register-ts-node-test");
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  { PGlite } = require("@electric-sql/pglite");
const {
  EXPORT_TABLES,
  BOOKS_EXPORT_SCHEMA_VERSION,
  verifyBooksExportBundle,
} = require("../lib/services/books/export-contract");
const {
  LEGAL_ENTITY_ARCHIVE_TABLES,
} = require("../lib/services/books/legal-entity-archive");
const { booksDigest } = require("../lib/services/books/hash"),
  { prepareBooksRestorePlan } = require("../lib/services/books/restore-plan");
const id = (n) => "99600000-0000-4000-8000-" + String(n).padStart(12, "0"),
  org = id(1),
  actor = id(2),
  reviewer = id(3),
  reader = id(4),
  entity = id(10),
  profile = id(20),
  notes = "Reviewed entity identity and original formation record";
const details = {
  legal_name: "Builder LLC",
  legal_form: "llc",
  functional_currency: "USD",
  fiscal_start_month: 7,
  fiscal_start_day: 1,
  effective_on: "2026-07-01",
  identity_evidence: {
    source: "Formation paper reviewed and held by entity accountant",
  },
};
const registry = fs.readFileSync(
    "supabase/migrations/20261004170526_books_native_legal_entity_registry.sql",
    "utf8",
  ),
  archive = fs.readFileSync(
    "supabase/migrations/20261004172415_books_legal_entity_archive_identity.sql",
    "utf8",
  );
async function setup(t, upgrade = true) {
  const db = new PGlite();
  t.after(() => db.close());
  await db.waitReady;
  await db.exec(
    `create role anon;create role authenticated;create role service_role bypassrls;create table orgs(id uuid primary key);create table app_users(id uuid primary key);create table memberships(org_id uuid,user_id uuid,status text);insert into orgs values('${org}'),('${id(100)}');insert into app_users values('${actor}'),('${reviewer}'),('${reader}');insert into memberships values('${org}','${actor}','active'),('${org}','${reviewer}','active'),('${org}','${reader}','active');`,
  );
  await db.exec(registry);
  const foundation = fs.readFileSync(
    "supabase/migrations/20260801143926_books_accounting_foundation.sql",
    "utf8",
  );
  const exportStart = foundation.indexOf("create table public.books_exports (");
  await db.exec(
    foundation.slice(exportStart, foundation.indexOf("\n);", exportStart) + 4),
  );
  for (const table of EXPORT_TABLES)
    if (!LEGAL_ENTITY_ARCHIVE_TABLES.includes(table))
      await db.exec(`create table ${table}(id uuid primary key,org_id uuid)`);
  if (upgrade) {
    await db.exec(archive);
    await require("./fixtures/books-export-snapshot-database").installBooksExportSnapshot(
      db,
    );
  }
  const rpc = async (name, args) =>
    (
      await db.query(
        `select ${name}(${args.map((_, i) => "$" + (i + 1)).join(",")}) value`,
        args,
      )
    ).rows[0].value;
  return {
    db,
    rpc,
    create: () =>
      rpc("create_books_legal_entity", [org, entity, "BUILDER", actor, notes]),
    member: (user, level = "review") =>
      rpc("set_books_legal_entity_member", [
        org,
        entity,
        actor,
        user,
        level,
        notes,
      ]),
    prepare: () =>
      rpc("prepare_books_legal_entity_profile", [
        org,
        entity,
        profile,
        actor,
        null,
        JSON.stringify(details),
        notes,
      ]),
    review: () =>
      rpc("review_books_legal_entity_profile", [
        org,
        entity,
        profile,
        reviewer,
        notes,
      ]),
    capture: () => rpc("capture_books_export_snapshot", [org]),
  };
}
async function ready(t, upgrade = true) {
  const f = await setup(t, upgrade);
  await f.create();
  await f.member(reviewer);
  await f.prepare();
  await f.review();
  return f;
}
function bundle(snapshot, version = 18) {
  return {
    tables: snapshot.tables,
    manifest: {
      schemaVersion: version,
      legalEntityIds: (snapshot.tables.books_legal_entities ?? [])
        .map((row) => row.id)
        .sort(),
      orgId: org,
      tables: Object.fromEntries(
        Object.entries(snapshot.tables).map(([name, rows]) => [
          name,
          { rows: rows.length, checksum: booksDigest(rows) },
        ]),
      ),
      supportingFiles: [],
      supportingHistoricalFiles: [],
    },
    supportingObjects: [],
    supportingHistoricalObjects: [],
  };
}
function rehash(b) {
  for (const [name, rows] of Object.entries(b.tables))
    b.manifest.tables[name] = {
      rows: rows.length,
      checksum: booksDigest(rows),
    };
  return b;
}
async function catalog(db) {
  const columns = (
    await db.query(
      "select table_schema schema,table_name as table,column_name name,is_nullable='NO' as \"notNull\",column_default is not null as \"hasDefault\",is_generated<>'NEVER' as generated from information_schema.columns where table_schema='public'",
    )
  ).rows;
  const foreignKeys = (
    await db.query(
      'select n.nspname schema,c.relname as table,array(select a.attname from unnest(k.conkey) with ordinality x(attnum,ord) join pg_attribute a on a.attrelid=k.conrelid and a.attnum=x.attnum order by x.ord) columns,nt.nspname as "targetSchema",ct.relname as "targetTable",array(select a.attname from unnest(k.confkey) with ordinality x(attnum,ord) join pg_attribute a on a.attrelid=k.confrelid and a.attnum=x.attnum order by x.ord) as "targetColumns" from pg_constraint k join pg_class c on c.oid=k.conrelid join pg_namespace n on n.oid=c.relnamespace join pg_class ct on ct.oid=k.confrelid join pg_namespace nt on nt.oid=ct.relnamespace where k.contype=\'f\' and n.nspname=\'public\'',
    )
  ).rows;
  return { columns, foreignKeys };
}
test("populated registry upgrade preserves reviewed profiles, actor grants and integer audit order while adding stable archive identities", async (t) => {
  const f = await ready(t, false),
    before = (
      await f.db.query(
        "select * from books_legal_entity_access_history order by id",
      )
    ).rows,
    prepared = await f.prepare(),
    reviewed = await f.review();
  await f.db.exec(archive);
  await require("./fixtures/books-export-snapshot-database").installBooksExportSnapshot(
    f.db,
  );
  const after = (
    await f.db.query(
      "select * from books_legal_entity_access_history order by sequence_no",
    )
  ).rows;
  assert.equal(after.length, before.length);
  for (let i = 0; i < before.length; i++) {
    const { id: sequence, ...old } = before[i],
      { id: stable, sequence_no, ...row } = after[i];
    assert.equal(sequence_no, sequence);
    assert.match(stable, /^[a-f0-9-]{36}$/);
    assert.deepEqual(row, old);
  }
  const { prepared_access_event_id: prepareEvent, ...oldPreparation } =
    await f.prepare();
  assert.ok(prepareEvent);
  assert.deepEqual(oldPreparation, prepared);
  const newReview = await f.review();
  const {
    id: reviewId,
    reviewed_access_event_id: reviewEvent,
    ...retained
  } = newReview;
  assert.ok(reviewEvent);
  assert.ok(reviewId);
  assert.deepEqual(retained, reviewed);
  const captured = await f.capture();
  assert.deepEqual(
    Object.keys(captured.tables).sort(),
    [...EXPORT_TABLES].sort(),
  );
  assert.equal(verifyBooksExportBundle(bundle(captured)).valid, true);
  const page = await f.rpc("read_books_legal_entity_setup", [
    org,
    actor,
    entity,
    null,
    50,
  ]);
  assert.deepEqual(
    page.accessHistory.map((e) => e.sequence_no),
    [2, 1],
  );
});
test("complete export requires access to all included entities in the same database snapshot, including after grant revocation", async (t) => {
  const f = await ready(t);
  await f.member(reader, "read");
  assert.equal(
    (await f.rpc("capture_books_entity_authorized_export", [org, reader]))
      .tables.books_legal_entities.length,
    1,
  );
  await f.rpc("create_books_legal_entity", [
    org,
    id(11),
    "OTHER",
    actor,
    notes,
  ]);
  await assert.rejects(
    f.rpc("capture_books_entity_authorized_export", [org, reader]),
    /every included legal entity/,
  );
  await f.rpc("set_books_legal_entity_member", [
    org,
    id(11),
    actor,
    reader,
    "read",
    notes,
  ]);
  assert.equal(
    (await f.rpc("capture_books_entity_authorized_export", [org, reader]))
      .tables.books_legal_entities.length,
    2,
  );
  await f.member(reader, "revoked");
  await assert.rejects(
    f.rpc("capture_books_entity_authorized_export", [org, reader]),
    /every included/,
  );
  await f.db.exec("set role authenticated");
  await assert.rejects(
    f.rpc("capture_books_entity_authorized_export", [org, actor]),
    /permission denied/,
  );
  await f.db.exec("reset role");
});
test("schema18 rejects orphan, forged, self-reviewed, reordered and divergent entity evidence even with recalculated checksums", async (t) => {
  const f = await ready(t),
    source = bundle(await f.capture());
  assert.equal(BOOKS_EXPORT_SCHEMA_VERSION, 32);
  assert.equal(verifyBooksExportBundle(source).valid, true);
  const mutators = [
    (b) => (b.tables.books_legal_entities[0].ledger_state = "active"),
    (b) =>
      (b.tables.books_legal_entities[0].id =
        "99600000-0000-4000-8000-00000000000A"),
    (b) => (b.tables.books_legal_entity_members[0].legal_entity_id = id(999)),
    (b) =>
      (b.tables.books_legal_entity_access_history[1].sequence_no =
        b.tables.books_legal_entity_access_history[0].sequence_no),
    (b) => (b.tables.books_legal_entity_access_history[0].prior_level = "read"),
    (b) => (b.tables.books_legal_entity_members[0].access_level = "read"),
    (b) => (b.tables.books_legal_entity_profile_reviews[0].reviewed_by = actor),
    (b) =>
      (b.tables.books_legal_entity_profiles[0].previous_profile_id = profile),
    (b) => (b.tables.books_legal_entity_profiles[0].revision = 2),
    (b) =>
      (b.tables.books_legal_entity_profiles[0].prepared_access_event_id =
        id(999)),
    (b) =>
      (b.tables.books_legal_entity_profile_reviews[0].reviewed_access_event_id =
        b.tables.books_legal_entity_profiles[0].prepared_access_event_id),
    (b) =>
      (b.tables.books_legal_entity_profiles[0].functional_currency = "CAD"),
    (b) =>
      (b.tables.books_legal_entity_profiles[0].identity_evidence = {
        formation_file_id: id(500),
      }),
    (b) => b.tables.books_legal_entity_access_history.pop(),
    (b) => (b.tables.books_legal_entity_profiles[0].org_id = id(100)),
    (b) =>
      b.tables.books_legal_entity_profile_reviews.push({
        ...b.tables.books_legal_entity_profile_reviews[0],
        id: id(600),
      }),
  ];
  for (const mutate of mutators) {
    const corrupted = structuredClone(source);
    mutate(corrupted);
    rehash(corrupted);
    const checked = verifyBooksExportBundle(corrupted);
    assert.equal(checked.valid, false, JSON.stringify(checked));
    assert.throws(
      () =>
        prepareBooksRestorePlan({
          bundle: corrupted,
          catalog: { columns: [], foreignKeys: [] },
          dependencies: [],
          fundingActors: {},
        }),
      /verified versioned archive/,
    );
  }
  const old = structuredClone(source);
  old.manifest.schemaVersion = 17;
  assert.equal(verifyBooksExportBundle(old).valid, false);
});
test("restore plan preserves full entity proof, requires actor dependencies, restores exact retries and continues audit sequence without resetting an identity", async (t) => {
  const source = await ready(t),
    b = bundle(await source.capture()),
    original = structuredClone(b),
    target = await setup(t),
    c = await catalog(target.db),
    dependencies = [
      { schema: "public", table: "orgs", rows: [{ id: org }] },
      {
        schema: "public",
        table: "app_users",
        rows: [actor, reviewer, reader].map((id) => ({ id })),
      },
    ];
  const missing = prepareBooksRestorePlan({
    bundle: b,
    catalog: c,
    dependencies: [],
    fundingActors: {},
  });
  assert.equal(missing.preflight.readyForRestoreAttempt, false);
  assert.ok(
    missing.preflight.externalDependencies.some(
      (row) => row.targetTable === "app_users",
    ),
  );
  const plan = prepareBooksRestorePlan({
    bundle: b,
    catalog: c,
    dependencies,
    fundingActors: {},
  });
  assert.equal(
    plan.preflight.readyForRestoreAttempt,
    true,
    JSON.stringify(plan.preflight),
  );
  assert.deepEqual(b, original);
  await target.db.exec("begin;set local session_replication_role=replica");
  for (const table of EXPORT_TABLES)
    for (const row of plan.tables[table]) {
      const keys = Object.keys(row);
      await target.db.query(
        `insert into ${table}(${keys.map((k) => '"' + k + '"').join(",")}) values(${keys.map((_, i) => "$" + (i + 1)).join(",")})`,
        Object.values(row).map((v) =>
          v && typeof v === "object" ? JSON.stringify(v) : v,
        ),
      );
    }
  await target.db.exec("set local session_replication_role=origin;commit");
  assert.deepEqual(await target.create(), await source.create());
  assert.deepEqual(await target.prepare(), await source.prepare());
  assert.deepEqual(await target.review(), await source.review());
  assert.deepEqual((await target.capture()).tables, b.tables);
  await target.member(reviewer, "read");
  const snapshot = await target.capture();
  assert.equal(verifyBooksExportBundle(bundle(snapshot)).valid, true);
  assert.deepEqual(
    snapshot.tables.books_legal_entity_access_history
      .map((row) => row.sequence_no)
      .sort((a, b) => a - b),
    [1, 2, 3],
  );
  const old = structuredClone(b);
  old.manifest.schemaVersion = 17;
  for (const table of LEGAL_ENTITY_ARCHIVE_TABLES) {
    delete old.tables[table];
    delete old.manifest.tables[table];
  }
  const legacy = prepareBooksRestorePlan({
    bundle: old,
    catalog: c,
    dependencies,
    fundingActors: {},
  });
  assert.equal(legacy.preflight.readyForRestoreAttempt, true);
  assert.ok(
    LEGAL_ENTITY_ARCHIVE_TABLES.every(
      (table) => legacy.tables[table].length === 0,
    ),
    "legacy recovery cannot silently assign entity ownership",
  );
});

test("download checks the retained entity inventory against current access and frozen proof cannot be edited to hide an entity", async (t) => {
  const f = await ready(t);
  await f.member(reader, "read");
  const b = bundle(await f.capture());
  await f.db.query(
    "insert into books_exports(id,org_id,export_type,status,schema_version,manifest) values($1,$2,'complete','ready',18,$3::jsonb)",
    [id(900), org, JSON.stringify(b.manifest)],
  );
  const check = () =>
    f.rpc("assert_books_entity_export_download", [org, reader, id(900)]);
  assert.equal(await check(), true);
  await f.member(reader, "revoked");
  await assert.rejects(check(), /outside current access/);
  await assert.rejects(
    f.db.query(
      "update books_exports set manifest=jsonb_set(manifest,'{legalEntityIds}','[]') where id=$1",
      [id(900)],
    ),
    /proof is immutable/,
  );
  await f.db.query(
    "update books_exports set downloaded_by=$1,downloaded_at=now() where id=$2",
    [actor, id(900)],
  );
  await f.member(reader, "read");
  assert.equal(await check(), true);
  const missing = structuredClone(b.manifest);
  delete missing.legalEntityIds;
  await f.db.query(
    "insert into books_exports(id,org_id,export_type,status,schema_version,manifest) values($1,$2,'complete','ready',18,$3::jsonb)",
    [id(901), org, JSON.stringify(missing)],
  );
  await assert.rejects(
    f.rpc("assert_books_entity_export_download", [org, reader, id(901)]),
    /inventory is unavailable/,
  );
  const wrong = structuredClone(b);
  wrong.manifest.legalEntityIds = [id(999)];
  assert.equal(verifyBooksExportBundle(wrong).valid, false);
  for (const op of ["insert", "update", "delete"])
    assert.equal(
      (
        await f.db.query("select has_table_privilege($1,$2,$3) granted", [
          "authenticated",
          "books_exports",
          op,
        ])
      ).rows[0].granted,
      false,
    );
  await f.db.query(
    "insert into books_exports(id,org_id,export_type,status,schema_version,manifest,expires_at) values($1,$2,'complete','ready',18,$3::jsonb,'2020-01-01')",
    [id(902), org, JSON.stringify(b.manifest)],
  );
  await assert.rejects(
    f.rpc("assert_books_entity_export_download", [org, reader, id(902)]),
    /unavailable/,
  );
  assert.equal(
    (
      await f.db.query(
        "select has_table_privilege('authenticated','books_exports','select') granted",
      )
    ).rows[0].granted,
    false,
  );
  const actions = fs.readFileSync("app/(app)/books/actions.ts", "utf8"),
    start = actions.indexOf(
      "export async function getBooksExportDownloadAction",
    ),
    end = actions.indexOf(
      "export async function loadBooksFundingAction",
      start,
    ),
    body = actions.slice(start, end);
  assert.ok(
    body.indexOf("assert_books_entity_export_download") <
      body.indexOf("createFilesDownloadUrl"),
  );
  assert.match(body, /entityAccess\.data !== true/);
});

test("populated upgrade refuses missing historical authority without inventing a default entity approval", async (t) => {
  const f = await ready(t, false);
  await f.db.exec(
    "set session_replication_role=replica;update books_legal_entity_profiles set prepared_at='2000-01-01';set session_replication_role=origin",
  );
  const before = (await f.db.query("select * from books_legal_entity_profiles"))
    .rows;
  await f.db.exec("begin");
  await assert.rejects(f.db.exec(archive), /lacks proven historical/);
  await f.db.exec("rollback");
  assert.deepEqual(
    (await f.db.query("select * from books_legal_entity_profiles")).rows,
    before,
  );
  assert.equal(
    (
      await f.db.query(
        "select count(*)::int n from information_schema.columns where table_name='books_legal_entity_profiles' and column_name='prepared_access_event_id'",
      )
    ).rows[0].n,
    0,
  );
});
