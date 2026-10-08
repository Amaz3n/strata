/**
 * What production still needs: repository migrations against the production
 * migration ledger. Pure, so the deploy list can be tested without a database.
 *
 * A repository migration counts as applied when the ledger records
 *   - its exact version;
 *   - its full stem as the name (`<version>_<name>`, how the Supabase MCP stamps
 *     a migration applied under a fresh version); or
 *   - its name under another version;
 * or when `supabase/scripts/repair-migration-ledger.sql` lists it as
 * object-verified in production (applied, but the ledger needs that repair).
 * Anything else is pending and belongs in the deploy.
 */
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const STEM = /^(\d{14})_(.+)\.sql$/

export function repositoryMigrations(dir) {
  return readdirSync(dir).flatMap((file) => {
    const match = STEM.exec(file)
    return match ? [{ version: match[1], name: match[2], file }] : []
  }).sort((a, b) => a.version.localeCompare(b.version))
}

/** The object-verified applied set from the reviewed ledger repair script. */
export function verifiedApplied(repairSql) {
  const map = new Map()
  for (const match of repairSql.matchAll(/^\s*\('(\d{14})',\s*'([^']+)'\)/gm)) map.set(match[1], match[2])
  return map
}

export function readVerifiedApplied(root) {
  return verifiedApplied(readFileSync(join(root, "supabase", "scripts", "repair-migration-ledger.sql"), "utf8"))
}

/** Ledger rows from a file: JSON `[{version, name}]`, or one `version name` per line. */
export function parseLedger(text) {
  const trimmed = text.trim()
  if (trimmed.startsWith("[")) return JSON.parse(trimmed).map((row) => ({ version: String(row.version), name: String(row.name ?? "") }))
  return trimmed.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
    const [version, ...rest] = line.split(/\s+/)
    return { version, name: rest.join(" ") }
  })
}

export function classifyMigrations({ migrations, ledger, verified = new Map() }) {
  const versions = new Map(ledger.map((row) => [row.version, row]))
  const stems = new Map(ledger.filter((row) => /^\d{14}_/.test(row.name)).map((row) => [row.name, row]))
  const names = new Map()
  for (const row of ledger) {
    const name = row.name.replace(/^\d{14}_/, "")
    names.set(name, [...(names.get(name) ?? []), row])
  }
  const result = { exact: [], underOtherVersion: [], verifiedApplied: [], pending: [] }
  for (const migration of migrations) {
    const exact = versions.get(migration.version)
    if (exact) { result.exact.push({ ...migration, ledgerName: exact.name }); continue }
    const stamped = stems.get(`${migration.version}_${migration.name}`) ?? names.get(migration.name)?.[0]
    if (stamped) { result.underOtherVersion.push({ ...migration, ledgerVersion: stamped.version }); continue }
    if (verified.get(migration.version) === migration.name) { result.verifiedApplied.push(migration); continue }
    result.pending.push(migration)
  }
  return result
}
