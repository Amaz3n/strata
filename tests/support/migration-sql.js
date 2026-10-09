const fs = require("node:fs")
const path = require("node:path")

const migrationsDir = path.join(__dirname, "../../supabase/migrations")

/**
 * The SQL one migration contributes, for scoped database fixtures that build a
 * schema from a few migrations rather than all of them (tests/support/pglite.js).
 * Migrations consolidated before they were ever applied keep their original
 * name as a marked section of the consolidated file
 * (`-- ==== <name> ====`), so a fixture keeps loading exactly the SQL it did.
 */
function migrationSql(name) {
  const file = path.join(migrationsDir, `${name}.sql`)
  if (fs.existsSync(file)) return fs.readFileSync(file, "utf8")
  const marker = `-- ==== ${name} ====\n`
  for (const candidate of fs.readdirSync(migrationsDir)) {
    const sql = fs.readFileSync(path.join(migrationsDir, candidate), "utf8")
    const start = sql.indexOf(marker)
    if (start < 0) continue
    const body = sql.slice(start + marker.length)
    const end = body.indexOf("\n-- ==== ")
    return end < 0 ? body : body.slice(0, end + 1)
  }
  throw new Error(`No migration named ${name}`)
}

module.exports = { migrationSql }
