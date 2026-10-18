require("../scripts/register-ts-node-test");
const test = require("node:test"),
  assert = require("node:assert/strict");
const { fixture, id } = require("./fixtures/books-journal-resolution-database");
const {
  EXPORT_TABLES,
  verifyBooksExportBundle,
} = require("../lib/services/books/export-contract");
const { booksDigest } = require("../lib/services/books/hash");
const {
  prepareJournalResolutionRestoreSql,
} = require("../lib/services/books/journal-resolution-restore");
const identity = {
  instanceId: id(90),
  projectId: "arc-books-acceptance-journal-restore",
  migrationManifestSha256: "a".repeat(64),
  database: "postgres",
  migrationVersions: ["20261004211129"],
};
async function archive(f) {
  const tables = Object.fromEntries(EXPORT_TABLES.map((t) => [t, []]));
  for (const t of [
    "books_journal_request_resolutions",
    "books_journal_proposals",
    "journal_entries",
    "journal_lines",
    "gl_accounts",
    "accounting_periods",
    "projects",
    "companies",
  ])
    tables[t] = (
      await f.db.query(
        `select to_jsonb(r) row from ${t} r where org_id=$1 order by id`,
        [id(1)],
      )
    ).rows.map((r) => r.row);
  const bundle = {
    tables,
    manifest: {
      schemaVersion: 34,
      orgId: id(1),
      tables: Object.fromEntries(
        Object.entries(tables).map(([name, rows]) => [
          name,
          { rows: rows.length, checksum: booksDigest(rows) },
        ]),
      ),
      supportingFiles: [],
      supportingHistoricalFiles: [],
    },
  };
  assert.equal(
    verifyBooksExportBundle(bundle).valid,
    true,
    JSON.stringify(verifyBooksExportBundle(bundle)),
  );
  return bundle;
}
async function marker(db, overrides = {}) {
  const v = { ...identity, ...overrides };
  await db.exec(
    `create schema supabase_migrations;create table supabase_migrations.schema_migrations(version text primary key);insert into supabase_migrations.schema_migrations values('20261004211129');create schema books_acceptance;create table books_acceptance.environment(instance_id uuid,project_id text,isolated boolean,migration_manifest_sha256 text);`,
  );
  await db.query(
    "insert into books_acceptance.environment values($1,$2,true,$3)",
    [v.instanceId, v.projectId, v.migrationManifestSha256],
  );
}
async function run(db, sql) {
  try {
    await db.exec(sql);
  } catch (e) {
    await db.exec("rollback");
    throw e;
  }
}
async function seedMoney(target, b) {
  await target.db.exec("begin;set local session_replication_role=replica");
  for (const table of [
    "books_journal_proposals",
    "journal_entries",
    "journal_lines",
  ])
    for (const r of b.tables[table]) {
      const names = Object.keys(r);
      await target.db.query(
        `insert into ${table}(${names.join(",")}) values(${names.map((_, i) => "$" + (i + 1)).join(",")})`,
        Object.values(r).map((v) =>
          v && typeof v === "object" ? JSON.stringify(v) : v,
        ),
      );
    }
  // Accounts and periods were created independently by the fixture, with new timestamps.
  for (const table of ["gl_accounts", "accounting_periods"])
    for (const r of b.tables[table]) {
      const names = Object.keys(r).filter((k) => k !== "id");
      await target.db.query(
        `update ${table} set ${names.map((k, i) => k + "=$" + (i + 1)).join(",")} where id=$${names.length + 1}`,
        [
          ...names.map((k) =>
            r[k] && typeof r[k] === "object" ? JSON.stringify(r[k]) : r[k],
          ),
          r.id,
        ],
      );
    }
  await target.db.exec("set local session_replication_role=origin;commit");
}
test("exact historical cancellations survive isolated restore, guards remain enabled and late packets remain fenced", async (t) => {
  const source = await fixture(t);
  const request = {
    ...source.prep,
    memo: "Quoted ' note \\ $books_restore_preflight$; drop table orgs; -- 建",
  };
  await source.resolve("prepare", request);
  const b = await archive(source),
    target = await fixture(t);
  await marker(target.db);
  await seedMoney(target, b);
  const sql = prepareJournalResolutionRestoreSql(b, identity);
  await run(target.db, sql);
  assert.deepEqual((await archive(target)).tables, b.tables);
  assert.equal((await target.resolve("prepare", request)).created, false);
  await assert.rejects(target.prepare(), /cancelled/);
  assert.equal(
    (
      await target.db.query(
        "select bool_and(tgenabled='O') valid from pg_trigger where tgrelid='books_journal_request_resolutions'::regclass",
      )
    ).rows[0].valid,
    true,
  );
  await assert.rejects(run(target.db, sql), /must be empty/);
});
test("acknowledged immutable posted review restores byte evidence without current membership or fresh approval", async (t) => {
  const source = await fixture(t),
    p = await source.prepare();
  await source.review(p.id);
  await source.resolve("review", source.req(p.id));
  const b = await archive(source),
    target = await fixture(t);
  await marker(target.db);
  await seedMoney(target, b);
  await target.db.query(
    "update memberships set status='revoked' where user_id=$1",
    [id(7)],
  );
  await run(target.db, prepareJournalResolutionRestoreSql(b, identity));
  assert.deepEqual((await archive(target)).tables, b.tables);
  await target.db.query(
    "update memberships set status='active' where user_id=$1",
    [id(7)],
  );
  assert.equal(
    (await target.resolve("review", target.req(p.id))).created,
    false,
  );
  assert.equal((await target.review(p.id)).created, false);
});
test("wrong target identity or changed restored money refuses import before disabling guards", async (t) => {
  const source = await fixture(t);
  await source.resolve("prepare", source.prep);
  const b = await archive(source),
    target = await fixture(t);
  await marker(target.db, { instanceId: id(91) });
  await seedMoney(target, b);
  const sql = prepareJournalResolutionRestoreSql(b, identity);
  await assert.rejects(run(target.db, sql), /identity/);
  await target.db.query(
    "update books_acceptance.environment set instance_id=$1",
    [identity.instanceId],
  );
  await target.db.query(
    "update gl_accounts set name='Changed restored chart' where id=$1",
    [id(3)],
  );
  await assert.rejects(run(target.db, sql), /gl_accounts differs/);
  assert.equal(
    (
      await target.db.query(
        "select count(*)::int n from books_journal_request_resolutions",
      )
    ).rows[0].n,
    0,
  );
  assert.equal(
    (
      await target.db.query(
        "select bool_and(tgenabled='O') valid from pg_trigger where tgrelid='books_journal_request_resolutions'::regclass",
      )
    ).rows[0].valid,
    true,
  );
  const bad = structuredClone(b);
  bad.tables.books_journal_request_resolutions[0].reason = "Tampered";
  assert.throws(
    () => prepareJournalResolutionRestoreSql(bad, identity),
    /verified/,
  );
});

test("failed retained actor dependency rolls back import and restores the ordinary insert guard", async (t) => {
  const source = await fixture(t);
  await source.resolve("prepare", source.prep);
  const b = await archive(source),
    target = await fixture(t);
  await marker(target.db);
  await seedMoney(target, b);
  await target.db.query("delete from app_users where id=$1", [id(2)]);
  await assert.rejects(
    run(target.db, prepareJournalResolutionRestoreSql(b, identity)),
    /foreign key/,
  );
  assert.equal(
    (
      await target.db.query(
        "select count(*)::int n from books_journal_request_resolutions",
      )
    ).rows[0].n,
    0,
  );
  assert.equal(
    (
      await target.db.query(
        "select bool_and(tgenabled='O') valid from pg_trigger where tgrelid='books_journal_request_resolutions'::regclass",
      )
    ).rows[0].valid,
    true,
  );
  await assert.rejects(
    target.db.query(
      "insert into books_journal_request_resolutions select * from jsonb_populate_recordset(null::books_journal_request_resolutions,$1::jsonb)",
      [JSON.stringify(b.tables.books_journal_request_resolutions)],
    ),
    /foreign key/,
  );
});

test("installed migration drift is rejected before history import", async (t) => {
  const source = await fixture(t);
  await source.resolve("prepare", source.prep);
  const b = await archive(source),
    target = await fixture(t);
  await marker(target.db);
  await seedMoney(target, b);
  await target.db.exec(
    "insert into supabase_migrations.schema_migrations values('20261004235959')",
  );
  await assert.rejects(
    run(target.db, prepareJournalResolutionRestoreSql(b, identity)),
    /migration identities differ/,
  );
  assert.equal(
    (
      await target.db.query(
        "select count(*)::int n from books_journal_request_resolutions",
      )
    ).rows[0].n,
    0,
  );
});

test("offline CLI preserves archive bytes, creates private reviewable SQL and refuses overwriting it", async (t) => {
  const fs = require("node:fs"),
    os = require("node:os"),
    path = require("node:path"),
    { gzipSync } = require("node:zlib"),
    { spawnSync } = require("node:child_process");
  const source = await fixture(t);
  await source.resolve("prepare", source.prep);
  const b = await archive(source);
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "books-journal-restore-cli-"),
  );
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const archivePath = path.join(dir, "archive.json.gz"),
    identityPath = path.join(dir, "identity.json"),
    output = path.join(dir, "new.sql"),
    bytes = gzipSync(Buffer.from(JSON.stringify(b)));
  fs.writeFileSync(archivePath, bytes);
  fs.writeFileSync(identityPath, JSON.stringify(identity));
  const args = [
    "scripts/prepare-books-journal-resolution-restore.cjs",
    archivePath,
    identityPath,
    output,
  ];
  const done = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.equal(done.status, 0, done.stderr);
  assert.equal(
    fs.readFileSync(output, "utf8"),
    prepareJournalResolutionRestoreSql(b, identity),
  );
  assert.equal(fs.statSync(output).mode & 0o777, 0o600);
  const retry = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.equal(retry.status, 1);
  assert.match(retry.stderr, /EEXIST/);
  assert.deepEqual(fs.readFileSync(archivePath), bytes);
});
