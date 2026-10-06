#!/usr/bin/env node
// Offline preparation only; never loads environment files or connects to a DB.
require("./register-ts-node-test");
const fs = require("node:fs");
const { gunzipSync } = require("node:zlib");
const {
  prepareLegacyOwnershipInventory,
} = require("../lib/services/books/legacy-ownership-inventory");
function prepareFile(archivePath, outputPath, orgId, accountingCutoff) {
  const bytes = fs.readFileSync(archivePath);
  const json =
    bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes;
  const inventory = prepareLegacyOwnershipInventory(
    JSON.parse(json.toString("utf8")),
    { orgId, accountingCutoff },
  );
  // Exclusive creation preserves an earlier review receipt. Hashes/identities
  // are sufficient for locating originals; do not copy wages, TINs or documents.
  fs.writeFileSync(outputPath, JSON.stringify(inventory, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  return inventory;
}
if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 4)
      throw new Error(
        "Use ARCHIVE NEW_OUTPUT_JSON ORG_UUID ACCOUNTING_CUTOFF_YYYY_MM_DD",
      );
    const receipt = prepareFile(...args);
    console.log(
      `UNREVIEWED: ${receipt.populations.reduce((n, p) => n + p.rows, 0)} retained rows; ${receipt.inventorySha256}`,
    );
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
module.exports = { prepareFile };
