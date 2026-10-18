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
 *
 * `ledgerParity()` is the stricter comparison `check-migration-ledger.mjs` runs
 * once the ledger is repaired: versions must match exactly in both directions.
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

/**
 * Production ledger rows that deliberately have no file in `supabase/migrations/`.
 * Each says where its effect lives in the repository instead. Parity treats an
 * exact `version` + `name` match as applied elsewhere, never as drift; anything
 * else stays a problem. Add to this only with the owner's sign-off: an entry here
 * is a migration a fresh database never runs.
 */
export const LEDGER_ONLY_MIGRATIONS = [
  {
    version: "20260906014540",
    name: "fix_greenfield_launch_pgcrypto_search_path",
    livesIn: "supabase/migrations/20260906014604_fix_greenfield_launch_atomic.sql",
    why: "An MCP hotfix setting launch_books_greenfield_atomic's search_path to include extensions; the migration applied 24 seconds later recreates the function with that same search_path.",
  },
  {
    version: "20260908163949",
    name: "accounting_d2_lossless_finalizer",
    livesIn: "supabase/pending-migrations/accounting_d2_lossless_finalizer.sql",
    why: "A one-off data finalizer bound to one org's QBO connection; it raises on any other database, so it can never be part of a replay. The ledger's statements are that file byte for byte.",
  },
]

/**
 * Exact parity between repository migrations and the ledger. Returns the
 * problems and, with `allowPending`, the repository files the ledger has not
 * recorded yet (listed, not failed).
 */
export function ledgerParity({ migrations, ledger, allowPending = false, ledgerOnly = LEDGER_ONLY_MIGRATIONS }) {
  const problems = []
  const pending = []
  const repoNames = new Set(migrations.map((m) => m.name))
  const repoByVersion = new Map(migrations.map((m) => [m.version, m]))
  const elsewhere = new Set(ledgerOnly.map((m) => `${m.version} ${m.name}`))
  const ledgerNames = new Map()
  const ledgerVersions = new Map()
  for (const row of ledger) {
    const name = String(row.name ?? "").replace(/^\d{14}_/, "")
    const version = String(row.version ?? "")
    ledgerNames.set(name, [...(ledgerNames.get(name) ?? []), version])
    ledgerVersions.set(version, [...(ledgerVersions.get(version) ?? []), name])
  }
  for (const [name, versions] of ledgerNames) {
    if (versions.length > 1) problems.push(`Migration "${name}" is recorded ${versions.length} times: ${versions.join(", ")}`)
    if (!repoNames.has(name) && !elsewhere.has(`${versions[0]} ${name}`)) {
      problems.push(`Migration "${name}" (${versions[0]}) is applied but has no repository file — run scripts/recover-live-only-migrations.mjs`)
    }
  }
  for (const [version, names] of ledgerVersions) {
    if (names.length > 1) problems.push(`Ledger version "${version}" is recorded ${names.length} times: ${names.join(", ")}`)
    const repo = repoByVersion.get(version)
    if (!repo) {
      if (!elsewhere.has(`${version} ${names[0]}`)) problems.push(`Ledger version "${version}" (${names[0]}) has no repository file`)
    } else if (repo.name !== names[0]) {
      problems.push(`Ledger version "${version}" is "${names[0]}" but the repository records "${repo.name}"`)
    }
  }
  for (const migration of migrations) {
    if (ledgerVersions.has(migration.version)) continue
    if (allowPending) pending.push(migration.file)
    else problems.push(`Repository migration "${migration.file}" is not recorded in production`)
  }
  return { problems, pending }
}
