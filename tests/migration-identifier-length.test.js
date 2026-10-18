const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// PostgreSQL truncates identifiers to 63 bytes (NAMEDATALEN - 1) without error.
// Two long names sharing a prefix then collide, and a full-length string literal
// (`proname in (...)`, `to_regprocedure(...)`) never matches the stored name, so
// grant/revoke loops silently skip the function.
const MAX_IDENTIFIER_LENGTH = 63;
const DIRECTORIES = ["supabase/migrations", "supabase/pending-migrations"];

test("migration identifiers fit PostgreSQL's 63-byte limit", () => {
  const offenders = [];
  for (const directory of DIRECTORIES) {
    const absolute = path.join(__dirname, "..", directory);
    if (!fs.existsSync(absolute)) continue;
    for (const file of fs.readdirSync(absolute).filter((name) => name.endsWith(".sql"))) {
      const sql = fs.readFileSync(path.join(absolute, file), "utf8");
      // An underscore separates real identifiers from checksums and other long hex tokens.
      const long = sql.match(/\b[a-z_][a-z0-9_]*_[a-z0-9_]*\b/gi) ?? [];
      for (const name of new Set(long)) {
        if (Buffer.byteLength(name) > MAX_IDENTIFIER_LENGTH) offenders.push(`${directory}/${file}: ${name} (${name.length})`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});
