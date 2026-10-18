#!/usr/bin/env node
/**
 * The deploy list: every repository migration production has not applied.
 * Read-only. The ledger comes from production's `list_migration_ledger()` (with
 * production credentials), or from a ledger file exported read-only:
 *
 *   pnpm db:pending                       # live, when list_migration_ledger exists
 *   pnpm db:pending --ledger ledger.txt   # `version name` per line, or JSON
 *   pnpm db:pending --json
 *
 * `supabase/pending-migrations/` is never listed: those cutovers are held behind
 * release gates and are not part of a deploy.
 */
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { classifyMigrations, parseLedger, readVerifiedApplied, repositoryMigrations } from "./migration-ledger.mjs"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const args = process.argv.slice(2)
const ledgerFile = args.includes("--ledger") ? args[args.indexOf("--ledger") + 1] : null

async function readLedger() {
  if (ledgerFile) return parseLedger(readFileSync(ledgerFile, "utf8"))
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error("No production credentials: pass --ledger with a read-only export of supabase_migrations.schema_migrations")
  const response = await fetch(`${url}/rest/v1/rpc/list_migration_ledger`, {
    method: "POST",
    headers: { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: "{}",
  })
  if (!response.ok) throw new Error(`Cannot read the production ledger (${response.status}); list_migration_ledger() is installed by the reviewed supabase/scripts/repair-migration-ledger.sql. Until then pass --ledger.`)
  return (await response.json()).map((row) => ({ version: String(row.version), name: String(row.name ?? "") }))
}

const result = classifyMigrations({
  migrations: repositoryMigrations(join(root, "supabase", "migrations")),
  ledger: await readLedger(),
  verified: readVerifiedApplied(root),
})

if (args.includes("--json")) {
  console.log(JSON.stringify({ pending: result.pending.map((m) => m.file), counts: Object.fromEntries(Object.entries(result).map(([key, list]) => [key, list.length])) }, null, 2))
} else {
  console.log(`Applied: ${result.exact.length} by version, ${result.underOtherVersion.length} under another version, ${result.verifiedApplied.length} object-verified (ledger repair pending).`)
  console.log(`\nPending for production (${result.pending.length}), in order:`)
  for (const migration of result.pending) console.log(`  ${migration.file}`)
}
