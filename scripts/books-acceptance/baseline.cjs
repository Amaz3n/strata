#!/usr/bin/env node
// The Books verification baseline (B00.1): exactly which sources, migrations,
// scenarios and runtimes a verification ran against. Every Books file is hashed
// as it is on disk (committed or not), so the same tree always reproduces the
// same sourceDigest. Read-only; prints JSON or writes it to a new file.
//   node scripts/books-acceptance/baseline.cjs [--container NAME] [--out NEW_FILE]
const fs = require("node:fs"),
  path = require("node:path"),
  { createHash } = require("node:crypto"),
  { spawnSync } = require("node:child_process")

const root = path.join(__dirname, "../..")
const SOURCE_ROOTS = ["lib/services/books", "lib/services/reports", "lib/reports", "lib/financials", "components/books", "app/(app)/books", "app/api/books", "scripts/books-acceptance", "docs/books-revenue-recognition.md", "docs/books-entities.md", "docs/books-1099.md", "docs/books-restore.md", "docs/books-period-close.md"]
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex")
const run = (command, args) => { const result = spawnSync(command, args, { cwd: root, encoding: "utf8" }); return result.status === 0 ? result.stdout.trim() : null }

function files(entry) {
  const full = path.join(root, entry)
  if (!fs.existsSync(full)) return []
  if (fs.statSync(full).isFile()) return [entry]
  return fs.readdirSync(full, { withFileTypes: true }).flatMap((child) => child.name === "node_modules" ? [] : files(path.join(entry, child.name)))
}

function baseline({ container = null } = {}) {
  const sources = SOURCE_ROOTS.flatMap(files).filter((file) => /\.(ts|tsx|cjs|js|json|sql|md)$/.test(file)).sort()
    .map((file) => ({ path: file, sha256: sha256(fs.readFileSync(path.join(root, file))) }))
  const migrations = fs.readdirSync(path.join(root, "supabase/migrations")).filter((name) => name.endsWith(".sql")).sort()
  const booksMigrations = migrations.filter((name) => /books|accounting|journal|ledger|gl_|1099|tax/.test(name))
    .map((name) => ({ name, sha256: sha256(fs.readFileSync(path.join(root, "supabase/migrations", name))) }))
  const dirty = (run("git", ["status", "--porcelain", "--", ...SOURCE_ROOTS, "supabase/migrations"]) ?? "").split("\n").filter(Boolean).map((line) => line.slice(3))
  const tracker = JSON.parse(fs.readFileSync(path.join(root, "advisor-plans/013-arc-books-completion-checklist.json"), "utf8"))
  const statuses = {}
  const walk = (node) => { if (Array.isArray(node)) return node.forEach(walk); if (!node || typeof node !== "object") return
    if (typeof node.id === "string" && node.status && node.title) { statuses[node.id] = node.status; return } Object.values(node).forEach(walk) }
  walk(tracker.items)
  const { IMPLEMENTED, NOT_IMPLEMENTED } = require("./catalog.cjs")
  const reproducible = { sources, booksMigrations, migrationCount: migrations.length, catalog: { implemented: Object.keys(IMPLEMENTED), notImplemented: Object.fromEntries(Object.entries(NOT_IMPLEMENTED).map(([id, entry]) => [id, entry.status])) }, trackerStatuses: statuses }
  return {
    generatedAt: new Date().toISOString(),
    sourceDigest: sha256(JSON.stringify(reproducible)),
    git: { head: run("git", ["rev-parse", "HEAD"]), branch: run("git", ["rev-parse", "--abbrev-ref", "HEAD"]), uncommittedBooksPaths: dirty },
    runtime: {
      node: process.version,
      next: JSON.parse(fs.readFileSync(require.resolve("next/package.json", { paths: [root] }), "utf8")).version,
      pnpm: run("pnpm", ["--version"]),
      postgres: container ? run("docker", ["exec", container, "psql", "-U", "postgres", "-At", "-c", "show server_version"]) : null,
    },
    counts: { sources: sources.length, booksMigrations: booksMigrations.length, migrations: migrations.length,
      tracker: Object.values(statuses).reduce((tally, status) => ({ ...tally, [status]: (tally[status] ?? 0) + 1 }), {}) },
    ...reproducible,
  }
}

module.exports = { baseline }

if (require.main === module) {
  const arg = (name) => { const index = process.argv.indexOf(name); return index < 0 ? null : process.argv[index + 1] }
  const result = baseline({ container: arg("--container") })
  const out = arg("--out")
  if (out) fs.writeFileSync(out, JSON.stringify(result, null, 2) + "\n", { flag: "wx" })
  console.log(JSON.stringify({ sourceDigest: result.sourceDigest, head: result.git.head, uncommitted: result.git.uncommittedBooksPaths.length, counts: result.counts, runtime: result.runtime }))
}
