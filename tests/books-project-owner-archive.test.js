require("../scripts/register-ts-node-test");
const test = require("node:test"),
  assert = require("node:assert/strict");
const {
  setup,
  id,
  org,
  entity,
  maker,
  reviewer,
  supportBytes,
} = require("./fixtures/books-project-owner-database");
const {
  PROJECT_ENTITY_TABLES,
  verifyProjectEntityArchive,
} = require("../lib/services/books/project-entity-archive");
const {
  LEGAL_ENTITY_ARCHIVE_TABLES,
} = require("../lib/services/books/legal-entity-archive");
const {
  ENTITY_CHART_TABLES,
} = require("../lib/services/books/entity-chart-archive");
const {
  EXPORT_TABLES,
  BOOKS_EXPORT_SCHEMA_VERSION,
  verifyBooksExportBundle,
} = require("../lib/services/books/export-contract");
const { booksDigest } = require("../lib/services/books/hash");
const {
  historicalDocumentInventory,
} = require("../lib/services/books/tax-attachment-archive");
const realTables = [
  ...LEGAL_ENTITY_ARCHIVE_TABLES,
  ...ENTITY_CHART_TABLES,
  ...PROJECT_ENTITY_TABLES,
  "projects",
  "accounting_facts",
  "journal_entries",
  "journal_lines",
  "vendor_bills",
  "invoices",
  "project_expenses",
  "payments",
  "files",
  "doc_versions",
];
async function archive(f) {
  const tables = Object.fromEntries(EXPORT_TABLES.map((t) => [t, []]));
  for (const t of realTables)
    tables[t] = (
      await f.db.query(
        `select to_jsonb(r) row from ${t} r where org_id=$1 order by id`,
        [org],
      )
    ).rows.map((r) => r.row);
  return bundle(tables);
}
function bundle(tables) {
  return {
    tables,
    manifest: {
      schemaVersion: BOOKS_EXPORT_SCHEMA_VERSION,
      orgId: org,
      legalEntityIds: [entity],
      tables: Object.fromEntries(
        Object.entries(tables).map(([t, rows]) => [
          t,
          { rows: rows.length, checksum: booksDigest(rows) },
        ]),
      ),
      supportingFiles: tables.files.map((f) => ({
        id: f.id,
        storagePath: f.storage_path,
        checksum: f.checksum,
        sizeBytes: Number(f.size_bytes),
      })),
      supportingHistoricalFiles: historicalDocumentInventory(tables, org),
    },
    supportingObjects: [
      { fileId: id(80), dataBase64: supportBytes.toString("base64") },
    ],
    supportingHistoricalObjects: [],
  };
}
test("schema23 actual capture includes all original project ownership rows and business validation survives rebuilt checksums", async (t) => {
  const f = await setup(t);
  await f.prepare();
  await f.review();
  const b = await archive(f);
  assert.equal(BOOKS_EXPORT_SCHEMA_VERSION, 32);
  assert.deepEqual(verifyProjectEntityArchive(b.tables, org, 23), []);
  assert.equal(
    verifyBooksExportBundle(b).valid,
    true,
    JSON.stringify(verifyBooksExportBundle(b)),
  );
  const captured = await f.rpc("capture_books_export_snapshot", [org]);
  for (const table of PROJECT_ENTITY_TABLES)
    assert.deepEqual(captured.tables[table], b.tables[table]);
  assert.ok(verifyProjectEntityArchive(b.tables, org, 22).length);
  for (const corrupt of [
    (b) => (b.tables.books_project_entity_reviews[0].reviewed_by = maker),
    (b) => (b.tables.books_project_entity_proposals[0].project_id = id(999)),
    (b) =>
      (b.tables.books_project_entity_proposals[0].prepared_access_event_id =
        id(999)),
    (b) =>
      (b.tables.books_project_entity_proposals[0].documents[0].checksum =
        "b".repeat(64)),
    (b) =>
      b.tables.books_project_entity_reviews.push({
        ...b.tables.books_project_entity_reviews[0],
        id: id(999),
      }),
    (b) =>
      b.tables.accounting_facts.push({
        id: id(200),
        org_id: org,
        source_type: "invoice",
        source_id: id(201),
        payload: { project_dimensions: { [id(70)]: {} } },
      }),
  ]) {
    const bad = structuredClone(b);
    corrupt(bad);
    for (const [t, rows] of Object.entries(bad.tables))
      bad.manifest.tables[t] = {
        rows: rows.length,
        checksum: booksDigest(rows),
      };
    assert.equal(
      verifyBooksExportBundle(bad).valid,
      false,
      JSON.stringify(verifyBooksExportBundle(bad)),
    );
  }
});
test("populated project ownership restore retains original exact receipts and ordinary posting fences", async (t) => {
  const source = await setup(t),
    p = await source.prepare(),
    r = await source.review(),
    b = await archive(source),
    target = await setup(t);
  const order = [...LEGAL_ENTITY_ARCHIVE_TABLES, ...PROJECT_ENTITY_TABLES];
  await target.db.exec("begin;set local session_replication_role=replica");
  for (const t of [...order].reverse())
    await target.db.exec(`delete from ${t}`);
  for (const t of order)
    for (const row of b.tables[t]) {
      const cols = Object.keys(row);
      await target.db.query(
        `insert into ${t} (${cols.join(",")}) values (${cols.map((_, i) => "$" + (i + 1)).join(",")})`,
        cols.map((c) =>
          row[c] && typeof row[c] === "object"
            ? JSON.stringify(row[c])
            : row[c],
        ),
      );
    }
  await target.db.exec("set local session_replication_role=origin;commit");
  const restored = await archive(target);
  assert.equal(
    verifyBooksExportBundle(restored).valid,
    true,
    JSON.stringify(verifyBooksExportBundle(restored)),
  );
  assert.deepEqual(await target.prepare(), p);
  assert.deepEqual(await target.review(), r);
  await assert.rejects(
    target.db.exec(
      `insert into journal_lines(id,org_id,project_id) values('${id(300)}','${org}','${id(70)}')`,
    ),
    /entity-native/,
  );
  await assert.rejects(
    target.db.exec("delete from books_project_entity_reviews"),
    /immutable/,
  );
  await target.prepare({ project: id(71), id: id(92) });
  await target.review({ project: id(71), proposal: id(92), id: id(93) });
  assert.equal(
    (
      await target.db.query(
        "select count(*)::int n from books_project_entity_reviews",
      )
    ).rows[0].n,
    2,
  );
});
