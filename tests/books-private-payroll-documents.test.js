require("../scripts/register-ts-node-test");
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs");
const { id, org } = require("./helpers/books-payroll-register-fixture");
const {
  fixture,
} = require("./helpers/books-private-payroll-documents-fixture");
const checksum =
  "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
async function commit(f, override = {}) {
  const values = [
    org,
    id(8600),
    id(8601),
    id(50),
    "Provider.csv",
    3,
    checksum,
    org + "/books/payroll-private/" + id(8600) + "/source.csv",
  ];
  for (const [key, value] of Object.entries(override))
    values[Number(key)] = value;
  return (
    await f.db.query(
      "select commit_books_private_payroll_document($1,$2,$3,$4,$5,$6,$7,$8) result",
      values,
    )
  ).rows[0].result;
}
test("existing payroll registers and versions are hidden despite broad ordinary document permissions; public documents remain available", async (t) => {
  const f = await fixture(t);
  await f.db.query(
    "insert into files(id,org_id,storage_path,file_name) values($1,$2,$3,'General.csv')",
    [id(8690), org, org + "/general.csv"],
  );
  await f.db.query(
    "insert into doc_versions(id,org_id,file_id,storage_path,file_name) values($1,$2,$3,$4,$5)",
    [id(8691), org, id(8690), org + "/general.csv", "General.csv"],
  );
  await f.db.query(
    "insert into file_links(id,org_id,file_id) values($1,$2,$3),($4,$2,$5)",
    [id(8692), org, id(8), id(8693), id(8690)],
  );
  await f.db.exec("set role authenticated");
  assert.deepEqual(
    (await f.db.query("select id from files")).rows.map((r) => r.id),
    [id(8690)],
  );
  assert.deepEqual(
    (await f.db.query("select id from doc_versions")).rows.map((r) => r.id),
    [id(8691)],
  );
  assert.deepEqual(
    (await f.db.query("select id from file_links")).rows.map((r) => r.id),
    [id(8693)],
  );
  assert.equal(
    (
      await f.db.query(
        "update files set metadata='{}' where id=$1 returning id",
        [id(8)],
      )
    ).rows.length,
    0,
  );
  await assert.rejects(commit(f), /permission denied/);
  await f.db.exec("reset role");
  assert.equal(
    (await f.db.query("select metadata from files where id=$1", [id(8)]))
      .rows[0].metadata.books_private_kind,
    "payroll_register",
  );
});
test("private upload metadata commits atomically, retries exact original identities, and refuses source or actor substitution", async (t) => {
  const f = await fixture(t);
  await f.db.exec("set role service_role");
  const expected = {
    fileId: id(8600),
    documentVersionId: id(8601),
    fileName: "Provider.csv",
    sizeBytes: 3,
    checksum,
  };
  assert.deepEqual(await commit(f), expected);
  assert.deepEqual(await commit(f), expected);
  for (const changed of [
    { 2: id(8602) },
    { 3: id(51) },
    { 4: "Changed.csv" },
    { 5: 4 },
    { 6: "f".repeat(64) },
  ])
    await assert.rejects(commit(f, changed), /different original/);
  await f.db.exec("reset role");
  assert.equal(
    (
      await f.db.query("select count(*)::int n from files where id=$1", [
        id(8600),
      ])
    ).rows[0].n,
    1,
  );
  assert.equal(
    (
      await f.db.query(
        "select count(*)::int n from doc_versions where file_id=$1",
        [id(8600)],
      )
    ).rows[0].n,
    1,
  );
  for (const change of [
    "metadata='{}'",
    "checksum=repeat('f',64)",
    "storage_path='other'",
    "current_version_id=null",
    "share_with_clients=true",
    "visibility='public'",
  ])
    await assert.rejects(
      f.db.query("update files set " + change + " where id=$1", [id(8600)]),
      /immutable|cannot be shared/,
    );
  await f.db.query(
    "insert into files(id,org_id,storage_path,file_name) values($1,$2,$3,'Collision.csv')",
    [id(8699), org, org + "/collision.csv"],
  );
  await f.db.query(
    "insert into doc_versions(id,org_id,file_id,version_number,storage_path,file_name) values($1,$2,$3,1,$4,$5)",
    [id(8611), org, id(8699), org + "/collision.csv", "Collision.csv"],
  );
  await assert.rejects(
    commit(f, {
      1: id(8610),
      2: id(8611),
      7: org + "/books/payroll-private/" + id(8610) + "/source.csv",
    }),
    /duplicate/,
  );
  assert.equal(
    (
      await f.db.query("select count(*)::int n from files where id=$1", [
        id(8610),
      ])
    ).rows[0].n,
    0,
  );
});
test("legacy and private storage paths are classified across historical versions; RPCs are invoker and service-only", async (t) => {
  const f = await fixture(t);
  await commit(f);
  const original = (
    await f.db.query("select storage_path from files where id=$1", [id(8)])
  ).rows[0].storage_path;
  const read = (organization, path) =>
    f.db.query("select is_books_private_payroll_object($1,$2) result", [
      organization,
      path,
    ]);
  assert.equal((await read(org, original)).rows[0].result, true);
  assert.equal((await read(id(99), original)).rows[0].result, false);
  assert.equal((await read(org, org + "/other.csv")).rows[0].result, false);
  await f.db.query(
    "insert into doc_versions(id,org_id,file_id,version_number,storage_path,file_name) values($1,$2,$3,2,$4,$5)",
    [id(8620), org, id(8600), org + "/legacy-version.csv", "Historical.csv"],
  );
  assert.equal(
    (await read(org, org + "/legacy-version.csv")).rows[0].result,
    true,
  );
  for (const name of [
    "is_books_private_payroll_object",
    "commit_books_private_payroll_document",
  ]) {
    const r = (
      await f.db.query(
        "select prosecdef,has_function_privilege('authenticated',oid,'execute') browser,has_function_privilege('anon',oid,'execute') anon,has_function_privilege('service_role',oid,'execute') service from pg_proc where proname=$1",
        [name],
      )
    ).rows[0];
    assert.deepEqual(r, {
      prosecdef: false,
      browser: false,
      anon: false,
      service: true,
    });
  }
});

test("new provider source preparation immediately restricts its existing versioned document", async (t) => {
  const f = await fixture(t),
    {
      nextSource,
    } = require("./helpers/books-payroll-correction-lineage-fixture");
  const source = await nextSource(f, { number: 42, review: false });
  const file = source.evidence.source_proof.file_id,
    version = source.evidence.source_proof.document_version_id;
  assert.equal(
    (await f.db.query("select metadata from files where id=$1", [file])).rows[0]
      .metadata.books_private_kind,
    "payroll_register",
  );
  await f.db.exec("set role authenticated");
  assert.equal(
    (await f.db.query("select id from files where id=$1", [file])).rows.length,
    0,
  );
  assert.equal(
    (await f.db.query("select id from doc_versions where id=$1", [version]))
      .rows.length,
    0,
  );
  await f.db.exec("reset role");
});

test("legacy archive recovery restricts payroll documents without changing original archive or accounting evidence", async (t) => {
  const f = await fixture(t);
  const { capture } = require("./helpers/books-payroll-workflow-fixture");
  const {
    BOOKS_EXPORT_SCHEMA_VERSION,
    verifyBooksExportBundle,
  } = require("../lib/services/books/export-contract");
  const { booksDigest } = require("../lib/services/books/hash");
  const {
    historicalDocumentInventory,
  } = require("../lib/services/books/tax-attachment-archive");
  const {
    prepareBooksRestorePlan,
  } = require("../lib/services/books/restore-plan");
  const tables = (await capture(f.db)).tables;
  for (const file of tables.files) {
    file.metadata = { retained_note: "legacy original" };
    file.visibility = "public";
    file.share_with_subs = true;
    file.share_with_clients = true;
  }
  const bundle = {
    tables,
    manifest: {
      schemaVersion: BOOKS_EXPORT_SCHEMA_VERSION,
      orgId: org,
      tables: Object.fromEntries(
        Object.entries(tables).map(([table, rows]) => [
          table,
          { rows: rows.length, checksum: booksDigest(rows) },
        ]),
      ),
      supportingFiles: tables.files.map((file) => ({
        id: file.id,
        storagePath: file.storage_path,
        sizeBytes: file.size_bytes,
        checksum: file.checksum,
      })),
      supportingHistoricalFiles: historicalDocumentInventory(tables, org),
    },
    supportingObjects: tables.files.map((file) => ({
      fileId: file.id,
      dataBase64: f.registers.get(file.id).toString("base64"),
    })),
    supportingHistoricalObjects: [],
  };
  assert.equal(
    verifyBooksExportBundle(bundle).valid,
    true,
    JSON.stringify(verifyBooksExportBundle(bundle)),
  );
  const original = structuredClone(bundle);
  const columns = (
    await f.db.query(
      "select table_name as table,column_name as name,is_nullable='NO' as \"notNull\",column_default is not null as \"hasDefault\",is_generated <> 'NEVER' as generated from information_schema.columns where table_schema='public'",
    )
  ).rows;
  const plan = prepareBooksRestorePlan({
    bundle,
    catalog: { columns, foreignKeys: [] },
    dependencies: [],
    fundingActors: {},
  });
  assert.equal(
    plan.preflight.readyForRestoreAttempt,
    true,
    JSON.stringify(plan.preflight),
  );
  assert.deepEqual(bundle, original);
  const sourceIds = new Set(
    [
      ...tables.books_payroll_imports,
      ...tables.books_payroll_correction_sources,
    ].map((row) => row.source_proof.file_id),
  );
  for (const file of plan.tables.files) {
    const before = tables.files.find((row) => row.id === file.id);
    if (!sourceIds.has(file.id)) {
      assert.deepEqual(file, before);
      continue;
    }
    assert.deepEqual(file.metadata, {
      retained_note: "legacy original",
      books_private_kind: "payroll_register",
    });
    assert.equal(file.visibility, "private");
    assert.equal(file.share_with_subs, false);
    assert.equal(file.share_with_clients, false);
    for (const key of [
      "id",
      "storage_path",
      "checksum",
      "size_bytes",
      "current_version_id",
      "file_name",
    ])
      assert.deepEqual(file[key], before[key]);
    assert.ok(
      plan.changes.some(
        (change) =>
          change.table === "files" &&
          change.rowId === file.id &&
          change.fields.includes("metadata"),
      ),
    );
  }
  for (const name of [
    "journal_entries",
    "journal_lines",
    "job_cost_entries",
    "books_payroll_imports",
    "books_payroll_correction_sources",
    "doc_versions",
  ])
    assert.deepEqual(plan.tables[name], tables[name], name);
});
