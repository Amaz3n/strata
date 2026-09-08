const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")

const root = path.resolve(__dirname, "..")
const source = (relative) => fs.readFileSync(path.join(root, relative), "utf8")

/**
 * The body of one exported function, bounded by the next top-level export.
 *
 * Assertions about a specific function must not be allowed to match text from a
 * later one — an unbounded `[\s\S]*?` scan happily finds an identical call in a
 * neighbour and reports a gate that is no longer there.
 */
const exportedFunctionBody = (relative, name) => {
  const src = source(relative)
  const start = src.indexOf(`export async function ${name}`)
  assert.notEqual(start, -1, `${relative} must export ${name}`)
  const next = src.indexOf("\nexport ", start + 1)
  return src.slice(start, next === -1 ? src.length : next)
}

test("organization membership gates require a fresh active membership", () => {
  const auth = source("lib/auth/context.ts")
  assert.match(auth, /fetchMembershipWithServiceRole[\s\S]+?\.eq\("status", "active"\)/)
  assert.match(auth, /Authorization must not trust the session-lifetime identity cache/)
  assert.doesNotMatch(auth, /context\.membership && context\.membership\.org_id === resolvedOrgId/)
})

test("explicit organization checks never fall back to another membership", () => {
  const auth = source("lib/auth/context.ts")
  assert.match(auth, /if \(!membership && orgId\)[\s\S]*?throw new Error/)
})

test("privileged document transport declares explicit document permissions", () => {
  // The upload routes gate through one shared preparer rather than each
  // repeating the check, so the guarantee is proven in two steps: every
  // transport reaches a gate, and that gate demands docs.upload. A route that
  // skips both — or a preparer that stops checking — still fails here.
  const uploadGate = /requireProjectPermission\([^)]*"docs\.upload"\)|prepareProjectDocumentUpload\(/s
  for (const relative of [
    "app/api/documents/upload-file/route.ts",
    "app/api/documents/upload-url/route.ts",
    "app/api/documents/multipart/create/route.ts",
  ]) {
    assert.match(source(relative), uploadGate, relative)
  }
  assert.match(
    exportedFunctionBody("lib/services/files.ts", "prepareProjectDocumentUpload"),
    /requireProjectPermission\([^)]*"docs\.upload"\)/,
    "prepareProjectDocumentUpload must enforce docs.upload",
  )
  assert.match(source("app/api/documents/download-zip/route.ts"), /requirePermission\("docs\.download"/)
  assert.match(source("app/api/files/[fileId]/raw/route.ts"), /"docs\.download"/)
})

test("public invoice payment amounts and access are checked against durable invoice state", () => {
  const payments = source("lib/services/payments.ts")
  const publicIntent = payments.slice(payments.indexOf("export async function createPublicInvoicePaymentIntent"))
  assert.match(publicIntent, /from\("invoices"\)[\s\S]*eq\("token", input\.token\)/)
  assert.match(publicIntent, /invoice\.client_visible === false \|\| invoice\.status === "void"/)
  assert.match(publicIntent, /requestedCents > invoiceBalanceCents/)
  assert.match(publicIntent, /requireReadyStripeConnectedAccountForOrg\(\s*invoice\.org_id/)
  assert.doesNotMatch(payments, /createPersistedPayLink/)
  assert.doesNotMatch(payments, /id: ""/)
})

test("fan-out jobs report partial failures with HTTP 207", () => {
  for (const relative of [
    "app/api/accounting/process-outbox/route.ts",
    "app/api/jobs/invoice-schedules/route.ts",
    "app/api/jobs/process-outbox/route.ts",
    "app/api/jobs/report-schedules/route.ts",
    "app/api/jobs/weekly-executive-snapshot/route.ts",
  ]) {
    assert.match(source(relative), /207/, relative)
  }
})

test("feature flags are registered and unknown keys fail closed", () => {
  const service = source("lib/services/feature-flags.ts")
  const registry = source("lib/feature-flags/registry.ts")
  assert.match(service, /Rejected unregistered feature flag/)
  assert.match(service, /return false/)
  assert.match(registry, /reviewAfter/)
  assert.match(registry, /removalCondition/)
})
