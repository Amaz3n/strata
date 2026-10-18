#!/usr/bin/env node
// Offline only: creates reviewable SQL, never connects to or mutates a database.
require("./register-ts-node-test");
const fs = require("node:fs"),
  { gunzipSync } = require("node:zlib");
const {
  prepareJournalResolutionRestoreSql,
} = require("../lib/services/books/journal-resolution-restore");
if (require.main === module) {
  try {
    const [archive, identity, output, ...extra] = process.argv.slice(2);
    if (!archive || !identity || !output || extra.length)
      throw Error(
        "Usage: node scripts/prepare-books-journal-resolution-restore.cjs archive.json.gz isolated-identity.json NEW_restore.sql",
      );
    const bytes = fs.readFileSync(archive);
    const bundle = JSON.parse(
      (bytes[0] === 0x1f && bytes[1] === 0x8b
        ? gunzipSync(bytes)
        : bytes
      ).toString("utf8"),
    );
    const sql = prepareJournalResolutionRestoreSql(
      bundle,
      JSON.parse(fs.readFileSync(identity, "utf8")),
    );
    fs.writeFileSync(output, sql, { flag: "wx", mode: 0o600 });
    console.log(
      JSON.stringify({
        output,
        scope:
          "Isolated exact journal recovery history only; ordinary accounting restoration must precede execution",
      }),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
