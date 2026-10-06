require("../scripts/register-ts-node-test");
const test = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const { gzipSync } = require("node:zlib");
const {
  EXPORT_TABLES,
  BOOKS_EXPORT_SCHEMA_VERSION,
} = require("../lib/services/books/export-contract");
const { booksDigest } = require("../lib/services/books/hash");
const {
  prepareLegacyOwnershipInventory,
  assertLegacyOwnershipInventoryCurrent,
} = require("../lib/services/books/legacy-ownership-inventory");
const {
  prepareFile,
} = require("../scripts/prepare-books-ownership-inventory.cjs");
const id = (n) => "88700000-0000-4000-8000-" + String(n).padStart(12, "0");
const orgId = id(1),
  input = { orgId, accountingCutoff: "2026-09-30" };
function refresh(b) {
  b.manifest.tables = Object.fromEntries(
    Object.entries(b.tables).map(([table, rows]) => [
      table,
      { rows: rows.length, checksum: booksDigest(rows) },
    ]),
  );
  return b;
}
function fixture() {
  const tables = Object.fromEntries(EXPORT_TABLES.map((table) => [table, []]));
  tables.gl_accounts = [
    { id: id(2), org_id: orgId },
    { id: id(3), org_id: orgId },
  ];
  tables.journal_entries = [{ id: id(4), org_id: orgId, status: "posted" }];
  tables.journal_lines = [
    {
      id: id(5),
      org_id: orgId,
      entry_id: id(4),
      account_id: id(2),
      debit_cents: 100,
      credit_cents: 0,
    },
    {
      id: id(6),
      org_id: orgId,
      entry_id: id(4),
      account_id: id(3),
      debit_cents: 0,
      credit_cents: 100,
    },
  ];
  tables.audit_log = [
    { id: "9007199254740993", org_id: orgId, action: "update" },
  ];
  tables.invoices = [{ id: id(7), org_id: orgId, issue_date: "2027-01-01" }];
  tables.companies = [
    {
      id: id(8),
      org_id: orgId,
      name: "Private counterparty original",
      tax_id: "PRIVATE-TIN",
    },
  ];
  return refresh({
    tables,
    manifest: {
      schemaVersion: BOOKS_EXPORT_SCHEMA_VERSION,
      orgId,
      legalEntityIds: [],
      tables: {},
      supportingFiles: [],
      supportingHistoricalFiles: [],
    },
  });
}
test("retains every current table and post-cutoff source without inferring ownership", () => {
  const b = fixture(),
    original = structuredClone(b),
    receipt = prepareLegacyOwnershipInventory(b, input);
  assert.deepEqual(b, original);
  assert.deepEqual(
    receipt.populations.map((p) => p.table),
    [...EXPORT_TABLES],
  );
  assert.equal(
    receipt.populations.find((p) => p.table === "invoices").retainedRows[0].id,
    id(7),
  );
  assert.equal(
    receipt.populations.find((p) => p.table === "audit_log").retainedRows[0].id,
    "9007199254740993",
  );
  assert.equal(receipt.status, "UNREVIEWED");
  assert.equal(receipt.approvedForLedgerActivation, false);
  assert.deepEqual(receipt.entityAssignments, []);
  assert.equal(receipt.archiveEvidenceSha256, booksDigest(b));
  assert.doesNotThrow(() => assertLegacyOwnershipInventoryCurrent(receipt, b));
  assert.ok(!JSON.stringify(receipt).includes("PRIVATE-TIN"));
  assert.ok(!JSON.stringify(receipt).includes("Private counterparty original"));
});
test("stale original rows, added populations, and altered review receipts fail", () => {
  const b = fixture(),
    receipt = prepareLegacyOwnershipInventory(b, input);
  for (const change of [
    (v) => {
      v.tables.companies[0].name = "Replaced original";
    },
    (v) => {
      v.tables.invoices.push({ id: id(9), org_id: orgId });
    },
    (v) => {
      v.tables.gl_accounts.reverse();
    },
  ]) {
    const changed = structuredClone(b);
    change(changed);
    refresh(changed);
    assert.throws(
      () => assertLegacyOwnershipInventoryCurrent(receipt, changed),
      /evidence changed/,
    );
  }
  for (const change of [
    (v) => {
      v.accountingCutoff = "2026-10-01";
    },
    (v) => {
      v.approvedForLedgerActivation = true;
    },
    (v) => {
      v.populations[0].rows++;
    },
  ]) {
    const changed = structuredClone(receipt);
    change(changed);
    assert.throws(
      () => assertLegacyOwnershipInventoryCurrent(changed, b),
      /receipt changed/,
    );
  }
});
test("rejects corrupt, incomplete, old, cross-org and unknown archive evidence", () => {
  for (const change of [
    (v) => {
      v.tables.journal_lines[0].debit_cents = 101;
      refresh(v);
    },
    (v) => {
      delete v.tables.invoices;
      refresh(v);
    },
    (v) => {
      v.manifest.schemaVersion = 17;
    },
    (v) => {
      v.tables.companies[0].org_id = id(99);
      refresh(v);
    },
    (v) => {
      v.tables.companies.push(v.tables.companies[0]);
      refresh(v);
    },
    (v) => {
      v.tables.unknown_money = [];
      refresh(v);
    },
    (v) => {
      v.tables.audit_log[0].id = "9223372036854775808";
      refresh(v);
    },
    (v) => {
      v.tables.audit_log[0].id = "09";
      refresh(v);
    },
    (v) => {
      v.tables.companies[0].name = "Unchecksummed replacement";
    },
  ]) {
    const b = fixture();
    change(b);
    assert.throws(() => prepareLegacyOwnershipInventory(b, input));
  }
  for (const accountingCutoff of ["2026-02-30", "2026-2-01", "not-a-date"])
    assert.throws(() =>
      prepareLegacyOwnershipInventory(fixture(), { orgId, accountingCutoff }),
    );
  assert.throws(() =>
    prepareLegacyOwnershipInventory(fixture(), { ...input, orgId: id(99) }),
  );
});
test("a checksummed source edit invalidates the exact archive without rewriting old inventory", () => {
  const b = fixture(),
    receipt = prepareLegacyOwnershipInventory(b, input);
  const changed = structuredClone(b);
  changed.tables.invoices[0].project_id = null;
  refresh(changed);
  assert.throws(
    () => assertLegacyOwnershipInventoryCurrent(receipt, changed),
    /evidence changed/,
  );
  assert.equal(
    receipt.populations.find((p) => p.table === "invoices").retainedRows[0]
      .evidenceSha256,
    booksDigest(b.tables.invoices[0]),
  );
});
test("offline JSON/gzip preparation writes private exclusive receipts and refuses invalid evidence before output", (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "books-ownership-inventory-"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const b = fixture();
  for (const gzip of [false, true]) {
    const archive = path.join(root, gzip ? "archive.gz" : "archive.json"),
      output = path.join(root, gzip ? "receipt-gz.json" : "receipt.json");
    fs.writeFileSync(
      archive,
      gzip ? gzipSync(JSON.stringify(b)) : JSON.stringify(b),
    );
    const result = prepareFile(archive, output, orgId, input.accountingCutoff);
    assert.deepEqual(JSON.parse(fs.readFileSync(output, "utf8")), result);
    assert.equal(fs.statSync(output).mode & 0o777, 0o600);
    assert.throws(
      () => prepareFile(archive, output, orgId, input.accountingCutoff),
      /EEXIST/,
    );
    assert.deepEqual(JSON.parse(fs.readFileSync(output, "utf8")), result);
    const badOutput = output + ".invalid";
    b.tables.journal_lines[0].debit_cents++;
    refresh(b);
    const badArchive = archive + ".invalid";
    fs.writeFileSync(badArchive, JSON.stringify(b));
    assert.throws(() =>
      prepareFile(badArchive, badOutput, orgId, input.accountingCutoff),
    );
    assert.equal(fs.existsSync(badOutput), false);
    b.tables.journal_lines[0].debit_cents--;
    refresh(b);
  }
});
