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
 *    repository file, and neither side contains duplicate names or versions
 *    (`ledgerParity()` in migration-ledger.mjs). The few production rows that
 *    deliberately have no migration file are listed, with where their effect
 *    lives, in `LEDGER_ONLY_MIGRATIONS` there.
 *
 * Without credentials it runs the repository-only half and says so. Credentials
 * come only from NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the
 * environment (nothing is read from .env files). In CI the repository half runs on
 * every pull request in the `database-contracts` job, with no secrets; the
 * production half runs only in the `migration-ledger-parity` job, on pushes to
 * main and manual runs, behind the `production-ledger` environment. A pull request
 * run never uses credentials even if some are present, because its code is not
 * trusted to hold a service-role key.
 *
 * Flags (CI's parity job passes both):
 *   --allow-pending       repository migrations the ledger has not recorded yet are
 *                         listed, not failed: they are waiting for approval. The ledger
 *                         holding something the repository lacks, or a shared version
 *                         under two names, still fails.
 *   --require-production  without credentials, say loudly that production was NOT
 *                         checked (a GitHub warning and step summary), never a quiet pass.
 */

import { appendFileSync, readdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { ledgerParity } from "./migration-ledger.mjs"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const migrationsDir = join(root, "supabase", "migrations")

const problems = []

const migrations = []
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
  migrations.push({ version, name, file })
  byName.set(name, [...(byName.get(name) ?? []), file])
  byVersion.set(version, [...(byVersion.get(version) ?? []), file])
}

for (const [name, files] of byName) {
  if (files.length > 1) problems.push(`Duplicate migration name "${name}": ${files.join(", ")}`)
}
for (const [version, files] of byVersion) {
  if (files.length > 1) problems.push(`Duplicate migration version "${version}": ${files.join(", ")}`)
}

const allowPending = process.argv.includes("--allow-pending")
const requireProduction = process.argv.includes("--require-production")
const pending = []
const untrusted = ["pull_request", "pull_request_target"].includes(process.env.GITHUB_EVENT_NAME ?? "")
const url = untrusted ? undefined : process.env.NEXT_PUBLIC_SUPABASE_URL
const key = untrusted ? undefined : process.env.SUPABASE_SERVICE_ROLE_KEY
if (untrusted) console.log("Pull request run: credentials are never used here.")
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
    const parity = ledgerParity({ migrations, ledger: await response.json() ?? [], allowPending })
    problems.push(...parity.problems)
    pending.push(...parity.pending)
  }
} else if (requireProduction) {
  const notice = "Production migration ledger NOT CHECKED: no ledger credentials in this run (LEDGER_SUPABASE_URL / LEDGER_SUPABASE_SERVICE_ROLE_KEY in the production-ledger environment)."
  console.log(`::warning title=Migration ledger not checked::${notice}`)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Migration ledger\n\n**Not checked.** ${notice}\n`)
} else {
  console.log("No database credentials: checking repository consistency only.")
}

if (pending.length > 0) {
  console.log(`\n${pending.length} repository migration(s) not yet in the production ledger (pending approval, not a failure):`)
  for (const file of pending) console.log(`  - ${file}`)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Migration ledger\n\n${pending.length} repository migration(s) pending approval:\n\n${pending.map((file) => `- \`${file}\``).join("\n")}\n`)
}

if (problems.length > 0) {
  console.error(`\nMigration ledger problems (${problems.length}):`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log(url && key && !url.includes("placeholder")
  ? `Repository and production migration ledger are consistent${pending.length ? ` apart from ${pending.length} pending migration(s)` : ""}.`
  : "Repository migration names and versions are consistent (production not checked).")
