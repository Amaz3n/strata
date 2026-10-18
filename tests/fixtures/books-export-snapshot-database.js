const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// The latest complete definition of the export snapshot, with its grants. It
// stands alone (no wrapper chain), so installing it alone is exact.
async function installBooksExportSnapshot(db) {
  const directory = path.join(__dirname, "../../supabase/migrations");
  const definition =
    "create or replace function public.capture_books_export_snapshot(";
  const latest = fs
    .readdirSync(directory)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => fs.readFileSync(path.join(directory, name), "utf8"))
    .filter((sql) => sql.includes(definition))
    .at(-1);
  assert.ok(latest, "Snapshot function migration is required");
  const start = latest.indexOf(definition);
  const end = latest.indexOf("$$;", start);
  assert.ok(end > start, "Snapshot body terminator is required");
  await db.exec(latest.slice(start, end + 3));
  const grants = latest
    .slice(end + 3)
    .match(
      /^(?:\s*(?:revoke|grant)[^;]*capture_books_export_snapshot\(uuid\)[^;]*;)+/i,
    );
  if (grants) await db.exec(grants[0]);
}
module.exports = { installBooksExportSnapshot };
