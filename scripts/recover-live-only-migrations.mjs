#!/usr/bin/env node
/**
 * Write migrations that exist only in production back into the repository.
 *
 * Applying a migration through the Supabase MCP records it under a fresh
 * timestamp and, when the SQL was composed in the tool rather than read from a
 * file, leaves no repository file at all. Production then carries schema the
 * repo cannot reproduce, which is how `payment_approver_division_scope` — a
 * change to the payment approver roster — came to exist in the database and
 * nowhere in git.
 *
 * The ledger stores each migration's statements, so recovery is mechanical.
 * This reads them and writes `supabase/migrations/<live version>_<name>.sql`,
 * using the live version so the repo and the ledger agree afterwards.
 *
 * Read-only against the database. It never applies anything.
 *
 *   node scripts/recover-live-only-migrations.mjs            # report only
 *   node scripts/recover-live-only-migrations.mjs --write     # write the files
 */

import { readdirSync, writeFileSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { createClient } from "@supabase/supabase-js"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const migrationsDir = join(root, "supabase", "migrations")
const write = process.argv.includes("--write")

// `.env.local` points at production. This script only reads, but say so.
const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) {
  console.error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (source .env.local).")
  process.exit(1)
}

/** Repo migration names, with the version prefix stripped. */
function repoNames() {
  const names = new Set()
  for (const file of readdirSync(migrationsDir)) {
    if (!file.endsWith(".sql")) continue
    const match = /^(\d{14})_(.+)\.sql$/.exec(file)
    if (match) names.add(match[2])
  }
  return names
}

const supabase = createClient(url, key, { auth: { persistSession: false } })

// The ledger lives outside the exposed schemas, so it is read through an RPC
// the repair migration installs rather than through PostgREST directly.
const { data, error } = await supabase.rpc("list_migration_ledger")
if (error) {
  console.error(`Unable to read the migration ledger: ${error.message}`)
  console.error("Apply supabase/scripts/repair-migration-ledger.sql first — it installs list_migration_ledger().")
  process.exit(1)
}

const known = repoNames()
const liveOnly = (data ?? []).filter((row) => {
  // Some ledger rows store the full repo filename as the name.
  const name = String(row.name ?? "").replace(/^\d{14}_/, "")
  return name && !known.has(name)
})

if (liveOnly.length === 0) {
  console.log("No live-only migrations: every ledger row has a repository file.")
  process.exit(0)
}

console.log(`${liveOnly.length} migration(s) exist in production with no repository file:\n`)
for (const row of liveOnly) {
  const name = String(row.name).replace(/^\d{14}_/, "")
  const target = join(migrationsDir, `${row.version}_${name}.sql`)
  const statements = Array.isArray(row.statements) ? row.statements : []
  console.log(`  ${row.version}_${name}  (${statements.length} statement(s), ${statements.join("").length} chars)`)
  if (!write) continue
  if (existsSync(target)) {
    console.log("    already written, skipping")
    continue
  }
  const header = [
    `-- RECOVERED FROM PRODUCTION ${new Date().toISOString().slice(0, 10)}.`,
    "--",
    "-- Applied through the Supabase MCP and never written back to the repository.",
    "-- The version above is the live ledger's, so the repo and the ledger agree.",
    "-- Already applied in production: do not re-run it there.",
    "",
  ].join("\n")
  writeFileSync(target, `${header}${statements.join(";\n")}\n`)
  console.log(`    written to ${target.replace(root + "/", "")}`)
}

if (!write) console.log("\nRe-run with --write to create the files.")
