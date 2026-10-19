import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

// This release suite must never silently skip its PostgreSQL behavior tests.
const require = createRequire(import.meta.url);
try {
  const { PGlite } = require(process.env.ARC_TEST_PGLITE_MODULE || "@electric-sql/pglite");
  const db = new PGlite();
  await db.query("select 1");
  await db.close();
} catch (error) {
  console.error("Precon verification requires the PGlite dev dependency. Run pnpm install first.");
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

const related = new Set([
  "deal-documents.test.js", "proposal-documents.test.js", "estimate-draft.test.js", "draft-save-queue.test.js",
  "estimate-commercial.test.js", "estimates.test.js", "estimate-portal.test.js", "estimate-issuance.test.js",
  "estimate-document-authorization.test.js", "bids.test.js", "bid-intelligence.test.js", "prospects.test.js",
  "prospect-write-access.test.js", "conversions.test.js", "tasks-db.test.js", "prospects-db.test.js",
]);
const files = readdirSync(new URL("../tests/", import.meta.url))
  .filter(name => name.endsWith(".test.js") && (name.startsWith("precon-") || name.startsWith("bid-pricing-") || related.has(name)))
  .sort().map(name => `tests/${name}`);
const result = spawnSync(process.execPath, ["--test", "--test-concurrency=2", ...files], {
  cwd: new URL("../", import.meta.url), stdio: "inherit", env: process.env,
});
if (result.error) console.error(result.error);
process.exit(result.status ?? 1);
