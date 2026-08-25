import fs from "node:fs"
import path from "node:path"
import process from "node:process"
import ts from "typescript"

const root = path.resolve(import.meta.dirname, "..")
const sourceRoots = ["app", "components", "lib"]
const baselinePath = path.join(root, "scripts/accounting-d2-legacy-baseline.json")

const dropSet = {
  invoices: ["qbo_id", "qbo_synced_at", "qbo_sync_status"],
  project_expenses: [
    "qbo_id", "qbo_synced_at", "qbo_sync_status", "qbo_sync_error", "qbo_transaction_type",
    "qbo_expense_account_id", "qbo_expense_account_name", "qbo_payment_account_id",
    "qbo_payment_account_name", "qbo_ap_account_id", "qbo_ap_account_name", "qbo_vendor_id",
    "qbo_vendor_name", "qbo_class_id", "qbo_class_name",
  ],
  vendor_bills: [
    "qbo_id", "qbo_synced_at", "qbo_sync_status", "qbo_sync_error", "qbo_expense_account_id",
    "qbo_expense_account_name", "qbo_ap_account_id", "qbo_ap_account_name", "qbo_vendor_id",
    "qbo_vendor_name", "qbo_class_id", "qbo_class_name",
  ],
  projects: ["qbo_class_id", "qbo_class_name", "qbo_customer_id", "qbo_customer_name"],
  companies: ["qbo_vendor_id", "qbo_vendor_name", "qbo_vendor_synced_at", "qbo_vendor_sync_status"],
}

function walk(directory) {
  if (!fs.existsSync(directory)) return []
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name)
    if (entry.isDirectory()) return walk(fullPath)
    return /\.(?:ts|tsx)$/.test(entry.name) ? [fullPath] : []
  })
}

/**
 * Return only the fluent PostgREST query rooted at `.from(...)`.
 *
 * Using the enclosing variable declaration made sibling queries in one
 * `Promise.all` contaminate each other: a legacy token selected from one table
 * was falsely attributed to every other table in the declaration. Wrappers
 * such as `withSpan(() => Promise.all(...))` then changed the count without
 * changing a single database dependency.
 */
function enclosingQuery(node) {
  let current = node
  while (current.parent) {
    const parent = current.parent
    if (ts.isPropertyAccessExpression(parent) && parent.expression === current) {
      current = parent
      continue
    }
    if (ts.isCallExpression(parent) && parent.expression === current) {
      current = parent
      continue
    }
    break
  }
  return current
}

function tableFromCall(node) {
  if (!ts.isCallExpression(node)) return null
  if (!ts.isPropertyAccessExpression(node.expression) || node.expression.name.text !== "from") return null
  const argument = node.arguments[0]
  if (!argument || !ts.isStringLiteralLike(argument)) return null
  return Object.hasOwn(dropSet, argument.text) ? argument.text : null
}

const findings = []
let exactTokenLines = 0
for (const sourceRoot of sourceRoots) {
  for (const absolutePath of walk(path.join(root, sourceRoot))) {
    const relativePath = path.relative(root, absolutePath)
    const sourceText = fs.readFileSync(absolutePath, "utf8")
    const exactTokens = new RegExp(`\\b(?:${[...new Set(Object.values(dropSet).flat())].join("|")})\\b`)
    exactTokenLines += sourceText.split("\n").filter((line) => exactTokens.test(line)).length
    const sourceFile = ts.createSourceFile(
      absolutePath,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      absolutePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    )

    const visit = (node) => {
      const table = tableFromCall(node)
      if (table) {
        const query = enclosingQuery(node)
        const queryText = query.getText(sourceFile)
        const columns = dropSet[table].filter((column) => new RegExp(`\\b${column}\\b`).test(queryText))
        if (columns.length > 0) {
          const line = sourceFile.getLineAndCharacterOfPosition(query.getStart(sourceFile)).line + 1
          findings.push({ file: relativePath, line, table, columns: columns.sort() })
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
  }
}

const counts = Object.fromEntries(
  Object.entries(
    findings.reduce((accumulator, finding) => {
      const key = `${finding.file}|${finding.table}|${finding.columns.join(",")}`
      accumulator[key] = (accumulator[key] ?? 0) + 1
      return accumulator
    }, {}),
  ).sort(([left], [right]) => left.localeCompare(right)),
)

if (process.argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify({ exactTokenLines, directDependencyStatements: findings.length, counts }, null, 2)}\n`)
  process.exit(0)
}

if (!fs.existsSync(baselinePath)) {
  console.error(`Missing D2 legacy baseline: ${path.relative(root, baselinePath)}`)
  process.exit(1)
}

const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"))
const currentTotal = Object.values(counts).reduce((sum, count) => sum + count, 0)
const currentFiles = [...new Set(findings.map((finding) => finding.file))]
const unexpectedFiles = currentFiles.filter((file) => !baseline.allowedFiles.includes(file))

console.log(`D2 census: ${exactTokenLines} exact-token lines; ${currentTotal} direct dependency statements (baseline ${baseline.total}).`)
if (unexpectedFiles.length > 0 || currentTotal > baseline.total) {
  console.error("New D2-dropped business-column dependencies detected:")
  for (const file of unexpectedFiles) console.error(`  dependency added in previously clean file: ${file}`)
  if (currentTotal > baseline.total) console.error(`  statement count grew by ${currentTotal - baseline.total}`)
  process.exit(1)
}

if (currentTotal < baseline.total) {
  console.log(`D2 dependency count improved by ${baseline.total - currentTotal}; tighten the reviewed baseline in the same change.`)
}
