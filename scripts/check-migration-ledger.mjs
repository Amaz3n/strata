#!/usr/bin/env node
/**
 * Fail when the repository and the production migration ledger disagree.
 *
 * The ledger drifted from the repo by 290 of 326 files before anyone noticed,
 * because nothing ever compared them: migrations applied through the Supabase
 * MCP are recorded under a fresh timestamp, so the repository file they came
 * from reads as unapplied forever. `supabase db push` in that state would try to
 * replay hundreds of migrations against a database that already has them.
 *
 * Two checks, both cheap:
 *
 * 1. **Duplicate names in the repository.** Two files with the same name are
 *    ambiguous no matter what the database says.
 * 2. **Exact production parity**, when a database is reachable: every
 *    repository version exists in the ledger, every ledger version has a
 *    repository file, and neither side contains duplicate names or versions.
 *
 * Without credentials it runs the repository-only half and says so. The
 * database-contracts CI job passes production credentials on trusted branches,
 * so drift fails there; forked pull requests cannot access those secrets and
 * intentionally get only the repository check.
 */

import { readdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const migrationsDir = join(root, "supabase", "migrations")

const problems = []

const byName = new Map()
const byVersion = new Map()
for (const file of readdirSync(migrationsDir)) {
  if (!file.endsWith(".sql")) continue
  const match = /^(\d{14})_(.+)\.sql$/.exec(file)
  if (!match) {
    problems.push(`${file} is not named <14-digit version>_<name>.sql`)
    continue
  }
  const [, version, name] = match
  byName.set(name, [...(byName.get(name) ?? []), file])
  byVersion.set(version, [...(byVersion.get(version) ?? []), file])
}

for (const [name, files] of byName) {
  if (files.length > 1) problems.push(`Duplicate migration name "${name}": ${files.join(", ")}`)
}
for (const [version, files] of byVersion) {
  if (files.length > 1) problems.push(`Duplicate migration version "${version}": ${files.join(", ")}`)
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (url && key && !url.includes("placeholder")) {
  const response = await fetch(`${url}/rest/v1/rpc/list_migration_ledger`, {
    method: "POST",
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: "{}",
  })
  if (!response.ok) {
    const detail = await response.text()
    problems.push(`Unable to read the production migration ledger (${response.status}): ${detail}`)
    problems.push("Run the reviewed supabase/scripts/repair-migration-ledger.sql to install list_migration_ledger().")
  } else {
    const data = await response.json()
    const ledgerNames = new Map()
    const ledgerVersions = new Map()
    for (const row of data ?? []) {
      const name = String(row.name ?? "").replace(/^\d{14}_/, "")
      const version = String(row.version ?? "")
      ledgerNames.set(name, [...(ledgerNames.get(name) ?? []), version])
      ledgerVersions.set(version, [...(ledgerVersions.get(version) ?? []), name])
    }
    for (const [name, versions] of ledgerNames) {
      if (versions.length > 1) problems.push(`Migration "${name}" is recorded ${versions.length} times: ${versions.join(", ")}`)
      if (!byName.has(name)) problems.push(`Migration "${name}" (${versions[0]}) is applied but has no repository file — run scripts/recover-live-only-migrations.mjs`)
    }
    for (const [version, names] of ledgerVersions) {
      if (names.length > 1) problems.push(`Ledger version "${version}" is recorded ${names.length} times: ${names.join(", ")}`)
      if (!byVersion.has(version)) problems.push(`Ledger version "${version}" (${names[0]}) has no repository file`)
      else {
        const repoName = /^\d{14}_(.+)\.sql$/.exec(byVersion.get(version)[0])?.[1]
        if (repoName && repoName !== names[0]) {
          problems.push(`Ledger version "${version}" is "${names[0]}" but the repository records "${repoName}"`)
        }
      }
    }
    for (const [version, files] of byVersion) {
      if (!ledgerVersions.has(version)) problems.push(`Repository migration "${files[0]}" is not recorded in production`)
    }
  }
} else {
  console.log("No database credentials: checking repository consistency only.")
}

if (problems.length > 0) {
  console.error(`\nMigration ledger problems (${problems.length}):`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log(url && key && !url.includes("placeholder")
  ? "Repository and production migration ledger are consistent."
  : "Repository migration names and versions are consistent (production not checked).")
