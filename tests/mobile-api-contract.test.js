require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const { test } = require("node:test")

const { NextRequest } = require("next/server")

const contracts = require("@/lib/mobile/contracts")
const { proxy } = require("@/proxy")

// The mobile API is a published contract: lib/mobile/contracts.ts holds its
// shared rules, docs/mobile-api-v1.openapi.yaml is what the iOS app is built
// against, and app/api/mobile/v1 is what answers. The repository invariants at
// the bottom keep those three describing the same API. Session, org and
// project scope are proved per module: tests/mobile-auth.test.js and the
// tests/mobile-*.test.js suites.

const root = path.resolve(__dirname, "..")
const routesDir = path.join(root, "app/api/mobile/v1")
const spec = fs.readFileSync(path.join(root, "docs/mobile-api-v1.openapi.yaml"), "utf8")

// ---------------------------------------------------------------------------
// Shared contract rules
// ---------------------------------------------------------------------------

test("the API version is v1 and the published spec serves it there", () => {
  assert.equal(contracts.MOBILE_API_VERSION, "v1")
  assert.match(spec, /^servers:\n\s+- url: \S+\/api\/mobile\/v1$/m)
})

test("page sizes default, floor and cap", () => {
  const cases = [
    [null, 50],
    ["0", 50],
    ["-3", 50],
    ["nope", 50],
    ["25", 25],
    ["250", 100],
  ]
  for (const [value, size] of cases) assert.equal(contracts.parsePageSize(value), size, String(value))
})

test("cursors round-trip, and anything else decodes to no cursor", () => {
  const cursor = contracts.encodeCursor("2026-06-23T12:00:00.000Z", "project-1")
  assert.deepEqual(contracts.decodeCursor(cursor), { updated_at: "2026-06-23T12:00:00.000Z", id: "project-1" })

  const wrongShape = Buffer.from(JSON.stringify({ id: 1 })).toString("base64url")
  for (const value of ["not-a-cursor", wrongShape, null]) assert.equal(contracts.decodeCursor(value), null)
})

test("days until due are whole calendar days, negative once overdue", () => {
  const today = new Date("2026-08-08T18:30:00.000Z")
  const cases = [
    ["2026-08-08", 0],
    ["2026-08-18", 10],
    ["2026-07-29", -10], // how late a vendor already is, never clamped to zero
    ["2026-08-09T23:59:59.000Z", 1], // a timestamp counts by its date
    [null, null],
    ["not-a-date", null],
  ]
  for (const [due, days] of cases) assert.equal(contracts.daysUntilDue(due, today), days, String(due))
})

// ---------------------------------------------------------------------------
// Repository invariants
// ---------------------------------------------------------------------------

/** Every mobile route as an OpenAPI path: `[projectId]` → `{projectId}`. */
function mobileRoutes(directory = routesDir) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) return mobileRoutes(full)
    if (entry.name !== "route.ts") return []
    const route = `/${path.relative(routesDir, directory)}`.replace(/\[(\w+)\]/g, "{$1}")
    return [route === "/" ? "/" : route.replace(/\/$/, "")]
  })
}

const documentedPaths = [...spec.matchAll(/^ {2}(\/\S*):$/gm)].map((match) => match[1])

// Shipped but not yet in the OpenAPI file; see the todo below.
const UNDOCUMENTED = new Set([
  "/capture",
  "/payment-runs",
  "/payment-runs/{id}/decision",
  "/service/visits",
  "/service/visits/{visitId}",
  "/service/visits/{visitId}/complete",
  "/time/approvals",
  "/time/approvals/approve",
  "/time/approvals/reject",
  "/time/clock",
  "/time/clock/break/end",
  "/time/clock/break/start",
  "/time/clock/cost-codes",
  "/time/clock/in",
  "/time/clock/out",
  "/time/clock/switch",
  "/time/mine",
])

test("every path the OpenAPI spec publishes is served by a route", () => {
  const served = new Set(mobileRoutes())
  assert.deepEqual(documentedPaths.filter((documented) => !served.has(documented)), [])
})

test("every mobile route is published in the OpenAPI spec", () => {
  const documented = new Set(documentedPaths)
  const missing = mobileRoutes().filter((route) => !documented.has(route) && !UNDOCUMENTED.has(route))
  assert.deepEqual(missing, [], "add these paths to docs/mobile-api-v1.openapi.yaml")
  for (const route of UNDOCUMENTED) {
    assert.ok(!documented.has(route), `${route} is documented now; remove it from UNDOCUMENTED`)
  }
})

test.todo("capture, payment-run, service-visit and time routes are published in the OpenAPI spec") // owner: mobile — seventeen shipped routes (UNDOCUMENTED above) are missing from docs/mobile-api-v1.openapi.yaml

test("the proxy lets every mobile route through to its bearer-token check", async () => {
  // Without a PUBLIC_API_ROUTES prefix the proxy 307s a mobile call to the web
  // sign-in, and the app sees an empty screen instead of an auth error.
  for (const route of mobileRoutes()) {
    const pathname = `/api/mobile/v1${route.replace(/\{\w+\}/g, "00000000-0000-4000-8000-000000000001")}`
    const response = await proxy(new NextRequest(`https://arc.test${pathname}`))
    assert.equal(response.headers.get("x-middleware-next"), "1", `${pathname} is not in PUBLIC_API_ROUTES`)
  }
})
