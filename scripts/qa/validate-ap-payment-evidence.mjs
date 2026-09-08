import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const evidenceDir = path.join(root, "docs/plans/ap-payment-qa-evidence")
const expected = { matrix: 12, failure: 16, construction: 10, accounting: 8 }
const requiredMarkers = [
  "- Status: [ ] Not run [ ] Pass [ ] Fail",
  "| Payment run |",
  "| Disbursement |",
  "| Ledger transaction IDs |",
  "| Accounting sync record and outbox job |",
  "| Stripe webhook event |",
  "| Reconciliation run/result |",
  "## Evidence SELECT",
  "from public.payment_runs",
  "from public.payment_provider_events",
  "from public.payment_reconciliation_items",
]

const files = fs.readdirSync(evidenceDir).filter((name) => name.endsWith(".md") && name !== "README.md")
const errors = []
for (const [group, count] of Object.entries(expected)) {
  const actual = files.filter((name) => name.startsWith(`${group}-`)).length
  if (actual !== count) errors.push(`${group}: expected ${count} templates, found ${actual}`)
}

for (const name of files) {
  const source = fs.readFileSync(path.join(evidenceDir, name), "utf8")
  for (const marker of requiredMarkers) {
    if (!source.includes(marker)) errors.push(`${name}: missing ${marker}`)
  }
  if (/- Status: \[[xX]\]/.test(source)) errors.push(`${name}: a human status is already checked`)
  if (/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{12,}\b/.test(source)) errors.push(`${name}: contains an API key-like value`)
}

if (errors.length > 0) {
  console.error(errors.join("\n"))
  process.exitCode = 1
} else {
  console.log(`AP payment QA evidence templates valid: ${files.length}/46`)
}
