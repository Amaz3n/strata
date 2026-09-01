const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const root = path.resolve(__dirname, "..")

function source(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8")
}

test("the ops snapshot uses one server-provided reference time", () => {
  const page = source("app/(app)/admin/ops/page.tsx")
  const client = source("components/admin/ops-client.tsx")

  assert.match(page, /referenceTimeMs=\{Date\.now\(\)\}/)
  assert.match(client, /formatDistance\(new Date\(value\), new Date\(referenceTimeMs\)/)
  assert.doesNotMatch(client, /formatDistanceToNow/)
  assert.doesNotMatch(client, /Date\.now\(\)/)
})

test("the ops table reuses one currency formatter", () => {
  const client = source("components/admin/ops-client.tsx")

  assert.match(client, /const CURRENCY_FORMATTER = new Intl\.NumberFormat/)
  assert.match(client, /return CURRENCY_FORMATTER\.format\(cents \/ 100\)/)
  assert.equal((client.match(/new Intl\.NumberFormat/g) ?? []).length, 1)
})
