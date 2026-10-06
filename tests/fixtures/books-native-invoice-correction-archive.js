const { org, id } = require("./books-native-invoice-correction-database");
const { EXPORT_TABLES } = require("../../lib/services/books/export-contract");
const { booksDigest } = require("../../lib/services/books/hash");
async function archive(f) {
  const names = (
    await f.db.query(
      "select tablename from pg_tables where schemaname='public'",
    )
  ).rows.map((r) => r.tablename);
  const tables = Object.fromEntries(EXPORT_TABLES.map((n) => [n, []]));
  for (const n of EXPORT_TABLES)
    if (names.includes(n))
      tables[n] = (
        await f.db.query(
          `select ${n === "invoice_lines" ? "to_jsonb(r)||jsonb_build_object('quantity',to_jsonb(r)->>'quantity')" : "to_jsonb(r)"} body from ${n} r where org_id=$1 order by to_jsonb(r)::text`,
          [org],
        )
      ).rows.map((r) => r.body);
  return tables;
}
function bundle(tables, version = 30) {
  return {
    tables,
    manifest: {
      schemaVersion: version,
      orgId: org,
      legalEntityIds: tables.books_legal_entities.map((r) => r.id).sort(),
      tables: Object.fromEntries(
        Object.entries(tables).map(([n, r]) => [
          n,
          { rows: r.length, checksum: booksDigest(r) },
        ]),
      ),
      supportingFiles: tables.files.map((f) => ({
        id: f.id,
        storagePath: f.storage_path,
        sizeBytes: Number(f.size_bytes),
        checksum: f.checksum,
      })),
      supportingHistoricalFiles:
        require("../../lib/services/books/tax-attachment-archive").historicalDocumentInventory(
          tables,
          org,
        ),
    },
    supportingObjects: [
      {
        fileId: id(80),
        dataBase64:
          require("./books-project-owner-database").supportBytes.toString(
            "base64",
          ),
      },
    ],
    supportingHistoricalObjects: [],
  };
}
async function restore(f, tables) {
  const actual = (
    await f.db.query(
      "select tablename from pg_tables where schemaname='public'",
    )
  ).rows.map((r) => r.tablename);
  const names = EXPORT_TABLES.filter((n) => actual.includes(n));
  await f.db.exec("begin;set local session_replication_role=replica");
  for (const n of names) await f.db.exec(`delete from ${n}`);
  for (const n of names)
    for (const row of tables[n]) {
      const keys = Object.keys(row);
      await f.db.query(
        `insert into ${n} (${keys.join(",")}) values (${keys.map((_, i) => "$" + (i + 1)).join(",")})`,
        keys.map((k) =>
          row[k] && typeof row[k] === "object"
            ? JSON.stringify(row[k])
            : row[k],
        ),
      );
    }
  await f.db.exec("set local session_replication_role=origin;commit");
}
module.exports = { archive, bundle, restore };
